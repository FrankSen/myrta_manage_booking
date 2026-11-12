// 联网测试：登录会话能复用多久。手动运行，不属于 npm test。
//   SMOKE_BOOKING_ID=xxxx SMOKE_SURNAME=xxxx node scripts/session-reuse.ts
// 阶段 A：按产品的节奏，每 2 分钟一轮（login 复用 + 读一个考点一周），共 ROUNDS 轮。
// 阶段 B：空闲 GAPS 分钟后再复用，看空闲多久会失效。
// 只读考位，不选位、不进确认页、不点 Finish。凭据只通过环境变量传入，输出里不打印。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { addDays, sydneyDateOf } from '../src/domain/time.ts';
import { BrowserSession } from '../src/site/flow.ts';
import { SiteError } from '../src/site/errors.ts';
import { detectPage } from '../src/site/parse.ts';

const bookingId = process.env.SMOKE_BOOKING_ID;
const surname = process.env.SMOKE_SURNAME;
if (!bookingId || !surname) {
  console.error('请设置环境变量 SMOKE_BOOKING_ID 和 SMOKE_SURNAME');
  process.exit(1);
}
const CENTRE = Number(process.env.SMOKE_CENTRE ?? 241);
const ROUNDS = Number(process.env.REUSE_ROUNDS ?? 6);
const GAPS = (process.env.REUSE_GAPS ?? '5,10,20').split(',').map(Number);

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 60_000).toFixed(1)}min]`;
const log = (s: string) => console.log(`${stamp()} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const totalMin = ROUNDS * 2 + GAPS.reduce((a, b) => a + b, 0) + 15;
setTimeout(() => { console.error(`总超时 ${totalMin} 分钟，退出`); process.exit(3); }, totalMin * 60_000).unref();

const profile = mkdtempSync(join(tmpdir(), 'reuse-'));
const s = new BrowserSession({ profileDir: profile, allowFinish: false });
// 只为观察：取出内部页面，看失效时页面是什么样子
const pageOf = (): Page | undefined => (s as unknown as { handle: { page: Page } | null }).handle?.page;

async function describePage(): Promise<string> {
  const page = pageOf();
  if (!page) return '无页面';
  const text = await page.innerText('body').catch(() => '');
  const kind = detectPage(text, page.url());
  // 只记录页面标题行和网址路径，不记录预约内容
  const firstLine = text.split('\n').map((x) => x.trim()).find((x) => /session|expired|timed? ?out|log ?in|sign ?in|error/i.test(x)) ?? '';
  return `kind=${kind} path=${new URL(page.url()).pathname} hint="${firstLine.slice(0, 120)}"`;
}

const from = addDays(sydneyDateOf(Date.now()), 3);
const to = addDays(from, 6);
let lastActive = Date.now();

async function round(label: string): Promise<void> {
  const before = await describePage();
  const t = Date.now();
  const cur = await s.login(bookingId!, surname!);
  const loginSec = ((Date.now() - t) / 1000).toFixed(0);
  log(`${label}：距上次活动 ${((t - lastActive) / 60_000).toFixed(1)} 分钟，login ${s.lastLoginReused ? '复用' : '重新登录'}（${loginSec}s），当前预约 ${cur.date} ${cur.time}`);
  if (!s.lastLoginReused && label !== '首次') log(`  复用失败前页面：${before}`);
  const t2 = Date.now();
  const slots = await s.listSlots(CENTRE, from, to);
  log(`  读考点 ${CENTRE} 一周：${slots.length} 个考位（${((Date.now() - t2) / 1000).toFixed(0)}s），之后页面：${await describePage()}`);
  lastActive = Date.now();
}

let failed = false;
try {
  await round('首次');
  for (let i = 1; i <= ROUNDS; i++) {
    await sleep(Math.max(0, 2 * 60_000 - (Date.now() - lastActive)));
    await round(`A${i}`);
  }
  for (const gap of GAPS) {
    log(`空闲 ${gap} 分钟…`);
    await sleep(gap * 60_000);
    await round(`B 空闲${gap}`);
  }
} catch (err) {
  failed = true;
  console.error(err instanceof SiteError ? `站点错误 [${err.kind}]：${err.message}` : err);
  log(`出错时页面：${await describePage()}`);
} finally {
  await s.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
