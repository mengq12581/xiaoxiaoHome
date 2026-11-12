// 前端的状态客户端：每秒向状态服务读一次当前状态，读到新状态就交给导演；
// 另外负责把前端日志和「实际演了多久」报回服务端落盘。
// 页面与状态服务同源（开发服务器把 /state 等路径挂在了自己身上），不用关心服务的实际端口。

import type { StateObject, StateResponse } from './types';

export interface ClientOptions {
  intervalMs?: number;
  onState: (state: StateObject) => void;
  onStatus?: (ok: boolean, detail: string) => void;
  fetchImpl?: typeof fetch;
  base?: string;
}

export class StateClient {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey: string | null = null;
  private ok: boolean | null = null;
  private f: typeof fetch;
  private base: string;

  constructor(private opts: ClientOptions) {
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.base = opts.base ?? '';
  }

  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 读一次。服务不可用或返回坏数据：保持上一次有效状态，只报一次状态变化，不抛错。 */
  async poll(): Promise<void> {
    try {
      const res = await this.f(`${this.base}/state`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as StateResponse & { seq?: number };
      this.setStatus(true, '已连接');
      if (!body || body.activity === null || typeof body.activity !== 'string') return;
      // 「新状态」的判据：服务端的接收序号变了（没有序号时退回到 since）
      const key = body.seq !== undefined ? `seq:${body.seq}` : `since:${body.since}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      const { activity, source, since, min_dwell, meta } = body;
      this.opts.onState({ activity, source, since, ...(min_dwell !== undefined ? { min_dwell } : {}), ...(meta ? { meta } : {}) });
    } catch (e) {
      this.setStatus(false, (e as Error).message);
    }
  }

  private setStatus(ok: boolean, detail: string) {
    if (this.ok === ok) return;
    this.ok = ok;
    this.opts.onStatus?.(ok, detail);
  }

  /** 写一个状态（开发面板用；模拟器和任务脚本直接打状态服务的端口） */
  async post(state: Partial<StateObject> & { activity: string; source: string }): Promise<{ status: number; body: unknown }> {
    const res = await this.f(`${this.base}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
    const body = await res.json().catch(() => null);
    void this.poll();
    return { status: res.status, body };
  }

  /** 报告一场演出的实际时长（写进 state-history.jsonl，验收「她演得比任务长」用） */
  reportPerformed(payload: Record<string, unknown>) {
    void this.f(`${this.base}/performed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
  }
}

/** 前端日志：控制台照常打，同时攒着每 2 秒发给状态服务，写进 logs/frontend-YYYYMMDD.log */
export class FrontendLog {
  private buf: { ts: string; level: string; msg: string; data?: unknown }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private base = '',
    private f: typeof fetch = (...a) => fetch(...a),
  ) {}

  start() {
    this.timer = setInterval(() => this.flush(), 2000);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.flush());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  write = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
    (level === 'info' ? console.info : level === 'warn' ? console.warn : console.error)(msg, data ?? '');
    this.buf.push({ ts: new Date().toISOString(), level, msg, data });
    if (this.buf.length > 500) this.buf.splice(0, this.buf.length - 500);
  };

  flush() {
    if (this.buf.length === 0) return;
    const lines = this.buf.splice(0, this.buf.length);
    void this.f(`${this.base}/log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }), keepalive: true }).catch(() => {
      // 服务不在：日志只留在控制台，不重发（避免越攒越多）
    });
  }
}
