import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../config/settings.ts';

/** 读取 runtime/settings.json（可选）。文件不存在就用默认值；内容有误直接报错，不悄悄忽略 */
export function loadSettings(path: string): Settings {
  if (!existsSync(path)) return DEFAULT_SETTINGS;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`配置文件不是有效的 JSON：${path}`);
  }
  return mergeSettings(DEFAULT_SETTINGS, raw);
}
