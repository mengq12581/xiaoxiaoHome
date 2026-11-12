// 状态服务的核心逻辑（不含 HTTP）：校验状态对象、保存当前状态、
// 写 runtime/state.json、追加 runtime/state-history.jsonl（带轮转）、写服务端与前端日志。
// 约定见 docs/数据与接口约定.md §1～§3、§6。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIsoWithZone, isoLocal, sourceKind, type HistoryEntry, type StateObject, type StateResponse } from '../src/state/types';

export interface ActivityInfo {
  min_dwell: number;
  anchor: string | string[] | null;
  anim: string;
  weight: number;
}

export type ValidateResult =
  | { ok: true; state: StateObject; warnings: string[] }
  | { ok: false; status: number; body: Record<string, unknown> };

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_META_BYTES = 1024;
const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
const HISTORY_KEEP = 3;

/** 校验并规范化一个状态对象。未知字段忽略；缺 since 补当前时间；未识别的 source 前缀按 manual 处理并给警告。 */
export function validateState(raw: unknown, activities: Record<string, ActivityInfo>, now: Date): ValidateResult {
  const allowed = Object.keys(activities);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, body: { error: 'invalid_body', message: '请求体应为 JSON 对象' } };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.activity !== 'string' || !(r.activity in activities)) {
    return { ok: false, status: 400, body: { error: 'unknown_activity', allowed } };
  }
  const warnings: string[] = [];
  let source = r.source;
  if (typeof source !== 'string' || source.length === 0 || source.length > 64) {
    return { ok: false, status: 400, body: { error: 'invalid_source', message: 'source 必填：task:<名字> / sim:click / idle / manual' } };
  }
  if (!sourceKind(source).recognized) {
    warnings.push(`未识别的 source 前缀「${source}」，按 manual 处理`);
    source = 'manual';
  }
  let since: string;
  if (r.since === undefined || r.since === null || r.since === '') {
    since = isoLocal(now);
  } else if (isIsoWithZone(r.since)) {
    since = r.since;
  } else {
    return { ok: false, status: 400, body: { error: 'invalid_since', message: 'since 应为带时区的 ISO8601，如 2026-11-11T10:10:00+08:00' } };
  }
  const state: StateObject = { activity: r.activity, source: source as string, since };
  if (r.min_dwell !== undefined) {
    if (!Number.isInteger(r.min_dwell) || (r.min_dwell as number) < 0 || (r.min_dwell as number) > 1800) {
      return { ok: false, status: 400, body: { error: 'invalid_min_dwell', message: 'min_dwell 应为 0～1800 的整数（秒）' } };
    }
    state.min_dwell = r.min_dwell as number;
  }
  if (r.meta !== undefined) {
    if (typeof r.meta !== 'object' || r.meta === null || Array.isArray(r.meta)) {
      return { ok: false, status: 400, body: { error: 'invalid_meta', message: 'meta 应为对象' } };
    }
    if (Buffer.byteLength(JSON.stringify(r.meta), 'utf8') > MAX_META_BYTES) {
      return { ok: false, status: 400, body: { error: 'meta_too_large', message: 'meta 最大 1KB' } };
    }
    state.meta = r.meta as Record<string, unknown>;
  }
  return { ok: true, state, warnings };
}

export interface StoreOptions {
  /** 仓库根目录；运行时数据写在它下面的 runtime/ 与 logs/ */
  root: string;
  loadActivities: () => Record<string, ActivityInfo>;
  now?: () => Date;
  /** 单测用：历史文件轮转阈值 */
  historyMaxBytes?: number;
}

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export class StateStore {
  readonly runtimeDir: string;
  readonly logsDir: string;
  readonly stateFile: string;
  readonly historyFile: string;
  private current: (StateObject & { received_at: string; seq: number }) | null = null;
  /** 每接受一个状态加一：前端靠它判断「来了新状态」（同一秒内连写两次也分得清） */
  private seq = 0;
  private currentStartedMs = 0;
  /** 我们自己上一次写进 state.json 的内容，用来区分「自己写的」和「别人手工改的」 */
  private lastWritten = '';
  private now: () => Date;

  constructor(private opts: StoreOptions) {
    this.now = opts.now ?? (() => new Date());
    this.runtimeDir = join(opts.root, 'runtime');
    this.logsDir = join(opts.root, 'logs');
    this.stateFile = join(this.runtimeDir, 'state.json');
    this.historyFile = join(this.runtimeDir, 'state-history.jsonl');
    mkdirSync(this.runtimeDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    // 重启后接着上次的状态（文件非法就当没有）
    const prev = this.readStateFile();
    if (prev.kind !== 'missing') this.lastWritten = prev.text;
    if (prev.kind === 'ok') {
      const v = validateState(prev.raw, this.activities(), this.now());
      if (v.ok) {
        this.current = { ...v.state, received_at: isoLocal(this.now()), seq: ++this.seq };
        this.currentStartedMs = this.now().getTime();
      }
    }
  }

  activities() {
    return this.opts.loadActivities();
  }

  get(): StateResponse {
    return this.current ?? { activity: null, received_at: null };
  }

  /** 校验并接受一个新状态。via 只用于日志（http / file）。 */
  submit(raw: unknown, via: 'http' | 'file'): ValidateResult {
    const now = this.now();
    const res = validateState(raw, this.activities(), now);
    if (!res.ok) {
      this.log('warn', `拒绝状态（${via}）`, { ...res.body, received: summarize(raw) });
      return res;
    }
    for (const w of res.warnings) this.log('warn', w);
    const prev = this.current;
    const entry: HistoryEntry = {
      ts: isoLocal(now),
      kind: 'state',
      activity: res.state.activity,
      source: res.state.source,
      min_dwell: res.state.min_dwell ?? this.activities()[res.state.activity].min_dwell,
      prev: prev?.activity ?? null,
      prev_duration: prev ? Math.round((now.getTime() - this.currentStartedMs) / 1000) : null,
    };
    // 同一活动重复写入不算「换了活动」，上一个活动的持续时间接着算
    if (!prev || prev.activity !== res.state.activity) this.currentStartedMs = now.getTime();
    this.current = { ...res.state, received_at: isoLocal(now), seq: ++this.seq };
    this.writeStateFile(res.state);
    this.appendHistory(entry);
    this.log('info', `状态更新（${via}）`, { activity: res.state.activity, source: res.state.source, since: res.state.since });
    return res;
  }

  history(limit: number): HistoryEntry[] {
    const n = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
    const out: HistoryEntry[] = [];
    for (const f of [this.historyFile, this.rotated(1), this.rotated(2)]) {
      if (out.length >= n || !existsSync(f)) continue;
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    return out.reverse();
  }

  /**
   * 检查 state.json 是否被别人（手工编辑、任务脚本）改过；改过且合法就当作一次新状态。
   * 缺 since 时补当前时间并写回文件（docs/验收问题.md A2）。文件不存在或非法：保持上一次有效状态，只记警告。
   */
  pollFile(): 'unchanged' | 'accepted' | 'rejected' {
    const f = this.readStateFile();
    if (f.kind === 'missing') return 'unchanged';
    if (f.text === this.lastWritten) return 'unchanged';
    this.lastWritten = f.text; // 同一份内容只处理一次（包括非法内容，避免每秒刷警告）
    if (f.kind === 'invalid') {
      this.log('warn', 'state.json 不是合法 JSON，保持上一次有效状态', { error: f.error });
      return 'rejected';
    }
    const res = this.submit(f.raw, 'file');
    return res.ok ? 'accepted' : 'rejected';
  }

  /**
   * 导演报告：一场演出结束、换下一场。写一行 kind = performed 的历史，
   * prev_duration 是上一场从开始走过去到离开的实际秒数（docs/验收问题.md B15）。
   */
  recordPerformed(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const r = raw as Record<string, unknown>;
    const acts = this.activities();
    const str = (v: unknown) => (typeof v === 'string' && v.length <= 64 ? v : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.round(v) : null);
    const activity = str(r.activity);
    const prev = str(r.prev);
    if (!activity || !(activity in acts) || !prev || !(prev in acts)) return false;
    this.appendHistory({
      ts: isoLocal(this.now()),
      kind: 'performed',
      activity,
      source: str(r.source) ?? 'manual',
      min_dwell: num(r.min_dwell),
      prev,
      prev_duration: num(r.prev_duration),
      prev_acted: num(r.prev_acted) ?? undefined,
      prev_min_dwell: num(r.prev_min_dwell) ?? undefined,
    });
    return true;
  }

  /** 前端日志代写（docs/验收问题.md A3） */
  appendFrontendLog(lines: unknown): number {
    if (!Array.isArray(lines)) return 0;
    const now = this.now();
    let n = 0;
    let text = '';
    for (const l of lines.slice(0, 200)) {
      if (typeof l !== 'object' || l === null) continue;
      const o = l as Record<string, unknown>;
      const level = o.level === 'warn' || o.level === 'error' ? o.level : 'info';
      const msg = typeof o.msg === 'string' ? o.msg.slice(0, 500) : '';
      const ts = typeof o.ts === 'string' && o.ts.length < 40 ? o.ts : isoLocal(now);
      const data = o.data === undefined ? '' : ' ' + JSON.stringify(o.data).slice(0, 1000);
      text += `${ts} [${level}] ${msg}${data}\n`;
      n++;
    }
    if (text) appendFileSync(join(this.logsDir, `frontend-${ymd(now)}.log`), text);
    return n;
  }

  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
    const now = this.now();
    const line = `${isoLocal(now)} [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`;
    try {
      appendFileSync(join(this.logsDir, `state-server-${ymd(now)}.log`), line);
    } catch {
      /* 日志写不了不影响服务 */
    }
  }

  // ───────── 文件 ─────────

  private readStateFile(): { kind: 'missing' } | { kind: 'invalid'; text: string; error: string } | { kind: 'ok'; text: string; raw: unknown } {
    if (!existsSync(this.stateFile)) return { kind: 'missing' };
    let text: string;
    try {
      text = readFileSync(this.stateFile, 'utf8');
    } catch (e) {
      return { kind: 'invalid', text: '', error: (e as Error).message };
    }
    try {
      return { kind: 'ok', text, raw: JSON.parse(text) };
    } catch (e) {
      return { kind: 'invalid', text, error: (e as Error).message };
    }
  }

  private writeStateFile(state: StateObject) {
    const text = JSON.stringify(state, null, 2) + '\n';
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, text);
    renameSync(tmp, this.stateFile);
    this.lastWritten = text;
  }

  private rotated(i: number) {
    return join(this.runtimeDir, `state-history.${i}.jsonl`);
  }

  private appendHistory(entry: HistoryEntry) {
    const max = this.opts.historyMaxBytes ?? HISTORY_MAX_BYTES;
    if (existsSync(this.historyFile) && statSync(this.historyFile).size >= max) {
      // 轮转：当前 → .1 → .2，最多保留 3 个文件
      const last = this.rotated(HISTORY_KEEP - 1);
      if (existsSync(last)) rmSync(last);
      for (let i = HISTORY_KEEP - 2; i >= 1; i--) {
        if (existsSync(this.rotated(i))) renameSync(this.rotated(i), this.rotated(i + 1));
      }
      renameSync(this.historyFile, this.rotated(1));
    }
    appendFileSync(this.historyFile, JSON.stringify(entry) + '\n');
  }
}

function summarize(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 200);
  } catch {
    return String(raw).slice(0, 200);
  }
}
