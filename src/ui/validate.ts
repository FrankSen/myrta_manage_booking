import { INTERVAL_CHOICES_MS, isAllowedInterval } from '../config/interval.ts';
import type { Target } from '../domain/types.ts';
import { TextError, msg } from '../i18n.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 考位都是 15 分钟一档 */
const QUARTER = /^([01]\d|2[0-3]):(00|15|30|45)$/;

/** 教练提交的内容不合法。text 可翻译 */
export class ValidationError extends TextError {}

/** 每个学员最多选几个考点。考点越多一轮越慢，5 个学员一起刷新时会拖慢所有人 */
export const MAX_CENTRES = 2;

function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 校验教练提交的目标，返回规范化后的值。不合法抛 ValidationError */
export function parseTarget(raw: unknown, knownCentreIds: ReadonlySet<number>): Target {
  if (!raw || typeof raw !== 'object') throw new ValidationError(msg('v.target_empty'));
  const o = raw as Record<string, unknown>;
  const ids = o.centreIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError(msg('v.need_centre'));
  if (new Set(ids.map(String)).size > MAX_CENTRES) throw new ValidationError(msg('v.max_centres', { max: MAX_CENTRES }));
  const centreIds = ids.map((x) => Number(x));
  for (const id of centreIds) {
    if (!Number.isInteger(id) || !knownCentreIds.has(id)) throw new ValidationError(msg('v.unknown_centre', { id: String(id) }));
  }
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const dateFrom = str('dateFrom');
  const dateTo = str('dateTo');
  const timeFrom = str('timeFrom');
  const timeTo = str('timeTo');
  if (!isRealDate(dateFrom) || !isRealDate(dateTo)) throw new ValidationError(msg('v.date_format'));
  if (dateFrom > dateTo) throw new ValidationError(msg('v.date_order'));
  if (!TIME.test(timeFrom) || !TIME.test(timeTo)) throw new ValidationError(msg('v.time_format'));
  if (!QUARTER.test(timeFrom) || !QUARTER.test(timeTo)) throw new ValidationError(msg('v.time_quarter'));
  if (timeFrom > timeTo) throw new ValidationError(msg('v.time_order'));
  const target: Target = { centreIds: [...new Set(centreIds)], dateFrom, dateTo, timeFrom, timeTo };
  if (o.times !== undefined) {
    if (!Array.isArray(o.times)) throw new ValidationError(msg('v.times_format'));
    for (const t of o.times) {
      if (typeof t !== 'string' || !TIME.test(t)) throw new ValidationError(msg('v.times_hhmm'));
      if (!QUARTER.test(t)) throw new ValidationError(msg('v.times_quarter', { t }));
    }
    const times = [...new Set(o.times as string[])].sort();
    if (times.length > 0) target.times = times;
  }
  return target;
}

export interface NewStudentInput {
  label: string;
  bookingId: string;
  surname: string;
}

export function parseNewStudent(raw: unknown): NewStudentInput {
  if (!raw || typeof raw !== 'object') throw new ValidationError(msg('v.bad_request'));
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  const bookingId = typeof o.bookingId === 'string' ? o.bookingId.trim() : '';
  const surname = typeof o.surname === 'string' ? o.surname.trim() : '';
  if (!label) throw new ValidationError(msg('v.need_label'));
  if (!/^\d{6,12}$/.test(bookingId)) throw new ValidationError(msg('v.booking_format'));
  if (!surname) throw new ValidationError(msg('v.need_surname'));
  return { label, bookingId, surname };
}

/** 刷新间隔：{ ms }。allowNull 时 ms 为 null 表示改回用全局设置 */
export function parseInterval(raw: unknown, allowNull: boolean): number | null {
  const ms = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).ms : undefined;
  if (ms === null && allowNull) return null;
  if (typeof ms !== 'number' || !isAllowedInterval(ms)) {
    throw new ValidationError(msg('v.interval', { list: INTERVAL_CHOICES_MS.map((m) => String(m / 1000)) }));
  }
  return ms;
}
