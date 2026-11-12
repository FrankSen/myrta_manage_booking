import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { zipDir } from '../scripts/zip.ts';
import { tempDir } from './helpers/tmp.ts';

describe('zipDir', () => {
  test('中文文件名带 UTF-8 标志，tar（Windows 自带的也是它）能完整解出', () => {
    const d = tempDir('zip-');
    const src = join(d, 'pkg');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, '启动.bat'), '@echo off\r\n');
    writeFileSync(join(src, 'run.command'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(join(src, 'sub', 'big.txt'), 'x'.repeat(100_000));
    writeFileSync(join(src, 'sub', 'rand.bin'), Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 97) % 256)));
    const out = join(d, 'a.zip');
    expect(zipDir(src, out)).toBe(4);

    const zip = readFileSync(out);
    // 每个本地文件头的通用标志位都是 0x800
    let at = 0;
    let headers = 0;
    while ((at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at)) >= 0) {
      expect(zip.readUInt16LE(at + 6)).toBe(0x800);
      headers++;
      at += 4;
    }
    expect(headers).toBe(4);

    const x = join(d, 'x');
    mkdirSync(x);
    execFileSync('tar', ['-xf', out, '-C', x]);
    expect(readFileSync(join(x, 'pkg', '启动.bat'), 'utf8')).toBe('@echo off\r\n');
    expect(readFileSync(join(x, 'pkg', 'sub', 'big.txt'), 'utf8')).toHaveLength(100_000);
    expect(readFileSync(join(x, 'pkg', 'sub', 'rand.bin'))).toEqual(readFileSync(join(src, 'sub', 'rand.bin')));
    // 可执行权限保留，普通文件不变成可执行
    expect(statSync(join(x, 'pkg', 'run.command')).mode & 0o111).not.toBe(0);
    expect(statSync(join(x, 'pkg', 'sub', 'big.txt')).mode & 0o111).toBe(0);
  });
});
