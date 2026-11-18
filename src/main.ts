import { fileURLToPath } from 'node:url';
import { startApp } from './app/start.ts';
import { BrowserSession } from './site/flow.ts';
import { cleanupOrphans } from './site/orphans.ts';
import { errorText, render } from './i18n.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

let app;
try {
  app = await startApp({
    runtimeDir: process.env.MYRTA_RUNTIME_DIR ?? `${root}runtime`,
    centresFile: `${root}data/nsw-test-centres.json`,
    // 开发调试入口：npm start。界面地址打印在控制台，用浏览器打开。正式使用是 Electron 独立应用（src/electron/main.ts）
    // 每个学员一个固定的浏览器资料目录，保留登录状态；添加学员时的临时读取用 probe 目录。
    // 提交改约（Finish）要等第一次真实改约验证后才打开，见实现计划任务 10
    openSession: async (_id, profileDir) => new BrowserSession({ profileDir, allowFinish: false }),
    cleanupBrowsers: (root) => cleanupOrphans(root),
    finishAvailable: false,
    requireLicense: process.env.MYRTA_NO_LICENSE !== '1',
  });
} catch (err) {
  // 给教练看的提示，不打印堆栈
  console.error(`启动失败：${render('zh', errorText(err))}`);
  process.exit(1);
}

console.log(`界面地址：${app.ui.url}`);
console.log(`自动改约：${app.settings.autoRebookEnabled ? '开启' : '关闭'}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
