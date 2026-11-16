import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/config/settings.ts';

describe('settings', () => {
  test('默认值：2 个学员、2 分钟、自动改约关闭', () => {
    expect(DEFAULT_SETTINGS.hidden.maxActiveStudents).toBe(5);
    expect(DEFAULT_SETTINGS.hidden.checkIntervalMs).toBe(120_000);
    expect(DEFAULT_SETTINGS.autoRebookEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.tolerance).toEqual({ maxDistanceKm: 10, maxTimeMinutes: 60, maxDateDays: 0 });
  });
  test('只覆盖给出的字段', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { hidden: { maxActiveStudents: 5 }, tolerance: { maxDateDays: 1 } });
    expect(s.hidden.maxActiveStudents).toBe(5);
    expect(s.hidden.checkIntervalMs).toBe(120_000);
    expect(s.tolerance.maxDateDays).toBe(1);
    expect(s.tolerance.maxDistanceKm).toBe(10);
  });
  test('undefined 返回原配置', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toBe(DEFAULT_SETTINGS);
  });
  test('类型错误报错，不静默忽略', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { hidden: { maxActiveStudents: '5' } })).toThrow('hidden.maxActiveStudents');
    expect(() => mergeSettings(DEFAULT_SETTINGS, { tolerance: { maxDistanceKm: -1 } })).toThrow('tolerance.maxDistanceKm');
    expect(() => mergeSettings(DEFAULT_SETTINGS, { autoRebookEnabled: 'yes' })).toThrow('autoRebookEnabled');
    expect(() => mergeSettings(DEFAULT_SETTINGS, 5)).toThrow('配置必须是对象');
  });
});
