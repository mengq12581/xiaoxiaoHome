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
  return out;
}
