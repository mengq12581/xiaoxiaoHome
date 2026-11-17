// 岛上的植被与小物件：树、灌木、花丛、芦苇、石头、木码头和码头灯。
// 造型原则（docs/art/美术方向.md「屋外」一节）：
//   - 树冠是几团圆球捏在一起的「一整块」，法线按树冠整体朝外，读起来是体块而不是一片片叶子；
//   - 树冠用 4 档明度的卡通着色（像手绘的几块色面），树干、石头、码头仍是柔和的 PBR；
//   - 默认视角从西南方看过来：房子南面只放矮的花草，高树放在北面和东西两侧，不挡屋里；
//   - 同类物件用实例化绘制，每棵大小、朝向、颜色略有差异。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec2 } from '../config/types';
import { P } from '../scene/house';
import type { Island } from './island';
import { WATER_LEVEL } from './island';
import { rng } from './noise';
import { PALETTE } from './palette';

/** 4 档明度的渐变贴图：卡通着色用 */
function toonRamp(): THREE.DataTexture {
  const v = [128, 172, 214, 255]; // 最暗一档不低于 0.5：手绘日光的阴影是带颜色的，不发黑
  const data = new Uint8Array(v.length * 4);
  v.forEach((x, i) => data.set([x, x, x, 255], i * 4));
  const t = new THREE.DataTexture(data, v.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** 树冠：几团球捏成一块，法线按整体朝外 */
function crownGeometry(seed: number, lobes: number, spreadX: number, spreadY: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lobes; i++) {
    const g = new THREE.IcosahedronGeometry(0.55 + r() * 0.35, 2);
    const a = (i / lobes) * Math.PI * 2 + r();
    const rad = i === 0 ? 0 : 0.45 + r() * 0.25;
    g.translate(Math.cos(a) * rad * spreadX, (i === 0 ? 0.25 : r() * 0.5 - 0.1) * spreadY, Math.sin(a) * rad * spreadX);
    parts.push(g);
  }
  const geo = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
  geo.computeVertexNormals();
  // 整体朝外的法线：与各自的球面法线混合，交界处不起棱
  geo.computeBoundingBox();
  const c = geo.boundingBox!.getCenter(new THREE.Vector3());
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(c).normalize();
    n.fromBufferAttribute(nor, i).lerp(v, 0.75).normalize();
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return geo;
}

export interface Practical {
  /** 世界坐标 */
  position: THREE.Vector3;
  color: string;
  intensity: number;
  distance: number;
}

export interface Vegetation {
  group: THREE.Group;
  /** 夜里要点亮的灯（码头灯等） */
  practicals: Practical[];
  /** 夜里发光的灯罩 */
  emissive: THREE.MeshStandardMaterial[];
}

interface TreeKind {
  name: string;
  crown: THREE.BufferGeometry;
  crownColor: string;
  trunkHeight: number;
  crownLift: number;
}

export function buildVegetation(island: Island, house: { x0: number; y0: number; x1: number; y1: number }): Vegetation {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const r = rng(2026);
  const ramp = toonRamp();
  const foliageMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp });
  // 花树单独一档更亮的渐变：粉色在背光面不能发紫
  const blossomMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: (() => { const t = toonRamp(); t.image.data.set([170, 170, 170, 255, 200, 200, 200, 255, 228, 228, 228, 255, 255, 255, 255, 255]); t.needsUpdate = true; return t; })() });
  const trunkMat = new THREE.MeshStandardMaterial({ color: PALETTE.foliage.trunk, roughness: 0.9 });
  const ground = (p: Vec2) => island.height(p);

  // 摆放规则：在岛上、离岸至少 minShore、离房子 houseGap 以外、不压小路
  const ok = (p: Vec2, minShore: number, houseGap: number, pathGap: number) =>
    island.shore(p) > minShore && !island.nearHouse(p, houseGap) && island.pathDist(p) > pathGap;
  const scatter = (count: number, test: (p: Vec2) => boolean, tries = 4000): Vec2[] => {
    const out: Vec2[] = [];
    const e = island.extent;
    for (let i = 0; i < tries && out.length < count; i++) {
      const p: Vec2 = [e.x0 + r() * (e.x1 - e.x0), e.y0 + r() * (e.y1 - e.y0)];
      if (test(p) && out.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 1.6)) out.push(p);
    }
    return out;
  };
  // 房子南面（默认视角朝向）只放矮的
  const southOfHouse = (p: Vec2) => p[1] < house.y0 + 0.5;

  // ───────── 树 ─────────
  const kinds: TreeKind[] = [
    { name: 'round', crown: crownGeometry(1, 5, 1.0, 1.0), crownColor: PALETTE.foliage.mid, trunkHeight: 1.6, crownLift: 0.6 },
    { name: 'tall', crown: crownGeometry(2, 4, 0.7, 1.7), crownColor: PALETTE.foliage.lit, trunkHeight: 1.9, crownLift: 1.0 },
    { name: 'blossom', crown: crownGeometry(3, 5, 1.05, 0.9), crownColor: PALETTE.foliage.blossom, trunkHeight: 1.4, crownLift: 0.55 },
  ];
  const trees: { kind: number; p: Vec2; s: number }[] = [];
  // 屋后土坡上一棵大树（打破地平线），卧室窗外一棵花树
  trees.push({ kind: 0, p: [house.x0 + 1.2, house.y1 + 4.6], s: 1.75 });
  trees.push({ kind: 2, p: [house.x1 - 2.2, house.y1 + 3.4], s: 1.1 });
  // 高树离房子至少 4.5 米（拉近看屋里时不挡视线）；房子南面（默认视角一侧）不种高树
  for (const p of scatter(16, (p) => ok(p, 1.6, 3.4, 1.4) && !southOfHouse(p))) trees.push({ kind: r() < 0.55 ? 0 : 1, p, s: 0.75 + r() * 0.5 });
  // 南面草地上只放一两棵小树，离房子远一些
  for (const p of scatter(2, (p) => ok(p, 1.5, 4.2, 1.6) && southOfHouse(p))) trees.push({ kind: 1, p, s: 0.6 + r() * 0.15 });

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  kinds.forEach((k, ki) => {
    const list = trees.filter((t) => t.kind === ki);
    if (list.length === 0) return;
    const crowns = new THREE.InstancedMesh(k.crown, k.name === 'blossom' ? blossomMat : foliageMat, list.length);
    const trunkGeo = new THREE.CylinderGeometry(0.09, 0.16, 1, 8);
    trunkGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    list.forEach((t, i) => {
      const y = ground(t.p);
      const base = P(t.p[0], y - 0.05, t.p[1]);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
      const sx = t.s * (0.92 + r() * 0.16);
      m4.compose(base, q, new THREE.Vector3(sx, t.s * k.trunkHeight, sx));
      trunks.setMatrixAt(i, m4);
      const top = base.clone().add(new THREE.Vector3(0, t.s * (k.trunkHeight + k.crownLift), 0));
      m4.compose(top, q, new THREE.Vector3(t.s * 1.1, t.s * (1.0 + r() * 0.12), t.s * 1.1));
      crowns.setMatrixAt(i, m4);
      col.set(k.crownColor).offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.08, (r() - 0.5) * 0.06);
      crowns.setColorAt(i, col);
    });
    crowns.castShadow = trunks.castShadow = true;
    // 花树不接受投影：粉色压在影子里会发紫
    crowns.receiveShadow = k.name !== 'blossom';
    crowns.name = `trees-${k.name}`;
    group.add(crowns, trunks);
  });

  // ───────── 灌木（沿房子墙根，避开门和阳台）与花丛 ─────────
  const bushGeo = crownGeometry(9, 3, 0.8, 0.6);
  const bushSpots: Vec2[] = [];
  const doorGap = (p: Vec2) => island.pathDist(p) > 1.0;
  for (let x = house.x0 + 0.6; x < 8.6; x += 1.15 + r() * 0.6) {
    bushSpots.push([x, house.y0 - 0.55 - r() * 0.25]);
    bushSpots.push([x + 0.4, house.y1 + 0.6 + r() * 0.3]);
  }
  for (let y = house.y0 + 0.6; y < house.y1; y += 1.3 + r() * 0.5) bushSpots.push([house.x0 - 0.6 - r() * 0.2, y]);
  // 草地上零星几丛矮灌木
  for (const p of scatter(10, (p) => ok(p, 1.2, 1.6, 1.0), 6000)) bushSpots.push(p);
  const bushes = bushSpots.filter(doorGap);
  const bushMesh = new THREE.InstancedMesh(bushGeo, foliageMat, bushes.length);
  bushes.forEach((p, i) => {
    const s = 0.42 + r() * 0.2;
    m4.compose(P(p[0], ground(p) + s * 0.25, p[1]), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(s, s * 0.85, s));
    bushMesh.setMatrixAt(i, m4);
    bushMesh.setColorAt(i, col.set(r() < 0.5 ? PALETTE.foliage.mid : PALETTE.foliage.shade).offsetHSL(0, 0, (r() - 0.5) * 0.06));
  });
  bushMesh.castShadow = true;
  bushMesh.name = 'bushes';
  group.add(bushMesh);

  // 花：灌木旁边和小路两侧一小撮一小撮
  const flowerGeo = new THREE.IcosahedronGeometry(0.06, 1);
  const flowerSpots: { p: Vec2; c: string }[] = [];
  for (const b of bushes) {
    const c = PALETTE.flowers[Math.floor(r() * PALETTE.flowers.length)];
    for (let k = 0; k < 7; k++) flowerSpots.push({ p: [b[0] + (r() - 0.5) * 0.9, b[1] + (r() - 0.5) * 0.5], c });
  }
  for (const p of scatter(16, (p) => island.shore(p) > 1 && island.pathDist(p) > 0.7 && island.pathDist(p) < 1.6 && !island.nearHouse(p, 0.8), 6000)) {
    const c = PALETTE.flowers[Math.floor(r() * PALETTE.flowers.length)];
    for (let k = 0; k < 6; k++) flowerSpots.push({ p: [p[0] + (r() - 0.5) * 0.5, p[1] + (r() - 0.5) * 0.5], c });
  }
  const flowerMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerSpots.length);
  flowerSpots.forEach((f, i) => {
    m4.compose(P(f.p[0], ground(f.p) + 0.12 + r() * 0.1, f.p[1]), q.identity(), new THREE.Vector3(1, 0.8, 1).multiplyScalar(0.8 + r() * 0.6));
    flowers.setMatrixAt(i, m4);
    flowers.setColorAt(i, col.set(f.c));
  });
  flowers.name = 'flowers';
  group.add(flowers);

  // ───────── 芦苇（水边）与石头 ─────────
  const reedGeo = new THREE.ConeGeometry(0.025, 1, 4);
  reedGeo.translate(0, 0.5, 0);
  const reedSpots: Vec2[] = [];
  for (const c of scatter(14, (p) => island.shore(p) > -0.7 && island.shore(p) < 0.2 && island.pathDist(p) > 3, 8000)) {
    for (let k = 0; k < 9; k++) reedSpots.push([c[0] + (r() - 0.5) * 0.7, c[1] + (r() - 0.5) * 0.7]);
  }
  const reeds = new THREE.InstancedMesh(reedGeo, new THREE.MeshStandardMaterial({ color: PALETTE.foliage.reed, roughness: 0.9 }), reedSpots.length);
  reedSpots.forEach((p, i) => {
    const hgt = 0.6 + r() * 0.6;
    q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.25));
    m4.compose(P(p[0], Math.max(ground(p), WATER_LEVEL - 0.2), p[1]), q, new THREE.Vector3(1, hgt, 1));
    reeds.setMatrixAt(i, m4);
  });
  reeds.name = 'reeds';
  group.add(reeds);

  const rockGeo = new THREE.DodecahedronGeometry(0.5, 1);
  const rockSpots = [
    ...scatter(10, (p) => island.shore(p) > -0.5 && island.shore(p) < 0.9 && island.pathDist(p) > 1.5, 8000),
    ...scatter(3, (p) => Math.hypot(p[0] - house.x0 - 1.4, p[1] - house.y1 - 3.4) < 2.4 && Math.hypot(p[0] - house.x0 - 1.4, p[1] - house.y1 - 3.4) > 1.2, 4000),
  ];
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), rockSpots.length);
  rockSpots.forEach((p, i) => {
    const s = 0.25 + r() * 0.45;
    q.setFromEuler(new THREE.Euler(r(), r() * 6, r()));
    m4.compose(P(p[0], ground(p) + s * 0.15, p[1]), q, new THREE.Vector3(s * 1.3, s * 0.7, s));
    rocks.setMatrixAt(i, m4);
    rocks.setColorAt(i, col.set(r() < 0.5 ? PALETTE.ground.rock : PALETTE.ground.rockDark));
  });
  rocks.castShadow = rocks.receiveShadow = true;
  rocks.name = 'rocks';
  group.add(rocks);

  // ───────── 木码头与码头灯 ─────────
  const practicals: Practical[] = [];
  const emissive: THREE.MeshStandardMaterial[] = [];
  const wood = new THREE.MeshStandardMaterial({ color: PALETTE.exterior.timber, roughness: 0.75 });
  const woodDark = new THREE.MeshStandardMaterial({ color: PALETTE.exterior.timberDark, roughness: 0.8 });
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
    plank.position.set(s + plankW / 2, deckY, 0);
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

  return { group, practicals, emissive };
}
