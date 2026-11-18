import { TextError, msg } from '../i18n.ts';
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

/** 页面里有没有考位数据脚本。没有时不能当作"没有考位"，可能是页面没加载完 */
export function hasTimeslotsData(html: string): boolean {
  return html.includes('var timeslots');
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
  if (!centre) throw new TextError(msg('err.parse_centre'));

  const d = /Date of test:[ \t]*(?:[A-Za-z]+,[ \t]*)?(\d{1,2})[ \t]+([A-Za-z]+)[ \t]+(\d{4})/i.exec(text);
  const month = d && MONTHS[d[2]!.toLowerCase()];
  if (!d || !month) throw new TextError(msg('err.parse_date'));

  const t = /Time of test:[ \t]*(\d{1,2}):(\d{2})[ \t]*(AM|PM)/i.exec(text);
  if (!t) throw new TextError(msg('err.parse_time'));
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

export type LoginProblem = { kind: 'bad_credentials' | 'widgets_missing'; line: string } | { kind: 'site_message'; line: string };

const BAD_CREDENTIALS =
  /(cannot|can ?not|can't|could not|couldn't|unable to|we were unable to) (find|locate|retrieve|match)|not (be )?found|no (matching )?booking|incorrect|invalid|do(es)? not match|don't match|not recogni[sz]ed|check (your|the) (details|booking|information)/i;

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * 点 Continue 之后、还没进入预约页时，看页面上有没有新出现的提示。
 * before 是点 Continue 之前的页面文字：本来就有的说明文字不算，只看新出现的行。
 * 返回 null 表示还没看到提示（可能还在加载）
 */
export function loginProblem(before: string, after: string): LoginProblem | null {
  const old = new Set(lines(before));
  const fresh = lines(after).filter((l) => !old.has(l));
  const mandatory = fresh.find((l) => /Enter all mandatory fields/i.test(l));
  if (mandatory) return { kind: 'widgets_missing', line: mandatory };
  const bad = fresh.find((l) => BAD_CREDENTIALS.test(l));
  if (bad) return { kind: 'bad_credentials', line: bad.slice(0, 200) };
  return null;
}

/** 新出现的文字（去掉本来就有的），用于报错时把网站的原话告诉教练 */
export function freshText(before: string, after: string, max = 200): string {
  const old = new Set(lines(before));
  return lines(after).filter((l) => !old.has(l)).join(' ').slice(0, max);
}
