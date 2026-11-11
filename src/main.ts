import { fileURLToPath } from 'node:url';
import { startApp } from './app/start.ts';
import { UnavailableSession } from './site/unavailable.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

let app;
try {
  app = await startApp({
    runtimeDir: process.env.MYRTA_RUNTIME_DIR ?? `${root}runtime`,
    centresFile: `${root}data/nsw-test-centres.json`,
    // 站点操作模块接入前使用占位实现：不会访问任何网站
    openSession: async () => new UnavailableSession(),
  });
} catch (err) {
  // 给教练看的提示，不打印堆栈
  console.error(`启动失败：${err instanceof Error ? err.message : String(err)}`);
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
