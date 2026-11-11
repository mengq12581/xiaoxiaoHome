// 地面寻路（纯函数，可单测）：
// - 障碍 = 落地墙体块 + 家具占地矩形，按角色半径膨胀；
// - 图 = rooms.json 的 nav 节点/边（被挡住的边自动停用）+ 起点、终点到所有可见节点的连线；
// - A* 找最短路，再做「拉直」（能直走就跳过中间点）。
// 无解时返回 ok=false 和原因，调用方原地停下并写警告，不许穿墙。

import type { FurnitureItem, RoomsConfig, Vec2 } from '../config/types';
import { computeWallLayout, wallPieces } from '../scene/layout';

/** 平面上的矩形障碍（可旋转） */
export interface Obstacle {
  id: string;
  kind: 'wall' | 'furniture';
  cx: number;
  cy: number;
  /** 半宽 / 半深（未膨胀） */
  hw: number;
  hh: number;
  /** 度，逆时针 */
  rot: number;
}

export interface PathResult {
  ok: boolean;
  path: Vec2[];
  reason?: 'start_blocked' | 'goal_blocked' | 'no_route';
}

export const CHARACTER_RADIUS = 0.25;
const EPS = 1e-6;

/** 墙体中落地（会挡人）的块 → 障碍 */
export function wallObstacles(rooms: RoomsConfig): Obstacle[] {
  const layout = computeWallLayout(rooms);
  const out: Obstacle[] = [];
  for (const seg of layout.segments) {
    wallPieces(seg, layout.thickness).forEach((p, i) => {
      if (p.y0 > 0.3) return; // 门楣、窗上墙不挡人
      const mid = (p.s + p.e) / 2;
      const half = (p.e - p.s) / 2;
      out.push(
        seg.orient === 'h'
          ? { id: `${seg.id}#${i}`, kind: 'wall', cx: mid, cy: seg.c, hw: half, hh: layout.thickness / 2, rot: 0 }
          : { id: `${seg.id}#${i}`, kind: 'wall', cx: seg.c, cy: mid, hw: layout.thickness / 2, hh: half, rot: 0 },
      );
    });
  }
  return out;
}

export function furnitureObstacles(items: FurnitureItem[]): Obstacle[] {
  return items
    .filter((it) => it.kind !== 'window_spot')
    .map((it) => ({
      id: it.id,
      kind: 'furniture' as const,
      cx: it.position[0],
      cy: it.position[1],
      hw: it.size[0] / 2,
      hh: it.size[1] / 2,
      rot: it.rotation,
    }));
}

/** 把点转到障碍的局部坐标 */
function toLocal(o: Obstacle, p: Vec2): Vec2 {
  const r = (-o.rot * Math.PI) / 180;
  const dx = p[0] - o.cx;
  const dy = p[1] - o.cy;
  return [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
}

export function pointInObstacle(o: Obstacle, p: Vec2, inflate: number): boolean {
  const [x, y] = toLocal(o, p);
  return Math.abs(x) < o.hw + inflate - EPS && Math.abs(y) < o.hh + inflate - EPS;
}

/** 线段是否穿过膨胀后的障碍（slab 法） */
export function segmentHitsObstacle(o: Obstacle, a: Vec2, b: Vec2, inflate: number): boolean {
  const p = toLocal(o, a);
  const q = toLocal(o, b);
  const hx = o.hw + inflate - EPS;
  const hy = o.hh + inflate - EPS;
  let t0 = 0;
  let t1 = 1;
  const d = [q[0] - p[0], q[1] - p[1]];
  const lo = [-hx, -hy];
  const hi = [hx, hy];
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < EPS) {
      if (p[k] <= lo[k] || p[k] >= hi[k]) return false;
    } else {
      let ta = (lo[k] - p[k]) / d[k];
      let tb = (hi[k] - p[k]) / d[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1) return false;
    }
  }
  return true;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class Pathfinder {
  /** 被障碍挡住而停用的配置边 / 节点（调试、日志用） */
  readonly blockedEdges: [number, number][] = [];
  readonly blockedNodes: number[] = [];

  constructor(
    private nodes: Vec2[],
    private edges: [number, number][],
    private obstacles: Obstacle[],
    private radius = CHARACTER_RADIUS,
  ) {
    this.refresh();
  }

  /** 家具移动后换一套障碍 */
  setObstacles(obstacles: Obstacle[]) {
    this.obstacles = obstacles;
    this.refresh();
  }

  private refresh() {
    this.blockedNodes.length = 0;
    this.blockedEdges.length = 0;
    this.nodes.forEach((n, i) => {
      if (!this.isFree(n)) this.blockedNodes.push(i);
    });
    for (const [a, b] of this.edges) {
      if (this.blockedNodes.includes(a) || this.blockedNodes.includes(b) || !this.isClear(this.nodes[a], this.nodes[b])) {
        this.blockedEdges.push([a, b]);
      }
    }
  }

  isFree(p: Vec2, ignore: Set<string> = new Set()): boolean {
    return !this.obstacles.some((o) => !ignore.has(o.id) && pointInObstacle(o, p, this.radius));
  }

  isClear(a: Vec2, b: Vec2, ignore: Set<string> = new Set()): boolean {
    return !this.obstacles.some((o) => !ignore.has(o.id) && segmentHitsObstacle(o, a, b, this.radius));
  }

  findPath(start: Vec2, goal: Vec2): PathResult {
    if (!this.isFree(goal)) return { ok: false, path: [start], reason: 'goal_blocked' };
    // 起点若落在障碍里（比如刚从座位起身），从它出发的线段忽略那些障碍
    const startIgnore = new Set(this.obstacles.filter((o) => pointInObstacle(o, start, this.radius)).map((o) => o.id));
    const clearFrom = (a: Vec2, b: Vec2, fromStart: boolean) => this.isClear(a, b, fromStart ? startIgnore : undefined);

    if (clearFrom(start, goal, true)) return { ok: true, path: [start, goal] };

    // 图：0..n-1 配置节点，n = 起点，n+1 = 终点
    const n = this.nodes.length;
    const S = n;
    const G = n + 1;
    const pts: Vec2[] = [...this.nodes, start, goal];
    const adj: number[][] = pts.map(() => []);
    const blockedNode = new Set(this.blockedNodes);
    const blockedEdge = new Set(this.blockedEdges.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
    for (const [a, b] of this.edges) {
      if (blockedEdge.has(`${Math.min(a, b)}-${Math.max(a, b)}`)) continue;
      adj[a].push(b);
      adj[b].push(a);
    }
    let startLinked = false;
    for (let i = 0; i < n; i++) {
      if (blockedNode.has(i)) continue;
      if (clearFrom(start, pts[i], true)) {
        adj[S].push(i);
        adj[i].push(S);
        startLinked = true;
      }
      if (this.isClear(pts[i], goal)) {
        adj[G].push(i);
        adj[i].push(G);
      }
    }
    if (!startLinked) return { ok: false, path: [start], reason: 'start_blocked' };

    // A*
    const g = new Array(pts.length).fill(Infinity);
    const prev = new Array<number>(pts.length).fill(-1);
    const open = new Set<number>([S]);
    g[S] = 0;
    const f = (i: number) => g[i] + dist(pts[i], goal);
    while (open.size) {
      let cur = -1;
      for (const i of open) if (cur < 0 || f(i) < f(cur)) cur = i;
      if (cur === G) break;
      open.delete(cur);
      for (const nb of adj[cur]) {
        const cand = g[cur] + dist(pts[cur], pts[nb]);
        if (cand < g[nb] - EPS) {
          g[nb] = cand;
          prev[nb] = cur;
          open.add(nb);
        }
      }
    }
    if (!Number.isFinite(g[G])) return { ok: false, path: [start], reason: 'no_route' };

    const raw: Vec2[] = [];
    for (let i = G; i >= 0; i = prev[i]) {
      raw.unshift(pts[i]);
      if (i === S) break;
    }
    return { ok: true, path: this.smooth(raw, startIgnore) };
  }

  /** 拉直：从当前点出发，跳到最远的可直达点 */
  private smooth(path: Vec2[], startIgnore: Set<string>): Vec2[] {
    const out: Vec2[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !this.isClear(path[i], path[j], i === 0 ? startIgnore : undefined)) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }
}

export function pathLength(path: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += dist(path[i - 1], path[i]);
  return s;
}
