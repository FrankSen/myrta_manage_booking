import { generateKeyPairSync, sign } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { sydneyInstant } from '../src/domain/time.ts';
import { LicenseGate } from '../src/license/gate.ts';
import { CLOCK_BACK_TOLERANCE_MS, checkLicense, expiresAt, parseLicense, payload } from '../src/license/license.ts';
import { PUBLIC_KEY_DER_B64 } from '../src/license/public-key.ts';
import { openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const make = (until: string, name = '测试教练') => {
  const body = { name, until, issuedAt: '2026-11-16' };
  return JSON.stringify({ ...body, sig: sign(null, payload(body), privateKey).toString('base64') });
};
const NOW = sydneyInstant('2026-11-20', '10:00');

describe('签名', () => {
  test('签名正确才通过', () => {
    expect(parseLicense(make('2026-12-31'), PUB)?.name).toBe('测试教练');
  });
  test('改了到期日期：不通过', () => {
    const l = JSON.parse(make('2026-12-31'));
    l.until = '2099-12-31';
    expect(parseLicense(JSON.stringify(l), PUB)).toBeNull();
  });
  test('改了名字：不通过', () => {
    const l = JSON.parse(make('2026-12-31'));
    l.name = '别人';
    expect(parseLicense(JSON.stringify(l), PUB)).toBeNull();
  });
  test('别的密钥签的：不通过', () => {
    expect(parseLicense(make('2026-12-31'), PUBLIC_KEY_DER_B64)).toBeNull();
  });
  test('不是 JSON、缺字段、签名不是 base64：不通过，不抛错', () => {
    expect(parseLicense('abc', PUB)).toBeNull();
    expect(parseLicense('{}', PUB)).toBeNull();
    expect(parseLicense(JSON.stringify({ name: 'a', until: '2026-12-31', issuedAt: '2026-11-16', sig: '!!!' }), PUB)).toBeNull();
  });
});

describe('到期', () => {
  test('按悉尼时间当天结束算，含夏令时', () => {
    expect(expiresAt('2026-12-31')).toBe(sydneyInstant('2027-01-01', '00:00'));
    expect(expiresAt('2026-12-31') - Date.UTC(2026, 11, 31, 13, 0)).toBe(0); // 悉尼夏令时 UTC+11
  });
  test('当天最后一刻还有效，次日 0 点过期', () => {
    const at = expiresAt('2026-11-20');
    expect(checkLicense(make('2026-11-20'), at - 1, 0, PUB).ok).toBe(true);
    expect(checkLicense(make('2026-11-20'), at, 0, PUB)).toMatchObject({ ok: false, reason: 'expired' });
  });
  test('没有文件 / 无效', () => {
    expect(checkLicense(null, NOW, 0, PUB)).toEqual({ ok: false, reason: 'missing' });
    expect(checkLicense('x', NOW, 0, PUB)).toEqual({ ok: false, reason: 'invalid' });
  });
  test('时间被调回超过 1 小时', () => {
    expect(checkLicense(make('2026-12-31'), NOW, NOW + CLOCK_BACK_TOLERANCE_MS + 1, PUB)).toMatchObject({ ok: false, reason: 'clock_back' });
    expect(checkLicense(make('2026-12-31'), NOW, NOW + CLOCK_BACK_TOLERANCE_MS - 1, PUB).ok).toBe(true);
  });
});

describe('LicenseGate', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), 'lic-'));
    dirs.push(d);
    let now = NOW;
    const repo = new Repo(openDb(':memory:'), randomBytes(32));
    const gate = new LicenseGate({ path: join(d, 'license.json'), repo, now: () => now, publicKey: PUB });
    return { d, gate, repo, setNow: (t: number) => (now = t) };
  };

  test('导入有效授权后保存；过期的授权不保存', () => {
    const t = setup();
    expect(t.gate.state()).toMatchObject({ ok: false, reason: 'missing' });
    expect(t.gate.import(make('2026-11-01')).ok).toBe(false);
    expect(existsSync(join(t.d, 'license.json'))).toBe(false);
    expect(t.gate.import(make('2026-12-31')).ok).toBe(true);
    expect(t.gate.state()).toMatchObject({ ok: true, until: '2026-12-31' });
  });

  test('调回时间被发现，调回之后不更新记录，所以改回来再调也不行', () => {
    const t = setup();
    t.gate.import(make('2026-12-31'));
    t.setNow(sydneyInstant('2026-12-30', '10:00'));
    expect(t.gate.ok()).toBe(true);
    t.setNow(NOW);
    expect(t.gate.state()).toMatchObject({ ok: false, reason: 'clock_back' });
    t.setNow(NOW + 3_600_000);
    expect(t.gate.state()).toMatchObject({ ok: false, reason: 'clock_back' });
    t.setNow(sydneyInstant('2026-12-30', '10:30'));
    expect(t.gate.ok()).toBe(true);
  });

  test('最晚时间存在数据库里，重启后仍然有效', () => {
    const t = setup();
    t.gate.import(make('2026-12-31'));
    t.gate.state();
    expect(Number(t.repo.getMeta('license.lastSeen'))).toBe(NOW);
  });
});
