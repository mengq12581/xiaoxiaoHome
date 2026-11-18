// 房子外观（程序生成，跟着 rooms.json 走，改户型自动跟上）。风格按客户 2026-11-18 给的两张参考图：
//   - 外墙：白色细抹灰（几乎看不出纹理，只有很淡的抹痕），墙脚一道很矮的浅灰混凝土勒脚；不要角柱、檐口线；
//   - 屋顶：深炭灰立边咬合金属屋面，薄屋面板 + 细封檐，长边出檐较深、檐下露出一排木椽，两端山墙同样白色抹灰；
//   - 门窗：外侧一圈深灰细框（窗洞有进深）；入户门是深色竖向木板门，门边一盏黑框壁灯，门外两级石阶；
//   - 南墙：几缕从地面爬上去的藤；长椅保留；阳台上方的木花架保留；
//   - 屋顶可以「掀开」：setOpen(k) 让屋顶抬起并淡出，看屋里时用（docs/art/美术方向.md）。

import * as THREE from 'three';
import type { RoomsConfig } from '../config/types';
import { P } from '../scene/house';
import { computeWallLayout, normBounds, wallPieces, type Opening, type WallSegment } from '../scene/layout';
import { PALETTE } from './palette';
import { leafCard, metalSeamMaps, plasterMaps, rockMaps, woodMaps } from './textures';

const PLINTH_H = 0.16; // 混凝土勒脚高度
const CLAD = 0.025; // 外墙贴面厚度
const PITCH = (24 * Math.PI) / 180;
const ROOF_T = 0.07; // 屋面板厚度
const EAVE = 0.68; // 长边出檐（从墙中线算）
const RAKE = 0.32; // 山墙一侧出檐
const SEAM = 0.45; // 金属屋面板宽度

/**
 * 盒子按世界尺寸重算 UV（每个面取另外两个轴的坐标 / tile 米），相邻墙块的纹理接得上。
 * offset：网格在世界里的位置（只有平移、没有旋转的盒子才用；旋转过的传 0，用自身坐标）。
 */
function worldUV(geo: THREE.BufferGeometry, tile: number, offset = new THREE.Vector3(), swap = false) {
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
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) [u, v] = [z, y];
    else if (az >= ay) [u, v] = [x, y];
    else [u, v] = [x, z];
    if (swap) [u, v] = [v, u];
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

export interface Exterior {
  group: THREE.Group;
  /** 夜里点亮的外墙灯 */
  practicals: { position: THREE.Vector3; color: string; intensity: number; distance: number }[];
  emissive: THREE.MeshStandardMaterial[];
  roof: THREE.Group;
  /** 外墙贴面按墙段分组（剖开看屋里时跟着墙一起淡出；门窗外框、入户门、壁灯、爬藤也在里面） */
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

  // ───────── 材质 ─────────
  const pm = plasterMaps();
  const wm = woodMaps();
  const rm = rockMaps();
  const plaster = new THREE.MeshStandardMaterial({ color: E.plaster, map: pm.map, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.92 });
  const plinth = new THREE.MeshStandardMaterial({ color: E.plinth, map: pm.map, normalMap: pm.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.9 });
  const frame = new THREE.MeshStandardMaterial({ color: E.frame, roughness: 0.5, metalness: 0.15 });
  const doorWood = new THREE.MeshStandardMaterial({ color: E.door, map: wm.map, normalMap: wm.normalMap, roughness: 0.7 });
  const timber = new THREE.MeshStandardMaterial({ color: E.timber, map: wm.map, normalMap: wm.normalMap, roughness: 0.75 });
  const timberDark = new THREE.MeshStandardMaterial({ color: E.timberDark, map: wm.map, normalMap: wm.normalMap, roughness: 0.8 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: E.stone, map: pm.map, normalMap: rm.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.9 });
  const tileOf = (m: THREE.Material) => (m === timber || m === timberDark || m === doorWood ? 0.9 : 1.6);

  const box = (seg: Pick<WallSegment, 'orient' | 'c'>, s: number, e: number, y0: number, y1: number, across: number, depth: number, mat: THREE.Material, swap = false) => {
    const len = e - s;
    const geo = seg.orient === 'h' ? new THREE.BoxGeometry(len, y1 - y0, depth) : new THREE.BoxGeometry(depth, y1 - y0, len);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(seg.orient === 'h' ? P((s + e) / 2, (y0 + y1) / 2, across) : P(across, (y0 + y1) / 2, (s + e) / 2));
    worldUV(geo, tileOf(mat), m.position, swap);
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  };

  const practicals: Exterior['practicals'] = [];
  const emissive: THREE.MeshStandardMaterial[] = [];

  // ───────── 外墙贴面、勒脚、门窗外框 ─────────
  const claddingBySegment = new Map<string, THREE.Object3D>();
  const segGroup = new Map<string, THREE.Group>();
  for (const seg of layout.segments) {
    if (!seg.outward) continue;
    const g = new THREE.Group();
    g.name = `cladding:${seg.id}`;
    const sign = seg.orient === 'h' ? seg.outward[1] : seg.outward[0];
    const across = seg.c + sign * (T / 2 + CLAD / 2);
    for (const p of wallPieces(seg, T)) {
      const s = p.s - (p.s < seg.a + 1e-6 ? CLAD : 0);
      const e = p.e + (p.e > seg.b - 1e-6 ? CLAD : 0);
      if (p.y0 < PLINTH_H) g.add(box(seg, s, e, p.y0, Math.min(PLINTH_H, p.y1), across + sign * 0.006, CLAD + 0.012, plinth));
      if (p.y1 > PLINTH_H) g.add(box(seg, s, e, Math.max(PLINTH_H, p.y0), p.y1, across, CLAD, plaster));
    }
    // 门窗外侧一圈深灰细框（贴在洞口里侧，看起来窗洞有进深）
    for (const op of seg.openings) addFrame(g, seg, sign, op);
    claddingBySegment.set(seg.id, g);
    segGroup.set(seg.id, g);
    group.add(g);
  }

  function addFrame(g: THREE.Group, seg: WallSegment, sign: number, op: Opening) {
    const f = 0.05;
    const acr = seg.c + sign * (T / 2 + CLAD / 2 - 0.004);
    const d = CLAD + 0.03;
    g.add(box(seg, op.s, op.s + f, op.bottom, op.top, acr, d, frame));
    g.add(box(seg, op.e - f, op.e, op.bottom, op.top, acr, d, frame));
    g.add(box(seg, op.s, op.e, op.top - f, op.top, acr, d, frame));
    if (op.bottom > 0.3) {
      // 窗台：一条薄金属披水板，略伸出墙面
      g.add(box(seg, op.s - 0.03, op.e + 0.03, op.bottom - 0.03, op.bottom, seg.c + sign * (T / 2 + CLAD + 0.02), 0.07, frame));
    } else if (op.kind === 'window') {
      g.add(box(seg, op.s, op.e, op.bottom, op.bottom + f, acr, d, frame));
    }
  }

  // 室内部分的外接矩形（不含露天阳台）
  const indoor = cfg.rooms.filter((r) => !r.outdoor).map(normBounds);
  const ix0 = Math.min(...indoor.map((b) => b.x0));
  const ix1 = Math.max(...indoor.map((b) => b.x1));
  const iy0 = Math.min(...indoor.map((b) => b.y0));
  const iy1 = Math.max(...indoor.map((b) => b.y1));
  const H = Math.max(...layout.segments.map((s) => s.height));

  // ───────── 屋顶 ─────────
  const roof = new THREE.Group();
  roof.name = 'roof';
  const half = (iy1 - iy0) / 2;
  const ym = (iy0 + iy1) / 2;
  const tan = Math.tan(PITCH);
  const eaveH = H + 0.1;
  /** 屋面（板底）在离屋脊线水平距离 d 处的高度 */
  const under = (d: number) => eaveH + (half - d) * tan;
  const ridgeH = under(0);
  const slope = (half + EAVE) / Math.cos(PITCH);
  const lenX = ix1 - ix0 + RAKE * 2;
  const seam = metalSeamMaps();
  const sMap = seam.map.clone();
  const sNor = seam.normalMap.clone();
  for (const t of [sMap, sNor]) {
    t.repeat.set(lenX / SEAM, slope / 2.2);
    t.needsUpdate = true;
  }
  // 金属度压低：太「金属」会把蓝天整片反射上去，深灰屋面看起来发蓝
  const roofMetal = new THREE.MeshStandardMaterial({ color: E.roof, map: sMap, normalMap: sNor, roughness: 0.62, metalness: 0.12, transparent: true });
  const roofEdge = new THREE.MeshStandardMaterial({ color: E.roofEdge, roughness: 0.55, metalness: 0.15, transparent: true });
  const soffit = new THREE.MeshStandardMaterial({ color: E.soffit, map: wm.map, roughness: 0.8, transparent: true });
  const roofMats: THREE.Material[] = [roofMetal, roofEdge, soffit];
  const cx = (ix0 + ix1) / 2;
  for (const side of [-1, 1]) {
    // side -1：南坡（平面 y 小的一侧）；+1：北坡。上面金属屋面，底面木吊顶，四边深灰封边
    const slab = new THREE.Mesh(new THREE.BoxGeometry(lenX, ROOF_T, slope), [roofEdge, roofEdge, roofMetal, soffit, roofEdge, roofEdge]);
    const dc = (half + EAVE) / 2;
    slab.position.copy(P(cx, under(dc) + ROOF_T / 2 / Math.cos(PITCH), ym + side * dc));
    slab.rotation.x = side < 0 ? PITCH : -PITCH;
    slab.castShadow = true;
    slab.receiveShadow = true;
    roof.add(slab);
    // 封檐板：檐口一道细的深灰金属边
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(lenX + 0.02, 0.11, 0.03), roofEdge);
    fascia.position.copy(P(cx, under(half + EAVE) + 0.01, ym + side * (half + EAVE + 0.01)));
    roof.add(fascia);
  }
  // 屋脊盖板
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(lenX + 0.02, 0.05, 0.24), roofEdge);
  ridge.position.copy(P(cx, ridgeH + ROOF_T + 0.03, ym));
  roof.add(ridge);
  // 檐下木椽：两条长边，每 0.6 米一根，从墙面伸到檐口
  const wallFace = half + T / 2 + CLAD;
  const rafterLen = (half + EAVE - wallFace + 0.1) / Math.cos(PITCH);
  const rafterXs: number[] = [];
  for (let x = ix0 - RAKE + 0.18; x <= ix1 + RAKE - 0.18; x += 0.6) rafterXs.push(x);
  const rafters = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.09, rafterLen), timber, rafterXs.length * 2);
  const o = new THREE.Object3D();
  let ri = 0;
  for (const side of [-1, 1]) {
    const dMid = (wallFace - 0.1 + half + EAVE) / 2;
    for (const x of rafterXs) {
      o.position.copy(P(x, under(dMid) - 0.05, ym + side * dMid));
      o.rotation.set(side < 0 ? PITCH : -PITCH, 0, 0);
      o.updateMatrix();
      rafters.setMatrixAt(ri++, o.matrix);
    }
  }
  rafters.castShadow = true;
  rafters.name = 'rafters';
  const rafterMat = timber.clone();
  rafterMat.transparent = true;
  rafters.material = rafterMat;
  roofMats.push(rafterMat);
  roof.add(rafters);
  // 山墙（两端的三角墙，白色抹灰）+ 斜向封檐
  const gableMat = plaster.clone();
  gableMat.transparent = true;
  roofMats.push(gableMat);
  for (const x of [ix0, ix1]) {
    const shape = new THREE.Shape();
    const y0 = iy0 - T / 2 - CLAD;
    const y1 = iy1 + T / 2 + CLAD;
    shape.moveTo(y0, 0);
    shape.lineTo(y1, 0);
    shape.lineTo(y1, under(wallFace) - H);
    shape.lineTo(ym, ridgeH - H);
    shape.lineTo(y0, under(wallFace) - H);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: T + CLAD * 2, bevelEnabled: false });
    geo.translate(0, 0, -(T + CLAD * 2) / 2);
    // ExtrudeGeometry 的 UV 就是形状坐标（米），抹灰贴图每 1.6 米一张
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 1.6, uv.getY(i) / 1.6);
    const gable = new THREE.Mesh(geo, gableMat);
    gable.rotation.y = Math.PI / 2;
    gable.position.set(x, H - 0.005, 0);
    gable.castShadow = true;
    gable.receiveShadow = true;
    roof.add(gable);
    for (const side of [-1, 1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, slope + 0.03), roofEdge);
      const dc = (half + EAVE) / 2;
      board.position.copy(P(x + (x === ix0 ? -RAKE - 0.01 : RAKE + 0.01), under(dc) + ROOF_T / 2, ym + side * dc));
      board.rotation.x = side < 0 ? PITCH : -PITCH;
      roof.add(board);
    }
  }
  group.add(roof);

  // ───────── 阳台花架 ─────────
  const balcony = cfg.rooms.find((r) => r.outdoor);
  if (balcony) {
    const b = normBounds(balcony);
    const pergola = new THREE.Group();
    pergola.name = 'pergola';
    const ph = H - 0.05;
    for (const y of [b.y0 + 0.08, (b.y0 + b.y1) / 2, b.y1 - 0.08]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, ph, 0.1), timber);
      post.position.copy(P(b.x1 - 0.08, ph / 2, y));
      post.castShadow = true;
      pergola.add(post);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, b.y1 - b.y0), timber);
    header.position.copy(P(b.x1 - 0.08, ph, (b.y0 + b.y1) / 2));
    pergola.add(header);
    for (let y = b.y0 + 0.15; y < b.y1; y += 0.55) {
      const rafter = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0 + 0.3, 0.09, 0.05), timberDark);
      rafter.position.copy(P((b.x0 + b.x1) / 2 + 0.1, ph + 0.11, y));
      rafter.castShadow = true;
      pergola.add(rafter);
    }
    group.add(pergola);
  }

  // ───────── 入户门：竖向木板门、黑框壁灯、两级石阶 ─────────
  const entry = layout.openings.find((op) => op.id === 'entry_door');
  const entrySeg = entry && layout.segments.find((sg) => sg.outward && sg.openings.some((op) => op.id === entry.id));
  if (entry && entrySeg) {
    const g = segGroup.get(entrySeg.id)!;
    const sign = entrySeg.orient === 'h' ? entrySeg.outward![1] : entrySeg.outward![0];
    const acr = entrySeg.c + sign * (T / 2 - 0.03);
    // 门板：几块竖向木板，板缝里是深色衬板
    g.add(box(entrySeg, entry.s + 0.02, entry.e - 0.02, 0.01, entry.top - 0.01, acr - sign * 0.01, 0.03, timberDark));
    const planks = 5;
    const w = (entry.e - entry.s - 0.04) / planks;
    for (let i = 0; i < planks; i++) {
      const s = entry.s + 0.02 + i * w + 0.006;
      g.add(box(entrySeg, s, s + w - 0.012, 0.01, entry.top - 0.01, acr, 0.04, doorWood, true));
    }
    // 门把手
    g.add(box(entrySeg, entry.e - 0.12, entry.e - 0.1, 0.95, 1.12, acr + sign * 0.035, 0.03, frame));
    // 壁灯：黑色细框 + 发光的灯罩，挂在门把手一侧
    const along = entry.e + 0.32;
    const lx = entrySeg.c + sign * (T / 2 + CLAD + 0.1);
    const lampGlow = new THREE.MeshStandardMaterial({ color: '#fff1d6', roughness: 0.4, emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0 });
    emissive.push(lampGlow);
    const lamp = new THREE.Group();
    lamp.name = 'wall-lantern';
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.24, 0.15), lampGlow);
    lamp.add(glass);
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.26, 0.015), frame);
      post.position.set(dx * 0.075, 0, dz * 0.075);
      lamp.add(post);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.12, 0.07, 4), frame);
    cap.rotation.y = Math.PI / 4;
    cap.position.y = 0.16;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.17), frame);
    base.position.y = -0.13;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.1), frame);
    lamp.add(cap, base, arm);
    if (entrySeg.orient === 'v') {
      lamp.position.copy(P(lx, 1.9, along));
      arm.rotation.y = Math.PI / 2;
      arm.position.set(-sign * 0.09, 0.08, 0);
    } else {
      lamp.position.copy(P(along, 1.9, lx));
      arm.position.set(0, 0.08, sign * 0.09);
    }
    g.add(lamp);
    practicals.push({ position: lamp.position.clone().add(new THREE.Vector3(entrySeg.orient === 'v' ? sign * 0.15 : 0, -0.05, entrySeg.orient === 'h' ? -sign * 0.15 : 0)), color: PALETTE.lamp, intensity: 2.6, distance: 5 });
    // 门外两级石阶（贴着门，往外一级比一级低）
    for (const [i, h, depth] of [[0, 0.06, 0.42], [1, -0.02, 0.4]] as const) {
      const out = T / 2 + CLAD + 0.02 + i * 0.36 + depth / 2;
      const step = new THREE.Mesh(new THREE.BoxGeometry(entrySeg.orient === 'v' ? depth : entry.e - entry.s + 0.5 - i * 0.1, 0.12, entrySeg.orient === 'v' ? entry.e - entry.s + 0.5 - i * 0.1 : depth), stoneMat);
      const c = (entry.s + entry.e) / 2;
      step.position.copy(entrySeg.orient === 'v' ? P(entrySeg.c + sign * out, h - 0.06, c) : P(c, h - 0.06, entrySeg.c + sign * out));
      step.castShadow = step.receiveShadow = true;
      group.add(step);
    }
  }

  // ───────── 南墙：长椅 + 几缕爬藤（爬藤跟着墙一起淡出） ─────────
  const south = layout.segments.filter((sg) => sg.outward && sg.orient === 'h' && sg.outward[1] < 0);
  const vineMat = new THREE.MeshStandardMaterial({ map: leafCard('vine', [78, 112, 56], 17).map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  for (const sg of south) {
    const across = sg.c - (T / 2 + CLAD);
    const midX = (sg.a + sg.b) / 2;
    if (sg.b - sg.a > 3) {
      const benchX = midX + 0.4;
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
    // 爬藤：靠西头的一段墙上 7 缕，从地面往上爬 1.6～2.5 米，叶子越往上越小
    const strands = 7;
    const perStrand = 34;
    const vine = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), vineMat, strands * perStrand);
    let k = 0;
    for (let sIdx = 0; sIdx < strands; sIdx++) {
      const x0 = sg.a + 0.5 + sIdx * 0.22 + Math.sin(sIdx * 7.1) * 0.06;
      const top = 1.6 + Math.abs(Math.sin(sIdx * 3.7)) * 0.9;
      for (let i = 0; i < perStrand; i++) {
        const u = i / perStrand;
        const size = 0.2 - 0.08 * u;
        o.position.copy(P(x0 + Math.sin(u * 9 + sIdx) * 0.06, 0.12 + u * top, across - 0.03 - (i % 3) * 0.015));
        o.rotation.set(Math.sin(i * 1.7) * 0.4, Math.PI + Math.sin(i * 3.1) * 0.4, Math.sin(i * 0.9 + sIdx) * Math.PI);
        o.scale.setScalar(size);
        o.updateMatrix();
        vine.setMatrixAt(k++, o.matrix);
      }
    }
    vine.castShadow = true;
    vine.name = 'vine';
    (segGroup.get(sg.id) ?? group).add(vine);
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
