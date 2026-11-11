import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { startApp, type App } from '../src/app/start.ts';
import { loadSettings } from '../src/app/settings-file.ts';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { UnavailableSession } from '../src/site/unavailable.ts';
import { FakeSession, SILVERWATER_NAME } from './helpers/fakes.ts';
import { writeFileSync } from 'node:fs';

const centresFile = new URL('../data/nsw-test-centres.json', import.meta.url).pathname;
let app: App | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});
const dir = () => mkdtempSync(join(tmpdir(), 'app-'));

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
