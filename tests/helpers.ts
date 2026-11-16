import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_FILES, type ConfigKey } from '../src/config/types';

const root = resolve(__dirname, '..');

/** 读取仓库里的真实配置（每次返回新对象，可随意改） */
export function readRawConfig(): Record<ConfigKey, any> {
  const out = {} as Record<ConfigKey, any>;
  for (const [k, f] of Object.entries(CONFIG_FILES) as [ConfigKey, string][]) {
    out[k] = JSON.parse(readFileSync(resolve(root, f), 'utf8'));
  }
  // 最短停留的总开关在整体验收期间是关的（config/activities.json）；单测要验的是停留机制本身，所以这里一律按开着测。
  // 「关掉以后立刻切换」另有专门的用例（tests/director.test.ts）。
  out.activities.min_dwell_enabled = true;
  return out;
}
