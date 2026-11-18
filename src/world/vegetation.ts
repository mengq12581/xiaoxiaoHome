// 岛上的植被与小物件（写实版）：树、灌木、草丛、花、芦苇、石头、木码头和码头灯。
//   - 树：枝干 + 叶片卡片（trees.ts），挡住她或房间时变成稀疏网点；
//   - 灌木：几十张叶片卡片围成一团，法线整团朝外（远看是柔和的体块，近看是叶子）；
//   - 草丛：十字交叉的草叶卡片，随风轻摆；只种在草地上，不压小路、沙滩、房子；
//   - 石头：噪声扰动过的多面体 + 岩石贴图；码头：木纹贴图。
// 同类物件都用实例化绘制。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec2 } from '../config/types';
import { P } from '../scene/house';
import type { Island } from './island';
import { WATER_LEVEL } from './island';
import { fbm, rng } from './noise';
import { PALETTE } from './palette';
import { grassCard, leafCard, rockMaps, woodMaps } from './textures';
import { buildTrees, type TreeSpot, type Trees } from './trees';

export interface Practical {
  /** 世界坐标 */
  position: THREE.Vector3;
  color: string;
  intensity: number;
  distance: number;
}

export interface Vegetation {
  group: THREE.Group;
  trees: Trees;
  /** 夜里要点亮的灯（码头灯等） */
  practicals: Practical[];
  /** 夜里发光的灯罩 */
  emissive: THREE.MeshStandardMaterial[];
  /** 风、树的遮挡淡出 */
  update(dt: number, camera: THREE.Camera, targets: THREE.Vector3[]): void;
}

/** 叶片 / 草叶材质：双面，背面不翻法线（整团朝外），可选随风摆 */
function foliageMaterial(map: THREE.Texture, time: { value: number } | null, sway = 0): THREE.MeshStandardMaterial {
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
function bushGeometry(seed: number, n: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const g = new THREE.PlaneGeometry(0.42, 0.42);
    const u = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(1 - u * u);
    v.set(Math.cos(a) * rad, Math.abs(u) * 0.85 + 0.05, Math.sin(a) * rad).multiplyScalar(0.32 + r() * 0.2);
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
function tuftGeometry(): THREE.BufferGeometry {
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

/** 石头：多面体 + 噪声起伏 */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 3);
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm(v.x * 2.2 + seed, v.y * 2.2 + v.z * 1.7, 4, seed);
    v.multiplyScalar(0.78 + n * 0.45);
    if (v.y < -0.1) v.y = -0.1 + (v.y + 0.1) * 0.3; // 底部压平，像埋在土里
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function buildVegetation(island: Island, house: { x0: number; y0: number; x1: number; y1: number }): Vegetation {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const r = rng(2026);
  const time = { value: 0 };
  const ground = (p: Vec2) => island.height(p);

  // 摆放规则：在岛上、离岸至少 minShore、离房子 houseGap 以外、不压小路
  const ok = (p: Vec2, minShore: number, houseGap: number, pathGap: number) =>
    island.shore(p) > minShore && !island.nearHouse(p, houseGap) && island.pathDist(p) > pathGap;
  const scatter = (count: number, test: (p: Vec2) => boolean, spacing = 1.6, tries = 4000, taken: Vec2[] = []): Vec2[] => {
    const out: Vec2[] = [];
    const e = island.extent;
    for (let i = 0; i < tries && out.length < count; i++) {
      const p: Vec2 = [e.x0 + r() * (e.x1 - e.x0), e.y0 + r() * (e.y1 - e.y0)];
      if (test(p) && [...out, ...taken].every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > spacing)) out.push(p);
    }
    return out;
  };

  // ───────── 树 ─────────
  // 树挡住视线时会自己变透明，所以可以种得离房子近一些、也可以种在南面；树冠半径约 2.4 米，离墙至少 2.8 米免得插进屋顶
  const spots: TreeSpot[] = [];
  const add = (p: Vec2, scale: number, kind: TreeSpot['kind']) => spots.push({ p, scale, kind, variant: spots.length % 3, ground: ground(p) });
  add([house.x0 + 1.2, house.y1 + 4.6], 1.2, 'green'); // 屋后土坡上一棵大树，打破地平线
  add([house.x1 - 1.8, house.y1 + 3.3], 0.78, 'blossom'); // 书房窗外一棵花树
  const placed: Vec2[] = spots.map((s) => s.p);
  for (const p of scatter(6, (p) => ok(p, 2.0, 3.0, 1.6), 4.6, 6000, placed)) {
    add(p, 0.7 + r() * 0.35, r() < 0.15 ? 'blossom' : 'green');
    placed.push(p);
  }
  const trees = buildTrees(spots);
  group.add(trees.group);

  // ───────── 灌木（沿房子墙根，避开门和阳台；草地上零星几丛） ─────────
  const bushLeaf = foliageMaterial(leafCard('bush', [96, 132, 64], 11).map, null);
  const bushGeos = [bushGeometry(1, 34), bushGeometry(2, 30)];
  const bushSpots: Vec2[] = [];
  const doorGap = (p: Vec2) => island.pathDist(p) > 1.0;
  for (let x = house.x0 + 0.6; x < 8.6; x += 1.7 + r() * 0.9) {
    bushSpots.push([x, house.y0 - 0.5 - r() * 0.2]);
    bushSpots.push([x + 0.4, house.y1 + 0.55 + r() * 0.25]);
  }
  for (let y = house.y0 + 0.6; y < house.y1; y += 1.8 + r() * 0.6) bushSpots.push([house.x0 - 0.55 - r() * 0.2, y]);
  for (const p of scatter(6, (p) => ok(p, 1.2, 1.6, 1.0), 2.0, 6000)) bushSpots.push(p);
  const bushes = bushSpots.filter(doorGap);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  bushGeos.forEach((geo, gi) => {
    const list = bushes.filter((_, i) => i % 2 === gi);
    const mesh = new THREE.InstancedMesh(geo, bushLeaf, list.length);
    list.forEach((p, i) => {
      const s = 0.75 + r() * 0.5;
      m4.compose(P(p[0], ground(p) - 0.04, p[1]), q.setFromAxisAngle(Y, r() * 6.28), new THREE.Vector3(s, s * (0.8 + r() * 0.3), s));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col.setHSL(0.2 + (r() - 0.5) * 0.06, 0.1 + r() * 0.15, 0.75 + r() * 0.2));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `bushes-${gi}`;
    group.add(mesh);
  });

  // ───────── 草丛：草地上密密的一层（离房子、小路、沙滩都留一点边） ─────────
  const tufts: Vec2[] = [];
  {
    const e = island.extent;
    for (let i = 0; i < 26000 && tufts.length < 2600; i++) {
      const p: Vec2 = [e.x0 + r() * (e.x1 - e.x0), e.y0 + r() * (e.y1 - e.y0)];
      const d = island.shore(p);
      if (d < 1.5 || island.nearHouse(p, 0.25) || island.pathDist(p) < 0.62) continue;
      // 按低频噪声成片分布：有的地方密，有的地方只有短草
      if (fbm(p[0] * 0.35, p[1] * 0.35, 2, 13) < 0.42 + r() * 0.15) continue;
      tufts.push(p);
    }
  }
  const tuftMesh = new THREE.InstancedMesh(tuftGeometry(), foliageMaterial(grassCard(), time, 0.35), tufts.length);
  tufts.forEach((p, i) => {
    const s = 0.55 + r() * 0.7;
    m4.compose(P(p[0], ground(p) - 0.02, p[1]), q.setFromAxisAngle(Y, r() * 6.28), new THREE.Vector3(s, s * (0.7 + r() * 0.6), s));
    tuftMesh.setMatrixAt(i, m4);
    tuftMesh.setColorAt(i, col.setHSL(0.18 + (r() - 0.5) * 0.05, 0.15 + r() * 0.2, 0.78 + r() * 0.2));
  });
  tuftMesh.receiveShadow = true;
  tuftMesh.name = 'grass-tufts';
  group.add(tuftMesh);

  // ───────── 花：灌木旁边和小路两侧一小撮一小撮 ─────────
  const flowerGeo = new THREE.IcosahedronGeometry(0.035, 1);
  const flowerSpots: { p: Vec2; c: string }[] = [];
  for (const b of bushes) {
    if (r() < 0.4) continue;
    const c = PALETTE.flowers[Math.floor(r() * PALETTE.flowers.length)];
    for (let k = 0; k < 9; k++) flowerSpots.push({ p: [b[0] + (r() - 0.5) * 0.9, b[1] + (r() - 0.5) * 0.5], c });
  }
  for (const p of scatter(18, (p) => island.shore(p) > 1 && island.pathDist(p) > 0.7 && island.pathDist(p) < 1.6 && !island.nearHouse(p, 0.8), 1.2, 6000)) {
    const c = PALETTE.flowers[Math.floor(r() * PALETTE.flowers.length)];
    for (let k = 0; k < 8; k++) flowerSpots.push({ p: [p[0] + (r() - 0.5) * 0.55, p[1] + (r() - 0.5) * 0.55], c });
  }
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), flowerSpots.length);
  flowerSpots.forEach((f, i) => {
    m4.compose(P(f.p[0], ground(f.p) + 0.14 + r() * 0.14, f.p[1]), q.identity(), new THREE.Vector3(1, 0.7, 1).multiplyScalar(0.8 + r() * 0.6));
    flowers.setMatrixAt(i, m4);
    flowers.setColorAt(i, col.set(f.c));
  });
  flowers.name = 'flowers';
  group.add(flowers);

  // ───────── 芦苇（水边） ─────────
  const reedGeo = new THREE.ConeGeometry(0.012, 1, 3);
  reedGeo.translate(0, 0.5, 0);
  const reedSpots: Vec2[] = [];
  for (const c of scatter(16, (p) => island.shore(p) > -0.7 && island.shore(p) < 0.2 && island.pathDist(p) > 3, 1.6, 8000)) {
    for (let k = 0; k < 16; k++) reedSpots.push([c[0] + (r() - 0.5) * 0.8, c[1] + (r() - 0.5) * 0.8]);
  }
  const reeds = new THREE.InstancedMesh(reedGeo, new THREE.MeshStandardMaterial({ color: PALETTE.foliage.reed, roughness: 0.9 }), reedSpots.length);
  reedSpots.forEach((p, i) => {
    const hgt = 0.6 + r() * 0.7;
    q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3));
    m4.compose(P(p[0], Math.max(ground(p), WATER_LEVEL - 0.2), p[1]), q, new THREE.Vector3(1, hgt, 1));
    reeds.setMatrixAt(i, m4);
    reeds.setColorAt(i, col.set(PALETTE.foliage.reed).offsetHSL(0, 0, (r() - 0.5) * 0.12));
  });
  reeds.name = 'reeds';
  group.add(reeds);

  // ───────── 石头 ─────────
  const rm = rockMaps();
  const rockMat = new THREE.MeshStandardMaterial({ map: rm.map, normalMap: rm.normalMap, roughness: 0.9, color: '#c9c2b8' });
  const rockSpots = [
    ...scatter(12, (p) => island.shore(p) > -0.5 && island.shore(p) < 0.9 && island.pathDist(p) > 1.5, 1.6, 8000),
    ...scatter(4, (p) => Math.hypot(p[0] - house.x0 - 1.4, p[1] - house.y1 - 3.4) < 2.6 && Math.hypot(p[0] - house.x0 - 1.4, p[1] - house.y1 - 3.4) > 1.2, 1.0, 4000),
  ];
  const rockGeos = [rockGeometry(3), rockGeometry(8)];
  rockGeos.forEach((geo, gi) => {
    const list = rockSpots.filter((_, i) => i % 2 === gi);
    const rocks = new THREE.InstancedMesh(geo, rockMat, list.length);
    list.forEach((p, i) => {
      const s = 0.25 + r() * 0.5;
      q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, r() * 6, (r() - 0.5) * 0.4));
      m4.compose(P(p[0], ground(p) + s * 0.05, p[1]), q, new THREE.Vector3(s * 1.3, s * 0.75, s));
      rocks.setMatrixAt(i, m4);
      rocks.setColorAt(i, col.set(r() < 0.5 ? '#ffffff' : '#d8d2ca'));
    });
    rocks.castShadow = rocks.receiveShadow = true;
    rocks.name = `rocks-${gi}`;
    group.add(rocks);
  });

  // ───────── 木码头与码头灯 ─────────
  const practicals: Practical[] = [];
  const emissive: THREE.MeshStandardMaterial[] = [];
  const wm = woodMaps();
  const wood = new THREE.MeshStandardMaterial({ map: wm.map, normalMap: wm.normalMap, color: '#b89a7c', roughness: 0.8 });
  const woodDark = new THREE.MeshStandardMaterial({ map: wm.map, normalMap: wm.normalMap, color: '#86705c', roughness: 0.85 });
  const pier = new THREE.Group();
  pier.name = 'pier';
  const { start, dir } = island.pier;
  const len = 5.2;
  const width = 1.3;
  const deckY = WATER_LEVEL + 0.28;
  const heading = Math.atan2(dir[1], dir[0]);
  const plankW = 0.2;
  for (let s = -0.8; s < len; s += plankW + 0.025) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(plankW, 0.05, width), wood);
    plank.position.set(s + plankW / 2, deckY + (r() - 0.5) * 0.008, 0);
    plank.rotation.y = (r() - 0.5) * 0.02;
    plank.castShadow = plank.receiveShadow = true;
    pier.add(plank);
  }
  for (let s = 0; s <= len; s += 1.7) {
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 1.4, 10), woodDark);
      post.position.set(s, deckY - 0.5, side * (width / 2 - 0.05));
      post.castShadow = true;
      pier.add(post);
    }
  }
  // 码头尽头的灯柱
  const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 1.25, 10), woodDark);
  lampPost.position.set(len - 0.2, deckY + 0.62, width / 2 - 0.12);
  const shadeMat = new THREE.MeshStandardMaterial({ color: '#fff3dc', roughness: 0.6, emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0 });
  emissive.push(shadeMat);
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.24, 0.18), shadeMat);
  lantern.position.set(len - 0.2, deckY + 1.32, width / 2 - 0.12);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.12, 4), woodDark);
  cap.position.set(len - 0.2, deckY + 1.5, width / 2 - 0.12);
  cap.rotation.y = Math.PI / 4;
  pier.add(lampPost, lantern, cap);
  pier.position.copy(P(start[0], 0, start[1]));
  pier.rotation.y = heading;
  group.add(pier);
  pier.updateMatrixWorld(true);
  practicals.push({ position: lantern.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -0.05, 0)), color: PALETTE.lamp, intensity: 6, distance: 7 });

  return {
    group,
    trees,
    practicals,
    emissive,
    update(dt, camera, targets) {
      time.value += dt;
      trees.update(dt, camera, targets);
    },
  };
}
