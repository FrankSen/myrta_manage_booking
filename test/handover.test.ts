// 让位：A 改约后，原考位由 B 立即去抢（2026-11-19 教练要求）。一对一；B 的目标固定为 A 的考位；双方自动提交
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.ts';
import type { NotifyEvent } from '../src/engine/checker.ts';
import { Service } from '../src/engine/service.ts';
import type { BookingInfo, LocalDate, Slot } from '../src/domain/types.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import { openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';
import { render } from '../src/i18n.ts';
import { AUBURN, FakeSession, NOW, SILVERWATER, SILVERWATER_NAME, baseTarget, centres } from './helpers/fakes.ts';

const MIN = 60_000;
const AUBURN_NAME = centres.get(AUBURN)!.name;
const key = (s: Slot) => `${s.centreId} ${s.date} ${s.time}`;
const centreIdOf = (name: string) => [...centres.values()].find((c) => c.name === name)!.id;

/** 所有学员共用的假网站：考位只有一份，改约时新考位被占、原考位放回 */
class Site {
  readonly free = new Set<string>();
  readonly bookings = new Map<number, BookingInfo>();
  submits: number[] = [];
  open(s: Slot) {
    this.free.add(key(s));
  }
}

class SharedSession extends FakeSession {
  private chosen: Slot | null = null;
  private readonly site: Site;
  private readonly id: number;
  constructor(site: Site, id: number) {
    super();
    this.site = site;
    this.id = id;
  }
  override async login(): Promise<BookingInfo> {
    this.calls.push('login');
    return this.site.bookings.get(this.id)!;
  }
  override async listSlots(centreId: number, from: LocalDate, to: LocalDate): Promise<Slot[]> {
    this.calls.push(`listSlots:${centreId}`);
    return [...this.site.free]
      .map((k) => k.split(' '))
      .filter(([c, d]) => Number(c) === centreId && d! >= from && d! <= to)
      .map(([c, date, time]) => ({ centreId: Number(c), date: date!, time: time! }));
  }
  override async reachConfirm(slot: Slot): Promise<BookingInfo> {
    this.calls.push(`reachConfirm:${key(slot)}`);
    this.chosen = slot;
    return { centreName: centres.get(slot.centreId)!.name, date: slot.date, time: slot.time };
  }
  override async finish(): Promise<'success' | 'failed' | 'unknown'> {
    this.calls.push('finish');
    const s = this.chosen!;
    if (!this.site.free.has(key(s))) return 'failed';
    const old = this.site.bookings.get(this.id)!;
    this.site.free.delete(key(s));
    this.site.free.add(key({ centreId: centreIdOf(old.centreName), date: old.date, time: old.time }));
    this.site.bookings.set(this.id, { centreName: centres.get(s.centreId)!.name, date: s.date, time: s.time });
    this.site.submits.push(this.id);
    return 'success';
  }
  override async readCurrent(): Promise<BookingInfo> {
    this.calls.push('readCurrent');
    return this.site.bookings.get(this.id)!;
  }
}

const A_SLOT: BookingInfo = { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' };
const B_SLOT: BookingInfo = { centreName: AUBURN_NAME, date: '2027-01-20', time: '09:00' };
/** A 想要的新考位（在 A 的目标 baseTarget 里） */
const A_NEW: Slot = { centreId: SILVERWATER, date: '2026-11-17', time: '10:00' };

function setup(settings: Partial<Settings> = {}) {
  const repo = new Repo(openDb(':memory:'), randomBytes(32));
  const clock = new FakeClock(NOW);
  const site = new Site();
  const sessions = new Map<number, SharedSession>();
  const events: NotifyEvent[] = [];
  const merged: Settings = { ...DEFAULT_SETTINGS, ...settings, hidden: { ...DEFAULT_SETTINGS.hidden, checkIntervalMs: 2 * MIN, globalMinGapMs: 20_000 } };
  const service = new Service({
    repo, clock, settings: merged, centres,
    limiter: { acquire: async () => {}, reportBlocked: () => 5 * MIN, reportOk: () => {} },
    openSession: async (id) => {
      const s = new SharedSession(site, id);
      sessions.set(id, s);
      return s;
    },
    notify: (e) => events.push(e),
    random: () => 0.5,
  });
  const add = (label: string, current: BookingInfo, target = baseTarget) => {
    const id = repo.addStudent({ label, bookingId: `${label}000000000`.slice(0, 10), surname: 'X', current, target });
    site.bookings.set(id, current);
    return id;
  };
  const a = add('A', A_SLOT);
  const b = add('B', B_SLOT, { ...baseTarget, centreIds: [AUBURN] });
  const logs = (id: number) => repo.recentLogs(100).filter((l) => l.studentId === id).map((l) => render('zh', l.msg));
  return { repo, clock, site, sessions, events, service, a, b, add, logs };
}

describe('设置让位', () => {
  test('设好后：B 的目标改为 A 的考位，A、B 都开始刷新，都自动提交', async () => {
    const t = setup();
    expect(t.service.setHandover(t.a, t.b)).toBe('ok');
    const b = t.repo.getStudent(t.b)!;
    expect(b.target).toEqual({ centreIds: [SILVERWATER], dateFrom: '2026-12-30', dateTo: '2026-12-30', timeFrom: '11:30', timeTo: '11:30', times: ['11:30'] });
    expect(t.repo.getStudent(t.a)!.handoverTo).toBe(t.b);
    expect(t.repo.handoverFrom(t.b)!.id).toBe(t.a);
    expect(t.service.activeIds().sort()).toEqual([t.a, t.b].sort());
    expect([t.service.autoSubmit(t.a), t.service.autoSubmit(t.b)]).toEqual([true, true]);
    expect(t.logs(t.b).some((l) => l.includes('接 A 的考位'))).toBe(true);
    await t.service.stopAll();
  });

  test('不能让给自己；一对一，不能串联', () => {
    const t = setup();
    const c = t.add('C', { centreName: AUBURN_NAME, date: '2027-02-01', time: '10:00' });
    expect(t.service.setHandover(t.a, t.a)).toBe('same');
    expect(t.service.setHandover(t.a, t.b)).toBe('ok');
    expect(t.service.setHandover(c, t.b)).toBe('taken'); // B 已经在接 A 的
    expect(t.service.setHandover(t.a, c)).toBe('taken'); // A 已经让给 B
    expect(t.service.setHandover(t.b, c)).toBe('taken'); // B 在接，不能再让
    expect(t.service.setHandover(c, t.a)).toBe('taken'); // A 在让，不能再接
    expect(t.service.setHandover(t.a, t.b)).toBe('ok'); // 重复设置同一对没问题
    void t.service.stopAll();
  });

  test('A 没有目标、已完成、考位 48 小时内、考点不认识：拒绝，什么都不改', () => {
    const t = setup();
    const before = t.repo.getStudent(t.b)!.target;
    t.repo.updateTarget(t.a, { ...baseTarget, centreIds: [] });
    expect(t.service.setHandover(t.a, t.b)).toBe('no_target');
    t.repo.updateTarget(t.a, baseTarget);
    t.repo.setStatus(t.b, 'done');
    expect(t.service.setHandover(t.a, t.b)).toBe('done');
    t.repo.setStatus(t.b, 'idle');
    t.repo.setCurrent(t.a, { ...A_SLOT, date: '2026-11-12' });
    expect(t.service.setHandover(t.a, t.b)).toBe('not_bookable');
    t.repo.setCurrent(t.a, { ...A_SLOT, centreName: 'Nowhere' });
    expect(t.service.setHandover(t.a, t.b)).toBe('unknown_centre');
    expect(t.service.setHandover(t.a, 999)).toBe('no_student');
    expect(t.repo.getStudent(t.b)!.target).toEqual(before);
    expect(t.repo.getStudent(t.a)!.handoverTo).toBeNull();
    expect(t.service.activeIds()).toEqual([]);
  });

  test('解除后：不再自动提交；删除 B 时 A 的让位一起清掉', async () => {
    const t = setup();
    t.service.setHandover(t.a, t.b);
    expect(t.service.setHandover(t.a, null)).toBe('ok');
    expect(t.repo.getStudent(t.a)!.handoverTo).toBeNull();
    expect([t.service.autoSubmit(t.a), t.service.autoSubmit(t.b)]).toEqual([false, false]);
    t.service.setHandover(t.a, t.b);
    t.service.pauseStudent(t.b);
    t.repo.deleteStudent(t.b);
    expect(t.repo.getStudent(t.a)!.handoverTo).toBeNull();
    await t.service.stopAll();
  });
});

describe('让位全流程', () => {
  test('A 找到目标考位 → 软件替 A 提交 → B 立刻抢到 A 的原考位并提交 → 让位完成', async () => {
    const t = setup();
    t.service.setHandover(t.a, t.b);
    await t.clock.advance(0);
    // 第一轮：A 的目标没有考位，B 盯着的 A 原考位还被 A 占着
    expect(t.site.submits).toEqual([]);
    expect(t.repo.getStudent(t.b)!.status).toBe('running');

    t.site.open(A_NEW);
    t.service.checkNow(t.a);
    await t.clock.advance(0);

    // A：自动提交（全局自动改约是关的），核实成功
    expect(t.repo.getStudent(t.a)!.status).toBe('done');
    expect(t.repo.getStudent(t.a)!.current).toEqual({ centreName: SILVERWATER_NAME, date: A_NEW.date, time: A_NEW.time });
    // B：不等下一轮，立刻抢到 A 的原考位
    expect(t.repo.getStudent(t.b)!.status).toBe('done');
    expect(t.repo.getStudent(t.b)!.current).toEqual(A_SLOT);
    expect(t.site.submits).toEqual([t.a, t.b]);
    // B 原来的考位也放回了网站
    expect(t.site.free.has(`${AUBURN} ${B_SLOT.date} ${B_SLOT.time}`)).toBe(true);
    expect(t.events.filter((e) => e.type === 'rebooked').map((e) => e.studentId)).toEqual([t.a, t.b]);
    // 让位完成后解除
    expect(t.repo.getStudent(t.a)!.handoverTo).toBeNull();
    expect(t.logs(t.b).some((l) => l.includes('A 让出了'))).toBe(true);
    expect(t.logs(t.a).some((l) => l.includes('让位完成'))).toBe(true);
    // 都不停在确认页
    expect(t.service.heldIds()).toEqual([]);
    await t.service.stopAll();
  });

  test('A 自己在网站上改约（软件外）：A 下一轮发现预约变了，B 立刻去抢', async () => {
    const t = setup();
    t.service.setHandover(t.a, t.b);
    await t.clock.advance(0);
    // 模拟 A 在网站上自己改到了别的考位，原考位放回
    t.site.bookings.set(t.a, { centreName: AUBURN_NAME, date: '2027-02-10', time: '13:00' });
    t.site.open({ centreId: SILVERWATER, date: A_SLOT.date, time: A_SLOT.time });
    t.service.checkNow(t.a);
    await t.clock.advance(0);
    expect(t.repo.getStudent(t.b)!.status).toBe('done');
    expect(t.repo.getStudent(t.b)!.current).toEqual(A_SLOT);
    expect(t.site.submits).toEqual([t.b]);
    await t.service.stopAll();
  });

  test('A 让出时 B 被暂停了：自动启动 B 去抢', async () => {
    const t = setup();
    t.service.setHandover(t.a, t.b);
    await t.clock.advance(0);
    t.service.pauseStudent(t.b);
    await t.clock.advance(0);
    t.site.open(A_NEW);
    t.service.checkNow(t.a);
    await t.clock.advance(0);
    expect(t.repo.getStudent(t.b)!.status).toBe('done');
    expect(t.repo.getStudent(t.b)!.current).toEqual(A_SLOT);
    await t.service.stopAll();
  });

  test('原考位被别人先抢走：B 提交失败，继续刷新盯着这个考位', async () => {
    const t = setup();
    t.service.setHandover(t.a, t.b);
    await t.clock.advance(0);
    t.site.open(A_NEW);
    // B 列出考位之后、提交之前被别人抢走
    const orig = SharedSession.prototype.reachConfirm;
    let once = false;
    SharedSession.prototype.reachConfirm = async function (this: SharedSession, slot: Slot) {
      const r = await orig.call(this, slot);
      if (!once && slot.date === A_SLOT.date) {
        once = true;
        t.site.free.delete(`${SILVERWATER} ${A_SLOT.date} ${A_SLOT.time}`);
      }
      return r;
    };
    try {
      t.service.checkNow(t.a);
      await t.clock.advance(0);
    } finally {
      SharedSession.prototype.reachConfirm = orig;
    }
    expect(t.repo.getStudent(t.a)!.status).toBe('done');
    expect(t.repo.getStudent(t.b)!.status).toBe('running');
    expect(t.repo.getStudent(t.b)!.current).toEqual(B_SLOT);
    expect(t.service.activeIds()).toContain(t.b);
    // 还在让位里，下次考位再出现照样自动提交
    expect(t.service.autoSubmit(t.b)).toBe(true);
    await t.service.stopAll();
  });

  test('不在让位里的学员：全局自动改约关闭时照旧停在确认页，不提交', async () => {
    const t = setup();
    const c = t.add('C', { centreName: AUBURN_NAME, date: '2027-03-01', time: '10:00' });
    t.service.startStudent(c);
    await t.clock.advance(0);
    t.site.open(A_NEW);
    t.service.checkNow(c);
    await t.clock.advance(0);
    expect(t.repo.getStudent(c)!.status).toBe('pending_confirm');
    expect(t.site.submits).toEqual([]);
    expect(t.sessions.get(c)!.calls).not.toContain('finish');
    await t.service.stopAll();
  });
});
