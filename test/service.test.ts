import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.ts';
import type { NotifyEvent } from '../src/engine/checker.ts';
import { HOLD_MS, RELEASE_RECHECK_MS, Service } from '../src/engine/service.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import { Limiter } from '../src/scheduler/limiter.ts';
import { SiteError } from '../src/site/errors.ts';
import { openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';
import { render } from '../src/i18n.ts';
import { FakeSession, NOW, SILVERWATER, baseTarget, centres, slot } from './helpers/fakes.ts';

const MIN = 60_000;

function setup(settings: Partial<Settings> = {}, allowed?: () => boolean) {
  const repo = new Repo(openDb(':memory:'), randomBytes(32));
  const clock = new FakeClock(NOW);
  const sessions = new Map<number, FakeSession>();
  const events: NotifyEvent[] = [];
  const limiter = { acquire: async () => {}, reportBlocked: () => 5 * MIN, reportOk: () => {} };
  const merged: Settings = { ...DEFAULT_SETTINGS, ...settings, hidden: { ...DEFAULT_SETTINGS.hidden, ...(settings.hidden ?? {}) } };
  const service = new Service({
    repo, clock, limiter, settings: merged, centres,
    openSession: async (id) => {
      const s = new FakeSession();
      sessions.set(id, s);
      return s;
    },
    notify: (e) => events.push(e),
    random: () => 0.5,
    allowed,
  });
  const addStudent = (label = 'S') =>
    repo.addStudent({
      label, bookingId: '1234567890', surname: 'Testsurname',
      current: { centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' },
      target: baseTarget,
    });
  return { repo, clock, service, sessions, events, addStudent };
}

describe('启动与暂停', () => {
  test('startStudent 把状态改为 running 并立刻检查一轮', async () => {
    const t = setup();
    const id = t.addStudent();
    expect(t.service.startStudent(id)).toBe(true);
    await t.clock.advance(0);
    expect(t.repo.getStudent(id)!.status).toBe('running');
    expect(t.sessions.get(id)!.calls[0]).toBe('login');
  });

  test('默认最多 5 个学员同时刷新：第 6 个返回 false，状态不变', async () => {
    const t = setup();
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'].map((l) => t.addStudent(l));
    expect(ids.map((id) => t.service.startStudent(id))).toEqual([true, true, true, true, true, false]);
    expect(t.repo.getStudent(ids[5]!)!.status).toBe('idle');
    await t.service.stopAll();
  });

  test('上限可通过隐藏配置调整', () => {
    const t = setup({ hidden: { ...DEFAULT_SETTINGS.hidden, maxActiveStudents: 3 } });
    const ids = [t.addStudent('A'), t.addStudent('B'), t.addStudent('C')];
    expect(ids.map((id) => t.service.startStudent(id))).toEqual([true, true, true]);
  });

  test('pauseStudent 后不再检查，会话关闭，名额释放', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    t.service.pauseStudent(id);
    await t.clock.advance(0);
    const calls = t.sessions.get(id)!.calls.length;
    await t.clock.advance(10 * MIN);
    expect(t.sessions.get(id)!.calls.length).toBe(calls);
    expect(t.sessions.get(id)!.closed).toBe(true);
    expect(t.repo.getStudent(id)!.status).toBe('paused');
    expect(t.service.activeIds()).toEqual([]);
  });

  test('已完成的学员不能再启动', () => {
    const t = setup();
    const id = t.addStudent();
    t.repo.setStatus(id, 'done');
    expect(t.service.startStudent(id)).toBe(false);
  });

  test('resumeAll：只重新启动上次还在 running 的学员', async () => {
    const t = setup();
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.repo.setStatus(a, 'running');
    t.repo.setStatus(b, 'paused');
    t.service.resumeAll();
    expect(t.service.activeIds()).toEqual([a]);
    await t.service.stopAll();
  });
});

describe('退出', () => {
  test('页面操作卡住时：先关浏览器让操作立即结束，不等页面超时；学员保持刷新中，重启后继续', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    // 下一轮读考位时卡住，直到浏览器被关掉
    let hung = false;
    s.listSlots = () => {
      hung = true;
      return new Promise((_, reject) => {
        s.close = async () => {
          s.closed = true;
          reject(new Error('Target page, context or browser has been closed'));
        };
      });
    };
    await t.clock.advance(3 * MIN);
    expect(hung).toBe(true);

    const started = Date.now();
    await t.service.stopAll();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s.closed).toBe(true);
    expect(t.repo.getStudent(id)!.status).toBe('running');
  });

  test('退出后不会再打开新的浏览器', async () => {
    const t = setup();
    const id = t.addStudent();
    const offerId = t.repo.addOffer({ studentId: id, centreId: SILVERWATER, date: '2026-11-17', time: '13:00', notes: [] }, NOW)!;
    await t.service.stopAll();
    expect(await t.service.acceptOffer(offerId)).toBe('error');
    expect(t.sessions.size).toBe(0);
  });
});

describe('改约成功后', () => {
  test('学员不再被调度，会话关闭', async () => {
    const t = setup({ autoRebookEnabled: true });
    const id = t.addStudent();
    // 让第一个会话里有完全符合的考位
    const origOpen = t.sessions;
    t.service.startStudent(id);
    // 会话是在 startStudent 的第一轮里创建的，先让它创建，再往里放考位，第二轮才会命中
    await t.clock.advance(0);
    const s = origOpen.get(id)!;
    s.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    await t.clock.advance(3 * MIN);
    expect(t.repo.getStudent(id)!.status).toBe('done');
    expect(t.service.activeIds()).toEqual([]);
    expect(s.closed).toBe(true);
    const callsAfter = s.calls.length;
    await t.clock.advance(10 * MIN);
    expect(s.calls.length).toBe(callsAfter);
    expect(t.events.some((e) => e.type === 'rebooked')).toBe(true);
  });

  test('一个学员成功后，名额释放给其他学员', async () => {
    const t = setup({ autoRebookEnabled: true, hidden: { ...DEFAULT_SETTINGS.hidden, maxActiveStudents: 1 } });
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.service.startStudent(a);
    expect(t.service.startStudent(b)).toBe(false);
    await t.clock.advance(0);
    t.sessions.get(a)!.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    await t.clock.advance(3 * MIN);
    expect(t.service.startStudent(b)).toBe(true);
    await t.service.stopAll();
  });
});

describe('教练确认接近的考位', () => {
  const nearSlot = () => slot(SILVERWATER, '2026-11-17', '13:00');

  async function withOffer(settings: Partial<Settings> = {}) {
    const t = setup(settings);
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    s.slotsByCentre.set(SILVERWATER, [nearSlot()]);
    await t.clock.advance(3 * MIN);
    const offer = t.repo.listOffers(id)[0]!;
    return { ...t, id, s, offer };
  }

  test('考位还在、自动改约开启：改约成功，学员完成', async () => {
    const t = await withOffer({ autoRebookEnabled: true });
    expect(await t.service.acceptOffer(t.offer.id)).toBe('success');
    expect(t.repo.getOffer(t.offer.id)!.state).toBe('accepted');
    expect(t.repo.getStudent(t.id)!.status).toBe('done');
    expect(t.repo.getStudent(t.id)!.current).toMatchObject({ date: '2026-11-17', time: '13:00' });
  });

  test('自动改约关闭：只走到确认页，不点 Finish', async () => {
    const t = await withOffer({ autoRebookEnabled: false });
    expect(await t.service.acceptOffer(t.offer.id)).toBe('dry_run');
    expect(t.s.calls).not.toContain('finish');
    expect(t.s.calls.some((c) => c.startsWith('reachConfirm:241:2026-11-17:13:00'))).toBe(true);
    expect(t.repo.getStudent(t.id)!.status).toBe('pending_confirm');
    // 停在确认页等教练：浏览器不关，窗口调到前面
    expect(t.s.closed).toBe(false);
    expect(t.s.calls.at(-1)).toBe('reveal');
    expect(t.service.holdInfo(t.id)).toMatchObject({ slot: { date: '2026-11-17', time: '13:00' } });
    await t.service.stopAll();
  });

  test('考位已经没了：标记 gone，不改约，学员继续刷新', async () => {
    const t = await withOffer({ autoRebookEnabled: true });
    t.s.slotsByCentre.set(SILVERWATER, []);
    expect(await t.service.acceptOffer(t.offer.id)).toBe('gone');
    expect(t.repo.getOffer(t.offer.id)!.state).toBe('gone');
    expect(t.s.calls).not.toContain('finish');
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    await t.service.stopAll();
  });

  test('确认前考位已进入 48 小时线：gone，不访问站点', async () => {
    const t = await withOffer({ autoRebookEnabled: true });
    t.service.pauseStudent(t.id); // 停掉定时检查，避免快进时间时它去访问站点
    await t.clock.advance(5 * 24 * 60 * MIN); // 11-16 10:00，距 11-17 13:00 不足 48 小时
    const before = t.s.calls.length;
    expect(await t.service.acceptOffer(t.offer.id)).toBe('gone');
    expect(t.s.calls.length).toBe(before);
  });

  test('已处理过的 offer、不存在的 offer 都返回 not_open', async () => {
    const t = await withOffer({ autoRebookEnabled: true });
    t.service.dismissOffer(t.offer.id);
    expect(await t.service.acceptOffer(t.offer.id)).toBe('not_open');
    expect(await t.service.acceptOffer(99999)).toBe('not_open');
    await t.service.stopAll();
  });

  test('页面说失败且预约没变（被别人抢走）：failed，学员继续刷新', async () => {
    const t = await withOffer({ autoRebookEnabled: true });
    t.s.finishResult = 'failed';
    t.s.finishChangesBooking = false;
    expect(await t.service.acceptOffer(t.offer.id)).toBe('failed');
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    await t.service.stopAll();
  });

  test('确认过程出错：error，学员暂停', async () => {
    const t = await withOffer({ autoRebookEnabled: true });
    t.s.finishThrows = new Error('页面崩了');
    expect(await t.service.acceptOffer(t.offer.id)).toBe('error');
    expect(t.repo.getStudent(t.id)!.status).toBe('paused');
    expect(t.service.activeIds()).toEqual([]);
  });
});

describe('互斥与退出', () => {
  test('同一学员的确认和定时检查不会同时操作同一个浏览器', async () => {
    const t = setup({ autoRebookEnabled: true });
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    s.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '13:00')]);
    await t.clock.advance(3 * MIN);
    const offer = t.repo.listOffers(id)[0]!;

    let active = 0;
    let maxActive = 0;
    for (const name of ['login', 'listSlots', 'reachConfirm', 'finish', 'readCurrent'] as const) {
      const orig = (s as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!.bind(s);
      (s as unknown as Record<string, unknown>)[name] = async (...a: unknown[]) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        await Promise.resolve();
        try { return await orig(...a); } finally { active--; }
      };
    }
    const accept = t.service.acceptOffer(offer.id);
    await t.clock.advance(3 * MIN);
    await accept;
    expect(maxActive).toBe(1);
    await t.service.stopAll();
  });

  test('stopAll 关闭所有会话，之后不再调度', async () => {
    const t = setup();
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.service.startStudent(a);
    t.service.startStudent(b);
    await t.clock.advance(0);
    await t.service.stopAll();
    expect(t.sessions.get(a)!.closed).toBe(true);
    expect(t.sessions.get(b)!.closed).toBe(true);
    const calls = t.sessions.get(a)!.calls.length;
    await t.clock.advance(10 * MIN);
    expect(t.sessions.get(a)!.calls.length).toBe(calls);
  });
});

describe('退出时不被限速等待卡住', () => {
  test('检查正卡在全局限速的长时间等待里，stopAll 也能马上返回', async () => {
    const repo = new Repo(openDb(':memory:'), randomBytes(32));
    const clock = new FakeClock(NOW);
    const { Limiter } = await import('../src/scheduler/limiter.ts');
    const limiter = new Limiter(clock, DEFAULT_SETTINGS.hidden);
    limiter.reportBlocked(); // 5 分钟退避
    const sessions: FakeSession[] = [];
    const service = new Service({
      repo, clock, limiter, settings: DEFAULT_SETTINGS, centres,
      openSession: async () => { const s = new FakeSession(); sessions.push(s); return s; },
      notify: () => {},
    });
    const id = repo.addStudent({
      label: 'S', bookingId: '1234567890', surname: 'T',
      current: { centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' }, target: baseTarget,
    });
    service.startStudent(id);
    await clock.advance(0); // 正在等 5 分钟的退避，还没开浏览器
    expect(sessions).toHaveLength(0);
    await service.stopAll(); // 没有 clock.advance，不能卡住
    expect(repo.getStudent(id)!.status).toBe('running'); // 被中断不是失败，不改状态
  });
});

describe('刷新间隔与进度', () => {
  test('每完成一轮计数；重新开始时清零', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    await t.clock.advance(3 * MIN);
    expect(t.repo.getStudent(id)!.rounds).toBe(2);
    t.service.pauseStudent(id);
    await t.clock.advance(0);
    expect(t.repo.getStudent(id)!.rounds).toBe(2);
    t.service.startStudent(id);
    await t.clock.advance(0);
    expect(t.repo.getStudent(id)!.rounds).toBe(1);
    await t.service.stopAll();
  });

  test('程序重启后自动继续的学员，轮数不清零', async () => {
    const t = setup();
    const id = t.addStudent();
    t.repo.setStatus(id, 'running');
    t.repo.countRound(id, 1);
    t.service.resumeAll();
    await t.clock.advance(0);
    expect(t.repo.getStudent(id)!.rounds).toBe(2);
    await t.service.stopAll();
  });

  test('progress：等待中给出下一轮时刻，正在跑时给出阶段', async () => {
    const t = setup();
    const id = t.addStudent();
    expect(t.service.progress(id)).toBeNull();
    t.service.startStudent(id);
    await t.clock.advance(0);
    expect(t.service.progress(id)).toEqual({ running: false, nextAt: NOW + 2 * MIN, phase: '' });
    await t.service.stopAll();
  });

  test('改全局间隔：等待中的学员立刻按新间隔计时', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    t.service.setGlobalInterval(5 * MIN);
    await t.clock.advance(0);
    expect(t.service.progress(id)!.nextAt).toBe(NOW + 5 * MIN);
    expect(t.service.intervalFor(id)).toBe(5 * MIN);
    await t.service.stopAll();
  });

  test('学员单独间隔优先于全局；取消后回到全局', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    t.service.setStudentInterval(id, 10 * MIN);
    await t.clock.advance(0);
    expect(t.service.progress(id)!.nextAt).toBe(NOW + 10 * MIN);
    t.service.setGlobalInterval(3 * MIN);
    expect(t.service.intervalFor(id)).toBe(10 * MIN);
    t.service.setStudentInterval(id, null);
    await t.clock.advance(0);
    expect(t.service.intervalFor(id)).toBe(3 * MIN);
    expect(t.service.progress(id)!.nextAt).toBe(NOW + 3 * MIN);
    await t.service.stopAll();
  });
});

describe('预计刷新周期', () => {
  test('一个学员：设定间隔加一轮耗时', () => {
    const t = setup();
    const id = t.addStudent();
    // 只查 1 个目标考点，一轮访问 1 次
    expect(t.service.visits(id)).toBe(1);
    expect(t.service.expectedCycle(id)).toBe(2 * MIN + 15_000 + 35_000);
  });

  test('5 个学员各 2 个考点：排队时间超过设定间隔', async () => {
    const t = setup();
    const ids = ['A', 'B', 'C', 'D', 'E'].map((l) => t.addStudent(l));
    for (const id of ids) t.repo.updateTarget(id, { ...baseTarget, centreIds: [SILVERWATER, 112] });
    for (const id of ids) t.service.startStudent(id);
    // 每人 2 次，共 10 次 × 20 秒 = 200 秒；自己这一轮 2 分 + 15 秒 + 2 × 35 秒 = 205 秒，取较大的
    expect(t.service.expectedCycle(ids[0]!)).toBe(205_000);
    await t.service.stopAll();
  });

  test('没在刷新的学员按"加上它之后"估算', () => {
    const t = setup({ hidden: { ...DEFAULT_SETTINGS.hidden, checkIntervalMs: MIN } });
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.service.startStudent(a);
    // 各 1 个考点：自己一轮 1 分 + 15 秒 + 35 秒；两人共 2 次访问 × 20 秒
    expect(t.service.expectedCycle(b)).toBe(Math.max(MIN + 15_000 + 35_000, 2 * 20_000));
  });
});

describe('授权到期', () => {
  test('到期后到点不访问站点、不算轮数，状态保持刷新中；续期后下一轮继续', async () => {
    let ok = true;
    const t = setup({}, () => ok);
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const calls = t.sessions.get(id)!.calls.length;
    expect(t.repo.getStudent(id)!.rounds).toBe(1);
    ok = false;
    await t.clock.advance(5 * MIN);
    expect(t.sessions.get(id)!.calls.length).toBe(calls);
    expect(t.sessions.get(id)!.closed).toBe(true);
    expect(t.repo.getStudent(id)!.rounds).toBe(1);
    expect(t.repo.getStudent(id)!.status).toBe('running');
    ok = true;
    await t.clock.advance(5 * MIN);
    expect(t.repo.getStudent(id)!.rounds).toBeGreaterThan(1);
    await t.service.stopAll();
  });
});

describe('rebookingIds', () => {
  test('走到确认页的过程中算"正在改约"，结束后不算', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    // 第一轮没有考位；下一轮同一个会话出现完全符合的考位
    const s = t.sessions.get(id)!;
    let seen: number[] = [];
    const orig = s.reachConfirm.bind(s);
    s.reachConfirm = async (x) => { seen = t.service.rebookingIds(); return orig(x); };
    s.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:00')]);
    expect(t.service.rebookingIds()).toEqual([]);
    await t.clock.advance(2 * MIN);
    expect(seen).toEqual([id]);
    expect(t.repo.getStudent(id)!.status).toBe('pending_confirm');
    expect(t.service.rebookingIds()).toEqual([]);
    await t.service.stopAll();
  });
});

describe('退出时等浏览器关完', () => {
  test('暂停后马上退出：stopAll 等暂停时开始的关闭完成，即使超过 3 秒', { timeout: 10_000 }, async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    let release!: () => void;
    let closed = false;
    s.close = () => new Promise<void>((r) => { release = () => { closed = true; r(); }; });
    t.service.pauseStudent(id);
    await new Promise((r) => setTimeout(r, 0));
    const stopping = t.service.stopAll();
    let done = false;
    void stopping.then(() => (done = true));
    // 真实浏览器退出可能超过 3 秒（stopAll 等页面操作的上限）
    await new Promise((r) => setTimeout(r, 3300));
    expect(done).toBe(false);
    release();
    await stopping;
    expect(closed).toBe(true);
  });
});

describe('停在确认页等教练（自动改约关闭）', () => {
  const exact = () => slot(SILVERWATER, '2026-11-17', '10:00');

  /** 第一轮没有考位，第二轮出现完全符合的考位，停在确认页 */
  async function held() {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    s.slotsByCentre.set(SILVERWATER, [exact()]);
    await t.clock.advance(2 * MIN);
    expect(t.repo.getStudent(id)!.status).toBe('pending_confirm');
    return { ...t, id, s };
  }
  const moveTo = (s: FakeSession, x: { date: string; time: string }) => (s.current = { centreName: 'Silverwater Service NSW Centre', date: x.date, time: x.time });

  test('浏览器不关、窗口调到前面，保留 10 分钟；保留期间不再刷新', async () => {
    const t = await held();
    expect(t.s.closed).toBe(false);
    expect(t.s.calls.at(-1)).toBe('reveal');
    const h = t.service.holdInfo(t.id)!;
    expect(h.until).toBe(t.clock.now() + HOLD_MS);
    expect(HOLD_MS).toBe(10 * MIN);
    expect(t.service.activeIds()).toEqual([]);
    expect(t.service.heldIds()).toEqual([t.id]);
    const n = t.s.calls.length;
    await t.clock.advance(9 * MIN);
    expect(t.s.calls.length).toBe(n);
    await t.service.stopAll();
  });

  test('放弃，继续找：回到查看预约页（核实预约没变）、窗口最小化，用同一个浏览器继续刷新', async () => {
    const t = await held();
    expect(await t.service.endHold(t.id, 'abandon')).toBe('resumed');
    expect(t.s.calls.slice(-2)).toEqual(['login', 'conceal']);
    expect(t.s.closed).toBe(false);
    expect(t.service.holdInfo(t.id)).toBeNull();
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    t.s.slotsByCentre.set(SILVERWATER, []);
    await t.clock.advance(3 * MIN);
    expect(t.sessions.size).toBe(1);
    expect(t.s.calls.filter((c) => c === 'login').length).toBeGreaterThanOrEqual(3);
    await t.service.stopAll();
  });

  test('教练在浏览器里提交了，点"我已在网站提交"：重新读取核实，标记已改约', async () => {
    const t = await held();
    moveTo(t.s, exact());
    expect(await t.service.endHold(t.id, 'submitted')).toBe('rebooked');
    const st = t.repo.getStudent(t.id)!;
    expect(st.status).toBe('done');
    expect(st.current).toMatchObject({ date: '2026-11-17', time: '10:00' });
    expect(t.events.find((e) => e.type === 'rebooked')).toBeTruthy();
    expect(t.s.closed).toBe(true);
    expect(t.s.calls).not.toContain('finish');
  });

  test('点了"我已在网站提交"但读不到预约：不当作没改，暂停并报警', async () => {
    const t = await held();
    t.s.loginError = new Error('boom');
    expect(await t.service.endHold(t.id, 'submitted')).toBe('unknown');
    expect(t.repo.getStudent(t.id)!.status).toBe('paused');
    expect(t.events.find((e) => e.type === 'error')).toMatchObject({ kind: 'finish_unverified' });
    expect(t.service.activeIds()).toEqual([]);
  });

  test('保留期间预约变成了别的考位：暂停，请教练核对', async () => {
    const t = await held();
    moveTo(t.s, { date: '2026-11-19', time: '09:00' });
    expect(await t.service.endHold(t.id, 'abandon')).toBe('changed');
    const st = t.repo.getStudent(t.id)!;
    expect(st.status).toBe('paused');
    expect(st.current).toMatchObject({ date: '2026-11-19' });
    expect(t.service.activeIds()).toEqual([]);
  });

  test('点了"我已在网站提交"但预约没变：如实告诉教练，继续刷新', async () => {
    const t = await held();
    expect(await t.service.endHold(t.id, 'submitted')).toBe('unchanged');
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    expect(t.repo.recentLogs(50).some((l) => render('zh', l.msg).includes('预约没有变化'))).toBe(true);
    await t.service.stopAll();
  });

  test('放弃过的考位，之后再出现也不再停下（其他考位照常）', async () => {
    const t = await held();
    expect(await t.service.endHold(t.id, 'abandon')).toBe('resumed');
    await t.clock.advance(3 * MIN);
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    expect(t.service.holdInfo(t.id)).toBeNull();
    t.s.slotsByCentre.set(SILVERWATER, [exact(), slot(SILVERWATER, '2026-11-18', '10:00')]);
    await t.clock.advance(3 * MIN);
    expect(t.service.holdInfo(t.id)).toMatchObject({ slot: { date: '2026-11-18' } });
    await t.service.stopAll();
  });

  test('超过 10 分钟没处理：自动放弃确认页，继续刷新', async () => {
    const t = await held();
    t.s.slotsByCentre.set(SILVERWATER, []);
    await t.clock.advance(HOLD_MS);
    expect(t.service.holdInfo(t.id)).toBeNull();
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    expect(t.s.calls).toContain('conceal');
    expect(t.repo.recentLogs(50).some((l) => render('zh', l.msg).includes('10 分钟'))).toBe(true);
    await t.service.stopAll();
  });

  test('超时时发现教练已经在浏览器里提交：标记已改约，不再刷新', async () => {
    const t = await held();
    moveTo(t.s, exact());
    await t.clock.advance(HOLD_MS);
    expect(t.repo.getStudent(t.id)!.status).toBe('done');
    expect(t.service.activeIds()).toEqual([]);
  });

  test('回到查看预约页失败：关掉浏览器，仍然继续刷新（下一轮重新登录）', async () => {
    const t = await held();
    t.s.loginError = new Error('boom');
    expect(await t.service.endHold(t.id, 'abandon')).toBe('resumed');
    expect(t.s.closed).toBe(true);
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    await t.service.stopAll();
  });

  test('保留期间暂停：关掉浏览器、取消保留，之后到时间也不再动', async () => {
    const t = await held();
    t.service.pauseStudent(t.id);
    await t.clock.advance(0);
    expect(t.s.closed).toBe(true);
    expect(t.service.holdInfo(t.id)).toBeNull();
    await t.clock.advance(HOLD_MS);
    expect(t.repo.getStudent(t.id)!.status).toBe('paused');
  });

  test('保留期间"继续"（startStudent）等同放弃确认页', async () => {
    const t = await held();
    t.s.slotsByCentre.set(SILVERWATER, []);
    expect(t.service.startStudent(t.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await t.clock.advance(0);
    expect(t.service.holdInfo(t.id)).toBeNull();
    expect(t.s.calls).toContain('conceal');
    expect(t.repo.getStudent(t.id)!.status).toBe('running');
    await t.service.stopAll();
  });

  test('没有在保留的学员：endHold 返回 not_held', async () => {
    const t = setup();
    const id = t.addStudent();
    expect(await t.service.endHold(id, 'abandon')).toBe('not_held');
  });

  test('退出：关浏览器、取消保留，状态留在"已找到"', async () => {
    const t = await held();
    await t.service.stopAll();
    expect(t.s.closed).toBe(true);
    expect(t.service.holdInfo(t.id)).toBeNull();
    expect(t.repo.getStudent(t.id)!.status).toBe('pending_confirm');
  });

  test('再次显示浏览器窗口', async () => {
    const t = await held();
    expect(await t.service.revealHold(t.id)).toBe(true);
    expect(t.s.calls.at(-1)).toBe('reveal');
    await t.service.stopAll();
  });
});

describe('原考位放出后，立即为想要它的学员查一次', () => {
  const A_OLD = { centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' };
  const wantOld = { centreIds: [SILVERWATER], dateFrom: '2026-12-30', dateTo: '2026-12-30', timeFrom: '11:30', timeTo: '11:30' };
  const lists = (s: FakeSession) => s.calls.filter((c) => c.startsWith('listSlots')).length;

  /** A 停在确认页；B 想要 A 的原考位，第一轮已跑完，在等下一轮；C 的目标无关 */
  async function scene(settings: Partial<Settings> = {}) {
    const t = setup(settings);
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    const c = t.addStudent('C');
    t.repo.updateTarget(b, wantOld);
    for (const id of [b, c, a]) t.service.startStudent(id);
    await t.clock.advance(0);
    t.sessions.get(a)!.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:00')]);
    // A 的下一轮在 2 分钟左右（B、C 的也是），之后大家都在等下一轮
    await t.clock.advance(3 * MIN);
    return { ...t, a, b, c, sa: t.sessions.get(a)!, sb: t.sessions.get(b)!, sc: t.sessions.get(c)! };
  }

  test('教练在浏览器里给 A 提交后核实成功：B 立刻查一次，约 1 分钟后再补查一次；C 不动', async () => {
    const t = await scene();
    expect(t.service.holdInfo(t.a)).not.toBeNull();
    const nb = lists(t.sb), nc = lists(t.sc);
    t.sa.current = { centreName: A_OLD.centreName, date: '2026-11-17', time: '10:00' };
    expect(await t.service.endHold(t.a, 'submitted')).toBe('rebooked');
    await t.clock.advance(0);
    const v = t.service.visits(t.b);
    expect(lists(t.sb)).toBe(nb + v);
    expect(lists(t.sc)).toBe(nc);
    await t.clock.advance(RELEASE_RECHECK_MS);
    // C 自己定时的那一轮也在这 1 分钟里，所以 C 只检查没有被"放出"触发
    expect(lists(t.sb)).toBe(nb + 2 * v);
    expect(t.repo.recentLogs(30).some((l) => l.studentId === t.c && render('zh', l.msg).includes('原考位'))).toBe(false);
    expect(t.repo.recentLogs(20).some((l) => l.studentId === t.b && render('zh', l.msg).includes('A 的原考位'))).toBe(true);
    await t.service.stopAll();
  });

  test('自动改约成功（Finish 后核实）也会触发', async () => {
    const t = setup({ autoRebookEnabled: true });
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.repo.updateTarget(b, wantOld);
    t.service.startStudent(b);
    t.service.startStudent(a);
    await t.clock.advance(0);
    const sb = t.sessions.get(b)!;
    const nb = lists(sb);
    t.sessions.get(a)!.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:00')]);
    t.service.checkNow(a);
    await t.clock.advance(0);
    expect(t.repo.getStudent(a)!.status).toBe('done');
    expect(lists(sb)).toBe(nb + t.service.visits(b));
    await t.service.stopAll();
  });

  test('A 的预约在软件外被改了（登录时读到的和记录的不同）：同样触发', async () => {
    const t = setup();
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.repo.updateTarget(b, wantOld);
    t.service.startStudent(b);
    t.service.startStudent(a);
    await t.clock.advance(0);
    const nb = lists(t.sessions.get(b)!);
    t.sessions.get(a)!.current = { centreName: A_OLD.centreName, date: '2026-11-19', time: '09:00' };
    await t.clock.advance(5 * MIN);
    expect(t.repo.getStudent(a)!.current.date).toBe('2026-11-19');
    // B 自己的定时那一轮也在这 5 分钟里，所以至少多两次
    expect(lists(t.sessions.get(b)!)).toBeGreaterThanOrEqual(nb + 2 * t.service.visits(b));
    expect(t.repo.recentLogs(30).some((l) => l.studentId === b && render('zh', l.msg).includes('A 的原考位'))).toBe(true);
    await t.service.stopAll();
  });

  test('原考位已进入 48 小时线：不触发', async () => {
    const t = setup();
    const a = t.repo.addStudent({ label: 'A', bookingId: '1', surname: 'X', current: { centreName: A_OLD.centreName, date: '2026-11-12', time: '09:00' }, target: baseTarget });
    const b = t.addStudent('B');
    t.repo.updateTarget(b, { ...wantOld, dateFrom: '2026-11-12', dateTo: '2026-12-30', timeFrom: '09:00', timeTo: '11:30' });
    t.service.startStudent(b);
    await t.clock.advance(0);
    const nb = lists(t.sessions.get(b)!);
    expect(t.service.released(a, { centreName: A_OLD.centreName, date: '2026-11-12', time: '09:00' })).toEqual([]);
    await t.clock.advance(0);
    expect(lists(t.sessions.get(b)!)).toBe(nb);
    await t.service.stopAll();
  });
});

describe('立即查一次', () => {
  test('正在刷新的学员：马上跑一轮，不等间隔', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    const n = s.calls.filter((c) => c.startsWith('listSlots')).length;
    expect(t.service.checkNow(id)).toBe(true);
    await t.clock.advance(0);
    expect(s.calls.filter((c) => c.startsWith('listSlots')).length).toBe(n + t.service.visits(id));
    await t.service.stopAll();
  });
  test('没在刷新的学员：返回 false', () => {
    const t = setup();
    expect(t.service.checkNow(t.addStudent())).toBe(false);
  });
});

describe('被拦后退避期间不访问网站', () => {
  test('被拦后 5 分钟内不登录、不开浏览器；到点后才重新访问', async () => {
    const repo = new Repo(openDb(':memory:'), randomBytes(32));
    const clock = new FakeClock(NOW);
    const limiter = new Limiter(clock, DEFAULT_SETTINGS.hidden);
    const opened: FakeSession[] = [];
    const service = new Service({
      repo, clock, limiter, settings: DEFAULT_SETTINGS, centres,
      openSession: async () => {
        const s = new FakeSession();
        // 第一个浏览器登录被拦，之后正常
        if (opened.length === 0) s.loginError = new SiteError('blocked', 'x');
        opened.push(s);
        return s;
      },
      notify: () => {},
      random: () => 0.5,
    });
    const id = repo.addStudent({ label: 'S', bookingId: '1234567890', surname: 'T', current: { centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' }, target: baseTarget });
    service.startStudent(id);
    await clock.advance(0);
    expect(opened).toHaveLength(1);
    expect(repo.recentLogs(5).some((l) => render('zh', l.msg).includes('退避 5 分钟'))).toBe(true);
    // 刷新间隔 2 分钟到了，但还在退避：不开浏览器，界面显示在等
    await clock.advance(3 * MIN);
    expect(opened).toHaveLength(1);
    expect(render('zh', service.progress(id)!.phase)).toContain('暂停访问');
    await clock.advance(2 * MIN);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.calls[0]).toBe('login');
    expect(repo.recentLogs(10).filter((l) => render('zh', l.msg).includes('退避')).length).toBe(1);
    await service.stopAll();
  });
});

describe('放弃确认页后不马上再访问', () => {
  test('放弃后下一轮按刷新间隔来，不立刻再查', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    s.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:00')]);
    await t.clock.advance(2 * MIN);
    expect(await t.service.endHold(id, 'abandon')).toBe('resumed');
    const n = s.calls.length;
    await t.clock.advance(0);
    expect(s.calls.length).toBe(n);
    expect(t.service.progress(id)!.nextAt).toBeGreaterThan(t.clock.now() + MIN);
    await t.clock.advance(3 * MIN);
    expect(s.calls.length).toBeGreaterThan(n);
    await t.service.stopAll();
  });
});

describe('退避期间放弃确认页', () => {
  test('不碰网站：直接关浏览器，学员继续排队（等退避结束）', async () => {
    const repo = new Repo(openDb(':memory:'), randomBytes(32));
    const clock = new FakeClock(NOW);
    const limiter = new Limiter(clock, { ...DEFAULT_SETTINGS.hidden, globalMinGapMs: 1 });
    const sessions: FakeSession[] = [];
    const service = new Service({
      repo, clock, limiter, settings: DEFAULT_SETTINGS, centres,
      openSession: async () => { const s = new FakeSession(); s.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:00')]); sessions.push(s); return s; },
      notify: () => {}, random: () => 0.5,
    });
    const id = repo.addStudent({ label: 'S', bookingId: '1234567890', surname: 'T', current: { centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' }, target: baseTarget });
    service.startStudent(id);
    await clock.advance(0);
    expect(service.holdInfo(id)).not.toBeNull();
    limiter.reportBlocked(); // 别的学员被拦
    const n = sessions[0]!.calls.length;
    expect(await service.endHold(id, 'abandon')).toBe('resumed');
    expect(sessions[0]!.calls.length).toBe(n);
    expect(sessions[0]!.closed).toBe(true);
    expect(repo.getStudent(id)!.status).toBe('running');
    await service.stopAll();
  });
});

describe('暂停时马上停下', () => {
  test('一轮正在进行时暂停：立刻关浏览器、不等这一轮跑完；不记错误，不算轮数', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    const rounds = t.repo.getStudent(id)!.rounds;
    // 下一轮查考点时卡住，直到浏览器被关掉（和真实浏览器一样：关掉后页面操作报错）
    let entered!: () => void;
    const inList = new Promise<void>((r) => (entered = r));
    s.listSlots = () => { entered(); return new Promise((_, rej) => { s.close = async () => { s.closed = true; rej(new Error('locator.click: Target page, context or browser has been closed\nCall log:\n  - waiting')); }; }); };
    void t.clock.advance(3 * MIN);
    await inList;
    t.service.pauseStudent(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.closed).toBe(true);
    await t.clock.advance(0);
    const st = t.repo.getStudent(id)!;
    expect(st.status).toBe('paused');
    expect(render('zh', st.statusNote)).toBe('教练手动暂停');
    expect(st.rounds).toBe(rounds);
    expect(t.repo.recentLogs(20).filter((l) => l.level !== 'info')).toEqual([]);
    expect(t.service.progress(id)).toBeNull();
    await t.service.stopAll();
  });

  test('教练手动关掉了学员的浏览器：记录说清楚原因（只要第一行），下一轮重新打开', async () => {
    const t = setup();
    const id = t.addStudent();
    t.service.startStudent(id);
    await t.clock.advance(0);
    const s = t.sessions.get(id)!;
    s.listSlots = async () => { throw new Error('locator.click: Target page, context or browser has been closed\nCall log:\n  \u001b[2m- waiting for locator\u001b[22m'); };
    await t.clock.advance(3 * MIN);
    const log = t.repo.recentLogs(5).find((l) => l.level === 'warn')!;
    expect(render('zh', log.msg)).toContain('浏览器窗口被关闭');
    expect(render('zh', log.msg)).not.toContain('Call log');
    expect(t.repo.getStudent(id)!.status).toBe('running');
    await t.clock.advance(3 * MIN);
    expect(t.sessions.get(id)).not.toBe(s);
    await t.service.stopAll();
  });
});
