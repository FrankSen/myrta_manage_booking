import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { acquireLock } from '../src/app/lock.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'lock-')), 'sub', 'app.lock');

describe('单实例锁', () => {
  test('第一次能拿到，释放后锁文件消失', () => {
    const p = tmp();
    const release = acquireLock(p);
    expect(existsSync(p)).toBe(true);
    release();
    expect(existsSync(p)).toBe(false);
  });
  test('已有存活的实例：报错', () => {
    const p = tmp();
    const release = acquireLock(p);
    expect(() => acquireLock(p, 999_999)).toThrow('已经在运行');
    release();
  });
  test('旧锁（进程已经不存在）会被清掉', () => {
    const p = tmp();
    const release1 = acquireLock(p);
    writeFileSync(p, '2147483646'); // 不存在的进程号
    const release2 = acquireLock(p);
    expect(existsSync(p)).toBe(true);
    release2();
    release1(); // 锁已不是自己的，不能误删
  });
  test('锁文件内容损坏：当作旧锁清掉', () => {
    const p = tmp();
    acquireLock(p)();
    writeFileSync(p, 'garbage');
    const release = acquireLock(p);
    release();
    expect(existsSync(p)).toBe(false);
  });
  test('释放时不会误删别人的锁', () => {
    const p = tmp();
    const release = acquireLock(p);
    writeFileSync(p, String(process.pid + 1));
    release();
    expect(existsSync(p)).toBe(true);
  });
});
