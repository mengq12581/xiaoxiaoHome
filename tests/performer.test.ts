import { describe, expect, it } from 'vitest';
import { CharacterAgent, type AgentState } from '../src/character/agent';
import { createBareRig } from '../src/character/rig';
import { Director } from '../src/director/director';
import { StagePerformer } from '../src/director/stagePerformer';
import { Pathfinder, furnitureObstacles, wallObstacles } from '../src/nav/pathfinder';
import { indexAnchors } from '../src/scene/anchors';
import type { ActivitiesConfig, Vec2 } from '../src/config/types';
import { readRawConfig } from './helpers';

const raw = readRawConfig();
const activities = raw.activities as ActivitiesConfig;

/** 真实配置 + 真实寻路 + 真实走位，只是没有画面 */
function stage(patch?: (acts: ActivitiesConfig) => void) {
  const acts: ActivitiesConfig = structuredClone(activities);
  patch?.(acts);
  const pf = new Pathfinder(raw.rooms.nav.nodes, raw.rooms.nav.edges, [...wallObstacles(raw.rooms), ...furnitureObstacles(raw.furniture.items)]);
  const warnings: string[] = [];
  const rig = createBareRig('t');
  const agent = new CharacterAgent(rig, pf, [2.65, 2.2], -90, { log: (l, m) => l === 'warn' && warnings.push(m) });
  const anchors = indexAnchors(raw.furniture.items);
  const shown: string[][] = [];
  const performer = new StagePerformer(agent, pf, () => anchors, () => raw.rooms.nav.nodes, { set: (p) => shown.push([...p]) });
  const clock = { t: 0 };
  const director = new Director(acts, { now: () => clock.t });
  director.register('xiaoxiao', performer, true);
  const states: AgentState[] = [agent.state];
  let maxStep = 0;
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
      if (until?.()) return true;
    }
    return false;
  };
  const send = (activity: string, min_dwell?: number) =>
    director.setState('xiaoxiao', { activity, source: 'sim:click', since: String(clock.t), ...(min_dwell !== undefined ? { min_dwell } : {}) });
  const acting = (activity: string) => () => director.snapshot().phase === 'ACTING' && director.snapshot().activity === activity;
  return { agent, rig, anchors, performer, director, clock, states, shown, warnings, run, send, acting, maxStep: () => maxStep };
}

describe('导演 + 演员 + 走位（无画面联调）', () => {
  it('写笔记：走到电脑桌、转身、坐下，到位后才摆出翻开的本子和写字动作', () => {
    const s = stage();
    s.send('write_notes');
    expect(s.run(30, s.acting('write_notes'))).toBe(true);
    expect(s.agent.state).toBe('seated');
    expect(s.agent.seat?.id).toBe('desk:desk_seat');
    expect(s.states).toEqual(['idle', 'walking', 'turning', 'sitting_down', 'seated']);
    s.run(1.5);
    expect(s.shown[s.shown.length - 1]).toEqual(['notebook_open']);
    expect(s.agent.animName).toBe('sit_write');
    expect(s.agent.animWeight).toBe(1);
    // 低头写：头明显前倾
    expect(s.rig.head.rotation.x).toBeGreaterThan(0.15);
  });

  it('用电脑 → 写笔记：同一把椅子上直接换动作，不站起来', () => {
    const s = stage();
    s.send('use_computer', 0);
    s.run(30, s.acting('use_computer'));
    s.run(1);
    const before = s.states.length;
    s.send('write_notes', 0);
    expect(s.run(5, s.acting('write_notes'))).toBe(true);
    s.run(1.5);
    expect(s.states.length).toBe(before); // 没有经过 standing_up / walking
    expect(s.agent.animName).toBe('sit_write');
    expect(s.shown[s.shown.length - 1]).toEqual(['notebook_open']);
  });

  it('看电视 10 秒内点写笔记：看满最短停留才起身；全程不瞬移', () => {
    const s = stage();
    s.send('watch_tv');
    s.run(30, s.acting('watch_tv'));
    const tSeated = s.clock.t;
    s.run(5);
    expect(s.send('write_notes')).toBe('queued');
    s.run(38);
    expect(s.agent.state).toBe('seated');
    expect(s.agent.seat?.id).toBe('sofa:sofa_seat');
    expect(s.run(40, s.acting('write_notes'))).toBe(true);
    // 离开沙发的时刻 ≥ 坐定后 45 秒
    expect(s.clock.t - tSeated).toBeGreaterThan(45);
    expect(s.agent.seat?.id).toBe('desk:desk_seat');
    // 每帧位移不超过走路速度（0.75 m/s）能走的距离，坐下 / 起身的缓动也在这个量级内
    expect(s.maxStep()).toBeLessThan(0.75 / 60 + 0.012);
    expect(s.states.slice(-5)).toEqual(['standing_up', 'walking', 'turning', 'sitting_down', 'seated']);
  });

  it('睡觉：走到床边 → 坐上床 → 躺平；被任务叫起来时先坐起、再下床、再走', () => {
    const s = stage();
    s.send('sleep', 0);
    expect(s.run(40, s.acting('sleep'))).toBe(true);
    expect(s.agent.state).toBe('lying');
    expect(s.agent.lieWeight).toBe(1);
    expect(s.states.slice(-4)).toEqual(['turning', 'sitting_down', 'lying_down', 'lying']);
    s.run(1.5);
    expect(s.shown[s.shown.length - 1]).toEqual(['blanket_cover']);
    // 躺平：身体向后放倒 90°
    expect(s.rig.body.rotation.x).toBeCloseTo(-Math.PI / 2, 2);
    const from = s.states.length;
    s.send('write_notes', 0);
    expect(s.run(40, s.acting('write_notes'))).toBe(true);
    expect(s.states.slice(from, from + 3)).toEqual(['getting_up', 'standing_up', 'walking']);
  });

  it('听歌：优先去沙发（prefer_anchor）；窗边发呆：去最近的一扇窗站着', () => {
    const s = stage();
    s.send('listen_music', 0);
    s.run(30, s.acting('listen_music'));
    expect(s.agent.seat?.id).toBe('sofa:sofa_seat');
    s.run(1.5);
    expect(s.shown[s.shown.length - 1]).toEqual(['headphones']);
    s.send('daydream_window', 0);
    expect(s.run(30, s.acting('daydream_window'))).toBe(true);
    expect(s.agent.state).toBe('idle');
    const spot = s.anchors.stands.get('living_window_spot:window_stand')!;
    expect(Math.hypot(s.agent.position[0] - spot.plan[0], s.agent.position[1] - spot.plan[1])).toBeLessThan(0.05);
    expect(s.agent.headingDeg).toBeCloseTo(spot.headingDeg, 0);
  });

  it('闲逛：在导航点之间走走停停，一直有事做，不穿墙', () => {
    const s = stage();
    s.send('wander', 0);
    s.run(2);
    expect(s.director.snapshot()).toMatchObject({ phase: 'ACTING', activity: 'wander' });
    const start: Vec2 = [s.agent.position[0], s.agent.position[1]];
    let walked = 0;
    let prev = start;
    s.run(60, () => {
      walked += Math.hypot(s.agent.position[0] - prev[0], s.agent.position[1] - prev[1]);
      prev = [s.agent.position[0], s.agent.position[1]];
      return false;
    });
    expect(walked).toBeGreaterThan(5);
    expect(s.warnings).toEqual([]);
    expect(s.states).toContain('walking');
  });

  it('停下：从沙发上站起来待着；之后的新状态马上接上', () => {
    const s = stage();
    s.send('watch_tv', 0);
    s.run(30, s.acting('watch_tv'));
    s.send('idle');
    expect(s.run(10, s.acting('idle_stand'))).toBe(true);
    expect(s.agent.state).toBe('idle');
    expect(s.agent.seat).toBeNull();
    expect(s.send('watch_tv')).toBe('started');
  });

  it('扩展性：只加一条活动配置（复用现有交互点），不改代码就能演', () => {
    const s = stage((acts) => {
      acts.activities.read_book = { anim: 'sit_read', anchor: 'sofa_seat', min_dwell: 5, weight: 0, duration: [10, 20], face: 'anchor_forward', props: [] };
    });
    expect(s.send('read_book')).toBe('started');
    expect(s.run(30, s.acting('read_book'))).toBe(true);
    expect(s.agent.seat?.id).toBe('sofa:sofa_seat');
    s.run(2); // 没有专门动作的活动：保留基础坐姿，不报错
    expect(s.warnings).toEqual([]);
  });

  it('去不了的地方（床被堵死）：原地停下、记警告、回落到站姿，不穿墙', () => {
    const s = stage();
    // 把卧室门堵上
    const pf = new Pathfinder(raw.rooms.nav.nodes, raw.rooms.nav.edges, [
      ...wallObstacles(raw.rooms),
      ...furnitureObstacles(raw.furniture.items),
      { id: 'block', kind: 'furniture', cx: 6, cy: 3.2, hw: 0.3, hh: 0.75, rot: 0 },
    ]);
    const agent = new CharacterAgent(createBareRig('t'), pf, [2.65, 2.2], -90, { log: (l, m) => l === 'warn' && s.warnings.push(m) });
    const performer = new StagePerformer(agent, pf, () => s.anchors, () => raw.rooms.nav.nodes, { set: () => {} });
    const clock = { t: 0 };
    const director = new Director(activities, { now: () => clock.t });
    director.register('xiaoxiao', performer, true);
    director.setState('xiaoxiao', { activity: 'sleep', source: 'sim:click', since: '0' });
    for (let i = 0; i < 300; i++) {
      clock.t += 1 / 60;
      agent.update(1 / 60);
      performer.update();
      director.update();
    }
    expect(s.warnings.some((w) => w.includes('寻路失败'))).toBe(true);
    expect(agent.position).toEqual([2.65, 2.2]);
    expect(director.snapshot().activity).toBe('idle_stand');
  });
});
