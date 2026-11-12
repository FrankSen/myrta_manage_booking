import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '../config/settings.ts';

/** 读取 runtime/settings.json（可选）。文件不存在就用默认值；内容有误直接报错，不悄悄忽略 */
export function loadSettings(path: string): Settings {
  if (!existsSync(path)) return DEFAULT_SETTINGS;
  return mergeSettings(DEFAULT_SETTINGS, readRaw(path));
}

function readRaw(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`配置文件不是有效的 JSON：${path}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`配置文件内容必须是对象：${path}`);
  return raw as Record<string, unknown>;
}

/** 把刷新间隔写回配置文件，保留文件里的其他内容。先写临时文件再改名，中途断电也不会写坏 */
export function saveCheckInterval(path: string, ms: number): void {
  const raw = existsSync(path) ? readRaw(path) : {};
  const hidden = (raw.hidden && typeof raw.hidden === 'object' ? raw.hidden : {}) as Record<string, unknown>;
  raw.hidden = { ...hidden, checkIntervalMs: ms };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, path);
}
