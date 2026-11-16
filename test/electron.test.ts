import { describe, expect, test } from 'vitest';
import { isAppUrl, quitQuestion } from '../src/electron/quit.ts';
import { render } from '../src/i18n.ts';

describe('关窗口确认', () => {
  test('没有在刷新：直接退出', () => expect(quitQuestion({ running: 0, rebooking: 0 })).toBeNull());
  test('有学员在刷新：提示人数', () => expect(render('zh', quitQuestion({ running: 3, rebooking: 0 })!)).toContain('3 个学员'));
  test('正在改约：优先提示会中断改约', () => expect(render('zh', quitQuestion({ running: 3, rebooking: 1 })!)).toContain('正在改约'));
});

describe('窗口只开本地页面', () => {
  const origin = 'http://127.0.0.1:5000';
  test.each([
    ['http://127.0.0.1:5000/?t=x', true],
    ['http://127.0.0.1:5001/', false],
    ['https://www.myrta.com/', false],
    ['file:///etc/passwd', false],
    ['不是网址', false],
  ])('%s', (url, ok) => expect(isAppUrl(url, origin)).toBe(ok));
});
