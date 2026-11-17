// 独立应用入口（Electron 主进程）。
// 主进程直接跑引擎、数据库和本地界面服务；界面是一个 Electron 窗口，加载本地服务的页面。
// 学员刷新仍然用本机 Chrome/Edge：Electron 自带的浏览器会被 myrta.com 拦截（2026-11-16 实测 403）。
import { BrowserWindow, Menu, app, dialog, shell } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, type App } from '../app/start.ts';
import { BrowserSession } from '../site/flow.ts';
import { realFindBrowser } from '../site/browser.ts';
import { DEFAULT_LANG, errorText, render, t, type Lang, type Text } from '../i18n.ts';
import { isAppUrl, quitQuestion } from './quit.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const PRODUCT = 'MyRTA Rebook';
app.setName(PRODUCT);
// 数据目录：Windows %APPDATA%\MyRTA Rebook，Mac ~/Library/Application Support/MyRTA Rebook。和程序分开，升级不影响
const dataDir = process.env.MYRTA_RUNTIME_DIR ?? join(app.getPath('appData'), PRODUCT);
app.setPath('userData', join(dataDir, 'ui-session'));
if (process.platform === 'win32') app.setAppUserModelId('com.myrta.rebook');
// 排查用：MYRTA_DEBUG_PORT=9333 时开放界面窗口的调试端口（只监听本机），正常使用不设
if (process.env.MYRTA_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.MYRTA_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

let core: App | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
let lang: Lang = DEFAULT_LANG;
const tr = (k: string, a?: Record<string, Text>) => t(lang, k, a);

if (!app.requestSingleInstanceLock()) {
  // 已经开着一个：让那个窗口到前面，自己退出
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(boot);
}

async function boot(): Promise<void> {
  try {
    core = await startApp({
      runtimeDir: dataDir,
      centresFile: join(root, 'data', 'nsw-test-centres.json'),
      openSession: async (_id, profileDir) => new BrowserSession({ profileDir, allowFinish: false }),
      finishAvailable: false,
      requireLicense: true,
      openWindow: () => null,
      warn: (m) => console.warn(render(lang, m)),
      onLanguage: (l) => {
        lang = l;
        setMenu();
      },
    });
  } catch (err) {
    dialog.showErrorBox(t(lang, 'el.start_failed'), render(lang, errorText(err)));
    app.exit(1);
    return;
  }
  lang = core.language();
  setMenu();
  checkBrowser();
  firstRunShortcuts();
  openWindow(core.ui.url);
}

function openWindow(url: string): void {
  const origin = new URL(url).origin;
  win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: tr('app.title'),
    icon: join(root, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#eef1ee',
    // 窗口在后台时也要及时收到事件、弹通知
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  // 只允许本地界面；外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) void shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (!isAppUrl(u, origin)) {
      e.preventDefault();
      if (/^https?:/.test(u)) void shell.openExternal(u);
    }
  });
  // 桌面通知由界面页面发出（网页通知在 Electron 里就是系统通知）；窗口最小化时也照常弹出
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'));
  win.on('close', (e) => {
    if (quitting || !core) return;
    const q = quitQuestion({ running: core.service.activeIds().length, rebooking: core.service.rebookingIds().length, held: core.service.heldIds().length });
    if (q) {
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'question',
        buttons: [tr('el.quit'), tr('el.cancel')],
        defaultId: 1,
        cancelId: 1,
        message: render(lang, q),
      });
      if (choice !== 0) {
        e.preventDefault();
        return;
      }
    }
    e.preventDefault();
    void shutdown();
  });
  void win.loadURL(url);
}

/** 退出：先停引擎（关掉所有学员的 Chrome），再退出程序 */
async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  win?.hide();
  try {
    await core?.stop();
  } finally {
    app.exit(0);
  }
}

app.on('window-all-closed', () => void shutdown());
// 不经过窗口的退出（系统关机/注销、进程收到 SIGTERM、Dock 里点"退出"）：不弹确认框，直接收尾。
// 这时可能没人看着屏幕，弹框会卡住退出，学员的 Chrome 也关不掉
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void shutdown();
});

/** Mac 菜单。Cmd+Q 走关窗口的确认流程；Windows 不要菜单栏 */
function setMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: PRODUCT,
        submenu: [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: tr('el.quit'), accelerator: 'Command+Q', click: () => win?.close() }],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

/** 学员刷新要用本机 Chrome/Edge，没有就提示，界面照常打开 */
function checkBrowser(): void {
  try {
    realFindBrowser();
  } catch (err) {
    dialog.showErrorBox(tr('app.title'), render(lang, errorText(err)));
  }
}

/** Windows 免安装版：第一次运行时在桌面和开始菜单建快捷方式 */
function firstRunShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const marker = join(dataDir, 'shortcuts-created');
  if (existsSync(marker)) return;
  const name = `${tr('el.shortcut_name')}.lnk`;
  const opts = { target: process.execPath, description: tr('app.title'), icon: process.execPath, iconIndex: 0, appUserModelId: 'com.myrta.rebook' };
  for (const dir of [app.getPath('desktop'), join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')]) {
    try {
      shell.writeShortcutLink(join(dir, name), 'create', opts);
    } catch {
      // 建不了快捷方式不影响使用
    }
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
}
