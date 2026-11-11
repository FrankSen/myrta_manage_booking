import type { LocalDate, LocalTime } from './types.ts';

const TZ = 'Australia/Sydney';

const fmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * HOUR_MS;
export const LOCK_MS = 48 * HOUR_MS;

/** 某个 UTC 时刻悉尼比 UTC 快多少毫秒（含夏令时） */
function tzOffsetMs(utcMs: number): number {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** 悉尼本地的日期和时间，换算成 UTC 毫秒时间戳 */
export function sydneyInstant(date: LocalDate, time: LocalTime): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

export function minutesOf(time: LocalTime): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

function pad(n: number | string, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 把站点上的 "16/11/2026 8:00" 转成本地日期和时间 */
export function parseSlotTime(raw: string): { date: LocalDate; time: LocalTime } {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`无法解析考位时间: ${raw}`);
  return { date: `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}`, time: `${pad(m[4]!)}:${m[5]}` };
}

/** 把站点上的 "16/11/2026" 转成本地日期 */
export function parseSiteDate(raw: string): LocalDate {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) throw new Error(`无法解析日期: ${raw}`);
  return `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}`;
}

/** 日期加减天数 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** b 比 a 晚几天（可为负） */
export function diffDays(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** 星期几，用于拼考位格子的 id，如 'thu' */
export function weekdayKey(date: LocalDate): 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  return keys[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** 该日期所在周的周一 */
export function mondayOf(date: LocalDate): LocalDate {
  const key = weekdayKey(date);
  const offset = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }[key];
  return addDays(date, -offset);
}
