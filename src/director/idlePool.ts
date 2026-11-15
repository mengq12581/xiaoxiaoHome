// 空闲行为池（docs/PRD.md F-06、docs/状态与动作映射表.md §三.4）：
// 没人给她安排事情时，按配置里的权重随机挑一件事做，持续随机若干秒，然后换下一件。
//   - 权重：activities.json 里每个活动的 weight（0 = 不进空闲池）；
//   - 时长：活动的 duration [最短, 最长]（秒），且不短于它的 min_dwell；
//   - 睡眠时段（quiet_hours，可跨午夜）：权重换成 idle_pool_override.quiet；
//   - 冷却：同一活动结束后 idle_cooldown_sec（默认 90）秒内不再被挑中，所以不会固定顺序循环、也不会连着做同一件事。
// 纯逻辑，不依赖 three.js；随机数与墙上时钟都可以注入，方便单测。

import type { ActivitiesConfig } from '../config/types';

export const DEFAULT_IDLE_COOLDOWN_SEC = 90;

export interface IdlePick {
  activity: string;
  /** 这件事计划做多久（秒，从就位开始算） */
  durationSec: number;
  /** normal / quiet */
  mode: string;
  /** 挑选时用的权重表（日志用） */
  weights: Record<string, number>;
}

export interface IdlePoolOptions {
  /** 0～1 的随机数 */
  rand?: () => number;
  /** 墙上时钟（判断是不是睡眠时段） */
  wallClock?: () => Date;
  /** 这个角色能做的活动（characters.json 的 activities）；"all" 或缺省 = 全部 */
  allowed?: 'all' | string[];
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** 某个时刻是否落在 [from, to) 里；from > to 表示跨午夜（如 23:30～07:30） */
export function inTimeRange(d: Date, [from, to]: [string, string]): boolean {
  const t = d.getHours() * 60 + d.getMinutes();
  const a = toMin(from);
  const b = toMin(to);
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

export class IdlePool {
  private rand: () => number;
  private wallClock: () => Date;
  /** 活动 → 上次结束的时刻（单调时钟，秒） */
  private endedAt = new Map<string, number>();

  constructor(
    private cfg: ActivitiesConfig,
    private opts: IdlePoolOptions = {},
  ) {
    this.rand = opts.rand ?? Math.random;
    this.wallClock = opts.wallClock ?? (() => new Date());
  }

  get cooldownSec() {
    return this.cfg.idle_cooldown_sec ?? DEFAULT_IDLE_COOLDOWN_SEC;
  }

  /** 当前时段与对应的权重表（已去掉权重为 0、角色不能做、配置里不存在的活动） */
  weights(): { mode: string; weights: Record<string, number> } {
    const quiet = inTimeRange(this.wallClock(), this.cfg.quiet_hours) && this.cfg.idle_pool_override?.quiet;
    const mode = quiet ? 'quiet' : 'normal';
    const src: Record<string, number> = quiet
      ? this.cfg.idle_pool_override!.quiet
      : Object.fromEntries(Object.entries(this.cfg.activities).map(([id, a]) => [id, a.weight]));
    const allowed = this.opts.allowed;
    const out: Record<string, number> = {};
    for (const [id, w] of Object.entries(src)) {
      if (!(w > 0) || !this.cfg.activities[id]) continue;
      if (allowed && allowed !== 'all' && !allowed.includes(id)) continue;
      out[id] = w;
    }
    return { mode, weights: out };
  }

  /** 记一笔：某个活动在 now 时结束了（冷却从这里开始算） */
  ended(activity: string, now: number) {
    this.endedAt.set(activity, now);
  }

  /** 这件事计划做多久：duration 区间里随机，且不短于 min_dwell */
  durationFor(activity: string): number {
    const a = this.cfg.activities[activity];
    if (!a) return 0;
    const [lo, hi] = a.duration;
    return Math.max(a.min_dwell, lo + (hi - lo) * this.rand());
  }

  /**
   * 挑下一件事。current（正在做的）一定排除；冷却中的也排除——
   * 都被排除时放宽冷却，只排除 current；池子是空的（全部权重为 0）返回 null。
   */
  pick(now: number, current: string | null): IdlePick | null {
    const { mode, weights } = this.weights();
    const candidates = (ignoreCooldown: boolean) =>
      Object.entries(weights).filter(([id]) => {
        if (id === current) return false;
        if (ignoreCooldown) return true;
        const t = this.endedAt.get(id);
        return t === undefined || now - t >= this.cooldownSec;
      });
    let list = candidates(false);
    if (list.length === 0) list = candidates(true);
    if (list.length === 0) {
      // 池子里只有一种活动：只好接着做它
      list = Object.entries(weights);
      if (list.length === 0) return null;
    }
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = this.rand() * total;
    let chosen = list[list.length - 1][0];
    for (const [id, w] of list) {
      r -= w;
      if (r < 0) {
        chosen = id;
        break;
      }
    }
    return { activity: chosen, durationSec: this.durationFor(chosen), mode, weights };
  }
}
