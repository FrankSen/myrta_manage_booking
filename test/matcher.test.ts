import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { indexCentres } from '../src/domain/geo.ts';
import { DEFAULT_TOLERANCE, evaluate, isBookable, refreshDeadline } from '../src/domain/matcher.ts';
import { sydneyInstant } from '../src/domain/time.ts';
import type { Centre, Slot, Target } from '../src/domain/types.ts';

const centres = indexCentres(JSON.parse(readFileSync(new URL('../data/nsw-test-centres.json', import.meta.url), 'utf8')) as Centre[]);

const SILVERWATER = 241;
const AUBURN = 112; // 2.2 km
const BANKSTOWN = 20; // 9.7 km
const ROSELANDS = 421; // 11.8 km
const ALBURY = 17;

const NOW = sydneyInstant('2026-11-11', '10:00');
const target: Target = {
  centreIds: [SILVERWATER],
  dateFrom: '2026-11-16',
  dateTo: '2026-11-20',
  timeFrom: '09:00',
  timeTo: '12:00',
};
const slot = (centreId: number, date: string, time: string): Slot => ({ centreId, date, time });
const run = (s: Slot, tol = DEFAULT_TOLERANCE, now = NOW) => evaluate(s, target, tol, centres, now);

describe('48 小时规则', () => {
  test('刚好 48 小时可约', () => {
    expect(isBookable(slot(SILVERWATER, '2026-11-13', '10:00'), NOW)).toBe(true);
  });
  test('差 1 分钟不可约', () => {
    expect(isBookable(slot(SILVERWATER, '2026-11-13', '09:59'), NOW)).toBe(false);
  });
  test('完全符合目标但不足 48 小时 → 不符合', () => {
    const now = sydneyInstant('2026-11-15', '10:00'); // 16 日 9:00 只剩 23 小时
    expect(run(slot(SILVERWATER, '2026-11-16', '09:00'), DEFAULT_TOLERANCE, now).kind).toBe('none');
  });
});

describe('完全符合', () => {
  test('目标考点、日期和时间都在范围内', () => {
    expect(run(slot(SILVERWATER, '2026-11-17', '10:30')).kind).toBe('exact');
  });
  test('时间段边界含两端', () => {
    expect(run(slot(SILVERWATER, '2026-11-16', '09:00')).kind).toBe('exact');
    expect(run(slot(SILVERWATER, '2026-11-20', '12:00')).kind).toBe('exact');
  });
});

describe('接近', () => {
  test('考点对，时间超出 60 分钟以内', () => {
    const r = run(slot(SILVERWATER, '2026-11-17', '13:00'));
    expect(r.kind).toBe('near');
    expect(r.notes).toEqual(['时间超出目标时间段 60 分钟']);
  });
  test('时间超出 61 分钟 → 不符合', () => {
    expect(run(slot(SILVERWATER, '2026-11-17', '13:01')).kind).toBe('none');
  });
  test('时间对，考点在 10 公里内', () => {
    const r = run(slot(BANKSTOWN, '2026-11-17', '10:00'));
    expect(r.kind).toBe('near');
    expect(r.notes[0]).toMatch(/^距目标考点 9\.\d 公里$/);
  });
  test('考点超过 10 公里 → 不符合', () => {
    expect(run(slot(ROSELANDS, '2026-11-17', '10:00')).kind).toBe('none');
  });
  test('考点和时间同时有偏差，仍算接近，说明两项', () => {
    const r = run(slot(AUBURN, '2026-11-17', '08:30'));
    expect(r.kind).toBe('near');
    expect(r.notes).toHaveLength(2);
  });
  test('远处的考点即使时间完全对也不符合', () => {
    expect(run(slot(ALBURY, '2026-11-17', '10:00')).kind).toBe('none');
  });
});

describe('日期偏差', () => {
  test('默认不允许：差 1 天 → 不符合', () => {
    expect(run(slot(SILVERWATER, '2026-11-21', '10:00')).kind).toBe('none');
    expect(run(slot(SILVERWATER, '2026-11-15', '10:00')).kind).toBe('none');
  });
  test('放开到 1 天后，差 1 天算接近', () => {
    const tol = { ...DEFAULT_TOLERANCE, maxDateDays: 1 };
    const r = run(slot(SILVERWATER, '2026-11-21', '10:00'), tol);
    expect(r.kind).toBe('near');
    expect(r.notes).toEqual(['日期超出目标范围 1 天']);
    expect(run(slot(SILVERWATER, '2026-11-22', '10:00'), tol).kind).toBe('none');
  });
});

describe('容差可调', () => {
  test('距离放宽到 12 公里后 Roselands 算接近', () => {
    const tol = { ...DEFAULT_TOLERANCE, maxDistanceKm: 12 };
    expect(run(slot(ROSELANDS, '2026-11-17', '10:00'), tol).kind).toBe('near');
  });
});

describe('指定时间', () => {
  const t: Target = { ...target, timeFrom: '09:00', timeTo: '12:00', times: ['08:00', '13:30'] };
  const ev = (s: Slot) => evaluate(s, t, DEFAULT_TOLERANCE, centres, NOW);
  test('等于某个指定时间：完全符合（忽略时间范围）', () => {
    expect(ev(slot(SILVERWATER, '2026-11-17', '08:00')).kind).toBe('exact');
    expect(ev(slot(SILVERWATER, '2026-11-17', '13:30')).kind).toBe('exact');
  });
  test('在时间范围内但不是指定时间：按最近的指定时间算偏差', () => {
    const r = ev(slot(SILVERWATER, '2026-11-17', '10:00'));
    expect(r.kind).toBe('none'); // 离 08:00 120 分钟，离 13:30 210 分钟
    const r2 = ev(slot(SILVERWATER, '2026-11-17', '08:45'));
    expect(r2.kind).toBe('near');
    expect(r2.notes).toEqual(['与指定时间相差 45 分钟']);
  });
  test('取最近的指定时间', () => {
    expect(ev(slot(SILVERWATER, '2026-11-17', '13:00')).notes).toEqual(['与指定时间相差 30 分钟']);
  });
  test('正好 60 分钟算接近，61 分钟不算', () => {
    expect(ev(slot(SILVERWATER, '2026-11-17', '14:30')).kind).toBe('near');
    expect(ev(slot(SILVERWATER, '2026-11-17', '14:31')).kind).toBe('none');
  });
  test('空数组按时间范围', () => {
    expect(evaluate(slot(SILVERWATER, '2026-11-17', '10:00'), { ...target, times: [] }, DEFAULT_TOLERANCE, centres, NOW).kind).toBe('exact');
  });
});

describe('最早等于最晚', () => {
  test('只有这个时间完全符合', () => {
    const t: Target = { ...target, timeFrom: '08:00', timeTo: '08:00' };
    expect(evaluate(slot(SILVERWATER, '2026-11-17', '08:00'), t, DEFAULT_TOLERANCE, centres, NOW).kind).toBe('exact');
    expect(evaluate(slot(SILVERWATER, '2026-11-17', '08:15'), t, DEFAULT_TOLERANCE, centres, NOW).kind).toBe('near');
  });
});

describe('refreshDeadline', () => {
  test('目标最晚日期更早：截止于目标最晚日 23:59 前 48 小时', () => {
    const d = refreshDeadline({ date: '2026-12-30', time: '11:30' }, { dateTo: '2026-12-10' }, 0);
    expect(d).toEqual({ at: sydneyInstant('2026-12-08', '23:59'), reason: 'target' });
  });
  test('原考试更早：截止于原考试前 48 小时', () => {
    const d = refreshDeadline({ date: '2026-12-05', time: '09:00' }, { dateTo: '2026-12-20' }, 0);
    expect(d).toEqual({ at: sydneyInstant('2026-12-03', '09:00'), reason: 'locked' });
  });
  test('日期容差会延后目标截止', () => {
    expect(refreshDeadline({ date: '2027-01-30', time: '11:30' }, { dateTo: '2026-12-10' }, 2).at).toBe(sydneyInstant('2026-12-10', '23:59'));
  });
});
