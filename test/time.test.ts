import { describe, expect, test } from 'vitest';
import {
  addDays, diffDays, minutesOf, mondayOf, parseSiteDate, parseSlotTime, sydneyDateOf, sydneyInstant, weekdayKey,
} from '../src/domain/time.ts';

describe('sydneyInstant', () => {
  test('夏令时 +11', () => {
    expect(new Date(sydneyInstant('2026-12-30', '11:30')).toISOString()).toBe('2026-12-30T00:30:00.000Z');
  });
  test('标准时间 +10', () => {
    expect(new Date(sydneyInstant('2026-06-30', '11:30')).toISOString()).toBe('2026-06-30T01:30:00.000Z');
  });
  test('夏令时开始当天 2026-10-04：凌晨 1 点仍是 +10，8 点已是 +11', () => {
    expect(new Date(sydneyInstant('2026-10-04', '01:00')).toISOString()).toBe('2026-10-03T15:00:00.000Z');
    expect(new Date(sydneyInstant('2026-10-04', '08:00')).toISOString()).toBe('2026-10-03T21:00:00.000Z');
  });
});

describe('解析站点格式', () => {
  test('考位时间', () => {
    expect(parseSlotTime('16/11/2026 8:00')).toEqual({ date: '2026-11-16', time: '08:00' });
    expect(parseSlotTime('3/1/2027 15:30')).toEqual({ date: '2027-01-03', time: '15:30' });
  });
  test('日期', () => {
    expect(parseSiteDate('28/12/2026')).toBe('2026-12-28');
  });
  test('无法解析时抛错', () => {
    expect(() => parseSlotTime('明天')).toThrow('无法解析考位时间');
  });
});

describe('日期运算', () => {
  test('addDays 跨月跨年', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  test('diffDays', () => {
    expect(diffDays('2026-12-30', '2027-01-02')).toBe(3);
    expect(diffDays('2026-12-30', '2026-12-28')).toBe(-2);
  });
  test('weekdayKey / mondayOf', () => {
    expect(weekdayKey('2026-12-31')).toBe('thu');
    expect(mondayOf('2026-12-31')).toBe('2026-12-28');
    expect(mondayOf('2026-12-28')).toBe('2026-12-28');
    expect(mondayOf('2027-01-03')).toBe('2026-12-28');
  });
  test('minutesOf', () => {
    expect(minutesOf('08:30')).toBe(510);
  });
});

describe('sydneyDateOf', () => {
  test('UTC 的前一天晚上，悉尼已经是第二天', () => {
    expect(sydneyDateOf(Date.UTC(2026, 11, 29, 14, 0))).toBe('2026-12-30'); // 14:00Z = 01:00 +11
    expect(sydneyDateOf(Date.UTC(2026, 11, 29, 12, 59))).toBe('2026-12-29'); // 23:59 +11
  });
  test('与 sydneyInstant 互为逆运算', () => {
    expect(sydneyDateOf(sydneyInstant('2026-10-04', '00:30'))).toBe('2026-10-04');
    expect(sydneyDateOf(sydneyInstant('2026-06-30', '23:59'))).toBe('2026-06-30');
  });
});
