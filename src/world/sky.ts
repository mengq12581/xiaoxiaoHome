// 天空与远景：
//   - 天穹：从天顶到地平线的渐变，太阳 / 月亮周围一圈光晕，夜里有星星；
//   - 云：几片手绘感的扁平云（受光面 + 背光面两个颜色），不做体积云（以后天气系统再做）；
//   - 湖对岸：两圈低矮的山影，近的深、远的浅，靠雾融进地平线。
// 这些都由「时间」预设驱动（palette.ts 的 LIGHTING），天气以后在这里接（docs/验收问题.md C14）。

import * as THREE from 'three';
import { fbm, rng } from './noise';
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

/** 一片云的贴图：几团圆形叠在一起，上半部受光、下沿带一点背光色（用 alpha + 两个颜色分开画） */
function cloudTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  // R 通道 = 受光程度，A = 形状
  const blobs: [number, number, number][] = [];
  const n = 6 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const x = 90 + (i / (n - 1)) * 330 + (r() - 0.5) * 40;
    const rad = 38 + r() * 46 * Math.sin((i / (n - 1)) * Math.PI) + 18;
    blobs.push([x, 175 - rad * 0.55 - r() * 25, rad]);
  }
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 256);
  for (const [x, y, rad] of blobs) {
    const grad = g.createRadialGradient(x, y - rad * 0.35, rad * 0.1, x, y, rad);
    grad.addColorStop(0, 'rgba(255,0,0,1)');
    grad.addColorStop(0.65, 'rgba(255,0,0,1)');
    grad.addColorStop(1, 'rgba(120,0,0,1)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  // 底边压平
  g.fillStyle = '#000';
  g.fillRect(0, 182, 512, 74);
  const img = g.getImageData(0, 0, 512, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i];
    img.data[i + 3] = v > 8 ? 255 : 0;
    img.data[i] = v;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const cloudFrag = /* glsl */ `
uniform sampler2D map;
uniform vec3 uLit, uShade;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(map, vUv);
  if (s.a < 0.5) discard;
  float lit = smoothstep(0.45, 0.9, s.r) * smoothstep(0.0, 0.35, vUv.y - 0.25);
  vec3 col = mix(uShade, uLit, lit);
  gl_FragColor = vec4(col, uOpacity);
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
  const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), skyMat);
  dome.position.copy(center);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);

  // 云：一圈 11 片，距离 170～320 米，高 18～60 米
  const clouds: THREE.ShaderMaterial[] = [];
  const r = rng(42);
  for (let i = 0; i < 11; i++) {
    const tex = cloudTexture(100 + i);
    const mat = new THREE.ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: tex }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uOpacity: { value: 1 } },
    });
    clouds.push(mat);
    const w = 70 + r() * 70;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 2), mat);
    const a = (i / 11) * Math.PI * 2 + r() * 0.4;
    const dist = 170 + r() * 150;
    m.position.set(center.x + Math.cos(a) * dist, 18 + r() * 42, center.z + Math.sin(a) * dist);
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
    setLighting(p, sunDir) {
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
