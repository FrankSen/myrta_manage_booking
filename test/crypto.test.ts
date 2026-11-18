import { readFileSync, statSync } from 'node:fs';
import { tempDir } from './helpers/tmp.ts';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { decrypt, encrypt, loadOrCreateKey } from '../src/storage/crypto.ts';

describe('crypto', () => {
  test('加密后能解回原文，且密文不含原文', () => {
    const key = loadOrCreateKey(join(tempDir('k-'), 'secret.key'));
    const token = encrypt('1234567890', key);
    expect(token).not.toContain('1234567890');
    expect(decrypt(token, key)).toBe('1234567890');
  });
  test('同一明文每次密文不同', () => {
    const key = loadOrCreateKey(join(tempDir('k-'), 'secret.key'));
    expect(encrypt('a', key)).not.toBe(encrypt('a', key));
  });
  test('密文被改动会解密失败', () => {
    const key = loadOrCreateKey(join(tempDir('k-'), 'secret.key'));
    const [iv, tag, body] = encrypt('hello', key).split('.') as [string, string, string];
    const bad = Buffer.from(body, 'base64'); bad[0] = bad[0]! ^ 1;
    expect(() => decrypt([iv, tag, bad.toString('base64')].join('.'), key)).toThrow();
  });
  test('密钥文件只生成一次，权限仅限本人', () => {
    const path = join(tempDir('k-'), 'sub', 'secret.key');
    const k1 = loadOrCreateKey(path);
    const k2 = loadOrCreateKey(path);
    expect(k1.equals(k2)).toBe(true);
    expect(readFileSync(path)).toHaveLength(32);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test('密钥文件损坏时报错', () => {
    expect(() => loadOrCreateKey(new URL('../package.json', import.meta.url).pathname)).toThrow('密钥文件长度不对');
  });
});
