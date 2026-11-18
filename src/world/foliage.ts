// 叶片类物件共用的材质与几何：叶片卡片材质（双面、法线不翻、可随风摆）、卡片团成的灌木、十字交叉的草丛。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from './noise';

/** 叶片 / 草叶材质：双面，背面不翻法线（整团朝外），可选随风摆 */
export function foliageMaterial(map: THREE.Texture, time: { value: number } | null, sway = 0): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    if (!time) return;
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
{
  vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  float h = max(position.y, 0.0);
  float w = sin(uTime * 1.6 + ip.x * 0.8 + ip.y * 0.5) + 0.4 * sin(uTime * 3.1 + ip.x * 2.3);
  transformed.x += w * h * h * ${sway.toFixed(3)};
  transformed.z += w * h * h * ${(sway * 0.6).toFixed(3)};
}`,
    );
  };
  m.customProgramCacheKey = () => `foliage-${time ? sway : 'static'}`;
  return m;
}

/** 一团灌木：n 张卡片分布在椭球面上，法线 = 从中心指向外 */
export function bushGeometry(seed: number, n: number, card = 0.42, radius = 0.32): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const g = new THREE.PlaneGeometry(card, card);
    const u = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(1 - u * u);
    v.set(Math.cos(a) * rad, Math.abs(u) * 0.85 + 0.05, Math.sin(a) * rad).multiplyScalar(radius + r() * radius * 0.6);
    g.rotateX((r() - 0.5) * 2.4);
    g.rotateY(r() * Math.PI * 2);
    g.translate(v.x, v.y, v.z);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const c = new THREE.Vector3(0, 0.12, 0);
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).sub(c).normalize();
      nor.setXYZ(k, v.x, v.y, v.z);
    }
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}

/** 十字交叉的草丛卡片（底边在原点） */
export function tuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(0.5, 0.36);
    g.translate(0, 0.18, 0);
    g.rotateY((i / 3) * Math.PI);
    // 法线朝上偏一点：草丛整体像一块受光的草地，而不是一张张竖着的纸
    const nor = g.getAttribute('normal');
    for (let k = 0; k < nor.count; k++) {
      const n = new THREE.Vector3().fromBufferAttribute(nor, k).multiplyScalar(0.35).add(new THREE.Vector3(0, 1, 0)).normalize();
      nor.setXYZ(k, n.x, n.y, n.z);
    }
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}

