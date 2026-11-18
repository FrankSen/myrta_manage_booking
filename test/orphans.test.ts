import { describe, expect, test } from 'vitest';
import { cleanupOrphans, findOrphans } from '../src/site/orphans.ts';

const WIN_ROOT = 'C:\\Users\\w\\AppData\\Roaming\\MyRTA Rebook\\browser-profile';

describe('findOrphans', () => {
  test('Windows：大小写和斜杠不同也认得；带引号的参数也认得', () => {
    const procs = [
      { pid: 10, command: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=5000 "--user-data-dir=C:\\Users\\w\\AppData\\Roaming\\MyRTA Rebook\\browser-profile/1" about:blank' },
      { pid: 11, command: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer "--user-data-dir=c:\\users\\w\\appdata\\roaming\\myrta rebook\\browser-profile\\probe"' },
      { pid: 12, command: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" "--user-data-dir=C:\\Users\\w\\AppData\\Roaming\\MyRTA Rebook\\browser-profile\\pending-1"' },
    ];
    expect(findOrphans(procs, WIN_ROOT, 'win32', 1)).toEqual([10, 11, 12]);
  });

  test('教练自己的浏览器、别的资料目录、本软件界面窗口都不动', () => {
    const procs = [
      { pid: 20, command: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' },
      { pid: 21, command: 'chrome.exe "--user-data-dir=C:\\Users\\w\\AppData\\Local\\Google\\Chrome\\User Data"' },
      { pid: 22, command: '"MyRTA Rebook.exe" "--user-data-dir=C:\\Users\\w\\AppData\\Roaming\\MyRTA Rebook\\ui-session"' },
      // 前缀相同但不是这个目录
      { pid: 23, command: 'chrome.exe "--user-data-dir=C:\\Users\\w\\AppData\\Roaming\\MyRTA Rebook\\browser-profile-old\\1"' },
    ];
    expect(findOrphans(procs, WIN_ROOT, 'win32', 1)).toEqual([]);
  });

  test('Mac 区分大小写；不包括自己', () => {
    const root = '/Users/a/Library/Application Support/MyRTA Rebook/browser-profile';
    const procs = [
      { pid: 30, command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${root}/2 about:blank` },
      { pid: 31, command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${root.toLowerCase()}/2` },
      { pid: 32, command: `x --user-data-dir=${root}/3` },
    ];
    expect(findOrphans(procs, root, 'darwin', 32)).toEqual([30]);
  });
});

describe('cleanupOrphans', () => {
  test('逐个结束找到的进程，返回数量', async () => {
    const killed: number[] = [];
    const n = await cleanupOrphans(WIN_ROOT, {
      platform: 'win32',
      list: async () => [
        { pid: 40, command: `chrome.exe --user-data-dir=${WIN_ROOT}\\1` },
        { pid: 41, command: 'chrome.exe' },
      ],
      kill: async (pid) => void killed.push(pid),
    });
    expect(n).toBe(1);
    expect(killed).toEqual([40]);
  });

  test('拿不到进程列表时什么都不做', async () => {
    expect(await cleanupOrphans(WIN_ROOT, { list: async () => [], kill: async () => { throw new Error('不应调用'); } })).toBe(0);
  });
});
