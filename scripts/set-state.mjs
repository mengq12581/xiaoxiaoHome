#!/usr/bin/env node
// 状态写入小工具：往本地状态服务写一个状态（定时任务脚本、手工测试用）。
//
//   npm run state -- write_notes                       # source 默认 manual
//   npm run state -- use_computer task:browsing 60     # 活动 来源 最短停留秒数
//   npm run state -- --get                             # 看当前状态
//   npm run state -- --history 10                      # 看最近 10 条
//
// 端口默认 4317，可用环境变量 XH_STATE_PORT 指定。

const port = Number(process.env.XH_STATE_PORT ?? 4317);
const base = `http://127.0.0.1:${port}`;
const [a0, a1, a2] = process.argv.slice(2);

async function main() {
  if (!a0 || a0 === '--help' || a0 === '-h') {
    const res = await fetch(`${base}/activities`);
    const body = await res.json();
    console.log('用法：npm run state -- <活动> [来源] [最短停留秒数]');
    console.log('可用活动：' + body.activities.map((a) => a.id).join(' / '));
    return;
  }
  if (a0 === '--get') {
    console.log(JSON.stringify(await (await fetch(`${base}/state`)).json(), null, 2));
    return;
  }
  if (a0 === '--history') {
    const body = await (await fetch(`${base}/history?limit=${Number(a1) || 20}`)).json();
    for (const h of body.items) console.log(JSON.stringify(h));
    return;
  }
  const state = { activity: a0, source: a1 ?? 'manual' };
  if (a2 !== undefined) state.min_dwell = Number(a2);
  const res = await fetch(`${base}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
  const body = await res.json();
  console.log(res.status, JSON.stringify(body));
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`连不上状态服务 ${base}（先 npm run dev 或 npm run state-server）：${e.cause?.code ?? e.message}`);
  process.exitCode = 1;
});
