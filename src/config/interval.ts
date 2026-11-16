import { msg } from '../i18n.ts';

/** 界面上可选的刷新间隔（分钟）。最小 1 分钟，原因见 INTERVAL_HELP */
export const INTERVAL_CHOICES_MIN = [1, 2, 3, 5, 10, 15, 30] as const;

export const MIN_INTERVAL_MS = INTERVAL_CHOICES_MIN[0] * 60_000;

export function isAllowedInterval(ms: number): boolean {
  return (INTERVAL_CHOICES_MIN as readonly number[]).includes(ms / 60_000);
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
