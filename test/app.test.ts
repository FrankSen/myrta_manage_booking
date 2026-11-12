import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startApp, type App } from '../src/app/start.ts';
import { loadSettings } from '../src/app/settings-file.ts';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { UnavailableSession } from '../src/site/unavailable.ts';
import { FakeSession, SILVERWATER_NAME } from './helpers/fakes.ts';
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
    expect(app.settings.autoRebookEnabled).toBe(false);
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
    expect(((await res.json()) as { error: string }).error).toContain('还没有接入');
    expect(app.repo.listStudents()).toHaveLength(0);
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
      finishAvailable: false, warn: (m) => warnings.push(m),
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
