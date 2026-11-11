import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 单实例锁：同一份数据同时只能有一个程序在刷新，否则两个程序会同时访问站点。
 * 锁文件里存进程号。进程已不存在的旧锁（比如上次断电）会被自动清掉。
 * 返回释放函数；已有实例在运行则抛错。
 */
export function acquireLock(path: string, pid = process.pid): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(pid));
      closeSync(fd);
      return () => {
        try {
          if (Number(readFileSync(path, 'utf8')) === pid) unlinkSync(path);
        } catch {
          // 已被清理
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const other = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(other) && other > 0 && alive(other)) {
        throw new Error(`程序已经在运行（进程 ${other}）。请不要重复打开`);
      }
      unlinkSync(path); // 旧锁，进程已经不在了
    }
  }
  throw new Error('无法获取运行锁');
}
