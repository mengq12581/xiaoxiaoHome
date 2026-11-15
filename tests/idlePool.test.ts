import { describe, expect, it } from 'vitest';
import { IdlePool, inTimeRange } from '../src/director/idlePool';
import { Director, type PerformPlan, type Performer } from '../src/director/director';
import type { ActivitiesConfig } from '../src/config/types';
import type { StateObject } from '../src/state/types';
import { readRawConfig } from './helpers';

const activities = readRawConfig().activities as ActivitiesConfig;

/** 可复现的随机数 */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (hh: number, mm = 0) => () => new Date(2026, 10, 11, hh, mm, 0);

describe('睡眠时段判断', () => {
  it('跨午夜的区间', () => {
    const q: [string, string] = ['23:30', '07:30'];
    expect(inTimeRange(at(23, 29)(), q)).toBe(false);
    expect(inTimeRange(at(23, 30)(), q)).toBe(true);
    expect(inTimeRange(at(3, 0)(), q)).toBe(true);
    expect(inTimeRange(at(7, 29)(), q)).toBe(true);
    expect(inTimeRange(at(7, 30)(), q)).toBe(false);
    expect(inTimeRange(at(12, 0)(), q)).toBe(false);
  });
  it('不跨午夜的区间；起止相同表示没有睡眠时段', () => {
    expect(inTimeRange(at(13, 0)(), ['12:00', '14:00'])).toBe(true);
    expect(inTimeRange(at(14, 0)(), ['12:00', '14:00'])).toBe(false);
    expect(inTimeRange(at(13, 0)(), ['12:00', '12:00'])).toBe(false);
  });
});

describe('空闲池挑选', () => {
  it('白天：只从权重 > 0 的活动里挑，比例接近配置的权重', () => {
    const pool = new IdlePool(activities, { rand: seeded(1), wallClock: at(15) });
    const { mode, weights } = pool.weights();
    expect(mode).toBe('normal');
    expect(weights).toEqual({ watch_tv: 30, listen_music: 20, sleep: 15, daydream_window: 20, wander: 15 });
    const n = 20000;
    const count: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const p = pool.pick(0, null)!; // 不记结束：不受冷却影响，看纯权重
      count[p.activity] = (count[p.activity] ?? 0) + 1;
    }
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    for (const [id, w] of Object.entries(weights)) expect(Math.abs(count[id] / n - w / total)).toBeLessThan(0.015);
  });

  it('睡眠时段：换成 idle_pool_override.quiet（睡觉为主）', () => {
    const pool = new IdlePool(activities, { rand: seeded(2), wallClock: at(1) });
    const { mode, weights } = pool.weights();
    expect(mode).toBe('quiet');
    expect(weights).toEqual({ sleep: 60, daydream_window: 25, wander: 15 });
    const n = 10000;
    let sleep = 0;
    for (let i = 0; i < n; i++) if (pool.pick(0, null)!.activity === 'sleep') sleep++;
    expect(sleep / n).toBeGreaterThan(0.57);
    expect(sleep / n).toBeLessThan(0.63);
  });

  it('改配置里的权重，分布随之变化', () => {
    const cfg: ActivitiesConfig = structuredClone(activities);
    for (const a of Object.values(cfg.activities)) a.weight = 0;
    cfg.activities.wander.weight = 1;
    cfg.activities.sleep.weight = 3;
    const pool = new IdlePool(cfg, { rand: seeded(3), wallClock: at(15) });
    let sleep = 0;
    for (let i = 0; i < 4000; i++) if (pool.pick(0, null)!.activity === 'sleep') sleep++;
    expect(sleep / 4000).toBeGreaterThan(0.72);
    expect(sleep / 4000).toBeLessThan(0.78);
  });

  it('不挑正在做的；冷却中的不挑；全部在冷却时放宽', () => {
    const pool = new IdlePool(activities, { rand: seeded(4), wallClock: at(15) });
    for (let i = 0; i < 200; i++) expect(pool.pick(0, 'watch_tv')!.activity).not.toBe('watch_tv');
    pool.ended('listen_music', 100);
    pool.ended('sleep', 100);
    for (let i = 0; i < 200; i++) expect(['listen_music', 'sleep', 'watch_tv']).not.toContain(pool.pick(150, 'watch_tv')!.activity);
    // 冷却 90 秒过去后又能挑到
    const later = new Set(Array.from({ length: 300 }, () => pool.pick(191, 'watch_tv')!.activity));
    expect(later.has('sleep')).toBe(true);
    // 全部在冷却：放宽冷却，只排除正在做的
    for (const id of ['watch_tv', 'listen_music', 'sleep', 'daydream_window', 'wander']) pool.ended(id, 200);
    const relaxed = pool.pick(210, 'wander')!;
    expect(relaxed.activity).not.toBe('wander');
  });

  it('时长：落在 duration 区间里，且不短于最短停留', () => {
    const cfg: ActivitiesConfig = structuredClone(activities);
    cfg.activities.sleep.duration = [10, 20];
    const pool = new IdlePool(cfg, { rand: seeded(5) });
    for (let i = 0; i < 100; i++) {
      const d = pool.durationFor('watch_tv');
      expect(d).toBeGreaterThanOrEqual(60);
      expect(d).toBeLessThanOrEqual(240);
      expect(pool.durationFor('sleep')).toBe(120); // min_dwell 120 > duration 上限 20
    }
  });

  it('角色限定了能做的活动时，只从里面挑；池子为空返回 null', () => {
    const pool = new IdlePool(activities, { rand: seeded(6), wallClock: at(15), allowed: ['wander', 'write_notes'] });
    expect(Object.keys(pool.weights().weights)).toEqual(['wander']);
    // 只有一种可挑：正在做它也只好接着做
    expect(pool.pick(0, 'wander')!.activity).toBe('wander');
    expect(new IdlePool(activities, { allowed: ['write_notes'] }).pick(0, null)).toBeNull();
  });
});

/** 假演员：收到演出后过 travel 秒算就位 */
class FakePerformer implements Performer {
  begun: PerformPlan[] = [];
  failed = false;
  private arriveAt = 0;
  constructor(private now: () => number, public travel = 6) {}
  begin(plan: PerformPlan) {
    this.begun.push(plan);
    this.arriveAt = this.now() + this.travel;
  }
  get arrived() {
    return this.now() >= this.arriveAt;
  }
  get last() {
    return this.begun[this.begun.length - 1];
  }
}

function setup(hour = 15, seed = 7) {
  const clock = { t: 0 };
  const performer = new FakePerformer(() => clock.t);
  const picks: StateObject[] = [];
  const pool = new IdlePool(activities, { rand: seeded(seed), wallClock: at(hour) });
  const director = new Director(activities, { now: () => clock.t, idlePool: pool, onIdlePick: (_id, st) => picks.push(st), isoNow: () => `t${clock.t}` });
  director.register('xiaoxiao', performer, true);
  const run = (seconds: number) => {
    const end = clock.t + seconds;
    while (clock.t < end - 1e-9) {
      clock.t = Math.min(end, clock.t + 0.25);
      director.update();
    }
  };
  const st = (activity: string, source = 'sim:click'): StateObject => ({ activity, source, since: `t${clock.t}` });
  return { clock, performer, picks, director, run, st };
}

describe('导演 + 空闲池', () => {
  it('什么都不点：启动几秒后空闲池接手；5 分钟内至少换过一次活动', () => {
    const s = setup();
    s.run(2);
    expect(s.performer.begun).toHaveLength(0); // 给第一次读状态留时间
    s.run(2);
    expect(s.performer.last.state.source).toBe('idle');
    s.run(300);
    expect(new Set(s.performer.begun.map((p) => p.activity)).size).toBeGreaterThanOrEqual(2);
    // 每次自己挑的都报出去了（写回状态服务）
    expect(s.picks.map((p) => p.activity)).toEqual(s.performer.begun.map((p) => p.activity));
  });

  it('静置 20 分钟：≥ 3 种活动，没有连着做同一件事，相同活动间隔不少于冷却时间', () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const s = setup(15, seed);
      const ended = new Map<string, number>();
      const starts: { activity: string; t: number }[] = [];
      const origBegin = s.performer.begin.bind(s.performer);
      s.performer.begin = (plan) => {
        const prev = starts[starts.length - 1];
        if (prev) ended.set(prev.activity, s.clock.t);
        const last = ended.get(plan.activity);
        if (last !== undefined) expect(s.clock.t - last).toBeGreaterThanOrEqual(90);
        starts.push({ activity: plan.activity, t: s.clock.t });
        origBegin(plan);
      };
      s.run(20 * 60);
      expect(new Set(starts.map((x) => x.activity)).size).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < starts.length; i++) expect(starts[i].activity).not.toBe(starts[i - 1].activity);
      // 每件事的时长在 60～240 秒（加上走过去的 6 秒）
      for (let i = 1; i < starts.length; i++) {
        const d = starts[i].t - starts[i - 1].t;
        expect(d).toBeGreaterThanOrEqual(60);
        expect(d).toBeLessThanOrEqual(240 + 6 + 1);
      }
    }
  });

  it('长时间统计：各活动出现次数有明显的权重差异（不是平均分布）', () => {
    // 冷却与「不连着做同一件」会把分布拉平一些，但权重高的仍明显更常见（30 : 15 的活动约 1.6 倍）
    const s = setup(15, 21);
    s.run(7 * 24 * 3600);
    const count: Record<string, number> = {};
    for (const p of s.performer.begun) count[p.activity] = (count[p.activity] ?? 0) + 1;
    expect(count.watch_tv).toBeGreaterThan(count.sleep * 1.3);
    expect(count.watch_tv).toBeGreaterThan(count.wander * 1.3);
    expect(count.listen_music).toBeGreaterThan(count.wander * 1.1);
  });

  it('睡眠时段：以睡觉为主', () => {
    const s = setup(2, 31);
    s.run(8 * 3600);
    const count: Record<string, number> = {};
    for (const p of s.performer.begun) count[p.activity] = (count[p.activity] ?? 0) + 1;
    expect(Object.keys(count).sort()).toEqual(['daydream_window', 'sleep', 'wander']);
    expect(count.sleep).toBeGreaterThan(count.daydream_window);
    expect(count.sleep).toBeGreaterThan(count.wander);
  });

  it('空闲时写入任务：等当前这件的最短停留走完就接手；任务做完再过 idle_after_sec 回到空闲池', () => {
    const s = setup();
    s.run(12); // 第 3 秒空闲池挑了一件事，第 9 秒就位
    const idle = s.performer.last.activity;
    expect(s.director.setState('xiaoxiao', s.st('write_notes', 'task:daydream'))).toBe('queued');
    const left = s.director.snapshot().dwellLeft;
    expect(left).toBeGreaterThan(0);
    s.run(left - 0.5);
    expect(s.performer.last.activity).toBe(idle);
    s.run(1);
    expect(s.performer.last.activity).toBe('write_notes');
    const tTask = s.clock.t;
    // 任务期间空闲池不插队：要等任务演满最短停留、且距任务写入超过 idle_after_sec 才回到空闲池
    const tWrite = 12;
    const tBack = Math.max(tWrite + activities.idle_after_sec, tTask + 6 + activities.activities.write_notes.min_dwell);
    s.run(tBack - s.clock.t - 1);
    expect(s.performer.last.activity).toBe('write_notes');
    s.run(2);
    expect(s.performer.last.state.source).toBe('idle');
    expect(s.clock.t - tTask).toBeGreaterThanOrEqual(activities.activities.write_notes.min_dwell);
  });

  it('空闲活动最短停留已过：任务立刻接手', () => {
    const s = setup();
    s.run(4 + 6 + 130);
    expect(s.performer.last.state.source).toBe('idle');
    // 找一个最短停留肯定已过的时刻：重新挑之后等 130 秒
    const d = s.director.snapshot();
    if (d.dwellLeft > 0) s.run(d.dwellLeft + 0.5);
    if (s.director.snapshot().phase !== 'ACTING') s.run(7);
    expect(s.director.setState('xiaoxiao', s.st('write_notes', 'task:daydream'))).toBe('started');
  });

  it('「停下」：演满当前最短停留后进空闲池（不等 idle_after_sec）', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('write_notes'));
    s.run(10);
    expect(s.director.setState('xiaoxiao', s.st('idle'))).toBe('queued');
    s.run(85);
    expect(s.performer.last.activity).toBe('write_notes');
    s.run(3);
    expect(s.performer.last.state.source).toBe('idle');
    expect(s.performer.last.activity).not.toBe('write_notes');
  });

  it('空闲状态的回声（自己写回服务又被读回来）不重启动作', () => {
    const s = setup();
    s.run(4);
    const echo = s.picks[0];
    expect(s.director.setState('xiaoxiao', echo)).toBe('duplicate');
    expect(s.performer.begun).toHaveLength(1);
  });

  it('外部写入了正在做的那件空闲事：转成任务，不再按空闲计划时长换走', () => {
    const s = setup();
    s.run(4);
    const act = s.performer.last.activity;
    s.run(7);
    expect(s.director.setState('xiaoxiao', s.st(act, 'sim:click'))).toBe('duplicate');
    expect(s.director.snapshot().idleLeft).toBeNull();
    s.run(activities.idle_after_sec - 2);
    expect(s.performer.begun).toHaveLength(1);
  });

  it('重启后从 state.json 读回一件空闲事：按空闲规则接着做，做完换下一件', () => {
    const s = setup();
    expect(s.director.setState('xiaoxiao', s.st('daydream_window', 'idle'))).toBe('started');
    expect(s.director.snapshot().idleLeft).toBeGreaterThan(0);
    s.run(260);
    expect(s.performer.begun.length).toBeGreaterThanOrEqual(2);
    expect(s.performer.begun[1].activity).not.toBe('daydream_window');
  });
});
