// 房边的庭院植物与小品（客户 2026-11-18 参考图）：
//   - 绣球：墙根一排，深绿宽叶团 + 几个白 / 浅蓝 / 蓝紫的球形花头；
//   - 竹子：门边、南墙东头、阳台外各一丛，细竿 + 上半截的竹叶，随风摆；
//   - 蒲苇（芒草）：小路边和屋角几丛，细长叶 + 羽毛状的米白花穗；
//   - 雏菊：绣球前面、小路两边成片的白色小花；
//   - 踏步石：从入户门沿小路铺到码头；石灯笼：门前小路两侧各一座、阳台外一座（夜里透出微光）。
// 樱花树和小花树在 trees.ts（作为树种），由 vegetation.ts 摆放。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec2 } from '../config/types';
import { P } from '../scene/house';
import { bushGeometry, floretHeadGeometry, foliageMaterial, fountainGeometry } from './foliage';
import type { Island } from './island';
import { rng } from './noise';
import { PALETTE } from './palette';
import { bambooCulm, bambooLeafCard, broadLeafCard, daisyCard, hydrangeaFloret, hydrangeaMaps, plasterMaps, plumeCard, rockMaps } from './textures';

export interface Garden {
  group: THREE.Group;
  /** 夜里发光的石灯笼火袋 */
  emissive: THREE.MeshStandardMaterial[];
  /** 已经种了东西的位置（草丛避开） */
  occupied: { p: Vec2; r: number }[];
  update(dt: number): void;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

export function buildGarden(island: Island, house: Box, indoorX1: number): Garden {
  const group = new THREE.Group();
  group.name = 'garden';
  const r = rng(1118);
  const time = { value: 0 };
  const ground = (p: Vec2) => island.height(p);
  const occupied: Garden['occupied'] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  const door = island.pathPoints[0];
  const nearDoor = (p: Vec2, d: number) => Math.hypot(p[0] - door[0], p[1] - door[1]) < d;
  const onPath = (p: Vec2, d: number) => island.pathDist(p) < d;

  // ───────── 绣球 ─────────
  const hydra: Vec2[] = [];
  // 南墙根（长椅前留空）
  for (let x = house.x0 + 0.45; x < indoorX1 - 0.3; x += 0.8 + r() * 0.25) {
    if (x > 4.5 && x < 6.3) continue;
    hydra.push([x, house.y0 - 0.5 - r() * 0.15]);
  }
  // 西墙根（门口和台阶留空）
  for (let y = house.y0 + 0.5; y < house.y1 - 0.3; y += 0.8 + r() * 0.25) {
    if (Math.abs(y - door[1]) < 1.0 || (y > 4.7 && y < 5.9)) continue;
    hydra.push([house.x0 - 0.5 - r() * 0.15, y]);
  }
  // 小路起点两侧
  for (const p of [[door[0] - 1.6, door[1] - 1.3], [door[0] - 1.9, door[1] + 1.0]] as Vec2[]) if (!onPath(p, 0.6)) hydra.push(p);
  const leafGeo = bushGeometry(5, 34, 0.4, 0.3);
  const hLeaves = new THREE.InstancedMesh(leafGeo, foliageMaterial(broadLeafCard(), null), hydra.length);
  const heads: { p: THREE.Vector3; s: number; c: string }[] = [];
  hydra.forEach((p, i) => {
    const s = 0.9 + r() * 0.35;
    const base = P(p[0], ground(p) - 0.03, p[1]);
    m4.compose(base, q.setFromAxisAngle(Y, r() * 6.28), new THREE.Vector3(s, s * 0.9, s));
    hLeaves.setMatrixAt(i, m4);
    hLeaves.setColorAt(i, col.setHSL(0.27 + (r() - 0.5) * 0.04, 0.2 + r() * 0.1, 0.8 + r() * 0.15));
    occupied.push({ p, r: 0.5 * s });
    // 同一棵花色接近：先挑一种，再在它附近变化
    const tone = PALETTE.hydrangea[Math.floor(r() * PALETTE.hydrangea.length)];
    // 花头半埋在叶团里：外圈低、中间高，不要一个个浮在上面的圆球
    const n = 6 + Math.floor(r() * 5);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2;
      const rad = 0.08 + r() * 0.3;
      heads.push({ p: base.clone().add(new THREE.Vector3(Math.cos(a) * rad * s, (0.5 - rad * 0.55 + r() * 0.08) * s, Math.sin(a) * rad * s)), s: (0.8 + r() * 0.4) * s, c: tone });
    }
  });
  hLeaves.castShadow = hLeaves.receiveShadow = true;
  hLeaves.name = 'hydrangea-leaves';
  // 花头 = 半球面上铺 30 朵四瓣小花（边缘是一朵朵花的轮廓，不再是光滑的球）+ 里面一个略暗的芯（补花片之间的缝）
  const hm = hydrangeaMaps();
  const floretGeo = floretHeadGeometry(3, 30, 0.1, 0.055);
  const coreGeo = new THREE.SphereGeometry(0.082, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62);
  coreGeo.translate(0, 0.035, 0);
  const hFlorets = new THREE.InstancedMesh(floretGeo, foliageMaterial(hydrangeaFloret(), null, 0, 0.4), heads.length);
  const hCores = new THREE.InstancedMesh(coreGeo, new THREE.MeshStandardMaterial({ map: hm.map, normalMap: hm.normalMap, roughness: 0.85 }), heads.length);
  heads.forEach((h, i) => {
    m4.compose(h.p, q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.6, r() * 6, (r() - 0.5) * 0.6)), new THREE.Vector3(h.s, h.s * 0.85, h.s));
    hFlorets.setMatrixAt(i, m4);
    hCores.setMatrixAt(i, m4);
    col.set(h.c).offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, (r() - 0.5) * 0.06);
    hFlorets.setColorAt(i, col);
    hCores.setColorAt(i, col.multiplyScalar(0.78));
  });
  hFlorets.castShadow = hCores.castShadow = true;
  hFlorets.receiveShadow = hCores.receiveShadow = true;
  hFlorets.name = 'hydrangea-florets';
  hCores.name = 'hydrangea-cores';
  group.add(hLeaves, hFlorets, hCores);

  // ───────── 竹子 ─────────
  const clumps: { p: Vec2; n: number; h: number }[] = [
    { p: [house.x0 - 0.55, 5.3], n: 13, h: 3.1 }, // 门边（壁灯北侧）
    { p: [indoorX1 - 1.2, house.y0 - 0.55], n: 10, h: 2.7 }, // 南墙东头
    { p: [house.x1 + 0.9, house.y1 - 1.2], n: 11, h: 3.0 }, // 阳台外
  ];
  const culms: { base: THREE.Vector3; h: number; lean: THREE.Euler; r: number }[] = [];
  for (const c of clumps) {
    occupied.push({ p: c.p, r: 0.6 });
    for (let i = 0; i < c.n; i++) {
      const p: Vec2 = [c.p[0] + (r() - 0.5) * 0.55, c.p[1] + (r() - 0.5) * 0.55];
      culms.push({ base: P(p[0], ground(p) - 0.05, p[1]), h: c.h * (0.65 + r() * 0.4), lean: new THREE.Euler((r() - 0.5) * 0.16, 0, (r() - 0.5) * 0.16), r: 0.014 + r() * 0.01 });
    }
  }
  const culmGeo = new THREE.CylinderGeometry(0.8, 1, 1, 6, 1, true);
  culmGeo.translate(0, 0.5, 0);
  // 竹竿贴图带竹节（整根 8 节，随竿高自动拉开间距）
  const culmMesh = new THREE.InstancedMesh(culmGeo, new THREE.MeshStandardMaterial({ map: bambooCulm(), roughness: 0.45 }), culms.length);
  const leafCards: THREE.Matrix4[] = [];
  culms.forEach((c, i) => {
    q.setFromEuler(c.lean);
    m4.compose(c.base, q, new THREE.Vector3(c.r, c.h, c.r));
    culmMesh.setMatrixAt(i, m4);
    culmMesh.setColorAt(i, col.setRGB(1, 1, 1).offsetHSL((r() - 0.5) * 0.03, 0, -r() * 0.15));
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // 竹叶：上半截一簇簇，越往上越密，小枝向外伸、叶子往下垂
    for (let k = 0; k < 20; k++) {
      const t = 0.35 + Math.sqrt(r()) * 0.65;
      const at = c.base.clone().addScaledVector(axis, c.h * t);
      const a = r() * Math.PI * 2;
      const off = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.1 + r() * 0.16);
      const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3 + r() * 0.7, a, (r() - 0.5) * 0.8, 'YXZ'));
      const s = 0.3 + r() * 0.22;
      leafCards.push(new THREE.Matrix4().compose(at.add(off), lq, new THREE.Vector3(s, s, s)));
    }
  });
  culmMesh.castShadow = true;
  culmMesh.name = 'bamboo-culms';
  const bLeafGeo = new THREE.PlaneGeometry(1, 1);
  // 竹叶卡片法线朝上偏：一团叶子受光柔和
  const bn = bLeafGeo.getAttribute('normal');
  for (let k = 0; k < bn.count; k++) bn.setXYZ(k, 0, 0.8, 0.6);
  const bLeaves = new THREE.InstancedMesh(bLeafGeo, foliageMaterial(bambooLeafCard(), time, 0.04), leafCards.length);
  leafCards.forEach((m, i) => {
    bLeaves.setMatrixAt(i, m);
    bLeaves.setColorAt(i, col.setHSL(0.2, 0.15 + r() * 0.15, 0.8 + r() * 0.2));
  });
  bLeaves.castShadow = true;
  bLeaves.name = 'bamboo-leaves';
  group.add(culmMesh, bLeaves);

  // ───────── 蒲苇（芒草） ─────────
  const pampas: Vec2[] = [
    [door[0] - 2.6, door[1] - 2.4],
    [house.x1 + 0.6, house.y0 - 1.0],
    [house.x0 - 1.1, house.y1 + 0.4],
    [indoorX1 - 3.0, house.y0 - 1.5],
  ].filter((p) => !onPath(p as Vec2, 0.7)) as Vec2[];
  // 叶丛是真实几何的细长拱形叶（不是贴图卡片），花穗是十字交叉的两张卡片，从叶丛里高高伸出来
  const fountains = [fountainGeometry(81, 48, 0.95), fountainGeometry(82, 42, 0.85)];
  const bladeMat = foliageMaterial(null, time, 0.12);
  // 两种叶丛交替用：第 0 种放偶数号、第 1 种放奇数号
  const bladeMeshes = fountains.map((g, k) => new THREE.InstancedMesh(g, bladeMat, Math.floor((pampas.length + 1 - k) / 2)));
  const plumeGeo = mergeGeometries([0, Math.PI / 3, (Math.PI * 2) / 3].map((a) => {
    const g = new THREE.PlaneGeometry(0.2, 0.95);
    g.translate(0, 0.475, 0);
    g.rotateY(a);
    return g;
  }))!;
  const plumeMats: THREE.Matrix4[] = [];
  pampas.forEach((p, i) => {
    occupied.push({ p, r: 0.6 });
    const base = P(p[0], ground(p) - 0.03, p[1]);
    const bm = bladeMeshes[i % 2];
    const s0 = 0.9 + r() * 0.3;
    m4.compose(base, q.setFromAxisAngle(Y, r() * 6.28), new THREE.Vector3(s0, s0, s0));
    bm.setMatrixAt(Math.floor(i / 2), m4);
    for (let k = 0; k < 9; k++) {
      const a = r() * Math.PI * 2;
      const tilt = 0.05 + r() * 0.3;
      const pq = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, a, 0, 'YXZ'));
      const at = base.clone().add(new THREE.Vector3(Math.cos(a) * 0.07, 0.3 + r() * 0.25, Math.sin(a) * 0.07));
      const s = 0.9 + r() * 0.35;
      plumeMats.push(new THREE.Matrix4().compose(at, pq, new THREE.Vector3(s, s, s)));
    }
  });
  bladeMeshes.forEach((m, i) => {
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `pampas-blades-${i}`;
  });
  // 花穗边缘是一丝丝细毛：用多重采样的「透明度转覆盖率」，边缘柔和，不像剪纸
  const plumeMat = foliageMaterial(plumeCard(), time, 0.05, 0.2);
  plumeMat.alphaToCoverage = true;
  const plumes = new THREE.InstancedMesh(plumeGeo, plumeMat, plumeMats.length);
  plumeMats.forEach((m, i) => {
    plumes.setMatrixAt(i, m);
    plumes.setColorAt(i, col.setHSL(0.07, 0.15 + r() * 0.3, 0.88 + r() * 0.1));
  });
  plumes.castShadow = true;
  plumes.name = 'pampas-plumes';
  group.add(...bladeMeshes, plumes);

  // ───────── 雏菊：绣球前面和小路两边成片 ─────────
  const daisySpots: Vec2[] = [];
  for (const h of hydra) {
    const out: Vec2 = h[1] < house.y0 ? [0, -1] : [-1, 0];
    for (let k = 0; k < 6; k++) daisySpots.push([h[0] + out[0] * (0.55 + r() * 0.35) + (r() - 0.5) * 0.7, h[1] + out[1] * (0.55 + r() * 0.35) + (r() - 0.5) * 0.7]);
  }
  const pts = island.pathPoints;
  for (let i = 1; i < pts.length - 4; i++) {
    for (const side of [-1, 1]) {
      if (r() < 0.35) continue;
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      const d = 0.75 + r() * 0.4;
      daisySpots.push([ax + nx * d * side + (r() - 0.5) * 0.3, ay + ny * d * side + (r() - 0.5) * 0.3]);
    }
  }
  const daisies = daisySpots.filter((p) => !island.nearHouse(p, 0.3) && !onPath(p, 0.45) && island.shore(p) > 0.8 && !nearDoor(p, 0.9));
  const daisyGeo = new THREE.PlaneGeometry(0.42, 0.42);
  daisyGeo.rotateX(-Math.PI / 2);
  const dn = daisyGeo.getAttribute('normal');
  for (let k = 0; k < dn.count; k++) dn.setXYZ(k, 0, 1, 0);
  const daisyMesh = new THREE.InstancedMesh(daisyGeo, foliageMaterial(daisyCard(), null), daisies.length);
  daisies.forEach((p, i) => {
    const s = 0.8 + r() * 0.5;
    m4.compose(P(p[0], ground(p) + 0.1 + r() * 0.06, p[1]), q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.3, r() * 6.28, (r() - 0.5) * 0.3)), new THREE.Vector3(s, s, s));
    daisyMesh.setMatrixAt(i, m4);
  });
  daisyMesh.receiveShadow = true;
  daisyMesh.name = 'daisies';
  group.add(daisyMesh);

  // ───────── 踏步石：从门口沿小路到码头 ─────────
  const rm = rockMaps();
  // 花岗岩：颜色用很淡的斑驳（抹灰贴图），凹凸用岩石法线；岩石颜色贴图的裂纹在小物件上像大理石，不用
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#b8b4ac', map: plasterMaps().map, normalMap: rm.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.92 });
  const stones: { p: Vec2; s: number; a: number }[] = [];
  {
    let acc = 0.35;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      while (acc < len) {
        const t = acc / len;
        const jitter = (r() - 0.5) * 0.14;
        stones.push({ p: [ax + (bx - ax) * t + jitter, ay + (by - ay) * t - jitter], s: 0.24 + r() * 0.08, a: r() * 6.28 });
        acc += 0.58 + r() * 0.08;
      }
      acc -= len;
    }
  }
  const stoneGeo = new THREE.CylinderGeometry(1, 1, 0.06, 9);
  {
    // 边缘不规则：每个顶点按角度乱一点
    const pos = stoneGeo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 + 0.12 * Math.sin(a * 3 + 1) + 0.08 * Math.sin(a * 5 + 2);
      pos.setXYZ(i, x * k, pos.getY(i), z * k * 0.8);
    }
    stoneGeo.computeVertexNormals();
  }
  const stoneMesh = new THREE.InstancedMesh(stoneGeo, stoneMat, stones.length);
  stones.forEach((st, i) => {
    m4.compose(P(st.p[0], ground(st.p) + 0.01, st.p[1]), q.setFromAxisAngle(Y, st.a), new THREE.Vector3(st.s, 1, st.s));
    stoneMesh.setMatrixAt(i, m4);
  });
  stoneMesh.receiveShadow = true;
  stoneMesh.castShadow = true;
  stoneMesh.name = 'stepping-stones';
  group.add(stoneMesh);

  // ───────── 石灯笼 ─────────
  const emissive: THREE.MeshStandardMaterial[] = [];
  const glow = new THREE.MeshStandardMaterial({ color: '#3a3430', roughness: 0.6, emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0 });
  emissive.push(glow);
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, y: number) => {
    g.translate(0, y, 0);
    parts.push(g);
  };
  add(new THREE.CylinderGeometry(0.2, 0.23, 0.08, 6), 0.04); // 底座
  add(new THREE.CylinderGeometry(0.07, 0.08, 0.34, 6), 0.25); // 柱
  add(new THREE.CylinderGeometry(0.17, 0.12, 0.06, 6), 0.45); // 中台
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const post = new THREE.BoxGeometry(0.05, 0.2, 0.05);
    post.translate(dx * 0.1, 0, dz * 0.1);
    add(post, 0.58); // 火袋四角
  }
  const roofG = new THREE.ConeGeometry(0.3, 0.16, 4);
  roofG.rotateY(Math.PI / 4);
  add(roofG, 0.76); // 笠
  add(new THREE.SphereGeometry(0.05, 8, 6), 0.87); // 宝珠
  const lanternGeo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  const fireGeo = new THREE.BoxGeometry(0.17, 0.17, 0.17);
  fireGeo.translate(0, 0.58, 0);
  const lanternSpots: Vec2[] = [];
  {
    // 门前小路两侧各一座（离门约 1.4 米），阳台外一座
    const [ax, ay] = pts[0];
    const [bx, by] = pts[3];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const along: Vec2 = [ax + ((bx - ax) / len) * 1.2, ay + ((by - ay) / len) * 1.2];
    lanternSpots.push([along[0] + nx * 0.85, along[1] + ny * 0.85], [along[0] - nx * 0.85, along[1] - ny * 0.85]);
    lanternSpots.push([house.x1 + 0.7, house.y0 + 0.4]);
  }
  const lanterns = new THREE.InstancedMesh(lanternGeo, stoneMat, lanternSpots.length);
  const fires = new THREE.InstancedMesh(fireGeo, glow, lanternSpots.length);
  lanternSpots.forEach((p, i) => {
    occupied.push({ p, r: 0.35 });
    m4.compose(P(p[0], ground(p) - 0.02, p[1]), q.setFromAxisAngle(Y, r() * 0.3 + Math.PI / 4), new THREE.Vector3(1, 1, 1));
    lanterns.setMatrixAt(i, m4);
    fires.setMatrixAt(i, m4);
  });
  lanterns.castShadow = lanterns.receiveShadow = true;
  lanterns.name = 'stone-lanterns';
  group.add(lanterns, fires);

  return {
    group,
    emissive,
    occupied,
    update(dt) {
      time.value += dt;
    },
  };
}
