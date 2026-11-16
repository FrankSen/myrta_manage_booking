// 取 Electron 二进制压缩包：先查本机缓存，没有就从镜像下载，用 SHASUMS256 校验。
// 不用 electron 包自带的 install.js：它只连 GitHub，本机网络下经常卡住。
//   node scripts/electron-bin.ts            准备开发用的 Electron（解压到 node_modules/electron/dist），npm run app 会用到
//   node scripts/electron-bin.ts win-x64    只下载并校验压缩包，打印路径
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ELECTRON_VERSION = '38.7.2';
const root = fileURLToPath(new URL('..', import.meta.url));
const cacheDir = join(root, 'release', 'cache');

export const ELECTRON_PLATFORMS = { 'win-x64': 'win32-x64', 'mac-arm64': 'darwin-arm64', 'mac-x64': 'darwin-x64' } as const;
export type Target = keyof typeof ELECTRON_PLATFORMS;

const MIRRORS = [
  `https://cdn.npmmirror.com/binaries/electron/${ELECTRON_VERSION}/`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/`,
];

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 官方校验和。镜像和 GitHub 的内容一致，哪个能连上用哪个 */
async function shasums(): Promise<string> {
  const local = join(cacheDir, `electron-${ELECTRON_VERSION}-SHASUMS256.txt`);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  for (const m of MIRRORS) {
    try {
      const res = await fetch(`${m}SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const text = await res.text();
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(local, text);
      return text;
    } catch {
      // 换下一个
    }
  }
  throw new Error('取不到 Electron 的 SHASUMS256.txt');
}

/** electron 包自己的下载缓存（~/Library/Caches/electron/<哈希>/ 或 %LOCALAPPDATA%\electron\Cache） */
function systemCaches(): string[] {
  const dirs = [join(homedir(), 'Library', 'Caches', 'electron'), join(homedir(), '.cache', 'electron')];
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    out.push(d);
    for (const sub of readdirSync(d)) out.push(join(d, sub));
  }
  return out;
}

export async function electronZip(target: Target): Promise<string> {
  const name = `electron-v${ELECTRON_VERSION}-${ELECTRON_PLATFORMS[target]}.zip`;
  const expected = new RegExp(`^([0-9a-f]{64}) \\*?${name.replace(/\./g, '\\.')}$`, 'm').exec(await shasums())?.[1];
  if (!expected) throw new Error(`SHASUMS256.txt 里没有 ${name}`);
  const dest = join(cacheDir, name);
  if (existsSync(dest) && sha256(dest) === expected) return dest;
  for (const d of systemCaches()) {
    const p = join(d, name);
    if (existsSync(p) && sha256(p) === expected) return p;
  }
  mkdirSync(cacheDir, { recursive: true });
  const part = `${dest}.part`;
  for (const m of MIRRORS) {
    console.log(`下载 ${m}${name}`);
    try {
      execFileSync('curl', ['-fL', '-C', '-', '--retry', '2', '--speed-limit', '100000', '--speed-time', '30', '-o', part, `${m}${name}`], { stdio: 'inherit' });
    } catch {
      console.log('这个源太慢或失败，换下一个');
      continue;
    }
    if (sha256(part) !== expected) {
      rmSync(part, { force: true });
      throw new Error(`${name} 校验失败，已删除`);
    }
    renameSync(part, dest);
    return dest;
  }
  throw new Error(`所有下载源都失败了：${name}`);
}

/** 解压 zip。用系统自带工具：Mac 上 ditto 能保留 .app 里的符号链接和权限 */
export function unzip(zip: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, dir]);
  else execFileSync('tar', ['-xf', zip, '-C', dir]);
}

function hostTarget(): Target {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  throw new Error(`不支持的开发平台：${process.platform}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv[2] as Target | undefined;
  if (arg) {
    if (!(arg in ELECTRON_PLATFORMS)) throw new Error(`不认识的平台：${arg}`);
    console.log(await electronZip(arg));
  } else {
    // 开发用：放到 electron 包期望的位置，require('electron') 返回的路径就能用
    const pkgDir = join(root, 'node_modules', 'electron');
    const t = hostTarget();
    unzip(await electronZip(t), join(pkgDir, 'dist'));
    writeFileSync(join(pkgDir, 'path.txt'), t === 'win-x64' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron');
    console.log(`Electron ${ELECTRON_VERSION} 已就绪：${join(pkgDir, 'dist')}`);
  }
}
