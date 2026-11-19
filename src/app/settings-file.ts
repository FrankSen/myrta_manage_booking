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

/** 改配置文件里的一组值，保留文件里的其他内容。先写临时文件再改名，中途断电也不会写坏 */
function patch(path: string, group: 'hidden' | 'ui' | 'notify', values: Record<string, unknown>): void {
  const raw = existsSync(path) ? readRaw(path) : {};
  const old = (raw[group] && typeof raw[group] === 'object' ? raw[group] : {}) as Record<string, unknown>;
  raw[group] = { ...old, ...values };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, path);
}

/** 把刷新间隔写回配置文件 */
export function saveCheckInterval(path: string, ms: number): void {
  patch(path, 'hidden', { checkIntervalMs: ms });
}

/** 把界面语言写回配置文件 */
export function saveLanguage(path: string, language: string): void {
  patch(path, 'ui', { language });
}

/** 把自动改约开关写回配置文件（顶层的 autoRebookEnabled） */
export function saveAutoRebook(path: string, enabled: boolean): void {
  const raw = existsSync(path) ? readRaw(path) : {};
  raw.autoRebookEnabled = enabled;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, path);
}

/** 把飞书 Webhook 地址写回配置文件 */
export function saveFeishuWebhook(path: string, feishuWebhook: string): void {
  patch(path, 'notify', { feishuWebhook });
}
