import { parseSlotTime } from '../domain/time.ts';
import type { BookingInfo, LocalDate, LocalTime } from '../domain/types.ts';

export interface RawSlot {
  date: LocalDate;
  time: LocalTime;
  available: boolean;
  slotNumber: number;
}

/** 从选时间页的内联脚本 `var timeslots = {...}` 取出所有格子（一周） */
export function parseTimeslots(html: string): RawSlot[] {
  const marker = 'var timeslots';
  const at = html.indexOf(marker);
  if (at < 0) return [];
  const start = html.indexOf('{', at);
  if (start < 0) throw new Error('timeslots 后面没有对象');
  const json = extractObject(html, start);
  const parsed = JSON.parse(json) as { ajaxresult?: { slots?: { listTimeSlot?: unknown } } };
  const list = parsed.ajaxresult?.slots?.listTimeSlot;
  if (!Array.isArray(list)) throw new Error('timeslots 结构不对：没有 listTimeSlot');
  return list.map((raw) => {
    const s = raw as { startTime: string; availability: boolean; slotNumber: number };
    const { date, time } = parseSlotTime(s.startTime);
    return { date, time, available: s.availability === true, slotNumber: s.slotNumber };
  });
}

/** 从 start 处的 `{` 开始，按括号配对取出完整对象文本（字符串里的括号不算） */
function extractObject(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('timeslots 对象没有结束');
}

export function hasNoTimeslotsMessage(text: string): boolean {
  return /There are no timeslots available at this location/i.test(text);
}

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/** 查看预约页和确认页共用：读出考点、日期、时间 */
export function parseBookingDetails(text: string): BookingInfo {
  const centre = /Test location:[ \t]*([^\n]+)/i.exec(text)?.[1]?.trim();
  if (!centre) throw new Error('页面上找不到考点（Test location）');

  const d = /Date of test:[ \t]*(?:[A-Za-z]+,[ \t]*)?(\d{1,2})[ \t]+([A-Za-z]+)[ \t]+(\d{4})/i.exec(text);
  const month = d && MONTHS[d[2]!.toLowerCase()];
  if (!d || !month) throw new Error('页面上找不到日期（Date of test）');

  const t = /Time of test:[ \t]*(\d{1,2}):(\d{2})[ \t]*(AM|PM)/i.exec(text);
  if (!t) throw new Error('页面上找不到时间（Time of test）');
  let hour = Number(t[1]) % 12;
  if (t[3]!.toUpperCase() === 'PM') hour += 12;

  return {
    centreName: centre,
    date: `${d[3]}-${month}-${d[1]!.padStart(2, '0')}`,
    time: `${String(hour).padStart(2, '0')}:${t[2]}`,
  };
}

export type PageKind =
  | 'login' | 'main' | 'choose_location' | 'choose_time' | 'confirm' | 'finish' | 'blocked' | 'captcha' | 'unknown';

/** 判断当前是哪个页面。认不出来就返回 unknown，由调用方决定怎么处理 */
export function detectPage(text: string, url: string): PageKind {
  if (/temporarily unavailable/i.test(text)) return 'blocked';
  if (/captcha|verify (that )?you are (a )?human|are you a robot/i.test(text)) return 'captcha';
  const onMainPath = /\/tbs-change-main(\/|$)/.test(url);
  if (!onMainPath && /\/tbs-change(\/|$)/.test(url) && /Booking number/i.test(text)) return 'login';
  if (onMainPath) {
    const m = /step\s*(\d)\s*in progress/i.exec(text);
    if (m) {
      return ({ '1': 'main', '2': 'choose_location', '3': 'choose_time', '4': 'confirm', '5': 'finish' } as const)[m[1] as '1'] ?? 'unknown';
    }
    if (/finish\s*in progress/i.test(text)) return 'finish';
  }
  return 'unknown';
}
