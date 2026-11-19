import { msg } from '../i18n.ts';

/**
 * 界面上可选的刷新间隔（毫秒）。最快 5 秒：2026-11-17 教练要求大幅调快以抢考位，
 * 明确忽略被站点拦截/封 IP 的风险（由教练自行更换出口 IP 解决），原因与取舍见 INTERVAL_HELP。
 */
export const INTERVAL_CHOICES_MS = [
  5_000, 10_000, 30_000, 60_000, 2 * 60_000, 3 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
] as const;

export const MIN_INTERVAL_MS = INTERVAL_CHOICES_MS[0];

export function isAllowedInterval(ms: number): boolean {
  return (INTERVAL_CHOICES_MS as readonly number[]).includes(ms);
}

/** 给教练看的说明。数字来自 2026-11 实测，见实现计划"实测耗时" */
export const INTERVAL_HELP = [msg('interval.help1'), msg('interval.help2'), msg('interval.help3'), msg('interval.help4')];

/** 一轮里除了查考点之外的固定耗时（回到预约页），以及每查一个考点的耗时，实测平均值 */
export const ROUND_BASE_MS = 15_000;
export const PER_CENTRE_MS = 35_000;

/**
 * 某个学员实际多久刷新一次（毫秒）。两个下限取较大的：
 * 自己的间隔加上一轮本身的耗时；所有正在刷新的学员一轮总访问次数 × 全局访问间隔（大家排队共用一个出口）。
 */
export function expectedCycleMs(o: { intervalMs: number; ownVisits: number; totalVisits: number; gapMs: number }): number {
  const own = o.intervalMs + ROUND_BASE_MS + o.ownVisits * PER_CENTRE_MS;
  const shared = o.totalVisits * o.gapMs;
  return Math.max(own, shared);
}
