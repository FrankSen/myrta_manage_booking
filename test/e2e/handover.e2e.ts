// 让位全流程：引擎（Service）+ 真实 Chrome（BrowserSession）+ 本地假 myrta 网站。
// A 找到自己目标里的考位 → 软件替 A 选电话、勾条款、点 Finish → 核实 → A 的原考位放回网站 → B 立刻抢到并提交。
// 运行：npm run test:e2e
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/config/settings.ts';
import type { NotifyEvent } from '../../src/engine/checker.ts';
import { Service } from '../../src/engine/service.ts';
import { realClock } from '../../src/scheduler/clock.ts';
import { BrowserSession } from '../../src/site/flow.ts';
import { openDb } from '../../src/storage/db.ts';
import { Repo } from '../../src/storage/repo.ts';
import { render } from '../../src/i18n.ts';
import { centres } from '../helpers/fakes.ts';
import { MockMyrta } from '../helpers/mock-myrta.ts';

const root = mkdtempSync(join(tmpdir(), 'myrta-e2e-hand-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SILVERWATER = { id: 241, name: 'Silverwater Service NSW Centre' };
const AUBURN = { id: 112, name: 'Auburn Service NSW Centre' };

test('A→B 让位：软件替 A 改约，B 立刻抢到 A 的原考位，全程无人值守', async () => {
  const site = new MockMyrta({
    centres: [SILVERWATER, AUBURN],
    bookings: [
      { bookingId: '1111111111', surname: 'Alpha', centreId: 241, date: '2026-12-30', time: '11:30' },
      { bookingId: '2222222222', surname: 'Bravo', centreId: 112, date: '2027-01-20', time: '09:00' },
    ],
    slots: { 241: ['2026-12-10 09:00'] },
  });
  await site.start();

  const repo = new Repo(openDb(':memory:'), randomBytes(32));
  const events: NotifyEvent[] = [];
  const service = new Service({
    repo, clock: realClock, centres,
    settings: { ...DEFAULT_SETTINGS, autoRebookEnabled: true, hidden: { ...DEFAULT_SETTINGS.hidden, globalMinGapMs: 500 } },
    limiter: { acquire: async () => {} },
    openSession: async (id) => new BrowserSession({ profileDir: join(root, `s${id}`), allowFinish: true, home: site.url }),
    notify: (e) => events.push(e),
  });

  const a = repo.addStudent({
    label: 'A', bookingId: '1111111111', surname: 'Alpha',
    current: { centreName: SILVERWATER.name, date: '2026-12-30', time: '11:30' },
    target: { centreIds: [241], dateFrom: '2026-12-07', dateTo: '2026-12-13', timeFrom: '08:00', timeTo: '12:00' },
  });
  const b = repo.addStudent({
    label: 'B', bookingId: '2222222222', surname: 'Bravo',
    current: { centreName: AUBURN.name, date: '2027-01-20', time: '09:00' },
    target: { centreIds: [112], dateFrom: '2027-01-01', dateTo: '2027-01-10', timeFrom: '08:00', timeTo: '12:00' },
  });

  const t0 = Date.now();
  try {
    expect(service.setHandover(a, b)).toBe('ok');
    for (let i = 0; i < 360 && repo.getStudent(b)!.status !== 'done'; i++) {
      const st = repo.getStudent(b)!.status;
      if (st === 'paused' || st === 'stopped') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const logs = repo.recentLogs(100).reverse().map((l) => `${l.studentId === a ? 'A' : l.studentId === b ? 'B' : '-'} ${render('zh', l.msg)}`);
    console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒\n${logs.join('\n')}`);

    expect(repo.getStudent(a)!.status).toBe('done');
    expect(repo.getStudent(a)!.current).toEqual({ centreName: SILVERWATER.name, date: '2026-12-10', time: '09:00' });
    expect(repo.getStudent(b)!.status).toBe('done');
    expect(repo.getStudent(b)!.current).toEqual({ centreName: SILVERWATER.name, date: '2026-12-30', time: '11:30' });
    // 网站这边：先 A 后 B 各提交一次，B 原来的考位放回网站
    expect(site.finished.map((f) => f.bookingId)).toEqual(['1111111111', '2222222222']);
    expect(site.booking('2222222222')).toMatchObject({ centreId: 241, date: '2026-12-30', time: '11:30' });
    expect(site.isAvailable(112, '2027-01-20', '09:00')).toBe(true);
    expect(events.filter((e) => e.type === 'rebooked').map((e) => e.studentId)).toEqual([a, b]);
    expect(repo.getStudent(a)!.handoverTo).toBeNull();
    expect(service.heldIds()).toEqual([]);
  } finally {
    await service.stopAll();
    await site.stop();
  }
});
