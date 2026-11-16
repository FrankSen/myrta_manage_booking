import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
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
import { QUIET_ARGS, realFindBrowser } from '../site/browser.ts';
import { acquireLock } from './lock.ts';
import { LicenseGate } from '../license/gate.ts';
import { runtimePaths } from './paths.ts';
import { loadSettings, saveCheckInterval } from './settings-file.ts';

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
  /** 是否检查试用授权。正式入口（Electron、npm start）为 true；测试默认不检查 */
  requireLicense?: boolean;
  /** 测试用：替换验证公钥 */
  licensePublicKey?: string;
}

export interface App {
  service: Service;
  repo: Repo;
  ui: UiServer;
  settings: Settings;
  license: LicenseGate | null;
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
    const license = opts.requireLicense ? new LicenseGate({ path: paths.license, repo, now: () => clock.now(), publicKey: opts.licensePublicKey }) : null;

    const probeDir = `${paths.browserProfiles}/probe`;
    // 读取成功后，probe 目录改名留给这个学员用，不用再新建一个浏览器资料目录（新建时浏览器会写一大批文件，
    // 有的电脑安全软件会把这些当成"下载"一直弹窗）。键是 Booking number，只在内存里
    const pendingProfiles = new Map<string, string>();
    let pendingSeq = 0;
    // 上次没来得及认领的目录（程序在添加学员中途退出）
    for (const name of existsSync(paths.browserProfiles) ? readdirSync(paths.browserProfiles) : []) {
      if (name.startsWith('pending-')) rmSync(`${paths.browserProfiles}/${name}`, { recursive: true, force: true });
    }
    let probeQueue: Promise<unknown> = Promise.resolve();
    let probeSession: SiteSession | null = null;
    const probeAbort = new AbortController();
    // 退出时关掉正在读取的浏览器，否则它会一直等到页面超时
    closers.push(async () => {
      probeAbort.abort();
      await probeSession?.close().catch(() => {});
    });
    let ui: UiServer | null = null;
    const service = new Service({
      repo, clock, limiter, settings, centres,
      openSession: (id) => opts.openSession(id, `${paths.browserProfiles}/${id}`),
      notify: (e) => ui?.publish(e),
      saveGlobalInterval: (ms) => saveCheckInterval(paths.settings, ms),
      allowed: license ? () => license.ok() : undefined,
    });
    closers.push(() => service.stopAll());

    ui = await startUiServer(
      {
        repo, service, centreList,
        license: license ?? undefined,
        autoRebookEnabled: settings.autoRebookEnabled,
        maxDateDays: settings.tolerance.maxDateDays,
        now: () => clock.now(),
        // 临时读取共用一个 probe 目录，同一目录不能同时开两个浏览器，所以排队执行
        fetchCurrent: (bookingId, surname): Promise<BookingInfo> => {
          const run = probeQueue.then(async () => {
            await limiter.acquire(probeAbort.signal);
            // 每次清空，避免上一个学员的登录状态带到这一个
            rmSync(probeDir, { recursive: true, force: true });
            if (probeAbort.signal.aborted) throw new Error('程序正在退出');
            const session = await opts.openSession(null, probeDir);
            probeSession = session;
            let info: BookingInfo;
            try {
              info = await session.login(bookingId, surname);
            } finally {
              probeSession = null;
              await session.close();
            }
            const pending = `${paths.browserProfiles}/pending-${++pendingSeq}`;
            try {
              renameSync(probeDir, pending);
              const old = pendingProfiles.get(bookingId);
              if (old) rmSync(old, { recursive: true, force: true });
              pendingProfiles.set(bookingId, pending);
            } catch {
              // 改名失败（例如文件被占用）不影响添加，下次读取前会清空
            }
            return info;
          });
          probeQueue = run.catch(() => {});
          return run;
        },
        adoptProfile: (studentId, bookingId) => {
          const pending = pendingProfiles.get(bookingId);
          if (!pending) return;
          pendingProfiles.delete(bookingId);
          const dest = `${paths.browserProfiles}/${studentId}`;
          try {
            if (existsSync(dest)) rmSync(pending, { recursive: true, force: true });
            else renameSync(pending, dest);
          } catch {
            rmSync(pending, { recursive: true, force: true });
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
      service, repo, ui: server, settings, license,
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
  let exe: string;
  try {
    exe = realFindBrowser();
  } catch {
    console.log(`没有找到 Chrome 或 Edge，请手动用浏览器打开：${url}`);
    return null;
  }
  return spawn(exe, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--lang=zh-CN', '--no-first-run', '--no-default-browser-check', ...QUIET_ARGS], { stdio: 'ignore' });
}
