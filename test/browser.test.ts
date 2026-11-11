import { describe, expect, test } from 'vitest';
import { findBrowser, launchArgs, launchEnv, languageOk } from '../src/site/browser.ts';

describe('findBrowser', () => {
  const only = (...paths: string[]) => (p: string) => paths.includes(p);
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  test('Windows：Chrome 优先', () => {
    expect(findBrowser('win32', only(CHROME, EDGE), {})).toBe(CHROME);
  });
  test('Windows：没有 Chrome 用 Edge', () => {
    expect(findBrowser('win32', only(EDGE), {})).toBe(EDGE);
  });
  test('Windows：也会找用户目录下的 Chrome', () => {
    const user = 'C:\\Users\\coach\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(findBrowser('win32', only(user), { LOCALAPPDATA: 'C:\\Users\\coach\\AppData\\Local' })).toBe(user);
  });
  test('都没有：抛出教练能看懂的提示', () => {
    expect(() => findBrowser('win32', () => false, {})).toThrow('Chrome 或 Edge');
  });
  test('环境变量可以指定浏览器路径', () => {
    expect(findBrowser('win32', only('D:\\x\\chrome.exe'), { MYRTA_BROWSER: 'D:\\x\\chrome.exe' })).toBe('D:\\x\\chrome.exe');
  });
  test('指定的路径不存在：报错而不是悄悄换一个', () => {
    expect(() => findBrowser('win32', () => false, { MYRTA_BROWSER: 'D:\\nope.exe' })).toThrow('MYRTA_BROWSER');
  });
  test('Mac', () => {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(findBrowser('darwin', only(p), {})).toBe(p);
  });
});

describe('启动参数', () => {
  test('固定英文：--lang 和 --accept-lang 都要有', () => {
    const a = launchArgs(9333, '/tmp/p');
    expect(a).toContain('--lang=en-AU');
    expect(a).toContain('--accept-lang=en-AU,en');
    expect(a).toContain('--remote-debugging-port=9333');
    expect(a).toContain('--user-data-dir=/tmp/p');
    expect(a).toContain('--no-first-run');
  });
  test('只监听本机，不开放调试端口给局域网', () => {
    expect(launchArgs(9333, '/tmp/p')).toContain('--remote-debugging-address=127.0.0.1');
  });
  test('环境变量里语言也设成英文', () => {
    expect(launchEnv({ PATH: '/bin', LANG: 'zh_CN.UTF-8' })).toMatchObject({ PATH: '/bin', LANG: 'en_AU.UTF-8', LC_ALL: 'en_AU.UTF-8' });
  });
});

describe('languageOk', () => {
  test('en-AU,en 通过', () => expect(languageOk(['en-AU', 'en'])).toBe(true));
  test('en-AU 开头就行', () => expect(languageOk(['en-AU'])).toBe(true));
  test('中文不行', () => {
    expect(languageOk(['zh-CN', 'zh'])).toBe(false);
    expect(languageOk([])).toBe(false);
  });
});
