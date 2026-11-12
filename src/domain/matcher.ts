import { minDistanceKm } from './geo.ts';
import { LOCK_MS, diffDays, minutesOf, sydneyInstant } from './time.ts';
import type { CentreIndex, MatchResult, Slot, Target, Tolerance } from './types.ts';

export const DEFAULT_TOLERANCE: Tolerance = {
  maxDistanceKm: 10,
  maxTimeMinutes: 60,
  maxDateDays: 0,
};

/** 考位开始时间距现在是否已满 48 小时（R1） */
export function isBookable(slot: Slot, nowMs: number): boolean {
  return sydneyInstant(slot.date, slot.time) - nowMs >= LOCK_MS;
}

/** 时间超出目标时间段多少分钟，段内为 0 */
export function minutesOutside(time: string, from: string, to: string): number {
  const t = minutesOf(time);
  if (t < minutesOf(from)) return minutesOf(from) - t;
  if (t > minutesOf(to)) return t - minutesOf(to);
  return 0;
}

/** 与最近一个指定时间相差多少分钟 */
export function minutesFromNearest(time: string, times: readonly string[]): number {
  const t = minutesOf(time);
  return Math.min(...times.map((x) => Math.abs(minutesOf(x) - t)));
}

/** 日期超出目标日期范围多少天，范围内为 0 */
export function daysOutside(date: string, from: string, to: string): number {
  if (date < from) return diffDays(date, from);
  if (date > to) return diffDays(to, date);
  return 0;
}

const NONE: MatchResult = { kind: 'none', notes: [] };

/**
 * 判断一个考位对某个学员的目标来说是完全符合、接近还是不符合。
 * 纯函数：不访问网络，不读时钟，现在时间由调用方传入。
 */
export function evaluate(
  slot: Slot,
  target: Target,
  tolerance: Tolerance,
  centres: CentreIndex,
  nowMs: number,
): MatchResult {
  if (!isBookable(slot, nowMs)) return NONE;

  const dateOut = daysOutside(slot.date, target.dateFrom, target.dateTo);
  const byTimes = (target.times?.length ?? 0) > 0;
  const timeOut = byTimes ? minutesFromNearest(slot.time, target.times!) : minutesOutside(slot.time, target.timeFrom, target.timeTo);
  const centreIsTarget = target.centreIds.includes(slot.centreId);

  if (dateOut === 0 && timeOut === 0 && centreIsTarget) {
    return { kind: 'exact', notes: [] };
  }

  const notes: string[] = [];

  if (dateOut > tolerance.maxDateDays) return NONE;
  if (dateOut > 0) notes.push(`日期超出目标范围 ${dateOut} 天`);

  if (timeOut > tolerance.maxTimeMinutes) return NONE;
  if (timeOut > 0) notes.push(byTimes ? `与指定时间相差 ${timeOut} 分钟` : `时间超出目标时间段 ${timeOut} 分钟`);

  if (!centreIsTarget) {
    const km = minDistanceKm(slot.centreId, target.centreIds, centres);
    if (km > tolerance.maxDistanceKm) return NONE;
    notes.push(`距目标考点 ${km.toFixed(1)} 公里`);
  }

  return { kind: 'near', notes };
}
