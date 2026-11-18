import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/** 建一个临时目录，当前测试结束后自动删除 */
export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
