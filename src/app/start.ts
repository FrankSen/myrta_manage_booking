import { existsSync, readFileSync, rmSync } from 'node:fs';
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
  /**
   * 站点会话能否真正点 Finish。为 false 时即使配置开启了自动改约也强制关闭，
   * 否则提交会报错并被当成"可能已提交"，误导教练。默认 true（测试用假会话）
   */
  finishAvailable?: boolean;
  /** 启动时给教练的提示，默认打印到控制台 */
  warn?: (message: string) => void;
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
    let settings = opts.settings ?? loadSettings(paths.settings);
    if (opts.finishAvailable === false && settings.autoRebookEnabled) {
      settings = { ...settings, autoRebookEnabled: false };
      (opts.warn ?? console.warn)('配置里开启了自动改约，但当前版本还不能提交改约，已按"关闭"运行（只走到确认页）');
    }
    const clock = opts.clock ?? realClock;
    const centreList = JSON.parse(readFileSync(opts.centresFile, 'utf8')) as Centre[];
    const centres = indexCentres(centreList);
    const db = openDb(paths.db);
    closers.push(() => db.close());
    const repo = new Repo(db, loadOrCreateKey(paths.key));
    const limiter = new Limiter(clock, settings.hidden);

    const probeDir = `${paths.browserProfiles}/probe`;
    let probeQueue: Promise<unknown> = Promise.resolve();
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
        // 临时读取共用一个 probe 目录，同一目录不能同时开两个浏览器，所以排队执行
        fetchCurrent: (bookingId, surname): Promise<BookingInfo> => {
          const run = probeQueue.then(async () => {
            await limiter.acquire();
            // 每次清空，避免上一个学员的登录状态带到这一个
            rmSync(probeDir, { recursive: true, force: true });
            const session = await opts.openSession(null, probeDir);
            try {
              return await session.login(bookingId, surname);
            } finally {
              await session.close();
            }
          });
          probeQueue = run.catch(() => {});
          return run;
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
