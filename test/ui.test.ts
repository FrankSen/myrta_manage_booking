import { render } from '../src/i18n.ts';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { Service } from '../src/engine/service.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import { openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';
import { startUiServer, type UiServer } from '../src/ui/server.ts';
import { FakeSession, NOW, SILVERWATER, SILVERWATER_NAME, centreList, centres } from './helpers/fakes.ts';

let server: UiServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function setup(opts: { fetchCurrent?: () => Promise<{ centreName: string; date: string; time: string }>; openSite?: () => void } = {}) {
  const repo = new Repo(openDb(':memory:'), randomBytes(32));
  const clock = new FakeClock(NOW);
  const limiter = { acquire: async () => {}, reportBlocked: () => 1, reportOk: () => {} };
  const service = new Service({
    repo, clock, limiter, settings: DEFAULT_SETTINGS, centres,
    openSession: async () => new FakeSession(),
    notify: (e) => server?.publish(e),
  });
  server = await startUiServer({
    repo, service, centreList,
    fetchCurrent: opts.fetchCurrent ?? (async () => ({ centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' })),
    autoRebookEnabled: false,
    now: () => clock.now(),
    openSite: opts.openSite ?? (() => {}),
  });
  const call = (method: string, path: string, body?: unknown, token: string | null = server!.token) =>
    fetch(`http://127.0.0.1:${server!.port}${path}`, {
      method,
      headers: { ...(token ? { 'X-Token': token } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { repo, service, call, clock };
}

const goodTarget = { centreIds: [SILVERWATER], dateFrom: '2026-11-16', dateTo: '2026-11-20', timeFrom: '09:00', timeTo: '12:00' };

describe('令牌', () => {
  test('没带令牌 401；令牌不对 401；带对了 200', async () => {
    const { call } = await setup();
    expect((await call('GET', '/api/students', undefined, null)).status).toBe(401);
    expect((await call('GET', '/api/students', undefined, 'wrong')).status).toBe(401);
    expect((await call('GET', '/api/students')).status).toBe(200);
  });
  test('页面本身不含任何学员数据，可以直接打开', async () => {
    await setup();
    const res = await fetch(`http://127.0.0.1:${server!.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title');
  });
  test('只监听本机地址', async () => {
    await setup();
    expect(server!.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
  test('静态文件路径不能跳出目录', async () => {
    await setup();
    const res = await fetch(`http://127.0.0.1:${server!.port}/..%2Fserver.ts`);
    expect(res.status).toBe(404);
  });
});

describe('学员', () => {
  test('新增后返回的是脱敏数据：只有 Booking number 末 3 位，没有姓氏', async () => {
    const { call } = await setup();
    const res = await call('POST', '/api/students', { label: '学员A', bookingId: '1234567890', surname: 'Testsurname' });
    expect(res.status).toBe(201);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('890');
    expect(text).not.toContain('1234567890');
    expect(text).not.toContain('Testsurname');
    const list = JSON.stringify(await (await call('GET', '/api/students')).json());
    expect(list).not.toContain('1234567890');
    expect(list).not.toContain('Testsurname');
  });

  test('新增时会读取当前预约，并默认把目标考点设为当前考点', async () => {
    const { call } = await setup();
    const s = (await (await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'T' })).json()) as {
      current: { date: string }; target: { centreIds: number[] };
    };
    expect(s.current.date).toBe('2026-12-30');
    expect(s.target.centreIds).toEqual([SILVERWATER]);
  });

  test('读取预约失败（资料不对）：422，不保存', async () => {
    const { call, repo } = await setup({ fetchCurrent: async () => { throw new Error('Booking number 或姓氏不正确'); } });
    const res = await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'T' });
    expect(res.status).toBe(422);
    expect(render('zh', ((await res.json()) as { error: never }).error)).toContain('不正确');
    expect(repo.listStudents()).toHaveLength(0);
  });

  test('输入不合法：400', async () => {
    const { call } = await setup();
    expect((await call('POST', '/api/students', { label: '', bookingId: '1234567890', surname: 'T' })).status).toBe(400);
    expect((await call('POST', '/api/students', { label: 'A', bookingId: 'abc', surname: 'T' })).status).toBe(400);
    expect((await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: '' })).status).toBe(400);
  });

  test('删除学员', async () => {
    const { call, repo } = await setup();
    const id = ((await (await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'T' })).json()) as { id: number }).id;
    expect((await call('DELETE', `/api/students/${id}`)).status).toBe(200);
    expect(repo.listStudents()).toHaveLength(0);
    expect((await call('DELETE', `/api/students/${id}`)).status).toBe(404);
  });
});

describe('目标校验', () => {
  const create = async (call: Awaited<ReturnType<typeof setup>>['call']) =>
    ((await (await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'T' })).json()) as { id: number }).id;

  test('合法目标：200 并保存', async () => {
    const { call, repo } = await setup();
    const id = await create(call);
    expect((await call('PUT', `/api/students/${id}/target`, goodTarget)).status).toBe(200);
    expect(repo.getStudent(id)!.target).toEqual(goodTarget);
  });

  test.each([
    ['结束日期早于开始日期', { ...goodTarget, dateFrom: '2026-11-20', dateTo: '2026-11-16' }],
    ['开始时间晚于结束时间', { ...goodTarget, timeFrom: '12:15', timeTo: '12:00' }],
    ['时间不在 15 分钟档上', { ...goodTarget, timeFrom: '09:07' }],
    ['指定时间不在 15 分钟档上', { ...goodTarget, times: ['09:00', '09:10'] }],
    ['指定时间格式不对', { ...goodTarget, times: ['9am'] }],
    ['指定时间不是数组', { ...goodTarget, times: '09:00' }],
    ['日期格式不对', { ...goodTarget, dateFrom: '16/11/2026' }],
    ['日期不存在', { ...goodTarget, dateFrom: '2026-02-30' }],
    ['时间格式不对', { ...goodTarget, timeFrom: '9am' }],
    ['没有选考点', { ...goodTarget, centreIds: [] }],
    ['考点不存在', { ...goodTarget, centreIds: [99999] }],
    ['超过 2 个考点', { ...goodTarget, centreIds: [SILVERWATER, 112, 20] }],
  ])('不合法：%s → 400，且不保存', async (_name, bad) => {
    const { call, repo } = await setup();
    const id = await create(call);
    const before = repo.getStudent(id)!.target;
    expect((await call('PUT', `/api/students/${id}/target`, bad)).status).toBe(400);
    expect(repo.getStudent(id)!.target).toEqual(before);
  });

  test('最早时间等于最晚时间：只要这一个时间，合法', async () => {
    const { call, repo } = await setup();
    const id = await create(call);
    const t = { ...goodTarget, timeFrom: '08:00', timeTo: '08:00' };
    expect((await call('PUT', `/api/students/${id}/target`, t)).status).toBe(200);
    expect(repo.getStudent(id)!.target).toEqual(t);
  });

  test('指定时间：去重、排序后保存', async () => {
    const { call, repo } = await setup();
    const id = await create(call);
    expect((await call('PUT', `/api/students/${id}/target`, { ...goodTarget, times: ['13:30', '08:00', '13:30'] })).status).toBe(200);
    expect(repo.getStudent(id)!.target.times).toEqual(['08:00', '13:30']);
  });

  test('指定时间为空数组：按时间范围，不保存 times', async () => {
    const { call, repo } = await setup();
    const id = await create(call);
    expect((await call('PUT', `/api/students/${id}/target`, { ...goodTarget, times: [] })).status).toBe(200);
    expect(repo.getStudent(id)!.target).toEqual(goodTarget);
  });

  test('学员不存在：404', async () => {
    const { call } = await setup();
    expect((await call('PUT', '/api/students/999/target', goodTarget)).status).toBe(404);
  });
});

describe('开始与暂停', () => {
  test('start 后状态为 running，pause 后为 paused', async () => {
    const { call, service } = await setup();
    const id = ((await (await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'T' })).json()) as { id: number }).id;
    const started = (await (await call('POST', `/api/students/${id}/start`)).json()) as { status: string };
    expect(started.status).toBe('running');
    const paused = (await (await call('POST', `/api/students/${id}/pause`)).json()) as { status: string };
    expect(paused.status).toBe('paused');
    await service.stopAll();
  });

  test('超过上限：409，界面看不到上限数字', async () => {
    const { call, service } = await setup();
    const ids: number[] = [];
    for (const l of ['A', 'B', 'C', 'D', 'E', 'F']) {
      ids.push(((await (await call('POST', '/api/students', { label: l, bookingId: '1234567890', surname: 'T' })).json()) as { id: number }).id);
    }
    for (const id of ids.slice(0, 5)) expect((await call('POST', `/api/students/${id}/start`)).status).toBe(200);
    const res = await call('POST', `/api/students/${ids[5]}/start`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(/\b5\b/);
    const state = JSON.stringify(await (await call('GET', '/api/state')).json());
    expect(state).not.toContain('maxActiveStudents');
    expect(state).not.toContain('checkInterval');
    await service.stopAll();
  });
});

describe('待确认考位', () => {
  async function withOffer() {
    const t = await setup();
    const sid = t.repo.addStudent({
      label: 'A', bookingId: '1234567890', surname: 'T',
      current: { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' }, target: goodTarget,
    });
    const offerId = t.repo.addOffer({ studentId: sid, centreId: SILVERWATER, date: '2026-11-17', time: '13:00', notes: ['时间超出目标时间段 60 分钟'] }, 1)!;
    return { ...t, sid, offerId };
  }

  test('列表只含待处理的', async () => {
    const { call, offerId, service } = await withOffer();
    expect(((await (await call('GET', '/api/offers')).json()) as unknown[]).length).toBe(1);
    await call('POST', `/api/offers/${offerId}/dismiss`);
    expect(((await (await call('GET', '/api/offers')).json()) as unknown[]).length).toBe(0);
    await service.stopAll();
  });

  test('不存在的待确认考位：404', async () => {
    const { call } = await withOffer();
    expect((await call('POST', '/api/offers/9999/accept')).status).toBe(404);
    expect((await call('POST', '/api/offers/9999/dismiss')).status).toBe(404);
  });

  test('accept 返回处理结果（自动改约关闭时是 dry_run）', async () => {
    const t = await withOffer();
    const session = new FakeSession();
    session.slotsByCentre.set(SILVERWATER, [{ centreId: SILVERWATER, date: '2026-11-17', time: '13:00' }]);
    (t.service as unknown as { deps: { openSession: () => Promise<FakeSession> } }).deps.openSession = async () => session;
    const res = await t.call('POST', `/api/offers/${t.offerId}/accept`);
    expect(await res.json()).toEqual({ result: 'dry_run' });
    expect(session.calls).not.toContain('finish');
    // 停在确认页：学员数据里带保留信息，可以再显示窗口、放弃
    const st = (await (await t.call('GET', '/api/students')).json()).students[0];
    expect(st.hold).toMatchObject({ slot: { date: '2026-11-17', time: '13:00' } });
    expect(await (await t.call('POST', `/api/students/${st.id}/hold/reveal`)).json()).toEqual({ result: 'ok' });
    expect(await (await t.call('POST', `/api/students/${st.id}/hold/abandon`)).json()).toEqual({ result: 'resumed' });
    expect(await (await t.call('POST', `/api/students/${st.id}/hold/submitted`)).json()).toEqual({ result: 'not_held' });
    expect((await t.call('POST', '/api/students/9999/hold/abandon')).status).toBe(404);
    await t.service.stopAll();
  });
});

describe('立即查一次', () => {
  test('在刷新：200；没在刷新：409；没有这个学员：404', async () => {
    const t = await setup();
    const id = t.repo.addStudent({ label: 'A', bookingId: '1234567890', surname: 'T', current: { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' }, target: goodTarget });
    expect((await t.call('POST', `/api/students/${id}/check-now`)).status).toBe(409);
    await t.call('POST', `/api/students/${id}/start`);
    expect((await t.call('POST', `/api/students/${id}/check-now`)).status).toBe(200);
    expect((await t.call('POST', '/api/students/999/check-now')).status).toBe(404);
    await t.service.stopAll();
  });
});

describe('事件推送', () => {
  test('publish 的事件能通过 SSE 收到', async () => {
    const t = await setup();
    const sid = t.repo.addStudent({
      label: '学员A', bookingId: '1234567890', surname: 'T',
      current: { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' }, target: goodTarget,
    });
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server!.port}/api/events?t=${server!.token}`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    server!.publish({ type: 'stopped', studentId: sid, reason: '测试' });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: message');
    expect(text).toContain('学员A');
    expect(text).toContain('测试');
    ac.abort();
  });

  test('事件接口也需要令牌', async () => {
    await setup();
    expect((await fetch(`http://127.0.0.1:${server!.port}/api/events`)).status).toBe(401);
  });
});

describe('打开网站', () => {
  test('需要令牌；带令牌时用系统浏览器打开', async () => {
    let opened = 0;
    const { call } = await setup({ openSite: () => opened++ });
    expect((await call('POST', '/api/open-site', undefined, null)).status).toBe(401);
    expect(opened).toBe(0);
    expect((await call('POST', '/api/open-site')).status).toBe(200);
    expect(opened).toBe(1);
  });
});

describe('界面静态文件', () => {
  test('图标 svg 可访问', async () => {
    await setup();
    const res = await fetch(`http://127.0.0.1:${server!.port}/logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('svg');
  });
});

describe('刷新间隔', () => {
  const create = async (call: Awaited<ReturnType<typeof setup>>['call']) =>
    ((await (await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'T' })).json()) as { id: number }).id;

  test('state 里有当前间隔、可选项和说明', async () => {
    const { call } = await setup();
    const st = (await (await call('GET', '/api/state')).json()) as { intervalMs: number; intervalChoicesMin: number[]; intervalHelp: string[] };
    expect(st.intervalMs).toBe(2 * 60_000);
    expect(st.intervalChoicesMin[0]).toBe(1);
    expect(render('zh', st.intervalHelp as never)).toContain('为什么不是越快越好');
  });

  test.each([[30_000], [90_000], [-1], ['2'], [null]])('全局间隔不合法：%s → 400', async (ms) => {
    const { call, service } = await setup();
    expect((await call('PUT', '/api/settings/interval', { ms })).status).toBe(400);
    expect(service.globalInterval()).toBe(2 * 60_000);
  });

  test('全局间隔：改成 5 分钟', async () => {
    const { call, service } = await setup();
    expect((await call('PUT', '/api/settings/interval', { ms: 5 * 60_000 })).status).toBe(200);
    expect(service.globalInterval()).toBe(5 * 60_000);
  });

  test('学员单独间隔：设置、取消；学员列表里能看到生效的间隔', async () => {
    const { call } = await setup();
    const id = await create(call);
    const r = (await (await call('PUT', `/api/students/${id}/interval`, { ms: 10 * 60_000 })).json()) as { intervalMs: number; effectiveIntervalMs: number };
    expect(r).toMatchObject({ intervalMs: 10 * 60_000, effectiveIntervalMs: 10 * 60_000 });
    const back = (await (await call('PUT', `/api/students/${id}/interval`, { ms: null })).json()) as { intervalMs: number | null; effectiveIntervalMs: number };
    expect(back).toMatchObject({ intervalMs: null, effectiveIntervalMs: 2 * 60_000 });
    expect((await call('PUT', `/api/students/${id}/interval`, { ms: 1000 })).status).toBe(400);
    expect((await call('PUT', '/api/students/999/interval', { ms: 60_000 })).status).toBe(404);
  });

  test('学员列表带服务器时间、轮数、进度', async () => {
    const { call, clock } = await setup();
    const id = await create(call);
    await call('PUT', `/api/students/${id}/target`, goodTarget);
    await call('POST', `/api/students/${id}/start`);
    await clock.advance(0);
    const body = (await (await call('GET', '/api/students')).json()) as { now: number; students: { rounds: number; progress: { nextAt: number } }[] };
    expect(body.now).toBe(NOW);
    expect(body.students[0]!.rounds).toBe(1);
    // 间隔有 ±20% 随机浮动
    const wait = body.students[0]!.progress.nextAt - NOW;
    expect(wait).toBeGreaterThanOrEqual(0.8 * 2 * 60_000);
    expect(wait).toBeLessThanOrEqual(1.2 * 2 * 60_000);
  });
});
