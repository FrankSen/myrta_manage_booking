import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.ts';
import type { NotifyEvent } from '../src/engine/checker.ts';
import { Service } from '../src/engine/service.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import { openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';
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
    limiter.reportBlocked(); // 10 分钟
    limiter.reportBlocked(); // 20 分钟
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
    await clock.advance(0); // 登录完成，正在等 20 分钟的退避
    expect(sessions[0]!.calls).toEqual(['login']);
    await service.stopAll(); // 没有 clock.advance，不能卡住
    expect(sessions[0]!.closed).toBe(true);
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
    // Silverwater 10 公里内有别的考点，一轮访问 2 次
    expect(t.service.visits(id)).toBe(2);
    expect(t.service.expectedCycle(id)).toBe(2 * MIN + 15_000 + 2 * 35_000);
  });

  test('5 个学员各 2 个考点：排队时间超过设定间隔', async () => {
    const t = setup();
    const ids = ['A', 'B', 'C', 'D', 'E'].map((l) => t.addStudent(l));
    for (const id of ids) t.repo.updateTarget(id, { ...baseTarget, centreIds: [SILVERWATER, 112] });
    for (const id of ids) t.service.startStudent(id);
    // 每人 3 次（2 个目标 + 1 个附近），共 15 次 × 20 秒 = 5 分钟
    expect(t.service.expectedCycle(ids[0]!)).toBe(5 * MIN);
    await t.service.stopAll();
  });

  test('没在刷新的学员按"加上它之后"估算', () => {
    const t = setup({ hidden: { ...DEFAULT_SETTINGS.hidden, checkIntervalMs: MIN } });
    const a = t.addStudent('A');
    const b = t.addStudent('B');
    t.service.startStudent(a);
    expect(t.service.expectedCycle(b)).toBe(Math.max(MIN + 15_000 + 70_000, 4 * 20_000));
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
