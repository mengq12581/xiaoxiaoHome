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

/** 可走区域：各房间（含阳台）的矩形范围 */
export interface WalkArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 绕障碍时离膨胀后的边角再多留的余量（米），免得贴着家具角擦过去 */
const CORNER_MARGIN = 0.06;

export class Pathfinder {
  /** 被障碍挡住而停用的配置边 / 节点（调试、日志用） */
  readonly blockedEdges: [number, number][] = [];
  readonly blockedNodes: number[] = [];
  /** 寻路用的全部路点：可用的配置导航点 + 障碍物四角外侧的绕行点 */
  private waypoints: Vec2[] = [];
  /** 路点两两之间能否直走（按需计算并缓存，障碍变了就清空） */
  private sight = new Map<number, boolean>();

  /**
   * @param walkable 可走区域（房间范围）。给了它才会在障碍物四角生成绕行点——
   *   绕行点必须落在房间里，否则会从屋外绕路。不给则只用配置里的导航点。
   */
  constructor(
    private nodes: Vec2[],
    private edges: [number, number][],
    private obstacles: Obstacle[],
    private radius = CHARACTER_RADIUS,
    private walkable: WalkArea[] | null = null,
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
    const blocked = new Set(this.blockedNodes);
    this.waypoints = this.nodes.filter((_, i) => !blocked.has(i));
    if (this.walkable) {
      for (const o of this.obstacles) {
        const r = (o.rot * Math.PI) / 180;
        const hx = o.hw + this.radius + CORNER_MARGIN;
        const hy = o.hh + this.radius + CORNER_MARGIN;
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const lx = sx * hx;
          const ly = sy * hy;
          const p: Vec2 = [o.cx + lx * Math.cos(r) - ly * Math.sin(r), o.cy + lx * Math.sin(r) + ly * Math.cos(r)];
          if (this.inWalkable(p) && this.isFree(p)) this.waypoints.push(p);
        }
      }
    }
    this.sight.clear();
  }

  private inWalkable(p: Vec2): boolean {
    return !this.walkable || this.walkable.some((a) => p[0] >= a.x0 && p[0] <= a.x1 && p[1] >= a.y0 && p[1] <= a.y1);
  }

  isFree(p: Vec2, ignore: Set<string> = new Set()): boolean {
    return !this.obstacles.some((o) => !ignore.has(o.id) && pointInObstacle(o, p, this.radius));
  }

  isClear(a: Vec2, b: Vec2, ignore: Set<string> = new Set()): boolean {
    return !this.obstacles.some((o) => !ignore.has(o.id) && segmentHitsObstacle(o, a, b, this.radius));
  }

  /** 两个路点之间能否直走（带缓存） */
  private sees(i: number, j: number): boolean {
    const key = i < j ? i * 100000 + j : j * 100000 + i;
    let v = this.sight.get(key);
    if (v === undefined) {
      v = this.isClear(this.waypoints[i], this.waypoints[j]);
      this.sight.set(key, v);
    }
    return v;
  }

  /**
   * 最短路：在「起点、终点、全部路点」的可视图上做 A*（两点之间能直走就有边）。
   * 路点包含障碍物四角外侧的绕行点，所以绕家具、过门洞走的是几何上最短的折线，
   * 不再被几个手工导航点牵着绕远。
   */
  findPath(start: Vec2, goal: Vec2): PathResult {
    if (!this.isFree(goal)) return { ok: false, path: [start], reason: 'goal_blocked' };
    // 起点若落在障碍里（比如刚从座位起身），从它出发的线段忽略那些障碍
    const startIgnore = new Set(this.obstacles.filter((o) => pointInObstacle(o, start, this.radius)).map((o) => o.id));
    if (this.isClear(start, goal, startIgnore)) return { ok: true, path: [start, goal] };

    // 图：0..n-1 路点，n = 起点，n+1 = 终点
    const n = this.waypoints.length;
    const S = n;
    const G = n + 1;
    const pts: Vec2[] = [...this.waypoints, start, goal];
    const fromStart = this.waypoints.map((p) => this.isClear(start, p, startIgnore));
    if (!fromStart.some(Boolean)) return { ok: false, path: [start], reason: 'start_blocked' };
    const toGoal = this.waypoints.map((p) => this.isClear(p, goal));
    const linked = (a: number, b: number): boolean => {
      if (a === b) return false;
      if (a > b) [a, b] = [b, a];
      if (b === G) return a === S ? false : toGoal[a];
      if (b === S) return fromStart[a];
      return this.sees(a, b);
    };

    // A*
    const g = new Array(pts.length).fill(Infinity);
    const prev = new Array<number>(pts.length).fill(-1);
    const open = new Set<number>([S]);
    const closed = new Set<number>();
    g[S] = 0;
    const f = (i: number) => g[i] + dist(pts[i], goal);
    while (open.size) {
      let cur = -1;
      for (const i of open) if (cur < 0 || f(i) < f(cur)) cur = i;
      if (cur === G) break;
      open.delete(cur);
      closed.add(cur);
      for (let nb = 0; nb < pts.length; nb++) {
        if (closed.has(nb)) continue;
        const cand = g[cur] + dist(pts[cur], pts[nb]);
        if (cand >= g[nb] - EPS) continue;
        if (!linked(cur, nb)) continue;
        g[nb] = cand;
        prev[nb] = cur;
        open.add(nb);
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

/** 按配置建寻路器：墙 + 家具为障碍，房间范围为可走区域（带绕行点） */
export function createPathfinder(rooms: RoomsConfig, items: FurnitureItem[], extra: Obstacle[] = []): Pathfinder {
  const areas: WalkArea[] = rooms.rooms.map((r) => {
    const [[ax, ay], [bx, by]] = r.bounds;
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  });
  return new Pathfinder(rooms.nav.nodes, rooms.nav.edges as [number, number][], [...wallObstacles(rooms), ...furnitureObstacles(items), ...extra], CHARACTER_RADIUS, areas);
}

export function pathLength(path: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += dist(path[i - 1], path[i]);
  return s;
}
