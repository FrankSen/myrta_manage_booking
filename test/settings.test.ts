import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/config/settings.ts';

describe('settings', () => {
  test('默认值：5 个学员、5 秒、自动改约关闭', () => {
    expect(DEFAULT_SETTINGS.hidden.maxActiveStudents).toBe(5);
    expect(DEFAULT_SETTINGS.hidden.checkIntervalMs).toBe(5_000);
    expect(DEFAULT_SETTINGS.hidden.globalMinGapMs).toBe(2_000);
    expect(DEFAULT_SETTINGS.autoRebookEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.notify.feishuWebhook).toBe('');
    expect(DEFAULT_SETTINGS.tolerance).toEqual({ maxTimeMinutes: 60, maxDateDays: 0 });
  });
  test('只覆盖给出的字段', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { hidden: { maxActiveStudents: 5 }, tolerance: { maxDateDays: 1 } });
    expect(s.hidden.maxActiveStudents).toBe(5);
    expect(s.hidden.checkIntervalMs).toBe(5_000);
    expect(s.tolerance.maxDateDays).toBe(1);
  });
  test('飞书 Webhook：只接受字符串，去空格', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { notify: { feishuWebhook: '  https://open.feishu.cn/x  ' } });
    expect(s.notify.feishuWebhook).toBe('https://open.feishu.cn/x');
    expect(() => mergeSettings(DEFAULT_SETTINGS, { notify: { feishuWebhook: 5 } })).toThrow('notify.feishuWebhook');
  });
  test('undefined 返回原配置', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toBe(DEFAULT_SETTINGS);
  });
  test('类型错误报错，不静默忽略', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { hidden: { maxActiveStudents: '5' } })).toThrow('hidden.maxActiveStudents');
    expect(() => mergeSettings(DEFAULT_SETTINGS, { tolerance: { maxTimeMinutes: -1 } })).toThrow('tolerance.maxTimeMinutes');
    // 旧配置里的 maxDistanceKm 不再使用，忽略即可，不报错
    expect(mergeSettings(DEFAULT_SETTINGS, { tolerance: { maxDistanceKm: 8 } }).tolerance).toEqual(DEFAULT_SETTINGS.tolerance);
    expect(() => mergeSettings(DEFAULT_SETTINGS, { autoRebookEnabled: 'yes' })).toThrow('autoRebookEnabled');
    expect(() => mergeSettings(DEFAULT_SETTINGS, 5)).toThrow('配置必须是对象');
  });
});
