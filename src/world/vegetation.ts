// 岛上的植被与小物件（写实版）：树、灌木、草丛、花、芦苇、石头、木码头和码头灯。
//   - 树：枝干 + 叶片卡片（trees.ts），挡住她或房间时变成稀疏网点；
//   - 灌木：几十张叶片卡片围成一团，法线整团朝外（远看是柔和的体块，近看是叶子）；
//   - 草丛：十字交叉的草叶卡片，随风轻摆；只种在草地上，不压小路、沙滩、房子；
//   - 石头：噪声扰动过的多面体 + 岩石贴图；码头：木纹贴图。
// 同类物件都用实例化绘制。

import * as THREE from 'three';
import type { Vec2 } from '../config/types';
import { P } from '../scene/house';
import type { Island } from './island';
import { WATER_LEVEL } from './island';
import { fbm, rng } from './noise';
import { PALETTE } from './palette';
import { grassCard, leafCard, rockMaps, woodMaps } from './textures';
import { buildTrees, type TreeSpot, type Trees } from './trees';
import { bushGeometry, foliageMaterial, tuftGeometry } from './foliage';
import { buildGarden } from './garden';

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

export function buildVegetation(island: Island, house: { x0: number; y0: number; x1: number; y1: number }, indoorX1 = house.x1): Vegetation {
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
  // 树挡住视线时会自己变透明，所以可以种得离房子近一些、也可以种在南面；树冠不能插进屋檐（离墙至少 2.6～3 米）
  const spots: TreeSpot[] = [];
  const add = (p: Vec2, scale: number, kind: TreeSpot['kind']) => spots.push({ p, scale, kind, variant: spots.length, ground: ground(p) });
  // 樱花（参考图：门边一棵铺开的大樱花，南墙前一棵小的）与开白花的小树
  add([house.x0 - 2.7, house.y0 - 2.3], 1.0, 'sakura');
  add([indoorX1 - 2.6, house.y0 - 3.3], 0.72, 'sakura');
  add([house.x0 - 3.0, house.y1 + 0.2], 0.8, 'sakura');
  add([house.x0 + 3.0, house.y0 - 2.4], 0.62, 'sapling');
  add([house.x1 + 1.3, house.y0 - 1.6], 0.55, 'sapling');
  add([house.x0 - 2.2, house.y1 - 1.5], 0.5, 'sapling');
  add([house.x0 + 1.2, house.y1 + 4.6], 1.2, 'green'); // 屋后土坡上一棵大树，打破地平线
  const placed: Vec2[] = spots.map((s) => s.p);
  // 绿叶大树只种在房子北面和东西两侧靠后，把南面、门前留给樱花和花草
  for (const p of scatter(5, (p) => ok(p, 2.0, 3.0, 1.6) && p[1] > house.y0 + 2.5, 4.6, 6000, placed)) {
    add(p, 0.7 + r() * 0.35, 'green');
    placed.push(p);
  }
  const trees = buildTrees(spots);
  group.add(trees.group);

  // 樱花树下落了一地花瓣（树冠范围内，越靠近树干越密）
  const petals: { p: Vec2; a: number }[] = [];
  for (const t of spots.filter((s) => s.kind === 'sakura')) {
    const R = 2.3 * t.scale;
    for (let k = 0; k < 220 * t.scale; k++) {
      const a = r() * Math.PI * 2;
      const d = R * Math.sqrt(r()) * (0.4 + 0.6 * r());
      const p: Vec2 = [t.p[0] + Math.cos(a) * d, t.p[1] + Math.sin(a) * d];
      if (island.shore(p) < 0.3 || island.nearHouse(p, 0.05)) continue;
      petals.push({ p, a: r() * 6.28 });
    }
  }
  const petalGeo = new THREE.CircleGeometry(0.016, 5);
  petalGeo.scale(1, 0.7, 1);
  petalGeo.rotateX(-Math.PI / 2);
  const petalMesh = new THREE.InstancedMesh(petalGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, side: THREE.DoubleSide }), petals.length);
  {
    const pm = new THREE.Matrix4();
    const pq = new THREE.Quaternion();
    const pc = new THREE.Color();
    petals.forEach((pt, i) => {
      pq.setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, pt.a, (r() - 0.5) * 0.5));
      pm.compose(P(pt.p[0], ground(pt.p) + 0.035, pt.p[1]), pq, new THREE.Vector3(1, 1, 1).multiplyScalar(0.8 + r() * 0.5));
      petalMesh.setMatrixAt(i, pm);
      petalMesh.setColorAt(i, pc.setHSL(0.95, 0.45 + r() * 0.3, 0.88 + r() * 0.08));
    });
  }
  petalMesh.receiveShadow = true;
  petalMesh.name = 'fallen-petals';
  group.add(petalMesh);

  // ───────── 灌木（沿房子墙根，避开门和阳台；草地上零星几丛） ─────────
  const bushLeaf = foliageMaterial(leafCard('bush', [96, 132, 64], 11).map, null);
  const bushGeos = [bushGeometry(1, 34), bushGeometry(2, 30)];
  const bushSpots: Vec2[] = [];
  const doorGap = (p: Vec2) => island.pathDist(p) > 1.0;
  // 南墙、西墙根是绣球（garden.ts）；北墙根和草地上零星几丛普通灌木
  for (let x = house.x0 + 0.6; x < indoorX1 - 0.3; x += 1.7 + r() * 0.9) bushSpots.push([x + 0.4, house.y1 + 0.55 + r() * 0.25]);
  for (const p of scatter(5, (p) => ok(p, 1.2, 1.6, 1.0) && p[1] > house.y0, 2.0, 6000)) bushSpots.push(p);
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

  // ───────── 房边庭院：绣球、竹子、蒲苇、雏菊、踏步石、石灯笼 ─────────
  const garden = buildGarden(island, house, indoorX1);
  group.add(garden.group);

  // ───────── 草丛：草地上密密的一层（离房子、小路、沙滩、庭院植物都留一点边） ─────────
  const tufts: Vec2[] = [];
  {
    const e = island.extent;
    for (let i = 0; i < 50000 && tufts.length < 5600; i++) {
      const p: Vec2 = [e.x0 + r() * (e.x1 - e.x0), e.y0 + r() * (e.y1 - e.y0)];
      const d = island.shore(p);
      if (d < 1.5 || island.nearHouse(p, 0.25) || island.pathDist(p) < 0.62) continue;
      if (garden.occupied.some((o) => Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) < o.r)) continue;
      // 按低频噪声略有疏密（只剔掉少数地方），整体是一片连着的草地，不是一块块草团
      if (fbm(p[0] * 0.35, p[1] * 0.35, 2, 13) < 0.3 + r() * 0.12) continue;
      tufts.push(p);
    }
  }
  const tuftMesh = new THREE.InstancedMesh(tuftGeometry(), foliageMaterial(grassCard(), time, 0.35), tufts.length);
  tufts.forEach((p, i) => {
    // 草丛小而密，颜色贴近地面：远看是一片草地，不是一块块深色的草团
    const s = 0.42 + r() * 0.5;
    m4.compose(P(p[0], ground(p) - 0.02, p[1]), q.setFromAxisAngle(Y, r() * 6.28), new THREE.Vector3(s, s * (0.7 + r() * 0.6), s));
    tuftMesh.setMatrixAt(i, m4);
    tuftMesh.setColorAt(i, col.setHSL(0.17 + (r() - 0.5) * 0.05, 0.12 + r() * 0.18, 0.86 + r() * 0.14));
  });
  tuftMesh.receiveShadow = true;
  tuftMesh.name = 'grass-tufts';
  group.add(tuftMesh);

  // ───────── 野花：灌木旁边和小路两侧一小撮一小撮（朝上开的五瓣小花，不是小圆球） ─────────
  const flowerShape = new THREE.Shape();
  for (let k = 0; k <= 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    const rad = 0.035 * (0.55 + 0.45 * Math.abs(Math.cos(a * 2.5)));
    if (k === 0) flowerShape.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
    else flowerShape.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  const flowerGeo = new THREE.ShapeGeometry(flowerShape);
  flowerGeo.rotateX(-Math.PI / 2);
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
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }), flowerSpots.length);
  flowerSpots.forEach((f, i) => {
    m4.compose(P(f.p[0], ground(f.p) + 0.1 + r() * 0.12, f.p[1]), q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.6, r() * 6.28, (r() - 0.5) * 0.6)), new THREE.Vector3(1, 1, 1).multiplyScalar(0.7 + r() * 0.6));
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
    emissive: [...emissive, ...garden.emissive],
    update(dt, camera, targets) {
      time.value += dt;
      garden.update(dt);
      trees.update(dt, camera, targets);
    },
  };
}
