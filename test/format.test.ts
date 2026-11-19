import { describe, expect, test } from 'vitest';
// @ts-expect-error 浏览器端的普通 JS 模块，没有类型声明
import { countdown, cycleLabel, estimate, remaining } from '../src/ui/public/format.js';

describe('countdown', () => {
  test('分:秒，向上取整', () => {
    expect(countdown(65_000)).toBe('1:05');
    expect(countdown(64_001)).toBe('1:05');
    expect(countdown(0)).toBe('0:00');
    expect(countdown(-5)).toBe('0:00');
  });
  test('超过 1 小时', () => expect(countdown(3_723_000)).toBe('1:02:03'));
});

describe('remaining', () => {
  test('按天、小时、分钟', () => {
    expect(remaining(16 * 86_400_000 + 5)).toBe('16 天');
    expect(remaining(47 * 3_600_000)).toBe('47 小时');
    expect(remaining(10 * 60_000)).toBe('10 分钟');
  });
  test('已过：空', () => expect(remaining(0)).toBe(''));
});

describe('estimate', () => {
  test('2 分钟：实际约 3.1 到 3.8 分钟一轮', () => {
    expect(estimate(2 * 60_000).text).toBe('实际约 3.1 到 3.8 分钟一轮，每小时约 16 到 19 轮');
    expect(estimate(2 * 60_000).risky).toBe(false);
  });
  test('不到 1 分钟标为有风险', () => {
    expect(estimate(60_000).risky).toBe(false);
    expect(estimate(5_000).risky).toBe(true);
  });
});

describe('cycleLabel', () => {
  test('不到 1 分钟按秒，否则按半分钟取整', () => {
    expect(cycleLabel(5 * 60_000)).toBe('5 分钟');
    expect(cycleLabel(205_000)).toBe('3.5 分钟');
    expect(cycleLabel(10_000)).toBe('10 秒');
    expect(cycleLabel(5_000)).toBe('5 秒');
  });
});
