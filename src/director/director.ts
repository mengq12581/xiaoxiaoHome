// 行为导演：状态不是动作，状态是意图。
// 导演读到一个状态后决定「现在演 / 排队 / 忽略」，到最短停留时间后才允许换下一件事。
// 规则见 docs/PRD.md F-05、docs/状态与动作映射表.md §三、docs/技术方案要点.md §4：
//   - 显式状态机：IDLE → MOVING（走过去、就位）→ ACTING（在演）→ 换下一件 / 回落；
//   - 排队最多 1 条：最短停留没走完时来的新状态进排队，再来就替换（取最后一次，不堆叠）；
//   - 演出时长独立于状态时长：ACTING 至少演满 min_dwell，状态早结束也不打断；
//   - 相同活动重复写入视为幂等，不重启动作；
//   - 任务 / 模拟器 / 手工写入 > 空闲池：任务还在演（或还有任务在排队）时，空闲池的状态被忽略。
//
// 本文件不依赖 three.js：角色怎么走、怎么演由 Performer 实现（stagePerformer.ts），这里只管时机。

import type { ActivitiesConfig, ActivitySpec } from '../config/types';
import { sourcePriority, type StateObject } from '../state/types';

export type Phase = 'IDLE' | 'MOVING' | 'ACTING';

/** 交给演员的一场演出 */
export interface PerformPlan {
  activity: string;
  spec: ActivitySpec;
  state: StateObject;
}

/** 演员：把一场演出落到角色身上（选交互点、寻路、就位、播动作、摆道具） */
export interface Performer {
  /** 开始一场演出；之前那场自动收尾 */
  begin(plan: PerformPlan): void;
  /** 已就位并进入动作 */
  readonly arrived: boolean;
  /** 这场演不了（比如寻路无解） */
  readonly failed: boolean;
}

export type Decision =
  | 'started' // 立刻开始
  | 'queued' // 进排队（当前这场的最短停留还没走完）
  | 'duplicate' // 与正在演的 / 排队中的是同一个活动：不重启
  | 'cancelled_queue' // 新状态就是正在演的活动：撤掉排队，接着演
  | 'ignored_low_priority' // 空闲池的状态遇上还没演完的任务
  | 'ignored_unknown'; // 未知角色或未知活动

export interface PerformanceRecord {
  activity: string;
  source: string;
  minDwell: number;
  /** 从开始走过去到离开，一共多少秒 */
  totalSec: number;
  /** 真正在演（ACTING）的秒数 */
  actedSec: number;
}

export interface DirectorOptions {
  /** 单调时钟，秒 */
  now: () => number;
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
  /** 一场演出结束（换下一场）时回调：用来把「实际演了多久」报给状态服务 */
  onPerformed?: (characterId: string, ended: PerformanceRecord, next: { activity: string; source: string; minDwell: number }) => void;
  /**
   * 超过 idle_after_sec 没有外部状态写入、且当前这场已演满最短停留时，问「接下来干什么」。
   * M4 的空闲池接在这里；不提供时回落到 fallbackActivity。
   */
  pickIdle?: (characterId: string) => StateObject | null;
  /** 兜底活动：寻路失败、显式「停下」、空闲回落时用 */
  fallbackActivity?: string;
}

interface Performance {
  state: StateObject;
  spec: ActivitySpec;
  minDwell: number;
  priority: number;
  startedAt: number;
  actingSince: number | null;
  /** 是不是兜底 / 回落出来的（不算一件「正经事」，随时可以被替换） */
  filler: boolean;
}

interface Slot {
  performer: Performer;
  current: Performance | null;
  queued: Performance | null;
  phase: Phase;
  /** 最后一次外部（非空闲池）状态写入的时刻 */
  lastExternalAt: number;
}

export interface DirectorSnapshot {
  phase: Phase;
  activity: string | null;
  source: string | null;
  minDwell: number;
  /** 最短停留还剩多少秒（还没开始演时等于 minDwell） */
  dwellLeft: number;
  /** 已经演了多少秒 */
  acted: number;
  queued: string | null;
}

/** 控制项：「停下 / 回落空闲」，本身不是一个可演的活动（docs/验收问题.md A4） */
export const IDLE_CONTROL = 'idle';

export class Director {
  private slots = new Map<string, Slot>();
  private active: string | null = null;
  private log: NonNullable<DirectorOptions['log']>;
  private fallback: string;

  constructor(
    private cfg: ActivitiesConfig,
    private opts: DirectorOptions,
  ) {
    this.log = opts.log ?? (() => {});
    this.fallback = opts.fallbackActivity ?? 'idle_stand';
  }

  /** 登记一个角色。v0.1 只有 active 角色会真的收到状态。 */
  register(characterId: string, performer: Performer, active = false) {
    this.slots.set(characterId, { performer, current: null, queued: null, phase: 'IDLE', lastExternalAt: this.opts.now() });
    if (active || this.active === null) this.active = characterId;
  }

  get activeCharacter() {
    return this.active;
  }

  /**
   * 多角色接口：把一个状态交给某个角色。
   * v0.1 内部只路由给 active 角色——发给别的角色的状态记一条日志后忽略。
   */
  setState(characterId: string, state: StateObject): Decision {
    const slot = this.slots.get(characterId);
    if (!slot || characterId !== this.active) {
      this.log('warn', '状态发给了非 active 角色，忽略', { characterId, active: this.active, activity: state.activity });
      return 'ignored_unknown';
    }
    const now = this.opts.now();
    const external = sourcePriority(state.source) > 0;
    if (external) slot.lastExternalAt = now;

    // 「停下」：换成兜底活动，仍然要等当前这场演满最短停留
    const isControl = state.activity === IDLE_CONTROL;
    const activity = isControl ? this.fallback : state.activity;
    const spec = this.cfg.activities[activity];
    if (!spec) {
      this.log('warn', '未知活动，忽略', { activity: state.activity });
      return 'ignored_unknown';
    }
    const incoming: Performance = {
      state: isControl ? { ...state, activity } : state,
      spec,
      // 「停下」换来的兜底站姿不是一件正经事：没有最短停留，随时可以被下一个状态替换
      minDwell: isControl ? 0 : (state.min_dwell ?? spec.min_dwell),
      priority: sourcePriority(state.source),
      startedAt: now,
      actingSince: null,
      filler: isControl,
    };

    const cur = slot.current;
    if (!cur) return this.start(characterId, slot, incoming, 'started');

    // 幂等：同一个活动重复写入，不重启动作
    if (slot.queued && slot.queued.state.activity === activity) {
      slot.queued = { ...incoming, startedAt: slot.queued.startedAt };
      return 'duplicate';
    }
    if (cur.state.activity === activity) {
      if (slot.queued) {
        this.log('info', '新状态就是正在演的活动，撤掉排队', { activity, dropped: slot.queued.state.activity });
        slot.queued = null;
        cur.state = incoming.state;
        return 'cancelled_queue';
      }
      cur.state = incoming.state; // 只更新来源 / 时间，动作不动
      return 'duplicate';
    }

    const curDone = this.dwellLeft(cur, now) <= 0;
    // 空闲池的状态不打断还没演完的任务，也不顶掉排队中的任务
    const blocker = slot.queued ?? (curDone ? null : cur);
    if (blocker && incoming.priority < blocker.priority) {
      this.log('info', '空闲状态让位给任务，忽略', { activity, blocking: blocker.state.activity });
      return 'ignored_low_priority';
    }

    if (curDone) return this.start(characterId, slot, incoming, 'started');

    const replaced = slot.queued?.state.activity;
    slot.queued = incoming;
    this.log('info', replaced ? '排队项被替换（取最后一次）' : '最短停留未到，新状态排队', {
      activity,
      replaced,
      current: cur.state.activity,
      dwell_left: Math.ceil(this.dwellLeft(cur, now)),
    });
    return 'queued';
  }

  /** 每帧调用：推进状态机 */
  update() {
    const now = this.opts.now();
    for (const [id, slot] of this.slots) {
      const cur = slot.current;
      if (!cur) continue;
      if (slot.performer.failed && !cur.filler) {
        this.log('warn', '这场演不了（寻路无解等），回落到兜底活动', { activity: cur.state.activity });
        this.start(id, slot, this.fillerPerformance(cur.state.source, now), 'started');
        continue;
      }
      if (slot.phase === 'MOVING' && slot.performer.arrived) {
        slot.phase = 'ACTING';
        cur.actingSince = now;
        this.log('info', '就位，开始演', { activity: cur.state.activity, min_dwell: cur.minDwell });
      }
      if (slot.phase !== 'ACTING') continue;
      if (this.dwellLeft(cur, now) > 0) continue;
      if (slot.queued) {
        const next = slot.queued;
        slot.queued = null;
        this.start(id, slot, next, 'started');
        continue;
      }
      // 没人排队：超过 idle_after_sec 没有外部写入就回落（M4 起由空闲池决定干什么）
      if (now - slot.lastExternalAt >= this.cfg.idle_after_sec && now - (cur.actingSince ?? now) >= this.cfg.idle_after_sec) {
        const pick = this.opts.pickIdle?.(id) ?? null;
        if (pick && this.cfg.activities[pick.activity] && pick.activity !== cur.state.activity) {
          this.setState(id, pick);
        } else if (!pick && !cur.filler) {
          this.log('info', '长时间没有新状态，回落到兜底活动', { from: cur.state.activity });
          this.start(id, slot, this.fillerPerformance('idle', now), 'started');
        }
      }
    }
  }

  snapshot(characterId = this.active ?? ''): DirectorSnapshot {
    const slot = this.slots.get(characterId);
    const cur = slot?.current;
    if (!slot || !cur) return { phase: 'IDLE', activity: null, source: null, minDwell: 0, dwellLeft: 0, acted: 0, queued: null };
    const now = this.opts.now();
    return {
      phase: slot.phase,
      activity: cur.state.activity,
      source: cur.state.source,
      minDwell: cur.minDwell,
      dwellLeft: Math.max(0, this.dwellLeft(cur, now)),
      acted: cur.actingSince === null ? 0 : now - cur.actingSince,
      queued: slot.queued?.state.activity ?? null,
    };
  }

  private dwellLeft(p: Performance, now: number): number {
    return p.actingSince === null ? p.minDwell : p.minDwell - (now - p.actingSince);
  }

  private fillerPerformance(source: string, now: number): Performance {
    const spec = this.cfg.activities[this.fallback];
    return {
      state: { activity: this.fallback, source, since: '' },
      spec,
      minDwell: 0,
      priority: 0,
      startedAt: now,
      actingSince: null,
      filler: true,
    };
  }

  private start(characterId: string, slot: Slot, next: Performance, decision: Decision): Decision {
    const now = this.opts.now();
    const prev = slot.current;
    next.startedAt = now;
    next.actingSince = null;
    slot.current = next;
    slot.phase = 'MOVING';
    this.log('info', '开始一场演出', { activity: next.state.activity, source: next.state.source, prev: prev?.state.activity ?? null });
    if (prev) {
      this.opts.onPerformed?.(
        characterId,
        {
          activity: prev.state.activity,
          source: prev.state.source,
          minDwell: prev.minDwell,
          totalSec: now - prev.startedAt,
          actedSec: prev.actingSince === null ? 0 : now - prev.actingSince,
        },
        { activity: next.state.activity, source: next.state.source, minDwell: next.minDwell },
      );
    }
    slot.performer.begin({ activity: next.state.activity, spec: next.spec, state: next.state });
    return decision;
  }
}
