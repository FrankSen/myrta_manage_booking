import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SiteError } from './errors.ts';
import { TextError, msg } from '../i18n.ts';

type Env = Record<string, string | undefined>;

/** 找本机的 Chrome 或 Edge。MYRTA_BROWSER 可以指定路径；指定了但不存在就报错，不悄悄换别的 */
export function findBrowser(platform: string, exists: (p: string) => boolean, env: Env): string {
  const forced = env.MYRTA_BROWSER;
  if (forced) {
    if (exists(forced)) return forced;
    throw new TextError(msg('err.browser_forced_missing', { path: forced }));
  }
  const candidates: string[] = [];
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    candidates.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] : []),
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge');
  }
  const found = candidates.find(exists);
  if (!found) throw new TextError(msg('err.no_browser'));
  return found;
}

export const realFindBrowser = (): string => findBrowser(process.platform, existsSync, process.env);

/**
 * 关掉浏览器自己的后台下载：组件更新、AI 模型、翻译、安全浏览列表、同步等。
 * 不加时一个新资料目录一分多钟就会下载十几 MB，每添加一个学员都重来一遍。
 * 只关后台联网，不改网页能看到的特征（不用 --disable-extensions 之类），以免被站点防护识别
 */
export const QUIET_ARGS: readonly string[] = [
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--no-pings',
  // GPU 着色器缓存：每个资料目录约 6MB，没有用
  '--disable-gpu-shader-disk-cache',
  '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints,MediaRouter,Translate',
];

export function launchArgs(port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    // 站点按浏览器语言返回页面。中文页面会让登录控件无法初始化，所以必须同时固定这两项
    '--lang=en-AU',
    '--accept-lang=en-AU,en',
    '--no-first-run',
    '--no-default-browser-check',
    // MYRTA_QUIET=0 时不加（排查站点拦截用）
    ...(process.env.MYRTA_QUIET === '0' ? [] : QUIET_ARGS),
    'about:blank',
  ];
}

export function launchEnv(base: Env): Env {
  return { ...base, LANG: 'en_AU.UTF-8', LC_ALL: 'en_AU.UTF-8' };
}

export function languageOk(languages: readonly string[]): boolean {
  return languages[0]?.toLowerCase().startsWith('en') ?? false;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** 等子进程退出，超时后强制结束 */
export async function waitExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((r) => child.once('exit', () => r(true)));
  const timer = new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref());
  if (await Promise.race([exited, timer])) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref())]);
}

/** 最小化或恢复浏览器窗口。恢复时同时把页面调到前面。失败不影响使用 */
export async function setWindowState(page: Page, state: 'minimized' | 'normal'): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
    await cdp.detach();
    if (state === 'normal') await page.bringToFront();
  } catch {
    // 不支持就算了
  }
}

export interface BrowserHandle {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

/**
 * 以"正常方式"启动本机浏览器，再通过调试端口接管。
 * 直接由 Playwright 启动的浏览器会被站点的防护识别并返回 403，所以必须这样做。
 */
export async function launchBrowser(profileDir: string, exe: string = realFindBrowser()): Promise<BrowserHandle> {
  const port = await freePort();
  const child: ChildProcess = spawn(exe, launchArgs(port, profileDir), { stdio: 'ignore', env: launchEnv(process.env) as NodeJS.ProcessEnv });
  let spawnError: Error | null = null;
  child.once('error', (e) => (spawnError = e));

  const kill = () => {
    try {
      child.kill();
    } catch {
      // 已退出
    }
  };

  let browser: Browser | null = null;
  for (let i = 0; i < 40 && !browser; i++) {
    if (spawnError) throw new SiteError('timeout', msg('err.browser_spawn', { detail: (spawnError as Error).message }));
    await new Promise((r) => setTimeout(r, 500));
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
    } catch {
      // 浏览器还没准备好，继续等
    }
  }
  if (!browser) {
    kill();
    throw new SiteError('timeout', msg('err.browser_no_response'));
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const langs = await page.evaluate(() => Array.from(navigator.languages));
  if (!languageOk(langs)) {
    await browser.close().catch(() => {});
    kill();
    throw new SiteError('widgets_missing', msg('err.browser_lang', { langs: langs.join(',') }));
  }
  // 窗口最小化：5 个学员就是 5 个窗口，不最小化会挡住教练的屏幕。2026-11-16 实测最小化后登录、选考点、读考位都正常，站点不拦。
  // MYRTA_MINIMIZE=0 时不最小化（排查用）。最小化失败不影响使用
  if (process.env.MYRTA_MINIMIZE !== '0') await setWindowState(page, 'minimized');
  return {
    browser,
    page,
    close: async () => {
      await browser!.close().catch(() => {});
      kill();
      // 等进程真正退出：同一个资料目录马上会被重新使用，旧进程还在时新浏览器会把请求转交给它
      await waitExit(child, 10_000);
    },
  };
}
