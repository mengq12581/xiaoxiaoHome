import { describe, expect, it } from 'vitest';
import { Director, type PerformPlan, type Performer, type PerformanceRecord } from '../src/director/director';
import type { ActivitiesConfig } from '../src/config/types';
import type { StateObject } from '../src/state/types';
import { readRawConfig } from './helpers';

const activities = readRawConfig().activities as ActivitiesConfig;

/** 假演员：收到演出后过 travel 秒算就位 */
class FakePerformer implements Performer {
  begun: PerformPlan[] = [];
  failed = false;
  private arriveAt = 0;
  constructor(
    private now: () => number,
    public travel = 5,
  ) {}
  begin(plan: PerformPlan) {
    this.begun.push(plan);
    this.arriveAt = this.now() + this.travel;
  }
  get arrived() {
    return !this.failed && this.now() >= this.arriveAt;
  }
  get last() {
    return this.begun[this.begun.length - 1]?.activity;
  }
}

function setup(travel = 5) {
  const clock = { t: 0 };
  const logs: string[] = [];
  const performed: { ended: PerformanceRecord; next: string }[] = [];
  const performer = new FakePerformer(() => clock.t, travel);
  const director = new Director(activities, {
    now: () => clock.t,
    log: (_l, msg) => logs.push(msg),
    onPerformed: (_id, ended, next) => performed.push({ ended, next: next.activity }),
  });
  director.register('xiaoxiao', performer, true);
  /** 推进 seconds 秒，每 0.1 秒 update 一次 */
  const run = (seconds: number) => {
    const end = clock.t + seconds;
    while (clock.t < end - 1e-9) {
      clock.t = Math.min(end, clock.t + 0.1);
      director.update();
    }
  };
  const st = (activity: string, source = 'sim:click', extra: Partial<StateObject> = {}): StateObject => ({ activity, source, since: `t${clock.t}`, ...extra });
  return { clock, logs, performed, performer, director, run, st };
}

describe('导演状态机', () => {
  it('第一条状态立刻开始：IDLE → MOVING → ACTING', () => {
    const s = setup();
    expect(s.director.snapshot().phase).toBe('IDLE');
    expect(s.director.setState('xiaoxiao', s.st('watch_tv'))).toBe('started');
    expect(s.director.snapshot().phase).toBe('MOVING');
    s.run(4.9);
    expect(s.director.snapshot().phase).toBe('MOVING');
    s.run(0.2);
    expect(s.director.snapshot()).toMatchObject({ phase: 'ACTING', activity: 'watch_tv', minDwell: 45 });
  });

  it('看电视 10 秒内点写笔记：先把看电视的最短停留走完，再换；全程只开演两场', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv'));
    s.run(8);
    expect(s.director.setState('xiaoxiao', s.st('write_notes'))).toBe('queued');
    expect(s.director.snapshot()).toMatchObject({ activity: 'watch_tv', queued: 'write_notes' });
    // 就位（第 5 秒）后演满 45 秒 = 第 50 秒才换
    s.run(41.5);
    expect(s.performer.last).toBe('watch_tv');
    s.run(1);
    expect(s.performer.last).toBe('write_notes');
    expect(s.performer.begun.map((p) => p.activity)).toEqual(['watch_tv', 'write_notes']);
    expect(s.performed[0].ended).toMatchObject({ activity: 'watch_tv', minDwell: 45 });
    expect(s.performed[0].ended.actedSec).toBeGreaterThanOrEqual(45);
  });

  it('任务只持续 3 秒就写了「停下」：仍然把这一场演满最短停留（演出时长 > 任务时长）', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('write_notes', 'task:daydream'));
    s.run(3);
    expect(s.director.setState('xiaoxiao', s.st('idle', 'task:daydream'))).toBe('queued');
    s.run(80);
    expect(s.performer.last).toBe('write_notes');
    s.run(15);
    expect(s.performer.last).toBe('idle_stand');
    expect(s.performed[0].ended.activity).toBe('write_notes');
    expect(s.performed[0].ended.totalSec).toBeGreaterThan(90);
  });

  it('同一状态连写 10 次：动作只开演一次，不重启', () => {
    const s = setup();
    for (let i = 0; i < 10; i++) {
      const d = s.director.setState('xiaoxiao', s.st('watch_tv'));
      expect(d).toBe(i === 0 ? 'started' : 'duplicate');
      s.run(1);
    }
    expect(s.performer.begun).toHaveLength(1);
    // 最短停留也不会因为重复写入而重新计时
    s.run(41);
    expect(s.director.snapshot().dwellLeft).toBe(0);
  });

  it('最短停留内反复改写：只留最后一次，不堆叠', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv'));
    s.run(6);
    expect(s.director.setState('xiaoxiao', s.st('write_notes'))).toBe('queued');
    expect(s.director.setState('xiaoxiao', s.st('sleep'))).toBe('queued');
    expect(s.director.setState('xiaoxiao', s.st('listen_music'))).toBe('queued');
    expect(s.director.setState('xiaoxiao', s.st('listen_music'))).toBe('duplicate');
    s.run(60);
    expect(s.performer.begun.map((p) => p.activity)).toEqual(['watch_tv', 'listen_music']);
  });

  it('排队后又写回正在演的活动：撤掉排队，接着演', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv'));
    s.run(6);
    s.director.setState('xiaoxiao', s.st('write_notes'));
    expect(s.director.setState('xiaoxiao', s.st('watch_tv'))).toBe('cancelled_queue');
    s.run(60);
    expect(s.performer.begun).toHaveLength(1);
  });

  it('最短停留走完之后来的新状态：立刻切换', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv'));
    s.run(55);
    expect(s.director.setState('xiaoxiao', s.st('write_notes'))).toBe('started');
    expect(s.performer.last).toBe('write_notes');
  });

  it('状态自带的 min_dwell 覆盖活动配置', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv', 'sim:click', { min_dwell: 10 }));
    s.run(6);
    s.director.setState('xiaoxiao', s.st('write_notes'));
    s.run(8);
    expect(s.performer.last).toBe('watch_tv');
    s.run(2);
    expect(s.performer.last).toBe('write_notes');
  });

  it('优先级：任务没演完时空闲池的状态被忽略；任务演完后空闲状态可以接上', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('write_notes', 'task:daydream'));
    s.run(20);
    expect(s.director.setState('xiaoxiao', s.st('watch_tv', 'idle'))).toBe('ignored_low_priority');
    expect(s.director.snapshot().queued).toBeNull();
    s.run(80);
    expect(s.director.setState('xiaoxiao', s.st('watch_tv', 'idle'))).toBe('started');
  });

  it('优先级：空闲活动的最短停留没走完时，任务也要排队等它走完', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv', 'idle'));
    s.run(10);
    expect(s.director.setState('xiaoxiao', s.st('write_notes', 'task:daydream'))).toBe('queued');
    // 排着任务时，再来的空闲状态不能把任务顶掉
    expect(s.director.setState('xiaoxiao', s.st('sleep', 'idle'))).toBe('ignored_low_priority');
    s.run(41);
    expect(s.performer.last).toBe('write_notes');
  });

  it('「停下」换来的站姿没有最短停留，下一个状态马上接上', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('idle'));
    expect(s.performer.last).toBe('idle_stand');
    s.run(1);
    expect(s.director.setState('xiaoxiao', s.st('watch_tv'))).toBe('started');
  });

  it('演不了（寻路无解）：回落到兜底站姿并记警告，不卡死', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('sleep'));
    s.performer.failed = true;
    s.run(0.2);
    expect(s.performer.last).toBe('idle_stand');
    expect(s.logs.some((l) => l.includes('演不了'))).toBe(true);
    s.performer.failed = false;
    s.run(6);
    expect(s.director.setState('xiaoxiao', s.st('watch_tv'))).toBe('started');
  });

  it('长时间没有新状态：演满之后回落到兜底站姿（M4 起由空闲池接管）', () => {
    const s = setup();
    s.director.setState('xiaoxiao', s.st('watch_tv'));
    s.run(activities.idle_after_sec + 4);
    expect(s.performer.last).toBe('watch_tv');
    s.run(3);
    expect(s.performer.last).toBe('idle_stand');
  });

  it('多角色接口：发给非 active 角色或未知活动的状态被忽略', () => {
    const s = setup();
    expect(s.director.setState('shuaishuai', s.st('watch_tv'))).toBe('ignored_unknown');
    expect(s.director.setState('xiaoxiao', s.st('fly'))).toBe('ignored_unknown');
    expect(s.performer.begun).toHaveLength(0);
    expect(s.director.activeCharacter).toBe('xiaoxiao');
  });
});
