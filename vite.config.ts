import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { CONFIG_FILES, type ConfigKey } from './src/config/types';
import { formatIssues, validateAll, type ConfigIssue } from './src/config/validate';

const root = __dirname;

/** 读取并校验 config/*.json；返回问题列表（JSON 语法错误也算） */
function checkConfigFiles(): ConfigIssue[] {
  const raw = {} as Record<ConfigKey, unknown>;
  const issues: ConfigIssue[] = [];
  for (const [key, file] of Object.entries(CONFIG_FILES) as [ConfigKey, string][]) {
    try {
      raw[key] = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    } catch (e) {
      issues.push({ file, path: '$', message: `无法读取或 JSON 语法错误：${(e as Error).message}` });
    }
  }
  return issues.length ? issues : validateAll(raw);
}

/** 启动时校验配置，失败直接退出；开发中改配置时把错误推到浏览器遮罩 */
function configGuard(): Plugin {
  return {
    name: 'xiaoxiao-config-guard',
    buildStart() {
      const issues = checkConfigFiles();
      if (issues.length) {
        this.error(formatIssues(issues));
      }
    },
    configureServer(server: ViteDevServer) {
      const configDir = resolve(root, 'config') + sep;
      server.watcher.on('change', (file) => {
        if (!resolve(file).startsWith(configDir)) return;
        const issues = checkConfigFiles();
        if (issues.length) {
          const message = formatIssues(issues);
          server.config.logger.error(message);
          server.ws.send({ type: 'error', err: { message, stack: '' } });
        } else {
          server.config.logger.info('[config] 校验通过，重新加载');
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}

/** 开发态截图存档：POST /__dev/screenshot?name=xxx，请求体为 PNG dataURL，存到 docs/screenshots/ */
function devScreenshots(): Plugin {
  return {
    name: 'xiaoxiao-dev-screenshots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/screenshot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://127.0.0.1');
        const name = (url.searchParams.get('name') ?? 'shot').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 30 * 1024 * 1024) req.destroy();
          else chunks.push(c);
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const m = /^data:image\/png;base64,(.+)$/.exec(body);
          if (!m) {
            res.statusCode = 400;
            res.end('expected PNG dataURL');
            return;
          }
          const dir = resolve(root, 'docs', 'screenshots');
          mkdirSync(dir, { recursive: true });
          const file = resolve(dir, `${name}.png`);
          writeFileSync(file, Buffer.from(m[1], 'base64'));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ saved: `docs/screenshots/${name}.png` }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [configGuard(), devScreenshots()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: process.env.XH_NO_OPEN ? false : true,
  },
  preview: {
    host: '127.0.0.1',
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
});
