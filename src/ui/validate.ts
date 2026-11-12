import type { Target } from '../domain/types.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 考位都是 15 分钟一档 */
const QUARTER = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export class ValidationError extends Error {}

function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 校验教练提交的目标，返回规范化后的值。不合法抛 ValidationError */
export function parseTarget(raw: unknown, knownCentreIds: ReadonlySet<number>): Target {
  if (!raw || typeof raw !== 'object') throw new ValidationError('目标不能为空');
  const o = raw as Record<string, unknown>;
  const ids = o.centreIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError('至少选择一个考点');
  const centreIds = ids.map((x) => Number(x));
  for (const id of centreIds) {
    if (!Number.isInteger(id) || !knownCentreIds.has(id)) throw new ValidationError(`未知考点：${String(id)}`);
  }
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const dateFrom = str('dateFrom');
  const dateTo = str('dateTo');
  const timeFrom = str('timeFrom');
  const timeTo = str('timeTo');
  if (!isRealDate(dateFrom) || !isRealDate(dateTo)) throw new ValidationError('日期格式应为 YYYY-MM-DD');
  if (dateFrom > dateTo) throw new ValidationError('开始日期不能晚于结束日期');
  if (!TIME.test(timeFrom) || !TIME.test(timeTo)) throw new ValidationError('时间格式应为 HH:MM');
  if (!QUARTER.test(timeFrom) || !QUARTER.test(timeTo)) throw new ValidationError('时间要按 15 分钟一档选（如 08:00、08:15）');
  if (timeFrom > timeTo) throw new ValidationError('最早时间不能晚于最晚时间');
  const target: Target = { centreIds: [...new Set(centreIds)], dateFrom, dateTo, timeFrom, timeTo };
  if (o.times !== undefined) {
    if (!Array.isArray(o.times)) throw new ValidationError('指定时间格式不对');
    for (const t of o.times) {
      if (typeof t !== 'string' || !TIME.test(t)) throw new ValidationError('指定时间格式应为 HH:MM');
      if (!QUARTER.test(t)) throw new ValidationError(`指定时间要按 15 分钟一档选：${t}`);
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
  if (!raw || typeof raw !== 'object') throw new ValidationError('请求内容不对');
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  const bookingId = typeof o.bookingId === 'string' ? o.bookingId.trim() : '';
  const surname = typeof o.surname === 'string' ? o.surname.trim() : '';
  if (!label) throw new ValidationError('请填写备注名');
  if (!/^\d{6,12}$/.test(bookingId)) throw new ValidationError('Booking number 应为 6 到 12 位数字');
  if (!surname) throw new ValidationError('请填写姓氏');
  return { label, bookingId, surname };
}
