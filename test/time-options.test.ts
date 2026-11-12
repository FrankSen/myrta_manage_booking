import { describe, expect, test } from 'vitest';
// @ts-expect-error 浏览器端的普通 JS 模块，没有类型声明
import { checkTime, describeTime, onFromChange, onToChange, quarterTimes } from '../src/ui/public/time-options.js';

describe('时间选项', () => {
  test('06:00 到 18:00，每 15 分钟一档', () => {
    const t = quarterTimes() as string[];
    expect(t[0]).toBe('06:00');
    expect(t[1]).toBe('06:15');
    expect(t.at(-1)).toBe('18:00');
    expect(t).toHaveLength(49);
    expect(t.every((x) => /:(00|15|30|45)$/.test(x))).toBe(true);
  });
});

describe('联动', () => {
  test('选最早时间：最晚时间跟着变成同一个', () => {
    expect(onFromChange({ from: '09:15', to: '17:00' })).toEqual({ from: '09:15', to: '09:15' });
  });
  test('改最晚时间：最早时间不动', () => {
    expect(onToChange({ from: '09:15', to: '11:30' })).toEqual({ from: '09:15', to: '11:30' });
  });
});

describe('保存前检查', () => {
  test('范围：最晚早于最早不行，相等可以', () => {
    expect(checkTime('range', { from: '10:00', to: '09:45' }, [])).not.toBe('');
    expect(checkTime('range', { from: '10:00', to: '10:00' }, [])).toBe('');
  });
  test('指定时间：至少一个', () => {
    expect(checkTime('times', { from: '10:00', to: '09:00' }, [])).not.toBe('');
    expect(checkTime('times', { from: '10:00', to: '09:00' }, ['08:00'])).toBe('');
  });
});

describe('显示', () => {
  const base = { timeFrom: '08:00', timeTo: '12:00' };
  test('范围', () => expect(describeTime(base)).toBe('08:00–12:00'));
  test('单个时间', () => expect(describeTime({ timeFrom: '08:00', timeTo: '08:00' })).toBe('08:00'));
  test('指定时间', () => expect(describeTime({ ...base, times: ['08:00', '09:15'] })).toBe('指定 08:00、09:15'));
});
