// 清理遗留的学员浏览器。
// 软件被强行结束（任务管理器结束、闪退、强制关机）时，它启动的 Chrome/Edge 不会跟着退出，
// 一直占着数据目录里的文件：升级时替换、删除文件夹会提示"文件已在另一程序中打开"，下次启动也可能打不开同一个资料目录。
// 判断依据：命令行里 --user-data-dir 指向本软件的 browser-profile 目录。只有本软件会用这个目录，教练自己的浏览器不受影响
import { execFile } from 'node:child_process';

export interface ProcInfo {
  pid: number;
  command: string;
}

/** 统一大小写和斜杠后比较（Windows 路径不区分大小写，程序里拼路径时混用了 / 和 \） */
function norm(s: string, platform: string): string {
  const x = s.replace(/\\/g, '/');
  return platform === 'win32' ? x.toLowerCase() : x;
}

/** 从进程列表里找出用本软件资料目录的浏览器进程 */
export function findOrphans(procs: readonly ProcInfo[], profileRoot: string, platform: string, selfPid = process.pid): number[] {
  const root = norm(profileRoot, platform).replace(/\/+$/, '');
  const needle = `--user-data-dir=${root}/`;
  return procs.filter((p) => p.pid !== selfPid && norm(p.command, platform).includes(needle)).map((p) => p.pid);
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** 列出本机进程和命令行。拿不到时返回空（不影响启动） */
export async function listProcesses(platform: string = process.platform): Promise<ProcInfo[]> {
  try {
    if (platform === 'win32') {
      // 只取 chrome.exe 和 msedge.exe，减少输出
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15_000)).trim();
      if (!out) return [];
      const raw = JSON.parse(out) as { ProcessId: number; CommandLine: string | null } | { ProcessId: number; CommandLine: string | null }[];
      return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ pid: p.ProcessId, command: p.CommandLine ?? '' }));
    }
    const out = await run('ps', ['-axww', '-o', 'pid=,command='], 10_000);
    return out
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ pid: Number(m[1]), command: m[2]! }));
  } catch {
    return [];
  }
}

/** 结束进程及其子进程。Windows 用 taskkill /T，只结束主进程时子进程会留下 */
export async function killTree(pid: number, platform: string = process.platform): Promise<void> {
  try {
    if (platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F'], 10_000);
    else process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出
  }
}

export interface CleanupDeps {
  platform?: string;
  list?: () => Promise<ProcInfo[]>;
  kill?: (pid: number) => Promise<void>;
}

/** 结束所有遗留的学员浏览器，返回结束了几个进程 */
export async function cleanupOrphans(profileRoot: string, deps: CleanupDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const procs = await (deps.list ?? (() => listProcesses(platform)))();
  const pids = findOrphans(procs, profileRoot, platform);
  const kill = deps.kill ?? ((pid: number) => killTree(pid, platform));
  for (const pid of pids) await kill(pid);
  return pids.length;
}
