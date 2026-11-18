// 天空与远景（写实版）：
//   - 白天 / 黄昏：物理天空模型（Preetham，three 自带的 Sky），太阳高度决定天色与地平线的暖光；
//   - 夜晚：深蓝渐变天穹 + 月亮 + 星星（物理模型在太阳落下后只剩一片黑，不好看）；
//   - 环境光照（IBL）直接从这片天空生成（world.ts 里用 PMREM），房子和树的明暗跟天色一致；
//   - 云：一圈柔边的云片（噪声生成浓度），不做体积云（以后天气系统再做）；
//   - 湖对岸：两圈低矮的山影，近的深、远的浅，靠雾融进地平线。
// 这些都由「时间」预设驱动（palette.ts 的 LIGHTING），天气以后在这里接（docs/验收问题.md C14）。

import * as THREE from 'three';
import { Sky as PhysicalSky } from 'three/examples/jsm/objects/Sky.js';
import { fbm, rng } from './noise';
import { cloudShape } from './textures';
import type { LightingPreset } from './palette';

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const skyFrag = /* glsl */ `
uniform vec3 uZenith, uHorizon, uBelow, uGlow, uSunDir;
uniform float uStars;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = y > 0.0 ? mix(uHorizon, uZenith, pow(y, 0.55)) : mix(uHorizon, uBelow, pow(-y, 0.4));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uGlow * (pow(sd, 12.0) * 0.35 + pow(sd, 400.0) * 1.6);
  if (uStars > 0.0 && y > 0.05) {
    vec3 cell = floor(d * 260.0);
    float s = step(0.9975, hash(cell)) * smoothstep(0.05, 0.35, y);
    col += vec3(s) * uStars;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const cloudFrag = /* glsl */ `
uniform sampler2D map;
uniform vec3 uLit, uShade;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(map, vUv);
  if (s.a < 0.01) discard;
  vec3 col = mix(uShade, uLit, s.r);
  gl_FragColor = vec4(col, s.a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const cloudVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export interface Sky {
  group: THREE.Group;
  /** 只有天空（物理天空 + 夜空穹顶）的场景：生成环境光照用 */
  envScene: THREE.Scene;
  setLighting(p: LightingPreset, sunDir: THREE.Vector3): void;
}

export function buildSky(center: THREE.Vector3): Sky {
  const group = new THREE.Group();
  group.name = 'sky';
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uBelow: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uStars: { value: 0 },
    },
  });
  const domeGeo = new THREE.SphereGeometry(500, 48, 24);
  const dome = new THREE.Mesh(domeGeo, skyMat);
  dome.position.copy(center);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);
  const physical = new PhysicalSky();
  physical.scale.setScalar(900);
  physical.position.copy(center);
  physical.renderOrder = -10;
  physical.frustumCulled = false;
  group.add(physical);
  const physMat = physical.material as THREE.ShaderMaterial;

  // 生成环境光照用的天空场景：和上面共用材质，所以天色一变它也跟着变
  const envScene = new THREE.Scene();
  const envDome = new THREE.Mesh(domeGeo, skyMat);
  const envPhys = new THREE.Mesh(physical.geometry, physMat);
  envPhys.scale.setScalar(900);
  envScene.add(envDome, envPhys);

  // 云：一圈 14 片，距离 170～330 米，高 30～80 米
  const clouds: THREE.ShaderMaterial[] = [];
  const r = rng(42);
  for (let i = 0; i < 14; i++) {
    const tex = cloudShape(100 + i);
    const mat = new THREE.ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: tex }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uOpacity: { value: 1 } },
    });
    clouds.push(mat);
    const w = 90 + r() * 110;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 2), mat);
    const a = (i / 14) * Math.PI * 2 + r() * 0.4;
    const dist = 190 + r() * 140;
    m.position.set(center.x + Math.cos(a) * dist, 30 + r() * 50, center.z + Math.sin(a) * dist);
    m.lookAt(center.x, m.position.y, center.z);
    m.renderOrder = -9;
    group.add(m);
  }

  // 湖对岸的山影：两圈，用噪声做起伏的环带
  const hillMats: THREE.MeshStandardMaterial[] = [];
  for (const [layer, radius, hMax, seed] of [
    [0, 260, 34, 3],
    [1, 190, 20, 8],
  ] as const) {
    const seg = 220;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n = fbm(Math.cos(a) * 3 + 10, Math.sin(a) * 3 + seed, 4, seed);
      const hgt = Math.max(2, (n - 0.32) * hMax * 1.9);
      const x = center.x + Math.cos(a) * radius;
      const z = center.z + Math.sin(a) * radius;
      pos.push(x, -1, z, center.x + Math.cos(a) * (radius - 4), hgt, center.z + Math.sin(a) * (radius - 4));
      if (i < seg) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide });
    hillMats[layer] = mat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `hills-${layer}`;
    group.add(mesh);
  }

  return {
    group,
    envScene,
    setLighting(p, sunDir) {
      const phys = p.physicalSky;
      physical.visible = envPhys.visible = !!phys;
      dome.visible = envDome.visible = !phys;
      if (phys) {
        const pu = physMat.uniforms;
        pu.turbidity.value = phys.turbidity;
        pu.rayleigh.value = phys.rayleigh;
        pu.mieCoefficient.value = phys.mieCoefficient;
        pu.mieDirectionalG.value = phys.mieDirectionalG;
        pu.sunPosition.value.copy(sunDir);
      }
      const u = skyMat.uniforms;
      u.uZenith.value.set(p.sky.zenith);
      u.uHorizon.value.set(p.sky.horizon);
      u.uBelow.value.set(p.sky.below);
      u.uGlow.value.set(p.sky.glow);
      u.uSunDir.value.copy(sunDir);
      u.uStars.value = p.practicals && p.sunIntensity < 1 ? 0.9 : 0;
      for (const m of clouds) {
        m.uniforms.uLit.value.set(p.cloud.lit);
        m.uniforms.uShade.value.set(p.cloud.shade);
        m.uniforms.uOpacity.value = p.cloud.opacity;
      }
      hillMats[0].color.set(p.hills[0]);
      hillMats[1].color.set(p.hills[1]);
    },
  };
}
