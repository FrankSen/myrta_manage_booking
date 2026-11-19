// 真实 Chrome 对着本地假 myrta 网站，验证 BrowserSession 的完整流程，包括点 Finish。
// 运行：npm run test:e2e（本机要有 Chrome 或 Edge）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BrowserSession } from '../../src/site/flow.ts';
import { SiteError } from '../../src/site/errors.ts';
import { MockMyrta } from '../helpers/mock-myrta.ts';

const SILVERWATER = { id: 241, name: 'Silverwater Service NSW Centre' };
const AUBURN = { id: 112, name: 'Auburn Service NSW Centre' };

const root = mkdtempSync(join(tmpdir(), 'myrta-e2e-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let site: MockMyrta;
const sessions: BrowserSession[] = [];
let n = 0;
const open = (allowFinish = true) => {
  const s = new BrowserSession({ profileDir: join(root, `p${++n}`), allowFinish, home: site.url });
  sessions.push(s);
  return s;
};

beforeEach(async () => {
  site = new MockMyrta({
    centres: [SILVERWATER, AUBURN],
    bookings: [
      { bookingId: '1111111111', surname: 'Alpha', centreId: 241, date: '2026-12-30', time: '11:30' },
      { bookingId: '2222222222', surname: 'Bravo', centreId: 112, date: '2027-01-20', time: '09:00' },
    ],
    // A 想要的新考位在 12-10；12-30 11:30 现在被 A 占着
    slots: { 241: ['2026-12-10 09:00', '2026-12-17 14:15'], 112: ['2027-01-13 10:00'] },
  });
  await site.start();
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await site.stop();
});

describe('BrowserSession × 假网站', () => {
  test('A 改约（点 Finish）→ 原考位放回 → B 抢到 A 的原考位', async () => {
    const a = open();
    const before = await a.login('1111111111', 'Alpha');
    expect(before).toEqual({ centreName: SILVERWATER.name, date: '2026-12-30', time: '11:30' });

    const slots = await a.listSlots(241, '2026-12-01', '2026-12-31');
    expect(slots).toContainEqual({ centreId: 241, date: '2026-12-10', time: '09:00' });
    expect(slots).not.toContainEqual({ centreId: 241, date: '2026-12-30', time: '11:30' });

    const confirm = await a.reachConfirm({ centreId: 241, date: '2026-12-10', time: '09:00' });
    expect(confirm).toEqual({ centreName: SILVERWATER.name, date: '2026-12-10', time: '09:00' });
    expect(await a.finish()).toBe('success');
    // 完成页没有返回按钮：readCurrent 要能重新登录读到新预约
    expect(await a.readCurrent()).toEqual({ centreName: SILVERWATER.name, date: '2026-12-10', time: '09:00' });
    expect(site.isAvailable(241, '2026-12-30', '11:30')).toBe(true);

    const b = open();
    await b.login('2222222222', 'Bravo');
    const forB = await b.listSlots(241, '2026-12-28', '2027-01-03');
    expect(forB).toContainEqual({ centreId: 241, date: '2026-12-30', time: '11:30' });
    await b.reachConfirm({ centreId: 241, date: '2026-12-30', time: '11:30' });
    expect(await b.finish()).toBe('success');
    expect(await b.readCurrent()).toEqual({ centreName: SILVERWATER.name, date: '2026-12-30', time: '11:30' });
    // B 原来的考位也放回去了
    expect(site.isAvailable(112, '2027-01-20', '09:00')).toBe(true);
    expect(site.finished.map((f) => f.bookingId)).toEqual(['1111111111', '2222222222']);
  });

  test('到确认页后考位被别人抢走：finish 返回 failed，预约不变', async () => {
    const a = open();
    await a.login('1111111111', 'Alpha');
    await a.listSlots(241, '2026-12-07', '2026-12-13');
    await a.reachConfirm({ centreId: 241, date: '2026-12-10', time: '09:00' });
    site.take(241, '2026-12-10', '09:00');
    expect(await a.finish()).toBe('failed');
    expect(await a.readCurrent()).toEqual({ centreName: SILVERWATER.name, date: '2026-12-30', time: '11:30' });
    expect(site.finished).toEqual([]);
  });

  test('没开提交开关：finish 直接拒绝，不碰网站', async () => {
    const a = open(false);
    await a.login('1111111111', 'Alpha');
    await a.listSlots(241, '2026-12-07', '2026-12-13');
    await a.reachConfirm({ centreId: 241, date: '2026-12-10', time: '09:00' });
    await expect(a.finish()).rejects.toThrow(SiteError);
    expect(site.finished).toEqual([]);
  });

  test('资料不对：立即报 bad_credentials，带网站原话', async () => {
    const a = open();
    const err = await a.login('1111111111', 'Wrong').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).kind).toBe('bad_credentials');
    expect((err as SiteError).message).toMatch(/incorrect/);
  });

  test('Manage booking 链接缓存：第二个会话不再访问首页', async () => {
    await open().login('1111111111', 'Alpha');
    const homeHits = site.hits.filter((h) => h === '/').length;
    expect(homeHits).toBe(1);
    await open().login('2222222222', 'Bravo');
    expect(site.hits.filter((h) => h === '/').length).toBe(1);
  });
});
