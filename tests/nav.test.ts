import { describe, expect, it } from 'vitest';
import {
  Pathfinder,
  createPathfinder,
  furnitureObstacles,
  pathLength,
  segmentHitsObstacle,
  wallObstacles,
  type Obstacle,
} from '../src/nav/pathfinder';
import { localToPlan } from '../src/scene/layout';
import type { Vec2 } from '../src/config/types';
import { readRawConfig } from './helpers';

const raw = readRawConfig();
const obstacles = () => [...wallObstacles(raw.rooms), ...furnitureObstacles(raw.furniture.items)];
const make = (extra: Obstacle[] = []) => createPathfinder(raw.rooms, raw.furniture.items, extra);
const item = (id: string) => raw.furniture.items.find((i: { id: string }) => i.id === id);
const approachOf = (id: string) => {
  const it = item(id);
  return localToPlan(it, it.anchors[0].approach);
};

/** 路径每一段都不穿任何障碍 */
function assertClear(pf: Pathfinder, path: Vec2[]) {
  for (let i = 1; i < path.length; i++) {
    for (const o of obstacles()) {
      expect(segmentHitsObstacle(o, path[i - 1], path[i], 0.25), `段 ${i} 穿过 ${o.id}`).toBe(false);
    }
  }
  expect(pf.isFree(path[path.length - 1])).toBe(true);
}

describe('寻路', () => {
  it('默认配置里没有被家具或墙挡住的导航点和导航边', () => {
    const pf = make();
    expect(pf.blockedNodes).toEqual([]);
    expect(pf.blockedEdges).toEqual([]);
  });

  it('所有交互点的站位都可站人', () => {
    const pf = make();
    for (const it of raw.furniture.items) {
      for (const a of it.anchors) {
        if (!a.approach) continue;
        const p = localToPlan(it, a.approach);
        expect(pf.isFree(p), `${it.id}.${a.id} 站位 ${p}`).toBe(true);
      }
    }
  });

  it('从客厅沙发前走到卧室床边：穿过卧室门洞，不穿墙、不穿家具', () => {
    const pf = make();
    const res = pf.findPath(approachOf('sofa'), approachOf('bed'));
    expect(res.ok).toBe(true);
    assertClear(pf, res.path);
    // 必须经过卧室门洞（y=4.2 处 x 在 2.5～3.4）
    let crossed = false;
    for (let i = 1; i < res.path.length; i++) {
      const [a, b] = [res.path[i - 1], res.path[i]];
      if ((a[1] - 4.2) * (b[1] - 4.2) <= 0 && a[1] !== b[1]) {
        const t = (4.2 - a[1]) / (b[1] - a[1]);
        const x = a[0] + t * (b[0] - a[0]);
        expect(x).toBeGreaterThan(2.5 + 0.25 - 1e-6);
        expect(x).toBeLessThan(3.4 - 0.25 + 1e-6);
        crossed = true;
      }
    }
    expect(crossed).toBe(true);
  });

  it('从玄关、客厅、卫生间、书房、阳台都能走到床边', () => {
    const pf = make();
    const starts: Vec2[] = [[1.1, 2.0], [3.3, 2.7], [6.8, 2.7], [8.2, 0.8], [1.5, 5.0], [7.6, 5.6], [9.4, 3.1], [9.7, 5.0]];
    for (const s of starts) {
      const res = pf.findPath(s, approachOf('bed'));
      expect(res.ok, `起点 ${s}`).toBe(true);
      assertClear(pf, res.path);
    }
  });

  it('从入户门走到书房电脑椅后方站位：不穿椅子和桌子', () => {
    const pf = make();
    const res = pf.findPath([1.3, 3.5], approachOf('desk'));
    expect(res.ok).toBe(true);
    assertClear(pf, res.path);
  });

  it('厨房角（客厅南墙、伸进玄关一段）：从入户门仍能走到沙发、电视前、卧室门，不穿家具', () => {
    // 客户 2026-11-18 取消了「不挡玄关到客厅动线」的要求，这里只保证走得到
    const pf = make();
    const door: Vec2 = [0.4, 3.55];
    for (const goal of [approachOf('sofa'), [5.2, 2.95] as Vec2, [2.95, 3.5] as Vec2]) {
      const res = pf.findPath(door, goal);
      expect(res.ok, `到 ${goal}`).toBe(true);
      if (res.ok) assertClear(pf, res.path);
    }
  });

  it('客厅走到阳台：只能从玻璃门旁的通道过，不穿玻璃', () => {
    const pf = make();
    const res = pf.findPath([4.9, 2.95], [9.7, 5.0]);
    expect(res.ok).toBe(true);
    assertClear(pf, res.path);
    for (let i = 1; i < res.path.length; i++) {
      const [a, b] = [res.path[i - 1], res.path[i]];
      if ((a[0] - 8.8) * (b[0] - 8.8) <= 0 && a[0] !== b[0]) {
        const y = a[1] + ((8.8 - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
        expect(y).toBeGreaterThan(2.6 + 0.25 - 1e-6);
        expect(y).toBeLessThan(3.6 - 0.25 + 1e-6);
      }
    }
  });

  it('遇阻挡会绕行：在玄关和客厅之间放个障碍，仍能到达且路更长', () => {
    const base = make().findPath([3.3, 2.7], [1.1, 2.0]);
    const block: Obstacle = { id: 'box', kind: 'furniture', cx: 2.2, cy: 2.35, hw: 0.2, hh: 0.2, rot: 0 };
    const pf = make([block]);
    const res = pf.findPath([3.3, 2.7], [1.1, 2.0]);
    expect(res.ok).toBe(true);
    for (let i = 1; i < res.path.length; i++) expect(segmentHitsObstacle(block, res.path[i - 1], res.path[i], 0.25)).toBe(false);
    expect(pathLength(res.path)).toBeGreaterThan(pathLength(base.path) + 0.1);
  });

  it('无解：终点在衣柜里 → goal_blocked', () => {
    const res = make().findPath([3.3, 2.7], item('wardrobe').position);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('goal_blocked');
    expect(res.path).toEqual([[3.3, 2.7]]);
  });

  it('无解：卧室门洞被堵死 → no_route，不穿墙', () => {
    // 只填住门洞本身（x 2.35～3.55、y 4.1～4.3），不碰床边站位
    const plug: Obstacle = { id: 'plug', kind: 'furniture', cx: 2.95, cy: 4.2, hw: 0.6, hh: 0.1, rot: 0 };
    const res = make([plug]).findPath([3.3, 2.7], approachOf('bed'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_route');
  });

  it('路线不绕远：贴着家具角走最短折线，不被手工导航点牵着走', () => {
    const pf = make();
    const len = (a: Vec2, b: Vec2) => {
      const r = pf.findPath(a, b);
      expect(r.ok).toBe(true);
      assertClear(pf, r.path);
      return pathLength(r.path);
    };
    const sofa = approachOf('sofa');
    const tea = approachOf('coffee_table');
    const desk = approachOf('desk');
    const bed = approachOf('bed');
    // 茶几旁 → 沙发前：绕茶几一个角就到，不用兜到客厅另一头（原来 4.48 米）
    expect(len(tea, sofa)).toBeLessThan(3.0);
    // 书桌 → 沙发：出书房门后直奔沙发（原来 8.17 米）
    expect(len(desk, sofa)).toBeLessThan(6.2);
    // 床边 → 书桌：出卧室门、贴着电视柜下沿过、进书房门（原来 10.27 米）
    expect(len(bed, desk)).toBeLessThan(9.3);
    // 沙发 → 书房窗边（原来 8.42 米）
    expect(len(sofa, [7.9, 6.0])).toBeLessThan(6.3);
  });

  it('绕行点只在房间里：不会从屋外绕路（阳台没有墙，入户门是敞开的）', () => {
    // 把客厅通阳台的通道堵死：阳台与屋内就不连通了，不能绕到屋外从入户门进来
    const plug: Obstacle = { id: 'plug', kind: 'furniture', cx: 8.8, cy: 3.1, hw: 0.1, hh: 0.6, rot: 0 };
    const res = make([plug]).findPath([9.4, 5.0], [1.1, 2.0]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_route');
  });
});
