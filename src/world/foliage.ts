// 叶片类物件共用的材质与几何：叶片卡片材质（双面、法线不翻、可随风摆）、卡片团成的灌木、十字交叉的草丛、
// 真实几何的拱形长叶丛（芒草）、由小花片拼成的球形花头（绣球）。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from './noise';

/**
 * 叶片 / 草叶材质：双面，背面不翻法线（整团朝外），可选随风摆。
 * map 为 null 时不做透明裁切、改用顶点色（真实几何的叶片）。
 */
export function foliageMaterial(map: THREE.Texture | null, time: { value: number } | null, sway = 0, alphaTest = 0.5): THREE.MeshStandardMaterial {
  const m = map
    ? new THREE.MeshStandardMaterial({ map, alphaTest, side: THREE.DoubleSide, roughness: 0.85 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
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
  m.customProgramCacheKey = () => `foliage-${time ? sway : 'static'}-${map ? 'card' : 'mesh'}`;
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


/**
 * 拱形长叶丛（芒草的叶子）：n 片真实几何的细长叶，从中心向四周拱出、叶尖下垂。
 * 顶点色：叶基深绿，往上变成灰绿，叶尖偏枯黄。高度约 height 米。
 */
export function fountainGeometry(seed: number, n: number, height: number): THREE.BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const SEG = 6;
  const base = new THREE.Color('#4f6236');
  const mid = new THREE.Color('#8a9566');
  const tip = new THREE.Color('#c9c08f');
  const c = new THREE.Color();
  for (let b = 0; b < n; b++) {
    const a = r() * Math.PI * 2;
    const len = height * (0.75 + r() * 0.5);
    const reach = len * (0.25 + r() * 0.45); // 越往外拱的叶子越低
    const w0 = 0.014 + r() * 0.008;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const ox = (r() - 0.5) * 0.08;
    const oz = (r() - 0.5) * 0.08;
    const start = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const out = reach * t * t;
      const up = len * (t - 0.5 * t * t * (reach / len) * 1.6);
      const w = w0 * (1 - t * 0.9);
      const cx = ox + dir.x * out;
      const cz = oz + dir.z * out;
      for (const sgn of [-1, 1]) {
        pos.push(cx + side.x * w * sgn, Math.max(0, up), cz + side.z * w * sgn);
        // 法线朝上偏外：一丛叶子受光柔和
        const nn = new THREE.Vector3(dir.x * 0.4, 1, dir.z * 0.4).normalize();
        nor.push(nn.x, nn.y, nn.z);
        if (t < 0.5) c.copy(base).lerp(mid, t * 2);
        else c.copy(mid).lerp(tip, (t - 0.5) * 2);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < SEG; i++) {
      const k = start + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/**
 * 球形花头（绣球）：一个半球面上铺 n 张小花片（四瓣小花贴图），每片朝外、略带随机倾斜；
 * 法线一律从球心朝外，整团受光像一个蓬松的花球。半径约 radius 米，底面在原点。
 */
export function floretHeadGeometry(seed: number, n: number, radius: number, floret: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  const center = new THREE.Vector3(0, radius * 0.35, 0);
  for (let i = 0; i < n; i++) {
    // 斐波那契球面分布，只取上面约 70%
    const t = (i + 0.5) / n;
    const y = 1 - t * 1.4;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963 + r() * 0.3;
    v.set(Math.cos(phi) * rad, y, Math.sin(phi) * rad);
    const g = new THREE.PlaneGeometry(floret, floret);
    g.rotateZ(r() * Math.PI * 2);
    g.lookAt(v);
    const at = v.clone().multiplyScalar(radius * (0.92 + r() * 0.12)).add(center);
    g.translate(at.x, at.y, at.z);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).sub(center).normalize();
      nor.setXYZ(k, v.x, v.y, v.z);
    }
    parts.push(g);
  }
  return mergeGeometries(parts)!;
}
