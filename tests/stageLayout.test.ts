import { describe, expect, it } from 'vitest';
import { CharacterAgent, type AgentState } from '../src/character/agent';
import { createBareRig } from '../src/character/rig';
import { Director } from '../src/director/director';
import { StagePerformer } from '../src/director/stagePerformer';
import { LayoutStore } from '../src/layout/layoutStore';
import { StageLayout } from '../src/layout/stageLayout';
import { createPathfinder, furnitureObstacles, pointInObstacle, CHARACTER_RADIUS } from '../src/nav/pathfinder';
import { indexAnchors, type AnchorIndex } from '../src/scene/anchors';
import type { ActivitiesConfig, FurnitureItem, RoomsConfig, Vec2 } from '../src/config/types';
import { readRawConfig } from './helpers';

/** 真实配置 + 真实寻路 + 真实走位 + 导演 + 布局，只是没有画面 */
function stage() {
  const raw = readRawConfig();
  const items = raw.furniture.items as FurnitureItem[];
  const rooms = raw.rooms as RoomsConfig;
  const activities = raw.activities as ActivitiesConfig;
  const pf = createPathfinder(rooms, items);
  const warnings: string[] = [];
  const agent = new CharacterAgent(createBareRig('t'), pf, [3.3, 2.7], -90, { log: (l, m) => l === 'warn' && warnings.push(m) });
  let anchors: AnchorIndex = indexAnchors(items);
  const shown: string[][] = [];
  const performer = new StagePerformer(agent, pf, () => anchors, () => rooms.nav.nodes, { set: (p) => shown.push([...p]) });
  const clock = { t: 0 };
  const director = new Director(activities, { now: () => clock.t });
  director.register('xiaoxiao', performer, true);
  const store = new LayoutStore(items, rooms);
  const moved: string[][] = [];
  const layout = new StageLayout({ store, rooms, pathfinder: pf, agent, performer, director, characterId: 'xiaoxiao', setAnchors: (a) => (anchors = a), onMoved: (ids) => moved.push(ids) });
  const states: AgentState[] = [agent.state];
  let maxStep = 0;
  let insideFurniture = 0;
  const run = (seconds: number, until?: () => boolean) => {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      const p0: Vec2 = [agent.position[0], agent.position[1]];
      clock.t += dt;
      agent.update(dt);
      performer.update();
      director.update();
      maxStep = Math.max(maxStep, Math.hypot(agent.position[0] - p0[0], agent.position[1] - p0[1]));
      if (states[states.length - 1] !== agent.state) states.push(agent.state);
      // 走路时不许进任何家具的占地（按人的半径留一点容差）
      if (agent.state === 'walking' && furnitureObstacles(items).some((o) => pointInObstacle(o, agent.position, CHARACTER_RADIUS - 0.06))) insideFurniture++;
      if (until?.()) return true;
    }
    return false;
  };
  const send = (activity: string, min_dwell = 0) => director.setState('xiaoxiao', { activity, source: 'sim:click', since: String(clock.t), min_dwell });
  const acting = (activity: string) => () => director.snapshot().phase === 'ACTING' && director.snapshot().activity === activity;
  return { items, agent, performer, director, store, layout, anchors: () => anchors, states, shown, warnings, moved, clock, run, send, acting, maxStep: () => maxStep, insideFurniture: () => insideFurniture };
}

const near = (a: Vec2, b: Vec2, eps = 0.02) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;

describe('拖家具：人物配合', () => {
  it('把沙发拖到客厅另一角：下一次看电视走到新位置，准确坐在新交互点上', () => {
    const s = stage();
    s.layout.beginDrag('sofa');
    for (let x = 5.2; x <= 6.51; x += 0.05) s.layout.dragTo('sofa', [+x.toFixed(2), 0.52]);
    expect(s.layout.endDrag()).toBe(true);
    const seat = s.anchors().seats.get('sofa:sofa_seat')!;
    expect(near(seat.plan, [6.5, 0.86])).toBe(true); // 交互点跟着沙发走
    s.send('watch_tv');
    expect(s.run(40, s.acting('watch_tv'))).toBe(true);
    expect(s.agent.state).toBe('seated');
    expect(near(s.agent.position, seat.plan, 0.001)).toBe(true);
    expect(s.agent.seatHeight).toBe(seat.height);
    expect(s.warnings).toEqual([]);
  });

  it('她正在用电脑时拖电脑桌：先起身等着（不坐在空气里），松手后走到新位置坐下接着用', () => {
    const s = stage();
    s.send('use_computer', 60);
    s.run(30, s.acting('use_computer'));
    s.run(2);
    const oldSeat = s.anchors().seats.get('desk:desk_seat')!;
    const from = s.states.length;
    s.layout.beginDrag('desk');
    expect(s.performer.isSuspended).toBe(true);
    expect(s.shown[s.shown.length - 1]).toEqual([]); // 屏幕微光收起
    // 拖动持续 2 秒：桌椅沿上墙一步步往右挪 0.4 米，她在这期间站起来
    for (let i = 1; i <= 24; i++) {
      s.layout.dragTo('desk', [+(7.6 + (i * 0.4) / 24).toFixed(4), 7.38]);
      s.run(2 / 24);
    }
    expect(s.agent.state).toBe('idle');
    expect(s.agent.seat).toBeNull();
    expect(near(s.agent.position, oldSeat.approach)).toBe(true); // 站在原来的椅子后面等
    s.layout.endDrag();
    expect(s.run(30, () => s.agent.state === 'seated')).toBe(true);
    const seat = s.anchors().seats.get('desk:desk_seat')!;
    expect(near(seat.plan, [oldSeat.plan[0] + 0.4, oldSeat.plan[1]])).toBe(true);
    expect(near(s.agent.position, seat.plan, 0.001)).toBe(true);
    expect(s.states.slice(from)).toEqual(['standing_up', 'idle', 'walking', 'turning', 'sitting_down', 'seated']);
    s.run(2);
    expect(s.director.snapshot()).toMatchObject({ phase: 'ACTING', activity: 'use_computer' });
    expect(s.shown[s.shown.length - 1]).toEqual(['screen_glow']);
    // 椅子跟着桌子走（联动组）
    expect(s.moved.every((ids) => ids.includes('desk') && ids.includes('office_chair'))).toBe(true);
    expect(s.maxStep()).toBeLessThan(0.75 / 60 + 0.012); // 全程没有瞬移
  });

  it('挪家具不重置最短停留：已经演掉的时间照算', () => {
    const s = stage();
    s.send('watch_tv', 45);
    s.run(30, s.acting('watch_tv'));
    s.run(20);
    s.layout.beginDrag('sofa');
    s.layout.dragTo('sofa', [5.3, 0.52]);
    s.layout.endDrag();
    s.run(30, () => s.agent.state === 'seated');
    s.run(1);
    expect(s.director.snapshot().dwellLeft).toBeLessThan(25);
  });

  it('拖动时实时避让：她正走着，茶几被拖到她的路上，她绕开，不穿过去', () => {
    const s = stage();
    // 从客厅中间走去沙发：默认会从茶几旁边经过
    s.send('daydream_window');
    s.run(30, s.acting('daydream_window'));
    s.send('use_computer');
    s.run(1.0);
    expect(s.agent.state).toBe('walking');
    // 把茶几拖到她和电脑桌之间
    s.layout.beginDrag('coffee_table');
    const target: Vec2 = [(s.agent.position[0] + 4.9) / 2, (s.agent.position[1] + 1.9) / 2];
    const issue = s.layout.dragTo('coffee_table', [+target[0].toFixed(2), +target[1].toFixed(2)]);
    expect(issue).toBeNull();
    s.layout.endDrag();
    expect(s.run(40, s.acting('use_computer'))).toBe(true);
    expect(s.insideFurniture()).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it('家具不能拖到她身上；拖动途中路被暂时堵死，她先停下，松手让开后接着走', () => {
    const s = stage();
    expect(s.layout.dragTo('coffee_table', [3.3, 2.7])).not.toBeNull(); // 没 beginDrag 也安全
    s.layout.beginDrag('coffee_table');
    expect(s.layout.dragTo('coffee_table', [3.2, 2.6])).toBe('on_character');
    s.layout.endDrag();

    // 去卧室睡觉，途中把床头柜拖到门洞正后方堵住
    s.send('sleep');
    s.run(1.5);
    s.layout.beginDrag('nightstand');
    expect(s.layout.dragTo('nightstand', [2.95, 4.55])).toBeNull();
    s.run(6);
    expect(s.agent.state).toBe('idle'); // 走不通：停下等，不穿墙
    expect(s.agent.failed).toBe(false);
    expect(s.director.snapshot().activity).toBe('sleep');
    expect(s.layout.dragTo('nightstand', [5.5, 7.52])).toBeNull(); // 拖回去
    s.layout.endDrag();
    expect(s.run(60, s.acting('sleep'))).toBe(true);
    expect(s.warnings).toEqual([]);
  });

  it('松手时路确实堵死：记警告、回落站姿，不穿墙', () => {
    const s = stage();
    s.layout.beginDrag('nightstand');
    expect(s.layout.dragTo('nightstand', [2.95, 4.55])).toBeNull();
    s.layout.endDrag();
    s.send('sleep');
    s.run(5);
    expect(s.warnings.some((w) => w.includes('寻路失败'))).toBe(true);
    expect(s.agent.position[1]).toBeLessThan(4.2);
    expect(s.director.snapshot().activity).toBe('idle_stand');
  });

  it('旋转沙发：她正坐着也会起身，转完按新朝向重新坐好；交互点朝向跟着转', () => {
    const s = stage();
    // 先把沙发挪到转得开的地方
    s.layout.beginDrag('sofa');
    expect(s.layout.dragTo('sofa', [7.0, 1.4])).toBeNull();
    s.layout.endDrag();
    s.send('watch_tv');
    s.run(40, s.acting('watch_tv'));
    const h0 = s.anchors().seats.get('sofa:sofa_seat')!.headingDeg;
    expect(s.layout.rotate('sofa')).toBeNull();
    const seat = s.anchors().seats.get('sofa:sofa_seat')!;
    expect(seat.headingDeg).toBe((h0 + 90) % 360);
    expect(s.run(40, () => s.agent.state === 'seated' && near(s.agent.position, seat.plan, 0.001))).toBe(true);
    expect(s.agent.headingDeg).toBeCloseTo(seat.headingDeg, 0);
    // 旋转自己算一步撤销
    expect(s.layout.undo()).toEqual(['sofa']);
    expect(s.anchors().seats.get('sofa:sofa_seat')!.headingDeg).toBe(h0);
  });

  it('撤销 / 恢复默认：家具回去，她也跟着回到原位置重新就位', () => {
    const s = stage();
    s.layout.beginDrag('sofa');
    s.layout.dragTo('sofa', [6.5, 0.52]);
    s.layout.endDrag();
    s.send('watch_tv');
    s.run(40, s.acting('watch_tv'));
    expect(s.layout.undo()).toEqual(['sofa']);
    const seat = s.anchors().seats.get('sofa:sofa_seat')!;
    expect(near(seat.plan, [5.2, 0.86])).toBe(true);
    expect(s.run(40, () => s.agent.state === 'seated' && near(s.agent.position, seat.plan, 0.001))).toBe(true);
    expect(s.layout.undo()).toEqual([]);
    s.layout.beginDrag('coffee_table');
    s.layout.dragTo('coffee_table', [6.8, 2.2]);
    s.layout.endDrag();
    expect(s.layout.reset()).toEqual(['coffee_table']);
    expect(s.store.isDefault).toBe(true);
  });

  it('拖了没动（点一下就松手）：不记撤销、她不受打扰', () => {
    const s = stage();
    s.send('watch_tv');
    s.run(40, s.acting('watch_tv'));
    const n = s.states.length;
    s.layout.beginDrag('coffee_table');
    expect(s.layout.endDrag()).toBe(false);
    expect(s.store.canUndo).toBe(false);
    s.run(1);
    expect(s.states.length).toBe(n);
  });
});
