// 行为导演：状态不是动作，状态是意图。
// 导演读到一个状态后决定「现在演 / 排队 / 忽略」，到最短停留时间后才允许换下一件事。
// 规则见 docs/PRD.md F-05 / F-06、docs/状态与动作映射表.md §三、docs/技术方案要点.md §4：
//   - 显式状态机：IDLE → MOVING（走过去、就位）→ ACTING（在演）→ 换下一件 / 回落空闲池；
//   - 排队最多 1 条：最短停留没走完时来的新状态进排队，再来就替换（取最后一次，不堆叠）；
//   - 演出时长独立于状态时长：ACTING 至少演满 min_dwell，状态早结束也不打断；
//   - 相同活动重复写入视为幂等，不重启动作；
//   - 任务 / 模拟器 / 手工写入 > 空闲池：任务还在演（或还有任务在排队）时，空闲池的状态被忽略；
//   - 空闲池（M4）：超过 idle_after_sec 没有外部写入、或收到「停下」时，由 IdlePool 挑下一件事，
//     每件事做满它的计划时长再换；任务状态随时可以进来，等当前这件的最短停留走完就接手。
//
// 本文件不依赖 three.js：角色怎么走、怎么演由 Performer 实现（stagePerformer.ts），这里只管时机。

import type { ActivitiesConfig, ActivitySpec } from '../config/types';
import { sourcePriority, type StateObject } from '../state/types';
import type { IdlePool } from './idlePool';

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
  /** 空闲池（M4）。不提供时，空闲回落 / 「停下」只是原地站着（fallbackActivity） */
  idlePool?: IdlePool;
  /** 空闲池自己挑了一件事：用来把它写回状态服务（source = idle），让 state.json 和历史反映她在做什么 */
  onIdlePick?: (characterId: string, state: StateObject) => void;
  /** 兜底活动：寻路失败、空闲池为空时用 */
  fallbackActivity?: string;
  /** 刚启动时等多少秒还没收到任何状态，就让空闲池开始（给第一次读状态留时间） */
  startupGraceSec?: number;
  /** 墙上时间（写进状态的 since） */
  isoNow?: () => string;
}

interface Performance {
  state: StateObject;
  spec: ActivitySpec;
  minDwell: number;
  priority: number;
  startedAt: number;
  actingSince: number | null;
  /** 是不是兜底出来的站姿（不算一件「正经事」，没有最短停留，随时可以被替换） */
  filler: boolean;
  /** 空闲池的事：计划做多久（从就位开始算，秒） */
  plannedSec: number | null;
}

interface Slot {
  performer: Performer;
  current: Performance | null;
  queued: Performance | null;
  phase: Phase;
  /** 最后一次外部（非空闲池）状态写入的时刻 */
  lastExternalAt: number;
  /** 收到了「停下」：当前这场演满最短停留后进空闲池 */
  wantIdle: boolean;
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
  /** 空闲池的事：计划时长还剩多少秒；不是空闲池的事为 null */
  idleLeft: number | null;
  /** 不是空闲池的事：再过多少秒没有新状态就进空闲池（已经在空闲池里为 null） */
  idleIn: number | null;
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
    // 启动后 startupGraceSec 秒内没收到状态，就当作「已经很久没人安排」，空闲池开始
    const grace = this.opts.startupGraceSec ?? 3;
    this.slots.set(characterId, {
      performer,
      current: null,
      queued: null,
      phase: 'IDLE',
      lastExternalAt: this.opts.now() - this.cfg.idle_after_sec + grace,
      wantIdle: false,
    });
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

    // 「停下」：撤掉排队，当前这场演满最短停留后进空闲池
    if (state.activity === IDLE_CONTROL) {
      if (external) slot.lastExternalAt = now;
      slot.queued = null;
      slot.wantIdle = true;
      const cur = slot.current;
      if (!cur || this.dwellLeft(cur, now) <= 0) {
        this.goIdle(characterId, slot, '停下');
        return 'started';
      }
      this.log('info', '停下：演满最短停留后进空闲池', { current: cur.state.activity, dwell_left: Math.ceil(this.dwellLeft(cur, now)) });
      return 'queued';
    }

    const spec = this.cfg.activities[state.activity];
    if (!spec) {
      this.log('warn', '未知活动，忽略', { activity: state.activity });
      return 'ignored_unknown';
    }
    if (external) {
      slot.lastExternalAt = now;
      slot.wantIdle = false;
    }
    const incoming = this.performance(state, spec, now);

    const cur = slot.current;
    if (!cur) return this.start(characterId, slot, incoming, 'started');

    // 幂等：同一个活动重复写入，不重启动作
    if (slot.queued && slot.queued.state.activity === state.activity) {
      slot.queued = { ...incoming, startedAt: slot.queued.startedAt };
      return 'duplicate';
    }
    if (cur.state.activity === state.activity && !cur.filler) {
      // 外部写入「接管」了正在做的空闲事：从此按任务算（不再按空闲计划时长换走）
      if (external && cur.priority === 0) {
        cur.priority = incoming.priority;
        cur.plannedSec = null;
      }
      cur.state = incoming.state;
      if (slot.queued) {
        this.log('info', '新状态就是正在演的活动，撤掉排队', { activity: state.activity, dropped: slot.queued.state.activity });
        slot.queued = null;
        return 'cancelled_queue';
      }
      return 'duplicate';
    }

    const curDone = this.dwellLeft(cur, now) <= 0;
    // 空闲池的状态不打断还没演完的任务，也不顶掉排队中的任务
    const blocker = slot.queued ?? (curDone ? null : cur);
    if (blocker && incoming.priority < blocker.priority) {
      this.log('info', '空闲状态让位给任务，忽略', { activity: state.activity, blocking: blocker.state.activity });
      return 'ignored_low_priority';
    }

    if (curDone) return this.start(characterId, slot, incoming, 'started');

    const replaced = slot.queued?.state.activity;
    slot.queued = incoming;
    this.log('info', replaced ? '排队项被替换（取最后一次）' : '最短停留未到，新状态排队', {
      activity: state.activity,
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
      if (!cur) {
        // 什么都还没做过：等够了就让空闲池开始
        if (id === this.active && (slot.wantIdle || now - slot.lastExternalAt >= this.cfg.idle_after_sec)) this.goIdle(id, slot, '启动后没有收到状态');
        continue;
      }
      if (slot.performer.failed && !cur.filler) {
        this.log('warn', '这场演不了（寻路无解等），回落到兜底站姿', { activity: cur.state.activity });
        this.start(id, slot, this.fillerPerformance(cur.state.source, now), 'started');
        continue;
      }
      if (slot.phase === 'MOVING' && slot.performer.arrived) {
        slot.phase = 'ACTING';
        cur.actingSince = now;
        this.log('info', '就位，开始演', { activity: cur.state.activity, min_dwell: cur.minDwell, planned: cur.plannedSec === null ? undefined : Math.round(cur.plannedSec) });
      }
      // 兜底站姿不等就位：随时可以换走
      if (slot.phase !== 'ACTING' && !cur.filler) continue;
      if (this.dwellLeft(cur, now) > 0) continue;
      if (slot.queued) {
        const next = slot.queued;
        slot.queued = null;
        this.start(id, slot, next, 'started');
        continue;
      }
      if (cur.plannedSec !== null) {
        // 空闲池的事：做满计划时长就换下一件
        if (cur.actingSince !== null && now - cur.actingSince >= cur.plannedSec) this.goIdle(id, slot, '空闲活动做完了');
        continue;
      }
      // 任务 / 兜底：收到过「停下」，或超过 idle_after_sec 没有外部写入 → 空闲池
      if (slot.wantIdle) this.goIdle(id, slot, '停下');
      else if (now - slot.lastExternalAt >= this.cfg.idle_after_sec) this.goIdle(id, slot, '长时间没有新状态');
    }
  }

  snapshot(characterId = this.active ?? ''): DirectorSnapshot {
    const slot = this.slots.get(characterId);
    const cur = slot?.current;
    const now = this.opts.now();
    const idleIn = (s: Slot) => Math.max(0, this.cfg.idle_after_sec - (now - s.lastExternalAt));
    if (!slot || !cur) {
      return { phase: 'IDLE', activity: null, source: null, minDwell: 0, dwellLeft: 0, acted: 0, queued: null, idleLeft: null, idleIn: slot ? idleIn(slot) : null };
    }
    const acted = cur.actingSince === null ? 0 : now - cur.actingSince;
    return {
      phase: slot.phase,
      activity: cur.state.activity,
      source: cur.state.source,
      minDwell: cur.minDwell,
      dwellLeft: Math.max(0, this.dwellLeft(cur, now)),
      acted,
      queued: slot.queued?.state.activity ?? null,
      idleLeft: cur.plannedSec === null ? null : Math.max(0, cur.plannedSec - acted),
      idleIn: cur.plannedSec === null ? (slot.wantIdle ? 0 : idleIn(slot)) : null,
    };
  }

  // ───────── 内部 ─────────

  private dwellLeft(p: Performance, now: number): number {
    if (p.filler) return 0;
    return p.actingSince === null ? p.minDwell : p.minDwell - (now - p.actingSince);
  }

  private performance(state: StateObject, spec: ActivitySpec, now: number): Performance {
    const priority = sourcePriority(state.source);
    return {
      state,
      spec,
      minDwell: state.min_dwell ?? spec.min_dwell,
      priority,
      startedAt: now,
      actingSince: null,
      filler: false,
      // 空闲来源的状态（自己挑的，或重启后从 state.json 读回来的）按空闲池的规则做多久
      plannedSec: priority === 0 ? (this.opts.idlePool?.durationFor(state.activity) ?? spec.duration[1]) : null,
    };
  }

  private fillerPerformance(source: string, now: number): Performance {
    const spec = this.cfg.activities[this.fallback];
    return {
      state: { activity: this.fallback, source, since: this.opts.isoNow?.() ?? '' },
      spec,
      minDwell: 0,
      priority: 0,
      startedAt: now,
      actingSince: null,
      filler: true,
      plannedSec: null,
    };
  }

  /** 进空闲池：挑下一件事；池子是空的就原地站着 */
  private goIdle(characterId: string, slot: Slot, reason: string) {
    const now = this.opts.now();
    const cur = slot.current;
    slot.wantIdle = false;
    // 进了空闲池就不再算「刚被安排过」：下一次超时回落从现在起重新计时没有意义，空闲池自己会接着换
    slot.lastExternalAt = Math.min(slot.lastExternalAt, now - this.cfg.idle_after_sec);
    const pick = this.opts.idlePool?.pick(now, cur && !cur.filler ? cur.state.activity : null) ?? null;
    if (!pick) {
      if (cur?.filler) return;
      this.log('info', '进空闲：空闲池为空，原地站着', { reason, from: cur?.state.activity ?? null });
      this.start(characterId, slot, this.fillerPerformance('idle', now), 'started');
      return;
    }
    const state: StateObject = { activity: pick.activity, source: 'idle', since: this.opts.isoNow?.() ?? '' };
    const perf = this.performance(state, this.cfg.activities[pick.activity], now);
    perf.plannedSec = pick.durationSec;
    this.log('info', '空闲池挑了一件事', { reason, activity: pick.activity, planned: Math.round(pick.durationSec), mode: pick.mode, weights: pick.weights, from: cur?.state.activity ?? null });
    this.start(characterId, slot, perf, 'started');
    this.opts.onIdlePick?.(characterId, state);
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
      if (!prev.filler) this.opts.idlePool?.ended(prev.state.activity, now);
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
