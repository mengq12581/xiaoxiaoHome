// 本地状态服务（Node 原生 http）：只监听 127.0.0.1，默认端口 4317，被占用时自动 +1。
// 接口见 docs/数据与接口约定.md §2.2；POST /log 是给前端代写日志用的（docs/验收问题.md A3）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, StateStore, type ActivityInfo } from './stateStore';

export const DEFAULT_PORT = 4317;
const LOG_BODY_LIMIT = 64 * 1024;

const FIELD_HELP = {
  activity: '必填。活动 id，必须是 activities 里的一项',
  source: '必填。task:<名字> / sim:click / idle / manual；未识别的前缀按 manual 处理',
  since: '可选。带时区的 ISO8601；不给时服务端补当前时间',
  min_dwell: '可选。秒，0～1800 的整数；不给时用活动配置里的值',
  meta: '可选。对象，最大 1KB，原样透传',
};

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

/** 读请求体；超过 limit 返回 'too_large'（并把剩余数据丢掉） */
function readBody(req: IncomingMessage, limit: number): Promise<string | 'too_large'> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve('too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? 'too_large' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 只放行本机页面的跨域请求（开发服务器、打包后的预览页、模拟器窗口） */
function corsOrigin(req: IncomingMessage): string | null {
  const o = req.headers.origin;
  if (!o) return null;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o) || o === 'null' || o.startsWith('file://') ? o : null;
}

/** 请求处理函数：既挂在独立端口上，也挂在 Vite 开发服务器上（同源，前端不用关心端口）。返回是否已处理。 */
export function createHandler(store: StateStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!['/state', '/history', '/activities', '/log', '/performed'].includes(path)) return false;
    const origin = corsOrigin(req);
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    try {
      if (path === '/state' && req.method === 'GET') {
        send(res, 200, store.get());
      } else if (path === '/state' && req.method === 'POST') {
        const body = await readBody(req, MAX_BODY_BYTES);
        if (body === 'too_large') {
          store.log('warn', '请求体超过 8KB，拒绝');
          send(res, 413, { error: 'payload_too_large', limit_bytes: MAX_BODY_BYTES });
          return true;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          send(res, 400, { error: 'invalid_json', message: '请求体不是合法 JSON' });
          return true;
        }
        const r = store.submit(raw, 'http');
        if (r.ok) send(res, 200, store.get());
        else send(res, r.status, r.body);
      } else if (path === '/history' && req.method === 'GET') {
        send(res, 200, { items: store.history(Number(url.searchParams.get('limit') ?? 50)) });
      } else if (path === '/activities' && req.method === 'GET') {
        const acts = store.activities();
        send(res, 200, {
          activities: Object.entries(acts).map(([id, a]: [string, ActivityInfo]) => ({ id, min_dwell: a.min_dwell, anchor: a.anchor, anim: a.anim, weight: a.weight })),
          fields: FIELD_HELP,
        });
      } else if (path === '/performed' && req.method === 'POST') {
        const body = await readBody(req, MAX_BODY_BYTES);
        if (body === 'too_large') {
          send(res, 413, { error: 'payload_too_large', limit_bytes: MAX_BODY_BYTES });
          return true;
        }
        let raw: unknown = null;
        try {
          raw = JSON.parse(body);
        } catch {
          /* 下面按非法处理 */
        }
        if (store.recordPerformed(raw)) send(res, 200, { ok: true });
        else send(res, 400, { error: 'invalid_body' });
      } else if (path === '/log' && req.method === 'POST') {
        const body = await readBody(req, LOG_BODY_LIMIT);
        if (body === 'too_large') {
          send(res, 413, { error: 'payload_too_large', limit_bytes: LOG_BODY_LIMIT });
          return true;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          send(res, 400, { error: 'invalid_json' });
          return true;
        }
        send(res, 200, { written: store.appendFrontendLog((raw as { lines?: unknown })?.lines) });
      } else {
        send(res, 405, { error: 'method_not_allowed' });
      }
    } catch (e) {
      store.log('error', '处理请求出错', { path, error: (e as Error).message });
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    }
    return true;
  };
}

export interface RunningServer {
  port: number;
  store: StateStore;
  handler: ReturnType<typeof createHandler>;
  close(): Promise<void>;
}

/** 监听 127.0.0.1:port；端口被占用就 +1 再试（最多 20 次） */
function listen(server: Server, port: number, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (p: number, left: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : p);
      });
    };
    attempt(port, tries);
  });
}

export async function startStateServer(opts: {
  root: string;
  loadActivities: () => Record<string, ActivityInfo>;
  port?: number;
  /** 多久检查一次 state.json 有没有被手工改过（毫秒）；0 = 不检查 */
  filePollMs?: number;
  now?: () => Date;
  quiet?: boolean;
}): Promise<RunningServer> {
  const store = new StateStore({ root: opts.root, loadActivities: opts.loadActivities, now: opts.now });
  const handler = createHandler(store);
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) send(res, 404, { error: 'not_found', endpoints: ['GET /state', 'POST /state', 'GET /history?limit=50', 'GET /activities'] });
    });
  });
  const want = opts.port ?? DEFAULT_PORT;
  const port = await listen(server, want);
  const pollMs = opts.filePollMs ?? 500;
  const timer = pollMs > 0 ? setInterval(() => store.pollFile(), pollMs) : null;
  timer?.unref?.();
  const note = port === want ? '' : `（${want} 被占用，已顺延）`;
  store.log('info', `状态服务已启动 http://127.0.0.1:${port}${note}`);
  if (!opts.quiet) console.log(`  ➜  状态服务: http://127.0.0.1:${port}/state${note}`);
  return {
    port,
    store,
    handler,
    close: () =>
      new Promise((resolve) => {
        if (timer) clearInterval(timer);
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
