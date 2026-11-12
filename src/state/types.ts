// 状态对象：前端、状态服务、模拟器共用的唯一状态载体（docs/数据与接口约定.md §1）。

export interface StateObject {
  /** 活动 id，必须在 config/activities.json 里声明 */
  activity: string;
  /** task:<名字> / sim:click / idle / manual */
  source: string;
  /** ISO8601 带时区；写入方不给时由状态服务补 */
  since: string;
  /** 秒，0～1800；缺省取活动配置里的值 */
  min_dwell?: number;
  meta?: Record<string, unknown>;
}

/** GET /state 的返回：当前状态 + 服务端收到的时间；还没有任何状态时 activity 为 null */
export type StateResponse = (StateObject & { received_at: string; seq: number }) | { activity: null; received_at: null };

export interface HistoryEntry {
  ts: string;
  /**
   * state = 有人写入了一个状态（prev_duration 是距上一次换活动过了多久）；
   * performed = 导演真的换了一场演出（prev_duration 是上一场实际演了多久）。
   */
  kind: 'state' | 'performed';
  activity: string;
  source: string;
  min_dwell: number | null;
  prev: string | null;
  /** 上一个活动实际持续秒数 */
  prev_duration: number | null;
  /** 仅 performed：上一场真正在演（就位之后）的秒数，以及它的最短停留 */
  prev_acted?: number;
  prev_min_dwell?: number;
}

export type SourceKind = 'task' | 'sim' | 'idle' | 'manual';

/** source 前缀归类；未识别的按 manual 处理（由调用方记警告） */
export function sourceKind(source: string): { kind: SourceKind; recognized: boolean } {
  if (source.startsWith('task:') && source.length > 5) return { kind: 'task', recognized: true };
  if (source === 'sim:click' || source.startsWith('sim:')) return { kind: 'sim', recognized: true };
  if (source === 'idle') return { kind: 'idle', recognized: true };
  if (source === 'manual') return { kind: 'manual', recognized: true };
  return { kind: 'manual', recognized: false };
}

/** 优先级：任务、模拟器点击、手工写入 > 空闲池 */
export function sourcePriority(source: string): number {
  return sourceKind(source).kind === 'idle' ? 0 : 1;
}

/** 本地时间的 ISO8601（带时区偏移），如 2026-11-11T10:10:00+08:00 */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(off / 60)}:${p(off % 60)}`
  );
}

const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const isIsoWithZone = (s: unknown): s is string => typeof s === 'string' && ISO_TZ.test(s) && !Number.isNaN(Date.parse(s));
