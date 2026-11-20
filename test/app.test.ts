import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startApp, type App } from '../src/app/start.ts';
import { loadSettings, saveCheckInterval, saveLanguage } from '../src/app/settings-file.ts';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { UnavailableSession } from '../src/site/unavailable.ts';
import { FakeSession, SILVERWATER_NAME } from './helpers/fakes.ts';
import { render } from '../src/i18n.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const centresFile = new URL('../data/nsw-test-centres.json', import.meta.url).pathname;
let app: App | null = null;
const made: string[] = [];
afterEach(async () => {
  await app?.stop();
  app = null;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'app-'));
  made.push(d);
  return d;
};

describe('装配', () => {
  test('启动后界面可访问，数据文件和密钥都建在运行时目录里', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    const res = await fetch(`http://127.0.0.1:${app.ui.port}/api/students`, { headers: { 'X-Token': app.ui.token } });
    expect(res.status).toBe(200);
    expect(existsSync(join(d, 'data.sqlite'))).toBe(true);
    expect(existsSync(join(d, 'secret.key'))).toBe(true);
    // 2026-11-19 起默认开启
    expect(app.settings.autoRebookEnabled).toBe(true);
  });

  test('同一个运行时目录不能同时启动两个', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    await expect(startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null })).rejects.toThrow('已经在运行');
  });

  test('停止后锁被释放，可以再次启动', async () => {
    const d = dir();
    const a = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    await a.stop();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    expect(app.ui.port).toBeGreaterThan(0);
  });

  test('启动失败时不残留锁', async () => {
    const d = dir();
    await expect(startApp({ runtimeDir: d, centresFile: '/不存在.json', openSession: async () => new FakeSession(), openWindow: () => null })).rejects.toThrow();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
  });

  test('重启后：上次在刷新的学员自动继续，暂停的不动', async () => {
    const d = dir();
    const first = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    const mk = (label: string) =>
      first.repo.addStudent({
        label, bookingId: '1234567890', surname: 'T',
        current: { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' },
        target: { centreIds: [241], dateFrom: '2026-12-01', dateTo: '2026-12-10', timeFrom: '09:00', timeTo: '12:00' },
      });
    const a = mk('A');
    const b = mk('B');
    first.repo.setStatus(a, 'running');
    first.repo.setStatus(b, 'paused');
    // 直接修改数据库后关闭（模拟程序退出），再重新打开
    await first.stop();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    expect(app.service.activeIds()).toEqual([a]);
  });

  test('添加学员：通过界面接口走完整链路，读取当前预约并加密保存', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    const res = await fetch(`http://127.0.0.1:${app.ui.port}/api/students`, {
      method: 'POST',
      headers: { 'X-Token': app.ui.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'A', bookingId: '1234567890', surname: 'Testsurname' }),
    });
    expect(res.status).toBe(201);
    expect(app.repo.listStudents()[0]!.current.centreName).toBe(SILVERWATER_NAME);
  });

  test('占位的站点模块：添加学员得到明确的错误提示，不会假装成功，也不会保存', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new UnavailableSession(), openWindow: () => null });
    const res = await fetch(`http://127.0.0.1:${app.ui.port}/api/students`, {
      method: 'POST',
      headers: { 'X-Token': app.ui.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'A', bookingId: '1234567890', surname: 'T' }),
    });
    expect(res.status).toBe(422);
    expect(render('zh', ((await res.json()) as { error: never }).error)).toContain('还没有接入');
    expect(app.repo.listStudents()).toHaveLength(0);
  });
});

describe('遗留浏览器清理', () => {
  test('启动前清理一次（在恢复刷新之前），有清理时写记录；退出时再清理一次', async () => {
    const d = dir();
    const calls: string[] = [];
    let opened = false;
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null,
      openSession: async () => { opened = true; return new FakeSession(); },
      cleanupBrowsers: async (root) => { calls.push(root); return opened ? 0 : 2; },
    });
    expect(calls).toEqual([join(d, 'browser-profile')]);
    expect(app.repo.recentLogs(5).some((l) => render('zh', l.msg).includes('2 个学员浏览器'))).toBe(true);
    await app.stop();
    app = null;
    expect(calls).toHaveLength(2);
  });
});

describe('不再查附近考点后的旧数据', () => {
  test('启动时把不是目标考点的待确认考位（以前附近考点查到的）标记为忽略', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    const id = app.repo.addStudent({ label: 'A', bookingId: '1234567890', surname: 'T', current: { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' }, target: { centreIds: [241], dateFrom: '2026-12-01', dateTo: '2026-12-20', timeFrom: '08:00', timeTo: '12:00' } });
    const near = app.repo.addOffer({ studentId: id, centreId: 112, date: '2026-12-02', time: '09:00', notes: [] }, Date.now())!;
    const own = app.repo.addOffer({ studentId: id, centreId: 241, date: '2026-12-02', time: '13:00', notes: [] }, Date.now())!;
    await app.stop();
    app = await startApp({ runtimeDir: d, centresFile, openSession: async () => new FakeSession(), openWindow: () => null });
    expect(app.repo.getOffer(near)!.state).toBe('dismissed');
    expect(app.repo.getOffer(own)!.state).toBe('open');
  });
});

describe('配置文件', () => {
  test('不存在：用默认值', () => {
    expect(loadSettings(join(dir(), 'nope.json'))).toBe(DEFAULT_SETTINGS);
  });
  test('覆盖隐藏配置', () => {
    const p = join(dir(), 's.json');
    writeFileSync(p, JSON.stringify({ hidden: { maxActiveStudents: 5 } }));
    expect(loadSettings(p).hidden.maxActiveStudents).toBe(5);
  });
  test('JSON 不合法：报错，不悄悄用默认值', () => {
    const p = join(dir(), 's.json');
    writeFileSync(p, '{oops');
    expect(() => loadSettings(p)).toThrow('不是有效的 JSON');
  });
  test('字段类型不对：报错', () => {
    const p = join(dir(), 's.json');
    writeFileSync(p, JSON.stringify({ autoRebookEnabled: 'yes' }));
    expect(() => loadSettings(p)).toThrow('autoRebookEnabled');
  });
});

describe('添加学员时的临时读取', () => {
  const settings = { ...DEFAULT_SETTINGS, hidden: { ...DEFAULT_SETTINGS.hidden, globalMinGapMs: 1 } };
  const post = (a: App, bookingId: string) =>
    fetch(`http://127.0.0.1:${a.ui.port}/api/students`, {
      method: 'POST',
      headers: { 'X-Token': a.ui.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'A', bookingId, surname: 'Testsurname' }),
    });

  test('读取中取消：关掉读取用的浏览器，返回"已取消"，不保存学员', async () => {
    const d = dir();
    let session: FakeSession | null = null;
    let started!: () => void;
    const loginStarted = new Promise<void>((r) => (started = r));
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null, settings,
      openSession: async () => {
        const s = new FakeSession();
        // 登录一直不结束，直到浏览器被关掉
        s.login = () => { started(); return new Promise((_, rej) => { s.close = async () => { s.closed = true; rej(new Error('Target closed')); }; }); };
        session = s;
        return s;
      },
    });
    const res = post(app, '1234567890');
    await loginStarted;
    await fetch(`http://127.0.0.1:${app.ui.port}/api/students/cancel-read`, { method: 'POST', headers: { 'X-Token': app.ui.token } });
    const r = await res;
    expect(r.status).toBe(422);
    expect(render('zh', (await r.json()).error)).toContain('已取消读取');
    expect(session!.closed).toBe(true);
    expect(app.repo.listStudents()).toHaveLength(0);
  });

  test('用 probe 目录，同时添加两个学员时排队，不会同时开两个浏览器；每次清空上一次的登录状态', async () => {
    const d = dir();
    let open = 0;
    let maxOpen = 0;
    const dirs: string[] = [];
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null, settings,
      openSession: async (id, profileDir) => {
        expect(id).toBeNull();
        expect(existsSync(join(profileDir, 'leftover'))).toBe(false);
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(join(profileDir, 'leftover'), 'x');
        dirs.push(profileDir);
        open++;
        maxOpen = Math.max(maxOpen, open);
        const s = new FakeSession();
        const close = s.close.bind(s);
        s.close = async () => {
          await new Promise((r) => setTimeout(r, 20));
          open--;
          await close();
        };
        return s;
      },
    });
    const [a, b] = await Promise.all([post(app, '1234567890'), post(app, '1234567891')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(maxOpen).toBe(1);
    expect(dirs).toEqual([join(d, 'browser-profile', 'probe'), join(d, 'browser-profile', 'probe')]);
  });

  test('读取成功后，资料目录改名给这个学员用；失败时不留下', async () => {
    const d = dir();
    let n = 0;
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null, settings,
      openSession: async (_id, profileDir) => {
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(join(profileDir, 'cookie'), 'x');
        const s = new FakeSession();
        if (n++ === 1) s.loginError = new Error('坏了');
        return s;
      },
    });
    const created = (await (await post(app, '1234567890')).json()) as { id: number };
    expect(existsSync(join(d, 'browser-profile', String(created.id), 'cookie'))).toBe(true);
    expect(existsSync(join(d, 'browser-profile', 'probe'))).toBe(false);
    expect((await post(app, '1234567891')).status).toBe(422);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(d, 'browser-profile')).filter((x) => x.startsWith('pending-'))).toEqual([]);
  });

  test('启动时清掉上次没认领的目录', async () => {
    const d = dir();
    mkdirSync(join(d, 'browser-profile', 'pending-3'), { recursive: true });
    app = await startApp({ runtimeDir: d, centresFile, openWindow: () => null, settings, openSession: async () => new FakeSession() });
    expect(existsSync(join(d, 'browser-profile', 'pending-3'))).toBe(false);
  });

  test('前一次读取失败，不影响下一次', async () => {
    const d = dir();
    let n = 0;
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null, settings,
      openSession: async () => {
        const s = new FakeSession();
        if (n++ === 0) s.loginError = new Error('坏了');
        return s;
      },
    });
    expect((await post(app, '1234567890')).status).toBe(422);
    expect((await post(app, '1234567890')).status).toBe(201);
  });
});

describe('提交功能未启用', () => {
  test('配置开启了自动改约也按关闭运行，并提示教练', async () => {
    const d = dir();
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ autoRebookEnabled: true }));
    const warnings: string[] = [];
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession(),
      finishAvailable: false, warn: (m) => warnings.push(render('zh', m)),
    });
    expect(app.settings.autoRebookEnabled).toBe(false);
    expect(warnings[0]).toContain('自动改约');
  });

  test('提交功能可用时，按配置开启', async () => {
    const d = dir();
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ autoRebookEnabled: true }));
    app = await startApp({ runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession() });
    expect(app.settings.autoRebookEnabled).toBe(true);
  });

  test('界面切换自动改约后写回 settings.json，重启后保持', async () => {
    const d = dir();
    const start = () => startApp({ runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession() });
    app = await start();
    expect(app.service.autoRebookEnabled()).toBe(true);
    const res = await fetch(`http://127.0.0.1:${app.ui.port}/api/settings/auto-rebook`, {
      method: 'PUT', headers: { 'X-Token': app.ui.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(loadSettings(join(d, 'settings.json')).autoRebookEnabled).toBe(false);
    await app.stop();
    app = await start();
    expect(app.service.autoRebookEnabled()).toBe(false);
  });

  test('提交功能不可用时，界面不能打开自动改约', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession(), finishAvailable: false, warn: () => {} });
    const res = await fetch(`http://127.0.0.1:${app.ui.port}/api/settings/auto-rebook`, {
      method: 'PUT', headers: { 'X-Token': app.ui.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(409);
  });
});

describe('退出时', () => {
  test('正在读取新学员的浏览器也会被关掉，不等页面超时', async () => {
    const d = dir();
    let closed = false;
    let entered!: () => void;
    const loginStarted = new Promise<void>((r) => (entered = r));
    const a = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null,
      openSession: async () => {
        const s = new FakeSession();
        s.login = () => {
          entered();
          return new Promise((_, reject) => {
            s.close = async () => {
              closed = true;
              reject(new Error('browser has been closed'));
            };
          });
        };
        return s;
      },
    });
    const req = fetch(`http://127.0.0.1:${a.ui.port}/api/students`, {
      method: 'POST',
      headers: { 'X-Token': a.ui.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'A', bookingId: '1234567890', surname: 'Testsurname' }),
    }).catch(() => null);
    await loginStarted;
    const t = Date.now();
    await a.stop();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(closed).toBe(true);
    await req;
  });
});

describe('保存刷新间隔', () => {
  test('写回 settings.json，保留文件里原有的其他配置；重启后生效', async () => {
    const p = join(dir(), 's.json');
    writeFileSync(p, JSON.stringify({ hidden: { maxActiveStudents: 3 }, tolerance: { maxTimeMinutes: 30 } }));
    saveCheckInterval(p, 5 * 60_000);
    const s = loadSettings(p);
    expect(s.hidden.checkIntervalMs).toBe(5 * 60_000);
    expect(s.hidden.maxActiveStudents).toBe(3);
    expect(s.tolerance.maxTimeMinutes).toBe(30);
  });
  test('文件不存在时新建', () => {
    const p = join(dir(), 'sub', 's.json');
    saveCheckInterval(p, 3 * 60_000);
    expect(loadSettings(p).hidden.checkIntervalMs).toBe(3 * 60_000);
  });
  test('界面改间隔后写进运行时目录的配置文件', async () => {
    const d = dir();
    app = await startApp({ runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession() });
    const res = await fetch(`http://127.0.0.1:${app.ui.port}/api/settings/interval`, {
      method: 'PUT', headers: { 'X-Token': app.ui.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ms: 10 * 60_000 }),
    });
    expect(res.status).toBe(200);
    expect(loadSettings(join(d, 'settings.json')).hidden.checkIntervalMs).toBe(10 * 60_000);
  });
});

describe('试用授权', () => {
  const settings = { ...DEFAULT_SETTINGS, hidden: { ...DEFAULT_SETTINGS.hidden, globalMinGapMs: 1 } };
  test('没有授权：可以查看，不能添加学员；导入后可以', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { payload } = await import('../src/license/license.ts');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = { name: '测试', until: '2099-12-31', issuedAt: '2026-11-16' };
    const text = JSON.stringify({ ...body, sig: sign(null, payload(body), privateKey).toString('base64') });
    const d = dir();
    let opened = 0;
    app = await startApp({
      runtimeDir: d, centresFile, openWindow: () => null, settings, requireLicense: true,
      licensePublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      openSession: async () => { opened++; return new FakeSession(); },
    });
    const call = (method: string, path: string, b?: unknown) =>
      fetch(`http://127.0.0.1:${app!.ui.port}${path}`, { method, headers: { 'X-Token': app!.ui.token, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    expect((await call('GET', '/api/students')).status).toBe(200);
    const st = (await (await call('GET', '/api/state')).json()) as { license: { ok: boolean; reason: string } };
    expect(st.license).toMatchObject({ ok: false, reason: 'missing' });
    const denied = await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'Testsurname' });
    expect(denied.status).toBe(403);
    expect(opened).toBe(0);
    expect((await call('POST', '/api/license', { text: '{"bad":1}' })).status).toBe(400);
    expect((await call('POST', '/api/license', { text })).status).toBe(200);
    expect(existsSync(join(d, 'license.json'))).toBe(true);
    expect((await call('POST', '/api/students', { label: 'A', bookingId: '1234567890', surname: 'Testsurname' })).status).toBe(201);
  });
});

describe('界面语言', () => {
  test('默认中文；切换后写回 settings.json，重启后保持', async () => {
    const d = dir();
    const start = () => startApp({ runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession() });
    app = await start();
    const call = (method: string, path: string, b?: unknown) =>
      fetch(`http://127.0.0.1:${app!.ui.port}${path}`, { method, headers: { 'X-Token': app!.ui.token, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    expect(((await (await call('GET', '/api/state')).json()) as { language: string }).language).toBe('zh');
    expect((await call('PUT', '/api/settings/language', { language: 'fr' })).status).toBe(400);
    expect((await call('PUT', '/api/settings/language', { language: 'en' })).status).toBe(200);
    expect(loadSettings(join(d, 'settings.json')).language).toBe('en');
    await app.stop();
    app = await start();
    expect(app.language()).toBe('en');
  });
  test('改语言不影响配置文件里的其他内容', () => {
    const p = join(dir(), 's.json');
    writeFileSync(p, JSON.stringify({ hidden: { maxActiveStudents: 3 } }));
    saveCheckInterval(p, 5 * 60_000);
    saveLanguage(p, 'en');
    const s = loadSettings(p);
    expect([s.hidden.maxActiveStudents, s.hidden.checkIntervalMs, s.language]).toEqual([3, 5 * 60_000, 'en']);
  });
});

describe('飞书通知设置', () => {
  const hook = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc123';
  test('界面设置 Webhook 后写回 settings.json，restart 后 state 里还在', async () => {
    const d = dir();
    const start = () => startApp({ runtimeDir: d, centresFile, openWindow: () => null, openSession: async () => new FakeSession() });
    app = await start();
    const call = (method: string, path: string, b?: unknown) =>
      fetch(`http://127.0.0.1:${app!.ui.port}${path}`, { method, headers: { 'X-Token': app!.ui.token, 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    expect(((await (await call('GET', '/api/state')).json()) as { feishuWebhook: string }).feishuWebhook).toBe('');
    expect((await call('PUT', '/api/settings/feishu', { webhook: 'https://evil.com/x' })).status).toBe(400);
    expect((await call('PUT', '/api/settings/feishu', { webhook: hook })).status).toBe(200);
    expect(loadSettings(join(d, 'settings.json')).notify.feishuWebhook).toBe(hook);
    await app.stop();
    app = await start();
    expect(((await (await call('GET', '/api/state')).json()) as { feishuWebhook: string }).feishuWebhook).toBe(hook);
  });
});
