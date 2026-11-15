// 由 rooms.json 生成地板、墙体（真实开洞、每段独立 mesh）、门框、窗框与玻璃。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { RoomsConfig } from '../config/types';
import { computeWallLayout, normBounds, wallPieces, type Opening, type WallSegment } from './layout';
import { ROUGH, soft } from './materials';
import { FLOOR_TEXTURE_METERS, floorTexture } from './textures';

/** 平面 (x, y) + 高度 → 世界坐标 */
export const P = (x: number, h: number, y: number) => new THREE.Vector3(x, h, -y);

export interface WallView {
  segment: WallSegment;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  material: THREE.MeshStandardMaterial;
  edges: THREE.LineSegments;
  edgeMaterial: THREE.LineBasicMaterial;
  /** 当前不透明度（渐变中） */
  opacity: number;
}

export interface HouseView {
  root: THREE.Group;
  walls: WallView[];
  floors: THREE.Mesh[];
  /** 窗玻璃（不参与环境光遮蔽） */
  glass: THREE.Object3D[];
  /** 每个房间的中心点（世界坐标，离地 0.6m） */
  roomCenters: { roomId: string; point: THREE.Vector3 }[];
  /** 每个房间地面上的采样点（约 1m 一个，贴墙内缩 0.35m，离地 0.5m），用于墙体遮挡检测 */
  roomSamples: THREE.Vector3[];
  /** 全屋包围盒（世界坐标，含墙高） */
  box: THREE.Box3;
  wallHeight: number;
}

const WALL_COLOR = 0xe6d7c3;
const WALL_EDGE_COLOR = 0x9c8975;
const TRIM_COLOR = 0xf8f4ee;
const FRAME_COLOR = 0xd9c2a3;

/** 沿墙方向 s..e、高度 y0..y1、厚度 t 的盒子，返回几何体与中心 */
function wallBox(seg: Pick<WallSegment, 'orient' | 'c'>, s: number, e: number, y0: number, y1: number, t: number) {
  const len = e - s;
  const h = y1 - y0;
  const mid = (s + e) / 2;
  const geo = seg.orient === 'h' ? new THREE.BoxGeometry(len, h, t) : new THREE.BoxGeometry(t, h, len);
  const pos = seg.orient === 'h' ? P(mid, (y0 + y1) / 2, seg.c) : P(seg.c, (y0 + y1) / 2, mid);
  return { geo, pos };
}

function buildWall(seg: WallSegment, thickness: number): WallView {
  const group = new THREE.Group();
  group.name = `wall:${seg.id}`;
  const material = soft(WALL_COLOR, { roughness: ROUGH.wall, transparent: true, opacity: 1 });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: WALL_EDGE_COLOR, transparent: true, opacity: 0.85 });
  const meshes: THREE.Mesh[] = [];
  const edgeGeos: THREE.BufferGeometry[] = [];
  for (const piece of wallPieces(seg, thickness)) {
    const { geo, pos } = wallBox(seg, piece.s, piece.e, piece.y0, piece.y1, thickness);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(pos);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.wallId = seg.id;
    group.add(mesh);
    meshes.push(mesh);
    const eg = new THREE.EdgesGeometry(geo);
    eg.translate(pos.x, pos.y, pos.z);
    edgeGeos.push(eg);
  }
  const edges = new THREE.LineSegments(mergeLineGeometries(edgeGeos), edgeMaterial);
  edges.renderOrder = 2;
  group.add(edges);
  return { segment: seg, group, meshes, material, edges, edgeMaterial, opacity: 1 };
}

function mergeLineGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const total = geos.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const arr = new Float32Array(total * 3);
  let off = 0;
  for (const g of geos) {
    const a = g.getAttribute('position').array as Float32Array;
    arr.set(a, off);
    off += a.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return out;
}

const trimMat = soft(TRIM_COLOR, { roughness: ROUGH.trim });
const frameMat = soft(FRAME_COLOR, { roughness: ROUGH.wood });
const glassMat = soft(0xcfe6f2, { roughness: 0.15, transparent: true, opacity: 0.28, depthWrite: false });

/** 与 wallBox 同尺寸的圆角盒（门窗框用，边角不尖） */
function roundedWallBox(seg: Pick<WallSegment, 'orient' | 'c'>, s: number, e: number, y0: number, y1: number, t: number, radius = 0.012) {
  const len = e - s;
  const h = y1 - y0;
  const r = Math.min(radius, Math.min(len, h, t) * 0.45);
  const geo = seg.orient === 'h' ? new RoundedBoxGeometry(len, h, t, 2, r) : new RoundedBoxGeometry(t, h, len, 2, r);
  const pos = seg.orient === 'h' ? P((s + e) / 2, (y0 + y1) / 2, seg.c) : P(seg.c, (y0 + y1) / 2, (s + e) / 2);
  return { geo, pos };
}

/** 门洞上方内角的四分之一圆角块：side = -1 左角（贴 op.s），+1 右角（贴 op.e） */
function doorFillet(op: Opening, side: -1 | 1, R: number, t: number): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  if (side === -1) {
    shape.lineTo(R, 0);
    shape.absarc(R, -R, R, Math.PI / 2, Math.PI, false);
  } else {
    shape.lineTo(-R, 0);
    shape.absarc(-R, -R, R, Math.PI / 2, 0, true);
  }
  shape.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 16 });
  geo.translate(0, 0, -t / 2);
  const m = new THREE.Mesh(geo, trimMat);
  const along = side === -1 ? op.s : op.e;
  if (op.orient === 'h') {
    m.position.copy(P(along, op.top, op.c));
  } else {
    m.position.copy(P(op.c, op.top, along));
    m.rotation.y = Math.PI / 2;
  }
  return m;
}

/** 门框（两侧立框 + 上框 + 上方两个圆角），略厚于墙，所有边角倒圆 */
function buildDoorFrame(op: Opening, thickness: number): THREE.Group {
  const g = new THREE.Group();
  g.name = `door:${op.id}`;
  const w = 0.06;
  const t = thickness + 0.03;
  const parts: [number, number, number, number][] = [
    [op.s - w, op.s, 0, op.top + w],
    [op.e, op.e + w, 0, op.top + w],
    [op.s - w / 2, op.e + w / 2, op.top, op.top + w],
  ];
  for (const [s, e, y0, y1] of parts) {
    const { geo, pos } = roundedWallBox(op, s, e, y0, y1, t);
    const m = new THREE.Mesh(geo, trimMat);
    m.position.copy(pos);
    g.add(m);
  }
  for (const side of [-1, 1] as const) g.add(doorFillet(op, side, 0.09, t - 0.004));
  return g;
}

/** 窗框 + 中梃 + 玻璃 */
function buildWindow(op: Opening, thickness: number): THREE.Group {
  const g = new THREE.Group();
  g.name = `window:${op.id}`;
  const f = 0.05;
  const t = thickness + 0.02;
  const bars: [number, number, number, number][] = [
    [op.s, op.s + f, op.bottom, op.top],
    [op.e - f, op.e, op.bottom, op.top],
    [op.s, op.e, op.bottom, op.bottom + f],
    [op.s, op.e, op.top - f, op.top],
  ];
  const width = op.e - op.s;
  const panes = Math.max(1, Math.round(width / 0.8));
  for (let i = 1; i < panes; i++) {
    const x = op.s + (width * i) / panes;
    bars.push([x - f / 2, x + f / 2, op.bottom, op.top]);
  }
  // 普通窗加一道横档
  if (op.bottom > 0.3) {
    const y = op.bottom + (op.top - op.bottom) * 0.62;
    bars.push([op.s, op.e, y - f / 2, y + f / 2]);
  }
  for (const [s, e, y0, y1] of bars) {
    const { geo, pos } = roundedWallBox(op, s, e, y0, y1, t, 0.01);
    const m = new THREE.Mesh(geo, frameMat);
    m.position.copy(pos);
    g.add(m);
  }
  const { geo, pos } = wallBox(op, op.s + f, op.e - f, op.bottom + f, op.top - f, 0.015);
  const glass = new THREE.Mesh(geo, glassMat);
  glass.position.copy(pos);
  glass.renderOrder = 1;
  glass.name = 'glass';
  g.add(glass);
  // 窗台板
  if (op.bottom > 0.3) {
    const sill = roundedWallBox(op, op.s - 0.05, op.e + 0.05, op.bottom - 0.03, op.bottom, thickness + 0.12);
    const m = new THREE.Mesh(sill.geo, trimMat);
    m.position.copy(sill.pos);
    g.add(m);
  }
  return g;
}

export function buildHouse(cfg: RoomsConfig): HouseView {
  const root = new THREE.Group();
  root.name = 'house';
  const layout = computeWallLayout(cfg);
  const T = layout.thickness;
  const wallHeight = Math.max(...layout.segments.map((s) => s.height));

  // 地面
  const floors: THREE.Mesh[] = [];
  const roomCenters: HouseView['roomCenters'] = [];
  const roomSamples: THREE.Vector3[] = [];
  for (const room of cfg.rooms) {
    const b = normBounds(room);
    const w = b.x1 - b.x0;
    const d = b.y1 - b.y0;
    const tex = floorTexture(room.floor).clone();
    tex.needsUpdate = true;
    tex.repeat.set(w / FLOOR_TEXTURE_METERS, d / FLOOR_TEXTURE_METERS);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), soft(0xffffff, { map: tex, roughness: ROUGH.floor }));
    floor.position.copy(P((b.x0 + b.x1) / 2, -0.03, (b.y0 + b.y1) / 2));
    floor.receiveShadow = true;
    floor.name = `floor:${room.id}`;
    floor.userData.roomId = room.id;
    root.add(floor);
    floors.push(floor);
    roomCenters.push({ roomId: room.id, point: P((b.x0 + b.x1) / 2, 0.6, (b.y0 + b.y1) / 2) });
    const inset = 0.35;
    const nx = Math.max(2, Math.round((w - 2 * inset) / 1.0) + 1);
    const ny = Math.max(2, Math.round((d - 2 * inset) / 1.0) + 1);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const x = b.x0 + inset + ((w - 2 * inset) * i) / (nx - 1);
        const y = b.y0 + inset + ((d - 2 * inset) * j) / (ny - 1);
        roomSamples.push(P(x, 0.5, y));
      }
  }

  // 墙
  const walls = layout.segments.map((seg) => buildWall(seg, T));
  for (const w of walls) root.add(w.group);

  // 门框、窗
  for (const op of layout.openings) {
    root.add(op.kind === 'door' ? buildDoorFrame(op, T) : buildWindow(op, T));
  }

  const box = new THREE.Box3();
  for (const f of floors) box.expandByObject(f);
  box.max.y = Math.max(box.max.y, wallHeight);
  box.expandByVector(new THREE.Vector3(T / 2, 0, T / 2));

  const glass: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === 'glass') glass.push(o);
  });

  return { root, walls, floors, glass, roomCenters, roomSamples, box, wallHeight };
}
