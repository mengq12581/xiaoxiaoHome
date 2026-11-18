// 房子外观（程序生成，跟着 rooms.json 走，改户型自动跟上）：
//   - 外墙外侧贴一层「灰泥 + 石材墙基」，转角立原木角柱，墙顶一道檐口线；
//   - 双坡屋顶（陶土红瓦，整个画面唯一的高饱和暖色焦点），两端山墙，烟囱打破屋顶轮廓；
//   - 阳台上方是稀疏的木格栅（花架），从上往下看仍然通透；
//   - 屋顶可以「掀开」：setOpen(k) 让屋顶抬起并淡出，看屋里时用（docs/art/美术方向.md「屋顶」）。

import * as THREE from 'three';
import type { RoomsConfig } from '../config/types';
import { P } from '../scene/house';
import { computeWallLayout, normBounds, wallPieces, type WallSegment } from '../scene/layout';
import { PALETTE } from './palette';
import { leafCard, plasterMaps, roofTileMaps, stoneMaps, woodMaps } from './textures';

const BASE_H = 0.45; // 石材墙基高度
const CLAD = 0.025; // 外墙贴面厚度

/**
 * 盒子按世界尺寸重算 UV（每个面取另外两个轴的坐标 / tile 米），相邻墙块的纹理接得上。
 * offset：网格在世界里的位置（只有平移、没有旋转的盒子才用；旋转过的传 0，用自身坐标）。
 */
function worldUV(geo: THREE.BufferGeometry, tile: number, offset = new THREE.Vector3()) {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, z / tile, y / tile);
    else if (az >= ay) uv.setXY(i, x / tile, y / tile);
    else uv.setXY(i, x / tile, z / tile);
  }
  uv.needsUpdate = true;
}

export interface Exterior {
  group: THREE.Group;
  /** 夜里点亮的外墙灯 */
  practicals: { position: THREE.Vector3; color: string; intensity: number; distance: number }[];
  emissive: THREE.MeshStandardMaterial[];
  roof: THREE.Group;
  /** 外墙贴面按墙段分组（剖开看屋里时跟着墙一起隐藏） */
  claddingBySegment: Map<string, THREE.Object3D>;
  /** 0 = 盖着，1 = 完全掀开 */
  setOpen(k: number): void;
}

export function buildExterior(cfg: RoomsConfig): Exterior {
  const group = new THREE.Group();
  group.name = 'exterior';
  const layout = computeWallLayout(cfg);
  const T = layout.thickness;
  const E = PALETTE.exterior;
  // 写实材质：颜色贴图（乘在底色上）+ 法线贴图，UV 按世界尺寸（worldUV）
  const pm = plasterMaps();
  const sm = stoneMaps();
  const wm = woodMaps();
  const plaster = new THREE.MeshStandardMaterial({ color: E.plaster, map: pm.map, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95 });
  const stone = new THREE.MeshStandardMaterial({ color: E.stone, map: sm.map, normalMap: sm.normalMap, roughness: 0.9 });
  const timber = new THREE.MeshStandardMaterial({ color: E.timber, map: wm.map, normalMap: wm.normalMap, roughness: 0.75 });
  const timberDark = new THREE.MeshStandardMaterial({ color: E.timberDark, map: wm.map, normalMap: wm.normalMap, roughness: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ color: E.trim, map: pm.map, roughness: 0.7 });
  const tileOf = (m: THREE.Material) => (m === stone ? 1.2 : m === timber || m === timberDark ? 0.9 : 1.4);

  const box = (seg: Pick<WallSegment, 'orient' | 'c'>, s: number, e: number, y0: number, y1: number, across: number, depth: number, mat: THREE.Material) => {
    const len = e - s;
    const geo = seg.orient === 'h' ? new THREE.BoxGeometry(len, y1 - y0, depth) : new THREE.BoxGeometry(depth, y1 - y0, len);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(seg.orient === 'h' ? P((s + e) / 2, (y0 + y1) / 2, across) : P(across, (y0 + y1) / 2, (s + e) / 2));
    worldUV(geo, tileOf(mat), m.position);
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  };

  // ───────── 外墙贴面、墙基、檐口 ─────────
  const claddingBySegment = new Map<string, THREE.Object3D>();
  for (const seg of layout.segments) {
    if (!seg.outward) continue;
    const g = new THREE.Group();
    g.name = `cladding:${seg.id}`;
    const sign = seg.orient === 'h' ? seg.outward[1] : seg.outward[0];
    const across = seg.c + sign * (T / 2 + CLAD / 2);
    for (const p of wallPieces(seg, T)) {
      const s = p.s - (p.s < seg.a + 1e-6 ? CLAD : 0);
      const e = p.e + (p.e > seg.b - 1e-6 ? CLAD : 0);
      if (p.y0 < BASE_H) g.add(box(seg, s, e, p.y0, Math.min(BASE_H, p.y1), across + sign * 0.012, CLAD + 0.024, stone));
      if (p.y1 > BASE_H) g.add(box(seg, s, e, Math.max(BASE_H, p.y0), p.y1, across, CLAD, plaster));
    }
    g.add(box(seg, seg.a - T / 2 - 0.06, seg.b + T / 2 + 0.06, seg.height - 0.12, seg.height + 0.02, seg.c + sign * (T / 2 + 0.04), 0.08, trim));
    claddingBySegment.set(seg.id, g);
    group.add(g);
  }

  // 室内部分的外接矩形（不含露天阳台）
  const indoor = cfg.rooms.filter((r) => !r.outdoor).map(normBounds);
  const ix0 = Math.min(...indoor.map((b) => b.x0));
  const ix1 = Math.max(...indoor.map((b) => b.x1));
  const iy0 = Math.min(...indoor.map((b) => b.y0));
  const iy1 = Math.max(...indoor.map((b) => b.y1));
  const H = Math.max(...layout.segments.map((s) => s.height));

  // 转角原木柱
  for (const [x, y, sx, sy] of [
    [ix0, iy0, -1, -1],
    [ix1, iy0, 1, -1],
    [ix1, iy1, 1, 1],
    [ix0, iy1, -1, 1],
  ] as const) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, H + 0.02, 0.16), timber);
    post.position.copy(P(x + sx * (T / 2 + 0.03), (H + 0.02) / 2, y + sy * (T / 2 + 0.03)));
    post.castShadow = true;
    group.add(post);
  }

  // ───────── 屋顶 ─────────
  const roof = new THREE.Group();
  roof.name = 'roof';
  const pitch = (27 * Math.PI) / 180;
  const ox = 0.4; // 两端出檐
  const oy = 0.5; // 前后出檐
  const half = (iy1 - iy0) / 2;
  const ym = (iy0 + iy1) / 2;
  const eaveH = H + 0.08;
  const ridgeH = eaveH + half * Math.tan(pitch);
  const slope = (half + oy) / Math.cos(pitch);
  const lenX = ix1 - ix0 + ox * 2;
  const rt = roofTileMaps();
  // 一张贴图 = 6 列 × 4 行瓦（每片约 0.3 × 0.25 米）
  const tiles = rt.map.clone();
  const tilesN = rt.normalMap.clone();
  for (const t of [tiles, tilesN]) {
    t.repeat.set(lenX / 1.8, slope / 1.0);
    t.needsUpdate = true;
  }
  const roofMat = new THREE.MeshStandardMaterial({ color: E.roof, map: tiles, normalMap: tilesN, roughness: 0.8, transparent: true });
  const roofDark = new THREE.MeshStandardMaterial({ color: E.roofDark, map: sm.map, roughness: 0.85, transparent: true });
  const roofMats: THREE.Material[] = [roofMat, roofDark];
  for (const side of [-1, 1]) {
    // side -1：南坡（平面 y 小的一侧）；+1：北坡
    const slab = new THREE.Mesh(new THREE.BoxGeometry(lenX, 0.11, slope), [roofDark, roofDark, roofMat, roofDark, roofDark, roofDark]);
    const yc = ym + side * (half + oy) / 2;
    const hc = eaveH + (half - (half + oy) / 2) * Math.tan(pitch);
    slab.position.copy(P((ix0 + ix1) / 2, hc + 0.06, yc));
    slab.rotation.x = side < 0 ? pitch : -pitch;
    slab.castShadow = true;
    slab.receiveShadow = true;
    roof.add(slab);
  }
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(lenX + 0.04, 0.12, 0.22), roofDark);
  ridge.position.copy(P((ix0 + ix1) / 2, ridgeH + 0.12, ym));
  roof.add(ridge);
  // 山墙（两端的三角墙）+ 封檐板
  const gableMat = plaster.clone();
  gableMat.transparent = true;
  const timberT = timberDark.clone();
  timberT.transparent = true;
  roofMats.push(gableMat, timberT);
  for (const x of [ix0, ix1]) {
    const shape = new THREE.Shape();
    shape.moveTo(iy0 - T / 2 - CLAD, 0);
    shape.lineTo(iy1 + T / 2 + CLAD, 0);
    shape.lineTo(ym, ridgeH - eaveH + 0.02);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: T + CLAD * 2, bevelEnabled: false });
    geo.translate(0, 0, -(T + CLAD * 2) / 2);
    const gable = new THREE.Mesh(geo, gableMat);
    gable.rotation.y = Math.PI / 2;
    gable.position.set(x, eaveH - 0.02, 0);
    gable.castShadow = true;
    roof.add(gable);
    // 封檐板：沿屋顶边缘的两条木板
    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, slope + 0.05), timberT);
      board.position.copy(P(x + (x === ix0 ? -ox : ox), eaveH + (half - (half + oy) / 2) * Math.tan(pitch) + 0.06, ym + side * (half + oy) / 2));
      board.rotation.x = side < 0 ? pitch : -pitch;
      roof.add(board);
    }
  }
  // 烟囱（北坡，靠左）
  const chimMat = stone.clone();
  chimMat.transparent = true;
  roofMats.push(chimMat);
  const cx = ix0 + 1.6;
  const cy = ym + half * 0.45;
  const roofAt = eaveH + (half - (cy - ym)) * Math.tan(pitch);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.55, ridgeH + 0.7 - roofAt + 0.3, 0.55), chimMat);
  chimney.position.copy(P(cx, (ridgeH + 0.7 + roofAt - 0.3) / 2, cy));
  chimney.castShadow = true;
  const chimCap = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.08, 0.68), roofDark);
  chimCap.position.copy(P(cx, ridgeH + 0.74, cy));
  roof.add(chimney, chimCap);
  group.add(roof);

  // ───────── 阳台花架 ─────────
  const balcony = cfg.rooms.find((r) => r.outdoor);
  if (balcony) {
    const b = normBounds(balcony);
    const pergola = new THREE.Group();
    pergola.name = 'pergola';
    const ph = H - 0.05;
    for (const y of [b.y0 + 0.08, (b.y0 + b.y1) / 2, b.y1 - 0.08]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, ph, 0.12), timber);
      post.position.copy(P(b.x1 - 0.08, ph / 2, y));
      post.castShadow = true;
      pergola.add(post);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, b.y1 - b.y0), timber);
    header.position.copy(P(b.x1 - 0.08, ph, (b.y0 + b.y1) / 2));
    pergola.add(header);
    for (let y = b.y0 + 0.15; y < b.y1; y += 0.62) {
      const rafter = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0 + 0.3, 0.1, 0.07), timberDark);
      rafter.position.copy(P((b.x0 + b.x1) / 2 + 0.1, ph + 0.12, y));
      rafter.castShadow = true;
      pergola.add(rafter);
    }
    group.add(pergola);
  }

  // ───────── 外墙点缀：入户门两侧壁灯、南墙长椅和攀援植物 ─────────
  const practicals: Exterior['practicals'] = [];
  const emissive: THREE.MeshStandardMaterial[] = [];
  const lampMat = () => {
    const m = new THREE.MeshStandardMaterial({ color: '#fff3dc', roughness: 0.6, emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0 });
    emissive.push(m);
    return m;
  };
  const entry = layout.openings.find((o) => o.id === 'entry_door');
  if (entry && entry.orient === 'v') {
    for (const along of [entry.s - 0.28, entry.e + 0.28]) {
      const x = entry.c - (T / 2 + CLAD + 0.08);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.12), lampMat());
      box.position.copy(P(x, 2.0, along));
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.16), timberDark);
      cap.position.copy(P(x, 2.12, along));
      group.add(box, cap);
      practicals.push({ position: P(x - 0.2, 1.95, along), color: PALETTE.lamp, intensity: 2.2, distance: 4.5 });
    }
  }
  // 南墙（平面 y 最小的外墙）：一张木长椅 + 一片爬藤
  const south = layout.segments.filter((sg) => sg.outward && sg.orient === 'h' && sg.outward[1] < 0);
  const vineMat = new THREE.MeshStandardMaterial({ map: leafCard('vine', [92, 128, 60], 17).map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  for (const sg of south) {
    const across = sg.c - (T / 2 + CLAD);
    const midX = (sg.a + sg.b) / 2;
    if (sg.b - sg.a > 3) {
      const benchX = midX - 0.6;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.06, 0.38), timber);
      seat.position.copy(P(benchX, 0.44, across - 0.3));
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.32, 0.05), timber);
      back.position.copy(P(benchX, 0.72, across - 0.08));
      seat.castShadow = back.castShadow = true;
      group.add(seat, back);
      for (const dx of [-0.58, 0.58]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.34), timberDark);
        leg.position.copy(P(benchX + dx, 0.21, across - 0.3));
        group.add(leg);
      }
    }
    // 爬藤：沿墙往上一团团，越往上越稀
    const r0 = Math.abs(Math.sin(sg.a * 12.9898) * 43758.5453) % 1;
    const vx = sg.b - 1.1 - r0 * 0.4;
    // 70 片叶子卡片用一次实例化绘制
    const vine = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), vineMat, 70);
    const o = new THREE.Object3D();
    for (let i = 0; i < 70; i++) {
      const u = (i % 35) / 35;
      const size = 0.32 + 0.14 * (1 - u);
      const hgt = 0.15 + u * 2.35;
      o.position.copy(P(vx + Math.sin(i * 2.1) * (0.55 - 0.3 * u) + (i % 3) * 0.1, hgt, across - 0.03 - (i % 4) * 0.02));
      o.rotation.set(Math.sin(i * 1.7) * 0.5, Math.PI + Math.sin(i * 3.1) * 0.5, Math.sin(i * 0.9) * Math.PI);
      o.scale.setScalar(size);
      o.updateMatrix();
      vine.setMatrixAt(i, o.matrix);
    }
    vine.castShadow = true;
    vine.name = 'vine';
    group.add(vine);
  }

  const setOpen = (k: number) => {
    const e = k * k * (3 - 2 * k);
    roof.position.y = e * 1.2;
    roof.visible = e < 0.999;
    for (const m of roofMats) {
      m.opacity = 1 - e;
      m.depthWrite = e < 0.02;
    }
  };
  setOpen(0);

  return { group, roof, claddingBySegment, setOpen, practicals, emissive };
}
