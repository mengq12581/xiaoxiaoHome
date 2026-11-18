import { describe, expect, it } from 'vitest';
import { LAYOUT_KEY, LayoutStore, rectHitsCircle, rectsOverlap, roomContaining, type StorageLike } from '../src/layout/layoutStore';
import type { FurnitureItem, RoomsConfig, Vec2 } from '../src/config/types';
import { readRawConfig } from './helpers';

function fresh() {
  const raw = readRawConfig();
  return { items: raw.furniture.items as FurnitureItem[], rooms: raw.rooms as RoomsConfig };
}

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const pos = (s: LayoutStore, id: string) => s.item(id)!.position.map((v) => +v.toFixed(3));

describe('几何判断', () => {
  const a = { position: [0, 0] as Vec2, rotation: 0, size: [2, 1, 1] as [number, number, number] };
  it('矩形重叠（含旋转）；贴边不算', () => {
    expect(rectsOverlap(a, { ...a, position: [1.5, 0] })).toBe(true);
    expect(rectsOverlap(a, { ...a, position: [2, 0] })).toBe(false);
    expect(rectsOverlap(a, { ...a, position: [2.004, 0] }, 0.005)).toBe(false);
    // 转 90° 后变成 1×2：横向只占 ±0.5
    expect(rectsOverlap(a, { ...a, position: [1.6, 0], rotation: 90 })).toBe(false);
    expect(rectsOverlap(a, { ...a, position: [1.4, 0], rotation: 90 })).toBe(true);
    // 45° 斜放：角伸进来
    expect(rectsOverlap(a, { ...a, position: [1.9, 0.9], rotation: 45 })).toBe(true);
    expect(rectsOverlap(a, { ...a, position: [2.3, 1.3], rotation: 45 })).toBe(false);
  });
  it('矩形与圆', () => {
    expect(rectHitsCircle(a, [1.2, 0], 0.25)).toBe(true);
    expect(rectHitsCircle(a, [1.3, 0], 0.25)).toBe(false);
    expect(rectHitsCircle(a, [1.15, 0.65], 0.25)).toBe(true);
    expect(rectHitsCircle(a, [1.2, 0.7], 0.25)).toBe(false);
  });
  it('整件落在哪个房间；骑墙或出界为 null', () => {
    const { rooms } = fresh();
    const r = { position: [5, 2] as Vec2, rotation: 0, size: [1, 1, 1] as [number, number, number] };
    expect(roomContaining(r, rooms)).toBe('living');
    expect(roomContaining({ ...r, position: [4, 5] }, rooms)).toBe('bedroom');
    expect(roomContaining({ ...r, position: [9.7, 5] }, rooms)).toBe('balcony');
    expect(roomContaining({ ...r, position: [2.95, 4.2] }, rooms)).toBeNull(); // 卡在门洞里
    expect(roomContaining({ ...r, position: [0.4, 2] }, rooms)).toBeNull(); // 伸进左墙
  });
});

describe('布局：移动、旋转、联动组', () => {
  it('默认布局本身是合法的', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    expect(s.issue(items.map((i) => i.id), s.snapshot())).toBeNull();
  });

  it('沙发拖到客厅另一角：位置更新；撞墙 / 撞家具 / 压到人时原地不动并给出原因', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    expect(s.tryMove('sofa', [6.5, 0.52])).toBeNull();
    expect(pos(s, 'sofa')).toEqual([6.5, 0.52]);
    expect(s.tryMove('sofa', [6.5, 0.3])).toBe('outside_room');
    expect(s.tryMove('sofa', [5.2, 1.9])).toBe('overlap'); // 茶几在这儿
    expect(pos(s, 'sofa')).toEqual([6.5, 0.52]);
    expect(s.tryMove('sofa', [6.5, 1.0], { position: [6.5, 1.6], radius: 0.25 })).toBe('on_character');
    expect(s.tryMove('sofa', [6.5, 1.0], { position: [6.5, 2.6], radius: 0.25 })).toBeNull();
  });

  it('她本来就坐在上面的家具可以拖走（原来就压着的不算「压到人」）', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    const seated = { position: [5.2, 0.86] as Vec2, radius: 0.25 };
    expect(rectHitsCircle(s.item('sofa')!, seated.position, seated.radius)).toBe(true);
    expect(s.tryMove('sofa', [5.3, 0.6], seated)).toBeNull();
  });

  it('可以挪到另一个房间，room 字段跟着变', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    expect(s.tryMove('coffee_table', [3.4, 4.8])).toBeNull();
    expect(s.item('coffee_table')!.room).toBe('bedroom');
  });

  it('电脑桌和椅子联动：拖桌子椅子一起走、拖椅子桌子一起走，相对位置不变', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    const rel = () => [s.item('desk')!.position[0] - s.item('office_chair')!.position[0], s.item('desk')!.position[1] - s.item('office_chair')!.position[1]].map((v) => +v.toFixed(3));
    const before = rel();
    expect(s.groupOf('desk').map((i) => i.id).sort()).toEqual(['desk', 'office_chair']);
    expect(s.tryMove('desk', [7.6, 6.9])).toBeNull();
    expect(pos(s, 'office_chair')).toEqual([7.6, 6.25]);
    expect(s.tryMove('office_chair', [7.6, 6.0])).toBeNull();
    expect(pos(s, 'desk')).toEqual([7.6, 6.65]);
    expect(rel()).toEqual(before);
    // 组里任何一件放不下，整组都不动
    expect(s.tryMove('desk', [8.5, 6.65])).toBe('outside_room');
    expect(pos(s, 'office_chair')).toEqual([7.6, 6.0]);
  });

  it('旋转 90°：自己转；联动组绕被选中的那件一起转；转不开就不动', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    expect(s.tryRotate('coffee_table', 90)).toBeNull();
    expect(s.item('coffee_table')!.rotation).toBe(90);
    // 桌子原来朝 180°、椅子在桌子下方 0.65 米；先挪到宽敞处再转
    expect(s.tryMove('desk', [7.3, 6.4])).toBeNull();
    expect(s.tryRotate('desk', 90)).toBeNull();
    expect(s.item('desk')!.rotation).toBe(270);
    expect(s.item('office_chair')!.rotation).toBe(90);
    expect(pos(s, 'office_chair')).toEqual([7.95, 6.4]); // 原来在下（-y）0.65，逆时针转 90° 后到了右边（+x）
    // 沙发贴着下墙横放（2.1 长 × 0.9 深）：转 90° 后要占 y -0.53～1.57，会进墙
    expect(s.tryRotate('sofa', 90)).toBe('outside_room');
    expect(s.item('sofa')!.rotation).toBe(0);
  });

  it('不可拖动的（窗前站位）不能动', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    expect(s.tryMove('living_window_spot', [3, 3])).not.toBeNull();
    expect(pos(s, 'living_window_spot')).toEqual([8.7, 1.6]);
  });
});

describe('撤销、保存、恢复默认', () => {
  it('Ctrl+Z：一步步撤回；没得撤时什么都不做', () => {
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms);
    expect(s.undo()).toEqual([]);
    let before = s.snapshot();
    s.tryMove('sofa', [6.0, 0.52]);
    s.tryMove('sofa', [6.5, 0.52]); // 一次拖动里的很多小步
    expect(s.commit(before)).toBe(true);
    before = s.snapshot();
    s.tryRotate('coffee_table', 90);
    s.commit(before);
    expect(s.commit(s.snapshot())).toBe(false); // 没变化不记
    expect(s.undo()).toEqual(['coffee_table']);
    expect(s.item('coffee_table')!.rotation).toBe(0);
    expect(s.undo()).toEqual(['sofa']);
    expect(pos(s, 'sofa')).toEqual([5.2, 0.52]); // 一次拖动算一步
    expect(s.canUndo).toBe(false);
  });

  it('拖完写 localStorage；刷新（重新读配置 + 读存档）后布局保持', () => {
    const storage = new MemStorage();
    const a = fresh();
    const s1 = new LayoutStore(a.items, a.rooms, storage);
    const before = s1.snapshot();
    s1.tryMove('sofa', [6.5, 0.52]);
    s1.tryMove('desk', [7.6, 6.9]);
    s1.commit(before);
    const stored = JSON.parse(storage.getItem(LAYOUT_KEY)!);
    expect(stored.items).toHaveLength(a.items.length); // 全量家具
    expect(stored.items.find((i: { id: string }) => i.id === 'sofa')).toEqual({ id: 'sofa', position: [6.5, 0.52], rotation: 0 });

    const b = fresh();
    const s2 = new LayoutStore(b.items, b.rooms, storage);
    expect(s2.loadSaved()).toBe('applied');
    expect(pos(s2, 'sofa')).toEqual([6.5, 0.52]);
    expect(pos(s2, 'office_chair')).toEqual([7.6, 6.25]);
    expect(s2.isDefault).toBe(false);
  });

  it('恢复默认：回到配置初始位置，清掉存档，还能撤销回来', () => {
    const storage = new MemStorage();
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms, storage);
    const before = s.snapshot();
    s.tryMove('sofa', [6.5, 0.52]);
    s.commit(before);
    expect(s.reset()).toEqual(['sofa']);
    expect(pos(s, 'sofa')).toEqual([5.2, 0.52]);
    expect(storage.getItem(LAYOUT_KEY)).toBeNull();
    expect(s.undo()).toEqual(['sofa']);
    expect(pos(s, 'sofa')).toEqual([6.5, 0.52]);
    expect(storage.getItem(LAYOUT_KEY)).not.toBeNull();
  });

  it('清掉缓存后回落到配置默认值；撤销回默认布局时也清存档', () => {
    const storage = new MemStorage();
    const { items, rooms } = fresh();
    const s = new LayoutStore(items, rooms, storage);
    expect(s.loadSaved()).toBe('none');
    const before = s.snapshot();
    s.tryMove('sofa', [6.5, 0.52]);
    s.commit(before);
    s.undo();
    expect(storage.getItem(LAYOUT_KEY)).toBeNull();
  });

  it('存档不能用时丢弃并回落默认：坏 JSON、格式不对、家具对不上、摆不下', () => {
    const warns: string[] = [];
    const mk = (text: string) => {
      const storage = new MemStorage();
      storage.setItem(LAYOUT_KEY, text);
      const { items, rooms } = fresh();
      const s = new LayoutStore(items, rooms, storage, (_l, m) => warns.push(m));
      const r = s.loadSaved();
      return { r, s, storage };
    };
    const good = (() => {
      const { items, rooms } = fresh();
      const s = new LayoutStore(items, rooms);
      return s.export();
    })();
    expect(mk('{oops').r).toBe('discarded');
    expect(mk('{"version":2}').r).toBe('discarded');
    expect(mk(JSON.stringify({ ...good, items: [{ id: 'spaceship', position: [1, 1], rotation: 0 }] })).r).toBe('discarded');
    expect(mk(JSON.stringify({ ...good, items: good.items.map((i) => (i.id === 'sofa' ? { ...i, position: [20, 20] } : i)) })).r).toBe('discarded');
    const bad = mk(JSON.stringify({ ...good, items: good.items.map((i) => (i.id === 'sofa' ? { ...i, position: [5.2, 1.9] } : i)) }));
    expect(bad.r).toBe('discarded');
    expect(bad.s.isDefault).toBe(true);
    expect(bad.storage.getItem(LAYOUT_KEY)).toBeNull();
    expect(warns).toHaveLength(5);
  });

  it('config/furniture.json 的默认位置改过了：以配置为准，丢弃旧存档', () => {
    const storage = new MemStorage();
    const a = fresh();
    const s1 = new LayoutStore(a.items, a.rooms, storage);
    const before = s1.snapshot();
    s1.tryMove('coffee_table', [6.8, 2.2]);
    s1.commit(before);
    const b = fresh();
    b.items.find((i) => i.id === 'sofa')!.position = [6.5, 0.52]; // 用户改了配置文件
    const s2 = new LayoutStore(b.items, b.rooms, storage);
    expect(s2.loadSaved()).toBe('discarded');
    expect(pos(s2, 'sofa')).toEqual([6.5, 0.52]);
    expect(pos(s2, 'coffee_table')).toEqual([5.2, 1.95]);
  });
});
