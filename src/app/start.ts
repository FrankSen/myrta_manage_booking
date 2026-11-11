import { existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { indexCentres } from '../domain/geo.ts';
import type { BookingInfo, Centre } from '../domain/types.ts';
import { Service } from '../engine/service.ts';
import { Limiter } from '../scheduler/limiter.ts';
import { realClock, type Clock } from '../scheduler/clock.ts';
import type { Settings } from '../config/settings.ts';
import type { SiteSession } from '../site/session.ts';
import { loadOrCreateKey } from '../storage/crypto.ts';
import { openDb } from '../storage/db.ts';
import { Repo } from '../storage/repo.ts';
import { startUiServer, type UiServer } from '../ui/server.ts';
import { acquireLock } from './lock.ts';
import { runtimePaths } from './paths.ts';
import { loadSettings } from './settings-file.ts';

export interface AppOptions {
  runtimeDir: string;
  centresFile: string;
  /** 为某个学员打开站点会话；studentId 为 null 表示"添加学员时临时读取一次" */
  openSession(studentId: number | null, profileDir: string): Promise<SiteSession>;
  /** 打开界面窗口。默认用本机 Chrome/Edge 的 --app 模式；测试时传空函数 */
  openWindow?: (url: string, profileDir: string) => ChildProcess | null;
  settings?: Settings;
  clock?: Clock;
  port?: number;
}

export interface App {
  service: Service;
  repo: Repo;
  ui: UiServer;
  settings: Settings;
  stop(): Promise<void>;
}

/** 装配所有模块并启动。任何一步失败都要释放已占用的资源 */
export async function startApp(opts: AppOptions): Promise<App> {
  const paths = runtimePaths(opts.runtimeDir);
  const release = acquireLock(paths.lock);
  const closers: (() => Promise<void> | void)[] = [release];
  const undo = async () => {
    for (const c of closers.reverse()) await c();
  };

  try {
    const settings = opts.settings ?? loadSettings(paths.settings);
    const clock = opts.clock ?? realClock;
    const centreList = JSON.parse(readFileSync(opts.centresFile, 'utf8')) as Centre[];
    const centres = indexCentres(centreList);
    const db = openDb(paths.db);
    closers.push(() => db.close());
    const repo = new Repo(db, loadOrCreateKey(paths.key));
    const limiter = new Limiter(clock, settings.hidden);

    let ui: UiServer | null = null;
    const service = new Service({
      repo, clock, limiter, settings, centres,
      openSession: (id) => opts.openSession(id, `${paths.browserProfiles}/${id}`),
      notify: (e) => ui?.publish(e),
    });
    closers.push(() => service.stopAll());

    ui = await startUiServer(
      {
        repo, service, centreList,
        autoRebookEnabled: settings.autoRebookEnabled,
        now: () => clock.now(),
        fetchCurrent: async (bookingId, surname): Promise<BookingInfo> => {
          await limiter.acquire();
          const session = await opts.openSession(null, `${paths.browserProfiles}/probe`);
          try {
            return await session.login(bookingId, surname);
          } finally {
            await session.close();
          }
        },
      },
      { port: opts.port },
    );
    const server = ui;
    closers.push(() => server.close());

    service.resumeAll();

    const child = (opts.openWindow ?? defaultOpenWindow)(server.url, paths.uiProfile);
    if (child) closers.push(() => void child.kill());

    return {
      service, repo, ui: server, settings,
      stop: async () => {
        await undo();
      },
    };
  } catch (err) {
    await undo();
    throw err;
  }
}

/** 用 Chrome 的 --app 模式打开界面：没有地址栏，看起来像独立窗口 */
function defaultOpenWindow(url: string, profileDir: string): ChildProcess | null {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const exe of candidates) {
    if (!existsSync(exe)) continue;
    return spawn(exe, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--lang=zh-CN', '--no-first-run'], { stdio: 'ignore' });
  }
  console.log(`没有找到 Chrome 或 Edge，请手动用浏览器打开：${url}`);
  return null;
}
