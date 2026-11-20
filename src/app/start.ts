import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
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
import { LicenseGate } from '../license/gate.ts';
import { TextError, errorText, msg, render, type Lang, type Text } from '../i18n.ts';
import { runtimePaths } from './paths.ts';
import { loadSettings, saveAutoRebook, saveCheckInterval, saveLanguage, saveFeishuWebhook } from './settings-file.ts';
import { createFeishuPusher } from '../notify/feishu.ts';

export interface AppOptions {
  /** 启动时和退出时结束遗留的学员浏览器（上次软件被强行结束时留下的）。正式运行时打开，测试不用 */
  cleanupBrowsers?: (profileRoot: string) => Promise<number>;
  runtimeDir: string;
  centresFile: string;
  /** 为某个学员打开站点会话；studentId 为 null 表示"添加学员时临时读取一次" */
  openSession(studentId: number | null, profileDir: string): Promise<SiteSession>;
  /** 打开界面窗口（返回的子进程退出时一起结束）。默认不打开：Electron 自己开窗口，npm start 打印地址 */
  openWindow?: (url: string) => ChildProcess | null;
  settings?: Settings;
  /**
   * 站点会话能否真正点 Finish。为 false 时即使配置开启了自动改约也强制关闭，
   * 否则提交会报错并被当成"可能已提交"，误导教练。默认 true（测试用假会话）
   */
  finishAvailable?: boolean;
  /** 启动时给教练的提示，默认打印到控制台 */
  warn?: (message: Text) => void;
  clock?: Clock;
  port?: number;
  /** 是否检查试用授权。正式入口（Electron、npm start）为 true；测试默认不检查 */
  requireLicense?: boolean;
  /** 教练切换界面语言后调用（Electron 用来翻译菜单和对话框） */
  onLanguage?: (lang: Lang) => void;
  /** 测试用：替换验证公钥 */
  licensePublicKey?: string;
}

export interface App {
  service: Service;
  repo: Repo;
  ui: UiServer;
  settings: Settings;
  license: LicenseGate | null;
  /** 当前界面语言 */
  language(): Lang;
  stop(): Promise<void>;
}

/** 装配所有模块并启动。任何一步失败都要释放已占用的资源 */
/** 添加学员时最多愿意排队等多久，超过就直接告诉教练稍后再试 */
const PROBE_MAX_WAIT_MS = 2 * 60_000;

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
      const text = msg('start.auto_rebook_forced');
      (opts.warn ?? ((m: Text) => console.warn(render(settings.language, m))))(text);
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
    // 上次被强行结束时留下的学员浏览器：占着资料目录，新开的浏览器会把请求转给它，升级时文件也删不掉
    if (opts.cleanupBrowsers) {
      const n = await opts.cleanupBrowsers(paths.browserProfiles);
      if (n > 0) repo.log(null, 'info', msg('log.orphans_killed', { n }), clock.now());
      // 退出时再查一遍：正常关闭的浏览器已经没了，这里收拾关闭超时、没关掉的
      const cleanup = opts.cleanupBrowsers;
      closers.push(async () => {
        await cleanup(paths.browserProfiles).catch(() => 0);
      });
    }
    let probeQueue: Promise<unknown> = Promise.resolve();
    let probeSession: SiteSession | null = null;
    /** 教练在添加对话框里点了取消：中断正在进行的读取 */
    let probeCancel: AbortController | null = null;
    const probeAbort = new AbortController();
    // 退出时关掉正在读取的浏览器，否则它会一直等到页面超时
    closers.push(async () => {
      probeAbort.abort();
      await probeSession?.close().catch(() => {});
    });
    let ui: UiServer | null = null;
    let language: Lang = settings.language;
    // 飞书推送：配了 Webhook 才推。地址可在界面改，改后写回 settings.json 并用新值
    let feishuWebhook = settings.notify.feishuWebhook;
    const feishu = createFeishuPusher({
      webhook: () => feishuWebhook,
      lang: () => language,
      onError: (err) => repo.log(null, 'warn', msg('log.feishu_failed', { detail: errorText(err) }), clock.now()),
    });
    const service = new Service({
      repo, clock, limiter, settings, centres,
      openSession: async (id) => {
        const s = await opts.openSession(id, `${paths.browserProfiles}/${id}`);
        // 页面内请求也要排全局限速，不然 5 个学员会同时打向网站
        s.setThrottle?.(() => limiter.acquire());
        return s;
      },
      notify: (e) => ui?.publish(e),
      saveGlobalInterval: (ms) => saveCheckInterval(paths.settings, ms),
      allowed: license ? () => license.ok() : undefined,
    });
    closers.push(() => service.stopAll());

    ui = await startUiServer(
      {
        repo, service, centreList,
        license: license ?? undefined,
        language: {
          get: () => language,
          set: (lang) => {
            language = lang;
            saveLanguage(paths.settings, lang);
            opts.onLanguage?.(lang);
          },
        },
        autoRebookEnabled: settings.autoRebookEnabled,
        finishAvailable: opts.finishAvailable !== false,
        saveAutoRebook: (enabled) => saveAutoRebook(paths.settings, enabled),
        maxDateDays: settings.tolerance.maxDateDays,
        now: () => clock.now(),
        pushMessage: (m) => feishu.push(m),
        feishu: {
          get: () => feishuWebhook,
          set: (url) => {
            feishuWebhook = url;
            saveFeishuWebhook(paths.settings, url);
          },
        },
        // 临时读取共用一个 probe 目录，同一目录不能同时开两个浏览器，所以排队执行
        cancelFetch: () => {
          probeCancel?.abort();
          void probeSession?.close().catch(() => {});
        },
        fetchCurrent: (bookingId, surname): Promise<BookingInfo> => {
          // 别的学员正占着访问间隔、排队要等太久：不要让教练干等，直接说明
          const left = limiter.waitLeft();
          if (left > PROBE_MAX_WAIT_MS) return Promise.reject(new TextError(msg('err.probe_busy', { min: Math.ceil(left / 60_000) })));
          const cancel = new AbortController();
          probeCancel = cancel;
          const run = probeQueue.then(async () => {
            const signal = AbortSignal.any([probeAbort.signal, cancel.signal]);
            try {
              await limiter.acquire(signal);
            } catch {
              throw new TextError(msg(cancel.signal.aborted ? 'err.read_cancelled' : 'err.exiting'));
            }
            // 每次清空，避免上一个学员的登录状态带到这一个
            rmSync(probeDir, { recursive: true, force: true });
            if (probeAbort.signal.aborted) throw new TextError(msg('err.exiting'));
            const session = await opts.openSession(null, probeDir);
            probeSession = session;
            let info: BookingInfo;
            try {
              if (cancel.signal.aborted) throw new TextError(msg('err.read_cancelled'));
              info = await session.login(bookingId, surname);
            } catch (err) {
              if (cancel.signal.aborted) throw new TextError(msg('err.read_cancelled'));
              throw err;
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

    // 以前查附近考点时留下的待确认考位：已经不查附近考点了，不再提示
    for (const o of repo.listOffers()) {
      if (o.state !== 'open') continue;
      const s = repo.getStudent(o.studentId);
      if (s && !s.target.centreIds.includes(o.centreId)) repo.setOfferState(o.id, 'dismissed');
    }
    service.resumeAll();

    const child = opts.openWindow?.(server.url) ?? null;
    if (child) closers.push(() => void child.kill());

    return {
      service, repo, ui: server, settings, license,
      language: () => language,
      stop: async () => {
        await undo();
      },
    };
  } catch (err) {
    await undo();
    throw err;
  }
}
