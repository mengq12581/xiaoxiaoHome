// 湖面（写实版）：一张大平面 + 自写着色器。
//   - 实时倒影：镜像相机把整个场景（天空、房子、树）渲染到一张半分辨率贴图，按水面法线扰动采样；
//     低帧率时可以关掉（setReflection(false)），退回到只反射天色；
//   - 颜色按水深从浅到深（小岛的水深贴图），斜看时倒影占比按菲涅耳增加；
//   - 太阳在水面上的高光、岸边一圈浅浅的浪花、远处融进雾里。

import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { Island } from './island';
import { WATER_LEVEL } from './island';
import { PALETTE, type LightingPreset } from './palette';

const vert = /* glsl */ `
uniform mat4 textureMatrix;
varying vec3 vWorld;
varying vec4 vRefl;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vRefl = textureMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
uniform float uTime;
uniform sampler2D tDiffuse;
uniform float uReflect;
uniform sampler2D uDepth;
uniform vec4 uExtent; // x0, y0, x1, y1（平面坐标；世界 z = -平面 y）
uniform vec3 uShallow, uMid, uDeep, uFoam;
uniform vec3 uSkyZenith, uSkyHorizon, uSunColor, uSunDir;
uniform float uGlint;
uniform vec3 uTint;
uniform vec3 uFogColor;
uniform float uFogNear, uFogFar;
uniform vec3 color; // Reflector 需要（不用）
varying vec3 vWorld;
varying vec4 vRefl;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 plan = vec2(vWorld.x, -vWorld.z);
  vec2 uv = (plan - uExtent.xy) / (uExtent.zw - uExtent.xy);
  vec2 e2 = smoothstep(0.0, 0.12, uv) * smoothstep(0.0, 0.12, 1.0 - uv);
  float inside = e2.x * e2.y;
  vec4 d = texture2D(uDepth, clamp(uv, 0.0, 1.0));
  float depth = mix(4.0, d.r * 4.0, inside);
  float shore = mix(-6.0, d.g * 12.0 - 6.0, inside); // 离岸距离（米，水里为负）

  // 法线：几层不同方向、不同尺度的小波 + 噪声（湖面：风小，波浪细碎）
  float t = uTime;
  vec2 g = vec2(0.0);
  g += vec2(0.8, 0.6) * cos(dot(plan, vec2(0.8, 0.6)) * 1.7 + t * 1.1) * 0.016;
  g += vec2(-0.5, 0.86) * cos(dot(plan, vec2(-0.5, 0.86)) * 2.9 + t * 1.5) * 0.012;
  g += vec2(0.95, -0.3) * cos(dot(plan, vec2(0.95, -0.3)) * 5.3 + t * 2.1) * 0.008;
  g += (vec2(noise(plan * 2.3 + t * 0.35), noise(plan * 2.3 - t * 0.3 + 17.0)) - 0.5) * 0.03;
  g += (vec2(noise(plan * 7.0 - t * 0.6), noise(plan * 7.0 + t * 0.5 + 5.0)) - 0.5) * 0.012;
  // 远处的细浪在屏幕上小于一个像素，留着会排成一格一格的花纹：按距离压平
  float camDist = length(cameraPosition - vWorld);
  g *= 1.0 / (1.0 + camDist * 0.04);
  vec3 N = normalize(vec3(-g.x, 1.0, g.y));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 R = reflect(-V, N);

  // 水本身的颜色：按深度三段
  vec3 base = mix(uShallow, uMid, smoothstep(0.05, 0.9, depth));
  base = mix(base, uDeep, smoothstep(0.9, 3.2, depth)) * uTint;
  // 倒影：实时镜像贴图（按法线扰动），关掉时用天色
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(max(R.y, 0.0), 0.6));
  vec3 refl = sky;
  if (uReflect > 0.5) {
    vec4 ruv = vRefl;
    ruv.xy += g * 2.2 * ruv.w;
    refl = texture2DProj(tDiffuse, ruv).rgb;
  }
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  // 浅水处多透出水底，倒影弱一些
  float reflAmt = clamp(fres * mix(0.55, 1.0, smoothstep(0.1, 1.2, depth)), 0.0, 0.92);
  vec3 col = mix(base, refl, reflAmt);
  // 太阳高光（窄、亮）
  float spec = pow(max(dot(R, uSunDir), 0.0), 900.0) * 6.0 + pow(max(dot(R, uSunDir), 0.0), 120.0) * 0.25;
  col += uSunColor * spec * uGlint;
  // 岸边浪花：一圈很浅的细碎白边
  float band = (1.0 - smoothstep(0.0, 0.22 + 0.1 * sin(t * 0.8 + plan.x * 0.7), -shore)) * step(shore, 0.3);
  float foam = band * smoothstep(0.5, 0.85, noise(plan * 9.0 + vec2(t * 0.3, -t * 0.2)) * 0.7 + noise(plan * 2.0 - t * 0.1) * 0.3 + band * 0.2);
  col = mix(col, uFoam * uTint, foam * 0.28 * inside);
  // 远处融进雾里
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, camDist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface Water {
  mesh: THREE.Mesh;
  setLighting(p: LightingPreset, sunDir: THREE.Vector3): void;
  /** 实时倒影开关（低帧率时先关它） */
  setReflection(on: boolean): void;
  readonly reflection: boolean;
  /** 画布尺寸变化时调整倒影贴图（半分辨率） */
  setSize(w: number, h: number): void;
  update(dt: number): void;
}

export function buildWater(island: Island): Water {
  const lin = (hex: string) => new THREE.Color(hex);
  const shader = {
    name: 'LakeWater',
    uniforms: {
      color: { value: new THREE.Color() },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uReflect: { value: 1 },
      uTime: { value: 0 },
      uDepth: { value: null },
      uExtent: { value: new THREE.Vector4(island.extent.x0, island.extent.y0, island.extent.x1, island.extent.y1) },
      uShallow: { value: lin(PALETTE.water.shallow) },
      uMid: { value: lin(PALETTE.water.mid) },
      uDeep: { value: lin(PALETTE.water.deep) },
      uFoam: { value: lin(PALETTE.water.foam) },
      uSkyZenith: { value: new THREE.Color() },
      uSkyHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlint: { value: 1 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uFogColor: { value: new THREE.Color() },
      uFogNear: { value: 60 },
      uFogFar: { value: 400 },
    },
    vertexShader: vert,
    fragmentShader: frag,
  };
  const mesh = new Reflector(new THREE.CircleGeometry(460, 96), { shader, textureWidth: 512, textureHeight: 512, clipBias: 0.003, multisample: 0 });
  const mat = mesh.material as THREE.ShaderMaterial;
  // UniformsUtils.clone 会复制贴图对象，水深贴图换回原件
  mat.uniforms.uDepth.value = island.depthTexture;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(island.center[0], WATER_LEVEL, -island.center[1]);
  mesh.name = 'water';
  const reflect = mesh.onBeforeRender;
  let on = true;
  const api: Water = {
    mesh,
    setLighting(p, sunDir) {
      const u = mat.uniforms;
      u.uSkyZenith.value.set(p.sky.zenith);
      u.uSkyHorizon.value.set(p.sky.horizon);
      u.uSunColor.value.set(p.sunColor);
      u.uSunDir.value.copy(sunDir);
      u.uGlint.value = p.glint;
      u.uTint.value.set(p.waterTint);
      u.uFogColor.value.set(p.fog.color);
      u.uFogNear.value = p.fog.near;
      u.uFogFar.value = p.fog.far;
    },
    setReflection(v) {
      on = v;
      mat.uniforms.uReflect.value = v ? 1 : 0;
      mesh.onBeforeRender = v ? reflect : () => {};
    },
    get reflection() {
      return on;
    },
    setSize(w, h) {
      mesh.getRenderTarget().setSize(Math.max(64, Math.round(w / 2)), Math.max(64, Math.round(h / 2)));
    },
    update(dt) {
      mat.uniforms.uTime.value += dt;
    },
  };
  return api;
}
