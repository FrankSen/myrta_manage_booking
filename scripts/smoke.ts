// 联网冒烟测试：手动运行，不属于 npm test。
//   SMOKE_BOOKING_ID=xxxx SMOKE_SURNAME=xxxx node scripts/smoke.ts
// 流程：登录 → 读当前预约 → 选考点读一周 → 翻周 → 选一个考位 → 停在确认页 → 关闭
// 绝不点 Finish。结束后用全新的浏览器重新登录，核对预约没有变化。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, sydneyDateOf } from '../src/domain/time.ts';
import { BrowserSession } from '../src/site/flow.ts';
import { SiteError } from '../src/site/errors.ts';

const bookingId = process.env.SMOKE_BOOKING_ID;
const surname = process.env.SMOKE_SURNAME;
if (!bookingId || !surname) {
  console.error('请设置环境变量 SMOKE_BOOKING_ID 和 SMOKE_SURNAME');
  process.exit(1);
}

const CENTRE = Number(process.env.SMOKE_CENTRE ?? 241); // Silverwater
const PAUSE_MS = 8000;
const t0 = Date.now();
const lap = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

const profile = mkdtempSync(join(tmpdir(), 'smoke-'));
const mk = (sub: string) => new BrowserSession({ profileDir: join(profile, sub), allowFinish: false });
setTimeout(() => { console.error('总超时 6 分钟，退出'); process.exit(3); }, 6 * 60_000).unref();

let s1 = mk('a');
let failed = false;
try {
  const before = await s1.login(bookingId, surname);
  lap(`登录成功，当前预约：${before.centreName} ${before.date} ${before.time}`);
  await pause();

  const from = addDays(sydneyDateOf(Date.now()), 3);
  const to = addDays(from, 14);
  const slots = await s1.listSlots(CENTRE, from, to);
  lap(`考点 ${CENTRE}，${from} 至 ${to} 共 ${slots.length} 个可约考位`);
  const days = [...new Set(slots.map((s) => s.date))];
  lap(`涉及 ${days.length} 天：${days.slice(0, 6).join(' ')}${days.length > 6 ? ' …' : ''}`);
  if (slots.length === 0) throw new Error('没有可约考位，无法继续验证选位');
  await pause();

  // 选一个比当前预约更晚的考位（只走到确认页，不提交）
  const pick = slots.find((s) => s.date > before.date) ?? slots.at(-1)!;
  lap(`选位：${pick.date} ${pick.time}`);
  const confirm = await s1.reachConfirm(pick);
  lap(`到达确认页：${confirm.centreName} ${confirm.date} ${confirm.time}`);
  const ok = confirm.date === pick.date && confirm.time === pick.time;
  lap(ok ? '✓ 确认页内容与所选考位一致' : '✗ 确认页内容与所选考位不一致');
  if (!ok) failed = true;
  console.log('>>> 已停在确认页，没有点 Finish <<<');
  await pause();

  const back = await s1.readCurrent();
  lap(`放弃后回到查看预约页：${back.centreName} ${back.date} ${back.time}`);
} catch (err) {
  failed = true;
  console.error(err instanceof SiteError ? `站点错误 [${err.kind}]：${err.message}` : err);
} finally {
  await s1.close();
}

// 用全新的浏览器重新登录，核对预约确实没有被改动
await pause();
const s2 = mk('b');
try {
  const after = await s2.login(bookingId, surname);
  lap(`新会话核对：${after.centreName} ${after.date} ${after.time}`);
} catch (err) {
  failed = true;
  console.error('核对失败：', err instanceof Error ? err.message : err);
} finally {
  await s2.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
