// 纯几何：由 rooms.json 推出墙段、门窗洞、墙体分块。不依赖 three.js，可在 Node 里单测。
//
// 平面坐标 (x, y) → three.js 世界坐标 (x, 高度, -y)。

import type { FurnitureItem, RoomSpec, RoomsConfig, Vec2, WindowSpec } from '../config/types';

export const EPS = 1e-4;
export const DEFAULT_WALL_HEIGHT = 2.6;
export const DEFAULT_WALL_THICKNESS = 0.12;
export const DEFAULT_DOOR_HEIGHT = 2.1;
export const DEFAULT_WINDOW_SILL = 0.9;
export const DEFAULT_WINDOW_TOP = 2.1;

export type Side = 'bottom' | 'top' | 'left' | 'right';
export type Orient = 'h' | 'v';

/** 一个房间的一面墙（自动生成） */
export interface WallEdge {
  id: string;
  roomId: string;
  side: Side;
  /** h：沿 x 方向的墙（线 y=c）；v：沿 y 方向的墙（线 x=c） */
  orient: Orient;
  c: number;
  /** 沿墙方向的起止坐标，a < b */
  a: number;
  b: number;
  /** 房间在墙线的哪一侧：+1 = 坐标更大的一侧 */
  inside: 1 | -1;
  from: Vec2;
  to: Vec2;
  height: number;
}

export interface Opening {
  id: string;
  kind: 'door' | 'window';
  edgeId: string;
  orient: Orient;
  c: number;
  /** 沿墙方向起止 */
  s: number;
  e: number;
  bottom: number;
  top: number;
}

/** 合并后的墙段：同一条线上、覆盖同一组房间边的连续区间 */
export interface WallSegment {
  id: string;
  orient: Orient;
  c: number;
  a: number;
  b: number;
  height: number;
  interior: boolean;
  edgeIds: string[];
  rooms: string[];
  /** 外墙的朝外法线（平面坐标）；内墙为 null */
  outward: Vec2 | null;
  openings: Opening[];
}

/** 墙体实心块（沿墙方向 s..e，高度 y0..y1） */
export interface WallPiece {
  s: number;
  e: number;
  y0: number;
  y1: number;
}

export interface WallLayout {
  thickness: number;
  edges: WallEdge[];
  segments: WallSegment[];
  openings: Opening[];
}

export function normBounds(room: RoomSpec): { x0: number; y0: number; x1: number; y1: number } {
  const [[ax, ay], [bx, by]] = room.bounds;
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export function roomEdges(room: RoomSpec, defaultHeight: number): WallEdge[] {
  const { x0, y0, x1, y1 } = normBounds(room);
  const heightOf = (id: string) => room.walls?.find((w) => w.id === id)?.height ?? defaultHeight;
  const mk = (side: Side, orient: Orient, c: number, a: number, b: number, inside: 1 | -1, from: Vec2, to: Vec2): WallEdge => {
    const id = `${room.id}_${side}`;
    return { id, roomId: room.id, side, orient, c, a, b, inside, from, to, height: heightOf(id) };
  };
  return [
    mk('bottom', 'h', y0, x0, x1, 1, [x0, y0], [x1, y0]),
    mk('top', 'h', y1, x0, x1, -1, [x0, y1], [x1, y1]),
    mk('left', 'v', x0, y0, y1, 1, [x0, y0], [x0, y1]),
    mk('right', 'v', x1, y0, y1, -1, [x1, y0], [x1, y1]),
  ];
}

export function allEdges(cfg: RoomsConfig): WallEdge[] {
  const h = cfg.wall_height ?? DEFAULT_WALL_HEIGHT;
  return cfg.rooms.flatMap((r) => roomEdges(r, h));
}

/** 平面点在墙线上的沿墙坐标 */
export function alongOf(orient: Orient, p: Vec2): number {
  return orient === 'h' ? p[0] : p[1];
}
export function acrossOf(orient: Orient, p: Vec2): number {
  return orient === 'h' ? p[1] : p[0];
}

/** 窗的起止（沿墙坐标）。span 是距 `from` 的米数，方向 from → to。 */
export function windowRange(edge: WallEdge, from: Vec2, to: Vec2, win: WindowSpec): { s: number; e: number; sill: number; top: number; id?: string } {
  const obj = Array.isArray(win) ? { span: win as Vec2 } : win;
  const f = alongOf(edge.orient, from);
  const dir = Math.sign(alongOf(edge.orient, to) - f) || 1;
  const p = f + dir * obj.span[0];
  const q = f + dir * obj.span[1];
  return {
    s: Math.min(p, q),
    e: Math.max(p, q),
    sill: obj.sill ?? DEFAULT_WINDOW_SILL,
    top: obj.top ?? DEFAULT_WINDOW_TOP,
    id: obj.id,
  };
}

export function collectOpenings(cfg: RoomsConfig, edges: WallEdge[]): Opening[] {
  const out: Opening[] = [];
  for (const room of cfg.rooms) {
    for (const door of room.doors ?? []) {
      const edge = edges.find((e) => e.id === door.wall);
      if (!edge) continue;
      const mid = alongOf(edge.orient, door.at);
      out.push({
        id: door.id,
        kind: 'door',
        edgeId: edge.id,
        orient: edge.orient,
        c: edge.c,
        s: mid - door.width / 2,
        e: mid + door.width / 2,
        bottom: 0,
        top: door.height ?? DEFAULT_DOOR_HEIGHT,
      });
    }
    for (const wall of room.walls ?? []) {
      const edge = edges.find((e) => e.id === wall.id);
      if (!edge) continue;
      (wall.windows ?? []).forEach((win, i) => {
        const r = windowRange(edge, wall.from ?? edge.from, wall.to ?? edge.to, win);
        out.push({
          id: r.id ?? `${wall.id}_window_${i}`,
          kind: 'window',
          edgeId: edge.id,
          orient: edge.orient,
          c: edge.c,
          s: r.s,
          e: r.e,
          bottom: r.sill,
          top: r.top,
        });
      });
    }
  }
  return out;
}

const lineKey = (o: Orient, c: number) => `${o}:${c.toFixed(4)}`;

export function computeWallLayout(cfg: RoomsConfig): WallLayout {
  const thickness = cfg.wall_thickness ?? DEFAULT_WALL_THICKNESS;
  const edges = allEdges(cfg);
  const openings = collectOpenings(cfg, edges);

  const lines = new Map<string, WallEdge[]>();
  for (const e of edges) {
    const k = lineKey(e.orient, e.c);
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k)!.push(e);
  }

  const segments: WallSegment[] = [];
  for (const lineEdges of lines.values()) {
    const { orient, c } = lineEdges[0];
    const pts = [...new Set(lineEdges.flatMap((e) => [e.a, e.b]).map((v) => +v.toFixed(4)))].sort((p, q) => p - q);
    let current: WallSegment | null = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (q - p < EPS) continue;
      const cover = lineEdges.filter((e) => e.a <= p + EPS && e.b >= q - EPS);
      if (cover.length === 0) {
        current = null;
        continue;
      }
      const ids = cover.map((e) => e.id).sort();
      const pos = cover.some((e) => e.inside === 1);
      const neg = cover.some((e) => e.inside === -1);
      const interior = pos && neg;
      const outward: Vec2 | null = interior
        ? null
        : orient === 'h'
          ? [0, pos ? -1 : 1]
          : [pos ? -1 : 1, 0];
      if (current && Math.abs(current.b - p) < EPS && current.edgeIds.join('|') === ids.join('|')) {
        current.b = q;
        continue;
      }
      current = {
        id: ids.join('+'),
        orient,
        c,
        a: p,
        b: q,
        height: Math.max(...cover.map((e) => e.height)),
        interior,
        edgeIds: ids,
        rooms: [...new Set(cover.map((e) => e.roomId))],
        outward,
        openings: [],
      };
      segments.push(current);
    }
  }

  // 同名墙段（同一组边被不连续地切开时）加序号区分
  const seen = new Map<string, number>();
  for (const s of segments) {
    const n = seen.get(s.id) ?? 0;
    seen.set(s.id, n + 1);
    if (n > 0) s.id = `${s.id}#${n}`;
  }

  for (const op of openings) {
    for (const s of segments) {
      if (s.orient === op.orient && Math.abs(s.c - op.c) < EPS && op.s < s.b - EPS && op.e > s.a + EPS) {
        s.openings.push(op);
      }
    }
  }

  return { thickness, edges, segments, openings };
}

/** 把墙段按门窗洞切成实心块；两端各外延半个墙厚以封住墙角。 */
export function wallPieces(seg: WallSegment, thickness: number): WallPiece[] {
  const H = seg.height;
  const cuts = new Set<number>([seg.a, seg.b]);
  for (const op of seg.openings) {
    cuts.add(Math.max(seg.a, Math.min(seg.b, op.s)));
    cuts.add(Math.max(seg.a, Math.min(seg.b, op.e)));
  }
  const pts = [...cuts].sort((p, q) => p - q);
  const pieces: WallPiece[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (q - p < EPS) continue;
    const mid = (p + q) / 2;
    const op = seg.openings.find((o) => o.s <= mid && o.e >= mid);
    const s = Math.abs(p - seg.a) < EPS ? p - thickness / 2 : p;
    const e = Math.abs(q - seg.b) < EPS ? q + thickness / 2 : q;
    if (!op) {
      pieces.push({ s, e, y0: 0, y1: H });
    } else {
      if (op.bottom > EPS) pieces.push({ s, e, y0: 0, y1: Math.min(op.bottom, H) });
      if (op.top < H - EPS) pieces.push({ s, e, y0: op.top, y1: H });
    }
  }
  return pieces;
}

/** 全屋外接矩形（平面） */
export function houseBounds(cfg: RoomsConfig): { x0: number; y0: number; x1: number; y1: number } {
  const bs = cfg.rooms.map(normBounds);
  return {
    x0: Math.min(...bs.map((b) => b.x0)),
    y0: Math.min(...bs.map((b) => b.y0)),
    x1: Math.max(...bs.map((b) => b.x1)),
    y1: Math.max(...bs.map((b) => b.y1)),
  };
}

// ───────── 家具局部坐标 ─────────

/** 平面上逆时针旋转 */
export function rotate2(v: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

/** 家具局部 [右, 前] → 全屋平面坐标 */
export function localToPlan(item: Pick<FurnitureItem, 'position' | 'rotation'>, local: Vec2): Vec2 {
  const [dx, dy] = rotate2(local, item.rotation);
  return [item.position[0] + dx, item.position[1] + dy];
}

/** 家具占地矩形的四个角（平面） */
export function footprint(item: Pick<FurnitureItem, 'position' | 'rotation' | 'size'>): Vec2[] {
  const hw = item.size[0] / 2;
  const hd = item.size[1] / 2;
  return ([
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ] as Vec2[]).map((p) => localToPlan(item, p));
}

/** 交互点的平面位置、高度与人物朝向（平面角，度，0 = +x，逆时针） */
export function anchorPose(
  item: Pick<FurnitureItem, 'position' | 'rotation'>,
  anchor: { local: [number, number, number]; facing: 'forward' | 'toward' },
): { plan: Vec2; height: number; headingDeg: number } {
  const plan = localToPlan(item, [anchor.local[0], anchor.local[1]]);
  // 家具正面在 0° 时朝 +y（平面角 90°）
  const forwardDeg = 90 + item.rotation;
  const headingDeg = anchor.facing === 'forward' ? forwardDeg : forwardDeg + 180;
  return { plan, height: anchor.local[2], headingDeg: ((headingDeg % 360) + 360) % 360 };
}
