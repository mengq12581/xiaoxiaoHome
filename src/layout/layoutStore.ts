// 家具布局的数据层（不依赖 three.js / DOM，可单测）：
//   - 判断一件家具（连同它的联动组）挪到某处 / 转个方向后「放不放得下」；
//   - 一步步撤销；
//   - 存取 localStorage["xiaoxiao-home.layout"]（docs/数据与接口约定.md §5）；恢复默认；导出。
// 约束：整件家具必须落在同一个房间里（不骑墙、不堵在门洞里），不与别的家具重叠，不能压到人身上。

import type { FurnitureItem, RoomsConfig, Vec2 } from '../config/types';
import { footprint, normBounds, placementBounds, rotate2, DEFAULT_WALL_THICKNESS } from '../scene/layout';

export const LAYOUT_KEY = 'xiaoxiao-home.layout';
/** 家具与墙面之间留的缝（米） */
const WALL_GAP = 0.01;
/** 两件家具之间允许的重叠容差（米）：贴在一起不算重叠 */
const TOUCH_EPS = 0.005;
const UNDO_LIMIT = 50;

export interface Placement {
  position: Vec2;
  rotation: number;
}
export type LayoutSnapshot = Record<string, Placement>;

/** 存进 localStorage 的结构：全量家具的位置与旋转，外加保存时的默认布局（用来发现配置文件被改过） */
export interface StoredLayout {
  version: 1;
  items: { id: string; position: Vec2; rotation: number }[];
  base: LayoutSnapshot;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PlaceIssue = 'outside_room' | 'overlap' | 'on_character';

export const ISSUE_TEXT: Record<PlaceIssue, string> = {
  outside_room: '放不下：会卡进墙里或超出房间',
  overlap: '放不下：会和别的家具叠在一起',
  on_character: '放不下：会压到她',
};

export interface Blocker {
  position: Vec2;
  radius: number;
}

type Rect = Pick<FurnitureItem, 'position' | 'rotation' | 'size'>;

const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** 两个（可旋转的）矩形是否重叠：分离轴定理。margin > 0 表示允许这么多的重叠 */
export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  const pa = footprint(a);
  const pb = footprint(b);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < 2; i++) {
      const p = poly[i];
      const q = poly[i + 1];
      const ax = [-(q[1] - p[1]), q[0] - p[0]];
      const len = Math.hypot(ax[0], ax[1]) || 1;
      const proj = (pts: Vec2[]) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of pts) {
          const d = (v[0] * ax[0] + v[1] * ax[1]) / len;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return [lo, hi];
      };
      const [a0, a1] = proj(pa);
      const [b0, b1] = proj(pb);
      if (a1 - margin <= b0 || b1 - margin <= a0) return false;
    }
  }
  return true;
}

/** 圆（人）是否碰到矩形 */
export function rectHitsCircle(r: Rect, c: Vec2, radius: number): boolean {
  const [lx, ly] = rotate2([c[0] - r.position[0], c[1] - r.position[1]], -r.rotation);
  const dx = Math.max(0, Math.abs(lx) - r.size[0] / 2);
  const dy = Math.max(0, Math.abs(ly) - r.size[1] / 2);
  return Math.hypot(dx, dy) < radius - 1e-6;
}

/**
 * 这块矩形完整落在哪个房间里（留出墙厚）；骑墙或出界返回 null。
 * 中间不砌墙（open）的几个房间合起来算一块（例如玄关 + 客厅）：可以跨过分界线摆，归属按中心点所在的房间。
 */
export function roomContaining(r: Rect, rooms: RoomsConfig): string | null {
  const inset = (rooms.wall_thickness ?? DEFAULT_WALL_THICKNESS) / 2 + WALL_GAP;
  const pts = footprint(r);
  const inside = (b: { x0: number; y0: number; x1: number; y1: number }, p: Vec2) =>
    p[0] >= b.x0 + inset - 1e-9 && p[0] <= b.x1 - inset + 1e-9 && p[1] >= b.y0 + inset - 1e-9 && p[1] <= b.y1 - inset + 1e-9;
  for (const room of rooms.rooms) {
    const b = normBounds(room);
    if (pts.every((p) => inside(b, p))) return room.id;
  }
  const c = r.position;
  const home = rooms.rooms.find((room) => {
    const b = normBounds(room);
    return c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1;
  });
  if (!home) return null;
  const merged = placementBounds(rooms, home.id);
  return merged && pts.every((p) => inside(merged, p)) ? home.id : null;
}

export class LayoutStore {
  /** config/furniture.json 里的默认布局 */
  readonly defaults: LayoutSnapshot;
  private undoStack: LayoutSnapshot[] = [];

  /**
   * @param items 场景正在用的家具条目（就地修改：位置、旋转、所在房间）
   */
  constructor(
    readonly items: FurnitureItem[],
    private rooms: RoomsConfig,
    private storage: StorageLike | null = null,
    private log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {
    this.defaults = this.snapshot();
  }

  snapshot(): LayoutSnapshot {
    return Object.fromEntries(this.items.map((it) => [it.id, { position: [it.position[0], it.position[1]] as Vec2, rotation: it.rotation }]));
  }

  item(id: string): FurnitureItem | undefined {
    return this.items.find((it) => it.id === id);
  }

  /** 联动组：拖其中一件，同组的一起动（group 为 null 的自己一组） */
  groupOf(id: string): FurnitureItem[] {
    const it = this.item(id);
    if (!it) return [];
    return it.group ? this.items.filter((o) => o.group === it.group) : [it];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get isDefault() {
    return sameSnapshot(this.snapshot(), this.defaults);
  }

  // ───────── 放不放得下 ─────────

  /**
   * 检查 ids 这些家具按 next 摆放是否可行；可行返回 null。
   * blocker（人）：只有「原来没压到、挪过去会压到」才算问题——她本来就坐在上面的家具可以拖走。
   */
  issue(ids: string[], next: LayoutSnapshot, blocker?: Blocker): PlaceIssue | null {
    const moved = new Set(ids);
    for (const id of ids) {
      const it = this.item(id);
      if (!it || it.kind === 'window_spot') continue;
      const rect: Rect = { position: next[id].position, rotation: next[id].rotation, size: it.size };
      if (!roomContaining(rect, this.rooms)) return 'outside_room';
      for (const other of this.items) {
        if (other.id === id || other.kind === 'window_spot') continue;
        const orect: Rect = moved.has(other.id) ? { position: next[other.id].position, rotation: next[other.id].rotation, size: other.size } : other;
        // 同组的本来就挨着（椅子塞在桌子下面），不互相检查
        if (moved.has(other.id) && it.group && other.group === it.group) continue;
        if (rectsOverlap(rect, orect, TOUCH_EPS)) return 'overlap';
      }
      if (blocker && rectHitsCircle(rect, blocker.position, blocker.radius) && !rectHitsCircle(it, blocker.position, blocker.radius)) return 'on_character';
    }
    return null;
  }

  /** 把 id（连同联动组）整体平移，让 id 的中心落在 target。放不下则不动，返回原因。 */
  tryMove(id: string, target: Vec2, blocker?: Blocker): PlaceIssue | null {
    const it = this.item(id);
    if (!it || !it.draggable) return 'outside_room';
    const group = this.groupOf(id);
    const dx = target[0] - it.position[0];
    const dy = target[1] - it.position[1];
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
    const next: LayoutSnapshot = Object.fromEntries(group.map((g) => [g.id, { position: [g.position[0] + dx, g.position[1] + dy] as Vec2, rotation: g.rotation }]));
    const problem = this.issue(group.map((g) => g.id), next, blocker);
    if (!problem) this.apply(next);
    return problem;
  }

  /** 把 id（连同联动组）绕 id 的中心旋转 deg 度（逆时针）。放不下则不动，返回原因。 */
  tryRotate(id: string, deg: number, blocker?: Blocker): PlaceIssue | null {
    const it = this.item(id);
    if (!it || !it.draggable) return 'outside_room';
    const group = this.groupOf(id);
    const pivot = it.position;
    const next: LayoutSnapshot = Object.fromEntries(
      group.map((g) => {
        const [rx, ry] = rotate2([g.position[0] - pivot[0], g.position[1] - pivot[1]], deg);
        return [g.id, { position: [round4(pivot[0] + rx), round4(pivot[1] + ry)] as Vec2, rotation: norm360(g.rotation + deg) }];
      }),
    );
    const problem = this.issue(group.map((g) => g.id), next, blocker);
    if (!problem) this.apply(next);
    return problem;
  }

  /** 按快照摆放（只动认识的、且位置真的变了的家具），返回被改动的家具 id */
  apply(snap: LayoutSnapshot): string[] {
    const changed: string[] = [];
    for (const it of this.items) {
      const p = snap[it.id];
      if (!p) continue;
      if (Math.abs(p.position[0] - it.position[0]) < 1e-9 && Math.abs(p.position[1] - it.position[1]) < 1e-9 && norm360(p.rotation) === norm360(it.rotation)) continue;
      it.position = [p.position[0], p.position[1]];
      it.rotation = norm360(p.rotation);
      const room = roomContaining(it, this.rooms);
      if (room) it.room = room;
      changed.push(it.id);
    }
    return changed;
  }

  // ───────── 撤销 / 保存 ─────────

  /** 一次操作（拖完松手、转一下）结束：before 是操作前的快照。没变化就不记。 */
  commit(before: LayoutSnapshot): boolean {
    if (sameSnapshot(before, this.snapshot())) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.save();
    return true;
  }

  /** 撤销一步，返回被改动的家具 id（没得撤返回空数组） */
  undo(): string[] {
    const prev = this.undoStack.pop();
    if (!prev) return [];
    const changed = this.apply(prev);
    this.save();
    return changed;
  }

  /** 恢复 config/furniture.json 的默认布局（可以再撤销回来） */
  reset(): string[] {
    const before = this.snapshot();
    const changed = this.apply(this.defaults);
    if (changed.length) {
      this.undoStack.push(before);
      this.storage?.removeItem(LAYOUT_KEY);
    }
    return changed;
  }

  /** 导出 / 保存用的全量布局 */
  export(): StoredLayout {
    return {
      version: 1,
      items: this.items.map((it) => ({ id: it.id, position: [round4(it.position[0]), round4(it.position[1])] as Vec2, rotation: it.rotation })),
      base: this.defaults,
    };
  }

  save() {
    if (!this.storage) return;
    try {
      if (this.isDefault) this.storage.removeItem(LAYOUT_KEY);
      else this.storage.setItem(LAYOUT_KEY, JSON.stringify(this.export()));
    } catch (e) {
      this.log('warn', '[layout] 布局保存失败（localStorage 不可用或已满）', { error: (e as Error).message });
    }
  }

  /**
   * 启动时读回上次的布局。以下情况丢弃存档、用配置默认值：
   * 存档损坏；配置文件里的默认布局改过了（以配置为准）；按存档摆放后放不下（家具增删、房间改了）。
   */
  loadSaved(): 'none' | 'applied' | 'discarded' {
    if (!this.storage) return 'none';
    let text: string | null = null;
    try {
      text = this.storage.getItem(LAYOUT_KEY);
    } catch {
      return 'none';
    }
    if (!text) return 'none';
    const discard = (why: string) => {
      this.log('warn', `[layout] 上次保存的布局不用了：${why}`);
      try {
        this.storage?.removeItem(LAYOUT_KEY);
      } catch {
        /* 忽略 */
      }
      return 'discarded' as const;
    };
    let stored: StoredLayout;
    try {
      stored = JSON.parse(text);
    } catch {
      return discard('不是合法 JSON');
    }
    if (!stored || stored.version !== 1 || !Array.isArray(stored.items) || typeof stored.base !== 'object' || stored.base === null) return discard('格式不对');
    if (!sameSnapshot(stored.base, this.defaults)) return discard('config/furniture.json 的默认布局改过了，以配置为准');
    const snap: LayoutSnapshot = {};
    for (const s of stored.items) {
      const it = this.item(s?.id);
      const ok = it && Array.isArray(s.position) && s.position.length === 2 && s.position.every((v) => typeof v === 'number' && Number.isFinite(v)) && typeof s.rotation === 'number' && Number.isFinite(s.rotation);
      if (!ok) return discard('内容与当前家具对不上');
      if (it.draggable) snap[s.id] = { position: [s.position[0], s.position[1]], rotation: s.rotation };
    }
    const full = { ...this.snapshot(), ...snap };
    const problem = this.issue(Object.keys(snap), full);
    if (problem) return discard(ISSUE_TEXT[problem]);
    this.apply(snap);
    return 'applied';
  }
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function sameSnapshot(a: LayoutSnapshot, b: LayoutSnapshot): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const p = a[k];
    const q = b[k];
    return !!q && Math.abs(p.position[0] - q.position[0]) < 1e-6 && Math.abs(p.position[1] - q.position[1]) < 1e-6 && norm360(p.rotation) === norm360(q.rotation);
  });
}
