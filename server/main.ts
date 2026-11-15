// 单独启动状态服务（不起前端）：npm run state-server
// 平时不用单独跑——npm run dev 会把它和前端一起起来。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStateServer, DEFAULT_PORT } from './stateServer';

const root = resolve(__dirname, '..');
const port = Number(process.env.XH_STATE_PORT ?? DEFAULT_PORT);

startStateServer({
  root,
  port,
  // 每次现读：改了 activities.json 不用重启服务
  loadActivities: () => JSON.parse(readFileSync(resolve(root, 'config/activities.json'), 'utf8')).activities,
}).catch((e) => {
  console.error('状态服务启动失败：', e);
  process.exit(1);
});
