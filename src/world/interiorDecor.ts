// 室内软装（概念样张用，验证「每个房间一种墙色 + 少量软装」能不能让屋里不再单调）：
//   - 墙面：每个房间内侧贴一层自己的墙色，墙根一道白色踢脚线；
//   - 地毯、窗帘、绿植、挂画、落地灯；
//   - 夜里的灯（落地灯、床头灯、台灯、玄关壁灯、阳台串灯）。
// 正式接入时这些要进配置（每个房间的墙色、软装清单），这里先按房间 id 摆。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { FurnitureItem, RoomsConfig, Vec2 } from '../config/types';
import { P } from '../scene/house';
import { computeWallLayout, localToPlan, normBounds, wallPieces } from '../scene/layout';
import { rng } from './noise';
import { PALETTE } from './palette';
import type { Practical } from './vegetation';

function rugTexture(base: string, border: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = border;
  g.lineWidth = 10;
  g.strokeRect(18, 18, 220, 220);
  g.lineWidth = 3;
  g.strokeRect(34, 34, 188, 188);
  // 细密的织纹
  const r = rng(7);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '90,70,50'},0.05)`;
    g.fillRect(r() * 256, r() * 256, 2, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function artTexture(seed: number, colors: string[]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 200;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7f1e6';
  g.fillRect(0, 0, 160, 200);
  const r = rng(seed);
  // 几块柔和的色块（抽象风景）
  g.fillStyle = colors[0];
  g.beginPath();
  g.arc(60 + r() * 40, 70, 34, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = colors[1];
  g.beginPath();
  g.moveTo(0, 140);
  g.quadraticCurveTo(80, 90 + r() * 30, 160, 130);
  g.lineTo(160, 200);
  g.lineTo(0, 200);
  g.fill();
  g.fillStyle = colors[2];
  g.beginPath();
  g.moveTo(0, 170);
  g.quadraticCurveTo(90, 140, 160, 175);
  g.lineTo(160, 200);
  g.lineTo(0, 200);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface InteriorDecor {
  group: THREE.Group;
  /** 墙面贴层按墙段分组（剖开时跟墙一起隐藏） */
  paintBySegment: Map<string, THREE.Group>;
  practicals: Practical[];
  emissive: THREE.MeshStandardMaterial[];
}

export function buildInteriorDecor(cfg: RoomsConfig, items: FurnitureItem[]): InteriorDecor {
  const group = new THREE.Group();
  group.name = 'interior-decor';
  const layout = computeWallLayout(cfg);
  const T = layout.thickness;
  const paintBySegment = new Map<string, THREE.Group>();
  const baseboard = new THREE.MeshStandardMaterial({ color: PALETTE.baseboard, roughness: 0.6 });
  const roomColor = (id: string) => PALETTE.rooms[id] ?? PALETTE.rooms.living;
  const paintMats = new Map<string, THREE.MeshStandardMaterial>();
  const paintMat = (id: string) => {
    if (!paintMats.has(id)) paintMats.set(id, new THREE.MeshStandardMaterial({ color: roomColor(id).wall, roughness: 0.95 }));
    return paintMats.get(id)!;
  };

  // ───────── 墙面贴层 + 踢脚线 ─────────
  for (const edge of layout.edges) {
    if (edge.open) continue;
    const seg = layout.segments.find((s) => s.edgeIds.includes(edge.id));
    if (!seg) continue;
    let g = paintBySegment.get(seg.id);
    if (!g) {
      g = new THREE.Group();
      g.name = `paint:${seg.id}`;
      paintBySegment.set(seg.id, g);
      group.add(g);
    }
    const lo = edge.a + T / 2;
    const hi = edge.b - T / 2;
    const across = seg.c + edge.inside * (T / 2 + 0.004);
    for (const p of wallPieces(seg, T)) {
      const s = Math.max(p.s, lo);
      const e = Math.min(p.e, hi);
      if (e - s < 0.01) continue;
      const add = (y0: number, y1: number, depth: number, mat: THREE.Material, extra = 0) => {
        const len = e - s;
        const geo = seg.orient === 'h' ? new THREE.BoxGeometry(len, y1 - y0, depth) : new THREE.BoxGeometry(depth, y1 - y0, len);
        const m = new THREE.Mesh(geo, mat);
        const a = across + edge.inside * extra;
        m.position.copy(seg.orient === 'h' ? P((s + e) / 2, (y0 + y1) / 2, a) : P(a, (y0 + y1) / 2, (s + e) / 2));
        m.receiveShadow = true;
        g!.add(m);
      };
      add(Math.max(p.y0, p.y0 < 0.01 ? 0.09 : p.y0), p.y1 - 0.004, 0.008, paintMat(edge.roomId));
      if (p.y0 < 0.01) add(0, 0.09, 0.018, baseboard, 0.005);
    }
  }

  const find = (id: string) => items.find((i) => i.id === id);
  const practicals: Practical[] = [];
  const emissive: THREE.MeshStandardMaterial[] = [];
  const lampShade = () => {
    const m = new THREE.MeshStandardMaterial({ color: '#fff2dc', roughness: 0.65, emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0 });
    emissive.push(m);
    return m;
  };

  // ───────── 地毯 ─────────
  const rug = (center: Vec2, w: number, d: number, rot: number, room: string) => {
    const rc = roomColor(room);
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, 0.014, d, 2, 0.006), new THREE.MeshStandardMaterial({ map: rugTexture(rc.rug, rc.accent), roughness: 0.98 }));
    m.position.copy(P(center[0], 0.007, center[1]));
    m.rotation.y = (rot * Math.PI) / 180;
    m.receiveShadow = true;
    group.add(m);
  };
  const ct = find('coffee_table');
  if (ct) rug(ct.position, 2.6, 1.8, ct.rotation, 'living');
  const bed = find('bed');
  if (bed) rug(localToPlan(bed, [0, bed.size[1] / 2 + 0.25]), bed.size[0] + 0.6, 1.0, bed.rotation, 'bedroom');
  const chair = find('office_chair');
  if (chair) rug(chair.position, 1.5, 1.3, chair.rotation, 'study');
  const foyer = cfg.rooms.find((r) => r.id === 'foyer');
  if (foyer) {
    const b = normBounds(foyer);
    rug([b.x0 + 0.75, (b.y0 + b.y1) / 2 + 1.0], 0.9, 1.5, 0, 'foyer');
  }

  // ───────── 窗帘（卫生间不挂） ─────────
  const curtainMat = new THREE.MeshStandardMaterial({ color: '#f5eee2', roughness: 0.95, side: THREE.DoubleSide });
  for (const op of layout.openings) {
    if (op.kind !== 'window') continue;
    const edge = layout.edges.find((e) => e.id === op.edgeId);
    if (!edge || edge.roomId === 'bathroom') continue;
    const top = op.top + 0.12;
    const bottom = Math.max(0.04, op.bottom - 0.25);
    for (const side of [-1, 1]) {
      const w = 0.38;
      const geo = new THREE.PlaneGeometry(w, top - bottom, 12, 1);
      const pos = geo.getAttribute('position');
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getX(i) / w) * Math.PI * 6) * 0.025);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, curtainMat);
      const along = side < 0 ? op.s - w / 2 + 0.12 : op.e + w / 2 - 0.12;
      const across = op.c + edge.inside * (T / 2 + 0.09);
      if (op.orient === 'h') {
        m.position.copy(P(along, (top + bottom) / 2, across));
      } else {
        m.position.copy(P(across, (top + bottom) / 2, along));
        m.rotation.y = Math.PI / 2;
      }
      m.castShadow = true;
      group.add(m);
    }
    // 窗帘杆
    const rodLen = op.e - op.s + 0.7;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, rodLen, 8), new THREE.MeshStandardMaterial({ color: PALETTE.exterior.timber, roughness: 0.6 }));
    const across = op.c + edge.inside * (T / 2 + 0.09);
    if (op.orient === 'h') {
      rod.rotation.z = Math.PI / 2;
      rod.position.copy(P((op.s + op.e) / 2, top + 0.02, across));
    } else {
      rod.rotation.x = Math.PI / 2;
      rod.position.copy(P(across, top + 0.02, (op.s + op.e) / 2));
    }
    group.add(rod);
  }

  // ───────── 绿植（陶盆 + 一团叶子） ─────────
  const leafMat = new THREE.MeshStandardMaterial({ color: PALETTE.foliage.mid, roughness: 0.8 });
  const potMat = new THREE.MeshStandardMaterial({ color: '#e9dccb', roughness: 0.7 });
  const plant = (p: Vec2, s = 1) => {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.12 * s, 0.32 * s, 20), potMat);
    pot.position.y = 0.16 * s;
    g.add(pot);
    const r = rng(Math.round(p[0] * 100 + p[1]));
    for (let i = 0; i < 6; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15 * s, 1), leafMat);
      const a = (i / 6) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 0.12 * s, (0.48 + r() * 0.35) * s, Math.sin(a) * 0.12 * s);
      leaf.scale.set(1, 1.4, 1);
      leaf.castShadow = true;
      g.add(leaf);
    }
    g.position.copy(P(p[0], 0, p[1]));
    group.add(g);
  };
  const living = cfg.rooms.find((r) => r.id === 'living');
  if (living) {
    const b = normBounds(living);
    plant([b.x1 - 0.35, b.y0 + 0.35], 1.3);
    plant([b.x0 + 0.35, b.y0 + 0.35], 1.0);
  }
  const study = cfg.rooms.find((r) => r.id === 'study');
  if (study) {
    const b = normBounds(study);
    plant([b.x1 - 0.35, b.y1 - 0.35], 1.1);
  }
  if (foyer) {
    const b = normBounds(foyer);
    plant([b.x0 + 0.3, b.y0 + 0.3], 0.9);
  }

  // ───────── 挂画（客厅北墙、电视两侧上方） ─────────
  const tv = find('tv_stand');
  if (tv && living) {
    const b = normBounds(living);
    const frameMat = new THREE.MeshStandardMaterial({ color: PALETTE.exterior.timber, roughness: 0.6 });
    [
      { dx: -1.35, seed: 1, colors: ['#f2c4a0', '#9fc29a', '#7aa6b3'] },
      { dx: 1.35, seed: 2, colors: ['#f6dd8c', '#d9a2a0', '#8fae86'] },
    ].forEach((a) => {
      const x = tv.position[0] + a.dx;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.58, 0.03), frameMat);
      frame.position.copy(P(x, 1.65, b.y1 - T / 2 - 0.02));
      const art = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.5), new THREE.MeshStandardMaterial({ map: artTexture(a.seed, a.colors), roughness: 0.9 }));
      art.position.copy(P(x, 1.65, b.y1 - T / 2 - 0.037));
      group.add(frame, art);
    });
  }

  // ───────── 灯 ─────────
  const woodDark = new THREE.MeshStandardMaterial({ color: PALETTE.exterior.timberDark, roughness: 0.7 });
  // 客厅落地灯：沙发一端
  const sofa = find('sofa');
  if (sofa) {
    const p = localToPlan(sofa, [sofa.size[0] / 2 + 0.3, 0.1]);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.4, 8), woodDark);
    stem.position.copy(P(p[0], 0.7, p[1]));
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.03, 20), woodDark);
    base.position.copy(P(p[0], 0.015, p[1]));
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 0.26, 24, 1, true), lampShade());
    shade.position.copy(P(p[0], 1.5, p[1]));
    shade.castShadow = false;
    group.add(stem, base, shade);
    practicals.push({ position: P(p[0], 1.42, p[1]), color: PALETTE.lamp, intensity: 4.5, distance: 6 });
  }
  // 床头灯（床头柜上已有台灯模型，这里只放光源）
  const ns = find('nightstand');
  if (ns) {
    const p = ns.position;
    practicals.push({ position: P(p[0], ns.size[2] + 0.3, p[1]), color: PALETTE.lamp, intensity: 2.5, distance: 4.5 });
  }
  // 书房台灯
  const desk = find('desk');
  if (desk) {
    const p = localToPlan(desk, [desk.size[0] / 2 - 0.2, -desk.size[1] / 2 + 0.25]);
    const h = desk.size[2];
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.42, 8), woodDark);
    arm.position.copy(P(p[0], h + 0.21, p[1]));
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.12, 20, 1, true), lampShade());
    shade.position.copy(P(p[0], h + 0.44, p[1]));
    group.add(arm, shade);
    practicals.push({ position: P(p[0], h + 0.38, p[1]), color: PALETTE.lamp, intensity: 2.2, distance: 4 });
  }
  // 玄关壁灯
  if (foyer) {
    const b = normBounds(foyer);
    const p: Vec2 = [b.x0 + 0.12, (b.y0 + b.y1) / 2 + 0.3];
    const sconce = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), lampShade());
    sconce.position.copy(P(p[0], 1.9, p[1]));
    group.add(sconce);
    practicals.push({ position: P(p[0] + 0.25, 1.8, p[1]), color: PALETTE.lamp, intensity: 2.2, distance: 4.5 });
  }
  // 阳台串灯：沿花架外沿一排小灯泡，中间一盏光源
  const balcony = cfg.rooms.find((r) => r.outdoor);
  if (balcony) {
    const b = normBounds(balcony);
    const bulbMat = lampShade();
    for (let y = b.y0 + 0.3; y < b.y1; y += 0.45) {
      const sag = 0.08 * Math.sin(((y - b.y0) / 1.5) * Math.PI);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), bulbMat);
      bulb.position.copy(P(b.x1 - 0.12, 2.38 - Math.abs(sag), y));
      group.add(bulb);
    }
    practicals.push({ position: P((b.x0 + b.x1) / 2, 2.1, (b.y0 + b.y1) / 2), color: PALETTE.lamp, intensity: 3, distance: 6 });
  }

  return { group, paintBySegment, practicals, emissive };
}
