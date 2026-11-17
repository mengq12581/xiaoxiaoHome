// 湖面：一张大平面 + 自写着色器。
//   - 颜色按水深从浅青绿过渡到深蓝（水深来自小岛的水深贴图，岛外一律算深水）；
//   - 斜着看反射天空（菲涅耳），太阳 / 月亮在水面上拉出一道亮光；
//   - 岸边一圈浮动的白沫；远处融进地平线的颜色。
// 不做真实反射与折射（GTX 1650 预算），观感靠颜色关系。

import * as THREE from 'three';
import type { Island } from './island';
import { WATER_LEVEL } from './island';
import { PALETTE, type LightingPreset } from './palette';

const vert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const frag = /* glsl */ `
uniform float uTime;
uniform sampler2D uDepth;
uniform vec4 uExtent; // x0, y0, x1, y1（平面坐标；世界 z = -平面 y）
uniform vec3 uShallow, uMid, uDeep, uFoam;
uniform vec3 uSkyZenith, uSkyHorizon, uSunColor, uSunDir;
uniform float uGlint;
uniform vec3 uTint;
uniform vec3 uFogColor;
uniform float uFogNear, uFogFar;
varying vec3 vWorld;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 plan = vec2(vWorld.x, -vWorld.z);
  vec2 uv = (plan - uExtent.xy) / (uExtent.zw - uExtent.xy);
  // 贴图范围边缘平滑过渡到「深水」，不留接缝
  vec2 e2 = smoothstep(0.0, 0.12, uv) * smoothstep(0.0, 0.12, 1.0 - uv);
  float inside = e2.x * e2.y;
  vec4 d = texture2D(uDepth, clamp(uv, 0.0, 1.0));
  float depth = mix(4.0, d.r * 4.0, inside);
  float shore = mix(-6.0, d.g * 12.0 - 6.0, inside); // 离岸距离（米，水里为负）

  // 法线：几层斜向的正弦小波 + 噪声
  float t = uTime;
  vec2 g = vec2(0.0);
  g += vec2(0.8, 0.6) * cos(dot(plan, vec2(0.8, 0.6)) * 1.3 + t * 0.9) * 0.025;
  g += vec2(-0.5, 0.86) * cos(dot(plan, vec2(-0.5, 0.86)) * 2.1 + t * 1.3) * 0.018;
  g += vec2(0.95, -0.3) * cos(dot(plan, vec2(0.95, -0.3)) * 3.7 + t * 1.7) * 0.01;
  g += (vec2(noise(plan * 1.7 + t * 0.25), noise(plan * 1.7 - t * 0.2 + 17.0)) - 0.5) * 0.03;
  vec3 N = normalize(vec3(-g.x, 1.0, g.y));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 R = reflect(-V, N);

  // 水色：按深度三段
  vec3 base = mix(uShallow, uMid, smoothstep(0.05, 0.9, depth));
  base = mix(base, uDeep, smoothstep(0.9, 3.2, depth)) * uTint;
  // 反射天空
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(max(R.y, 0.0), 0.6));
  vec3 col = mix(base, sky, clamp(fres * 0.85, 0.0, 0.85));
  // 太阳 / 月亮的亮光
  // 只保留很窄的高光：碎成一点点闪光，不会在移轴模糊后糊成一大团
  float spec = pow(max(dot(R, uSunDir), 0.0), 600.0) * 3.0;
  col += uSunColor * spec * uGlint;
  // 岸边白沫：一圈随时间轻轻进退的带子
  float band = (1.0 - smoothstep(0.0, 0.35 + 0.15 * sin(t * 0.8 + plan.x * 0.7), -shore)) * step(shore, 0.3);
  float foam = band * smoothstep(0.45, 0.75, noise(plan * 3.0 + vec2(t * 0.3, -t * 0.2)) + band * 0.3);
  col = mix(col, uFoam * uTint, foam * 0.75 * inside);
  // 远处融进地平线
  float dist = length(cameraPosition - vWorld);
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface Water {
  mesh: THREE.Mesh;
  setLighting(p: LightingPreset, sunDir: THREE.Vector3): void;
  update(dt: number): void;
}

export function buildWater(island: Island): Water {
  const lin = (hex: string) => new THREE.Color(hex);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      uDepth: { value: island.depthTexture },
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
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(460, 96), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(island.center[0], WATER_LEVEL, -island.center[1]);
  mesh.name = 'water';
  return {
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
    update(dt) {
      mat.uniforms.uTime.value += dt;
    },
  };
}
