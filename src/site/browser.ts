import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SiteError } from './errors.ts';

type Env = Record<string, string | undefined>;

/** 找本机的 Chrome 或 Edge。MYRTA_BROWSER 可以指定路径；指定了但不存在就报错，不悄悄换别的 */
export function findBrowser(platform: string, exists: (p: string) => boolean, env: Env): string {
  const forced = env.MYRTA_BROWSER;
  if (forced) {
    if (exists(forced)) return forced;
    throw new Error(`MYRTA_BROWSER 指定的浏览器不存在：${forced}`);
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
  if (!found) throw new Error('找不到 Chrome 或 Edge。请先安装其中一个，再重新打开本软件');
  return found;
}

export const realFindBrowser = (): string => findBrowser(process.platform, existsSync, process.env);

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
    if (spawnError) throw new SiteError('timeout', `浏览器无法启动：${(spawnError as Error).message}`);
    await new Promise((r) => setTimeout(r, 500));
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
    } catch {
      // 浏览器还没准备好，继续等
    }
  }
  if (!browser) {
    kill();
    throw new SiteError('timeout', '浏览器启动后 20 秒内没有响应');
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const langs = await page.evaluate(() => Array.from(navigator.languages));
  if (!languageOk(langs)) {
    await browser.close().catch(() => {});
    kill();
    throw new SiteError('widgets_missing', `浏览器语言不是英文（${langs.join(',')}），站点会返回无法使用的中文页面`);
  }
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
