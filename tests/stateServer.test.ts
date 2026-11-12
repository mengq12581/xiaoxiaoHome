import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startStateServer, type RunningServer } from '../server/stateServer';
import { StateStore, validateState } from '../server/stateStore';
import { readRawConfig } from './helpers';

const activities = readRawConfig().activities.activities;
const dirs: string[] = [];
const servers: RunningServer[] = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'xh-state-'));
  dirs.push(d);
  return d;
}

async function start(opts: { port?: number; now?: () => Date } = {}) {
  const root = tmp();
  // 端口 0 = 让系统挑一个空闲端口，测试之间互不干扰
  const s = await startStateServer({ root, port: opts.port ?? 0, loadActivities: () => activities, filePollMs: 0, quiet: true, now: opts.now });
  servers.push(s);
  return { s, root, url: `http://127.0.0.1:${s.port}` };
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('状态对象校验', () => {
  const now = new Date('2026-11-11T10:10:00+08:00');
  it('合法状态通过；缺 since 时补当前时间；未知字段忽略', () => {
    const r = validateState({ activity: 'write_notes', source: 'task:daydream', extra: 1 }, activities, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state).not.toHaveProperty('extra');
      expect(r.state.since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    }
  });
  it('未识别的 source 前缀按 manual 处理并给警告', () => {
    const r = validateState({ activity: 'watch_tv', source: 'robot' }, activities, now);
    expect(r.ok && r.state.source).toBe('manual');
    expect(r.ok && r.warnings.length).toBe(1);
  });
  it.each([
    [{ activity: 'fly', source: 'manual' }, 'unknown_activity'],
    [{ source: 'manual' }, 'unknown_activity'],
    [{ activity: 'watch_tv' }, 'invalid_source'],
    [{ activity: 'watch_tv', source: 'manual', since: '昨天' }, 'invalid_since'],
    [{ activity: 'watch_tv', source: 'manual', since: '2026-11-11T10:10:00' }, 'invalid_since'],
    [{ activity: 'watch_tv', source: 'manual', min_dwell: 1801 }, 'invalid_min_dwell'],
    [{ activity: 'watch_tv', source: 'manual', min_dwell: 1.5 }, 'invalid_min_dwell'],
    [{ activity: 'watch_tv', source: 'manual', meta: 'x' }, 'invalid_meta'],
    [{ activity: 'watch_tv', source: 'manual', meta: { note: 'x'.repeat(1100) } }, 'meta_too_large'],
    [[1, 2], 'invalid_body'],
  ])('非法输入 %j → %s', (input, code) => {
    const r = validateState(input, activities, now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(code);
    }
  });
});

describe('状态服务 HTTP 接口', () => {
  it('POST /state 成功：返回当前状态，写 state.json，追加一行历史', async () => {
    const { url, root } = await start();
    expect(await (await fetch(`${url}/state`)).json()).toEqual({ activity: null, received_at: null });
    const res = await post(url, { activity: 'write_notes', source: 'task:daydream', since: '2026-11-11T10:10:00+08:00', min_dwell: 90 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ activity: 'write_notes', source: 'task:daydream', since: '2026-11-11T10:10:00+08:00', min_dwell: 90 });
    expect(body.received_at).toBeTruthy();
    expect(await (await fetch(`${url}/state`)).json()).toMatchObject({ activity: 'write_notes' });
    expect(JSON.parse(readFileSync(join(root, 'runtime/state.json'), 'utf8'))).toEqual({
      activity: 'write_notes',
      source: 'task:daydream',
      since: '2026-11-11T10:10:00+08:00',
      min_dwell: 90,
    });
    const lines = readFileSync(join(root, 'runtime/state-history.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'state', activity: 'write_notes', source: 'task:daydream', min_dwell: 90, prev: null, prev_duration: null });
  });

  it('非法 activity：400 + unknown_activity + allowed 列表；当前状态不受影响', async () => {
    const { url } = await start();
    await post(url, { activity: 'watch_tv', source: 'sim:click' });
    const res = await post(url, { activity: 'fly', source: 'sim:click' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_activity');
    expect(body.allowed).toEqual(Object.keys(activities));
    expect(await (await fetch(`${url}/state`)).json()).toMatchObject({ activity: 'watch_tv' });
  });

  it('请求体不是 JSON：400；超过 8KB：413', async () => {
    const { url } = await start();
    expect((await post(url, '{oops')).status).toBe(400);
    const big = await post(url, { activity: 'watch_tv', source: 'manual', pad: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe('payload_too_large');
    // 刚好不超的还能过
    expect((await post(url, { activity: 'watch_tv', source: 'manual', pad: 'x'.repeat(7000) })).status).toBe(200);
  });

  it('历史：每次变更一行，带 prev 与 prev_duration；GET /history 按时间顺序返回并支持 limit', async () => {
    let t = Date.parse('2026-11-11T10:00:00+08:00');
    const { url, root } = await start({ now: () => new Date(t) });
    await post(url, { activity: 'watch_tv', source: 'sim:click' });
    t += 143_000;
    await post(url, { activity: 'write_notes', source: 'task:daydream', min_dwell: 90 });
    t += 10_000;
    await post(url, { activity: 'write_notes', source: 'task:daydream', min_dwell: 90 }); // 重复写入也记一行
    const lines = readFileSync(join(root, 'runtime/state-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ activity: 'write_notes', source: 'task:daydream', min_dwell: 90, prev: 'watch_tv', prev_duration: 143 });
    expect(lines[0].min_dwell).toBe(45); // 状态里没给 min_dwell 时记活动配置里的值
    expect(lines[1].ts).toMatch(/[+-]\d{2}:\d{2}$/);
    const all = await (await fetch(`${url}/history`)).json();
    expect(all.items.map((i: { activity: string }) => i.activity)).toEqual(['watch_tv', 'write_notes', 'write_notes']);
    const last = await (await fetch(`${url}/history?limit=1`)).json();
    expect(last.items).toHaveLength(1);
  });

  it('POST /performed：导演报告的实际演出时长写进历史', async () => {
    const { url, root } = await start();
    const res = await fetch(`${url}/performed`, {
      method: 'POST',
      body: JSON.stringify({ activity: 'idle_stand', source: 'task:daydream', min_dwell: 0, prev: 'write_notes', prev_duration: 97.4, prev_acted: 90.2, prev_min_dwell: 90 }),
    });
    expect(res.status).toBe(200);
    const line = JSON.parse(readFileSync(join(root, 'runtime/state-history.jsonl'), 'utf8').trim());
    expect(line).toMatchObject({ kind: 'performed', activity: 'idle_stand', prev: 'write_notes', prev_duration: 97, prev_acted: 90 });
    expect((await fetch(`${url}/performed`, { method: 'POST', body: JSON.stringify({ activity: 'fly', prev: 'watch_tv' }) })).status).toBe(400);
  });

  it('GET /activities：返回可用活动与字段说明', async () => {
    const { url } = await start();
    const body = await (await fetch(`${url}/activities`)).json();
    expect(body.activities.map((a: { id: string }) => a.id)).toEqual(Object.keys(activities));
    expect(body.activities.find((a: { id: string }) => a.id === 'write_notes')).toMatchObject({ min_dwell: 90, anchor: 'desk_seat' });
    expect(Object.keys(body.fields)).toEqual(['activity', 'source', 'since', 'min_dwell', 'meta']);
  });

  it('未知路径 404；只监听 127.0.0.1', async () => {
    const { url, s } = await start();
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect(s.port).toBeGreaterThan(0);
  });

  it('端口被占用时自动顺延', async () => {
    const blocker = createServer();
    const taken: number = await new Promise((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as { port: number }).port)));
    try {
      const { s } = await start({ port: taken });
      expect(s.port).toBeGreaterThan(taken);
      expect(s.port).toBeLessThanOrEqual(taken + 20);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe('文件通道与日志落盘', () => {
  const mk = (root: string, now?: () => Date) => new StateStore({ root, loadActivities: () => activities, now });

  it('手工改 state.json（没有 since）：被接受、补上 since 并写回、记一行历史', () => {
    const root = tmp();
    const store = mk(root);
    writeFileSync(join(root, 'runtime/state.json'), '{"activity":"write_notes","source":"manual"}');
    expect(store.pollFile()).toBe('accepted');
    expect(store.get()).toMatchObject({ activity: 'write_notes', source: 'manual' });
    const written = JSON.parse(readFileSync(join(root, 'runtime/state.json'), 'utf8'));
    expect(written.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 自己写回去的那份不会被当成又一次新状态
    expect(store.pollFile()).toBe('unchanged');
    expect(readFileSync(join(root, 'runtime/state-history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('state.json 非法 JSON 或非法活动：保持上一次有效状态，只记警告，同一份坏内容不反复报', () => {
    const root = tmp();
    const store = mk(root);
    store.submit({ activity: 'watch_tv', source: 'sim:click' }, 'http');
    writeFileSync(join(root, 'runtime/state.json'), '{"activity": "write_no');
    expect(store.pollFile()).toBe('rejected');
    expect(store.pollFile()).toBe('unchanged');
    writeFileSync(join(root, 'runtime/state.json'), '{"activity":"fly","source":"manual"}');
    expect(store.pollFile()).toBe('rejected');
    expect(store.get()).toMatchObject({ activity: 'watch_tv' });
    const log = readFileSync(join(root, 'logs', readdirSync(join(root, 'logs')).find((f) => f.startsWith('state-server-'))!), 'utf8');
    expect(log).toContain('不是合法 JSON');
    expect(log).toContain('unknown_activity');
  });

  it('重启后接着上次的状态', () => {
    const root = tmp();
    mk(root).submit({ activity: 'sleep', source: 'sim:click' }, 'http');
    expect(mk(root).get()).toMatchObject({ activity: 'sleep', source: 'sim:click' });
  });

  it('历史文件超过上限自动轮转，最多保留 3 个', () => {
    const root = tmp();
    const store = new StateStore({ root, loadActivities: () => activities, historyMaxBytes: 300 });
    for (let i = 0; i < 40; i++) store.submit({ activity: i % 2 ? 'watch_tv' : 'sleep', source: 'sim:click' }, 'http');
    const files = readdirSync(join(root, 'runtime')).filter((f) => f.startsWith('state-history')).sort();
    expect(files).toEqual(['state-history.1.jsonl', 'state-history.2.jsonl', 'state-history.jsonl']);
    expect(store.history(5)).toHaveLength(5);
    expect(store.history(5)[4].activity).toBe('watch_tv');
  });

  it('日志落盘：服务端日志按天一个文件；前端日志经 /log 代写', async () => {
    const { url, root } = await start({ now: () => new Date(2026, 10, 11, 10, 10, 0) });
    await post(url, { activity: 'watch_tv', source: 'sim:click' });
    const server = readFileSync(join(root, 'logs/state-server-20261111.log'), 'utf8');
    expect(server).toContain('状态服务已启动');
    expect(server).toContain('状态更新（http）');
    const res = await fetch(`${url}/log`, {
      method: 'POST',
      body: JSON.stringify({ lines: [{ level: 'warn', msg: '[agent:xiaoxiao] 寻路失败，原地停下', data: { reason: 'no_route' } }, { level: 'info', msg: '[state] 收到状态' }] }),
    });
    expect(await res.json()).toEqual({ written: 2 });
    const front = readFileSync(join(root, 'logs/frontend-20261111.log'), 'utf8');
    expect(front).toContain('[warn] [agent:xiaoxiao] 寻路失败，原地停下 {"reason":"no_route"}');
    expect(front.trim().split('\n')).toHaveLength(2);
    expect(existsSync(join(root, 'runtime/state.json'))).toBe(true);
  });
});
