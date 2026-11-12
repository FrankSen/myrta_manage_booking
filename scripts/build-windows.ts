// 生成 Windows 版：一个文件夹，双击"启动.bat"即可运行，不需要安装 Node。
//   node scripts/build-windows.ts
// 输出：release/myrta-rebook/ 和 release/myrta-rebook-<版本>-win-x64.zip
// node.exe 用 curl 下载（Windows 10 以上和 macOS 都自带），用官方 SHASUMS256 校验，缓存在 release/cache/，下次不再下载。
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDir } from './zip.ts';

const NODE_VERSION = 'v24.14.0';
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
// 各源速度差别大而且会变（镜像有时 8MB/s，有时只有 20KB/s），按顺序试，太慢就换下一个。
// 内容完全相同，所以可以接着上一个源没下完的部分续传；最后统一用官方校验和核对
const NODE_SOURCES = [
  `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`,
  `https://cdn.npmmirror.com/binaries/node/${NODE_VERSION}/${NODE_ZIP}`,
  `https://mirrors.ustc.edu.cn/node/${NODE_VERSION}/${NODE_ZIP}`,
];
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const releaseDir = join(root, 'release');
const cacheDir = join(releaseDir, 'cache');
const outDir = join(releaseDir, 'myrta-rebook');
const appDir = join(outDir, 'app');

async function download(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function nodeZip(): Promise<string> {
  const path = join(cacheDir, NODE_ZIP);
  const sums = (await download(SHASUMS_URL, 60_000)).toString('utf8');
  const expected = new RegExp(`^([0-9a-f]{64})\\s+${NODE_ZIP.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
  if (!expected) throw new Error(`SHASUMS256.txt 里没有 ${NODE_ZIP}`);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  if (existsSync(path) && sha(readFileSync(path)) === expected) return path;
  mkdirSync(cacheDir, { recursive: true });
  const part = `${path}.part`;
  // 上次已经下完但没来得及改名：续传时服务器会报范围错误，所以先查一次
  if (existsSync(part) && sha(readFileSync(part)) === expected) {
    renameSync(part, path);
    return path;
  }
  for (const url of NODE_SOURCES) {
    console.log(`下载 ${url}`);
    try {
      // -C - 续传；连续 30 秒低于 100KB/s 就放弃这个源
      execFileSync('curl', ['-fL', '-C', '-', '--retry', '2', '--speed-limit', '100000', '--speed-time', '30', '-o', part, url], { stdio: 'inherit' });
    } catch {
      console.log('这个源太慢或失败，换下一个');
      continue;
    }
    if (sha(readFileSync(part)) !== expected) {
      rmSync(part, { force: true });
      throw new Error('node 压缩包校验失败，已删除，没有使用');
    }
    renameSync(part, path);
    return path;
  }
  throw new Error('所有下载源都失败了。可以稍后重试，已下载的部分会续传');
}

/** package-lock 里非开发依赖的包目录 */
function productionPackages(): string[] {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean; optional?: boolean }>;
  };
  return Object.entries(lock.packages)
    .filter(([k, v]) => k.startsWith('node_modules/') && !v.dev)
    .map(([k]) => k);
}

// 换行用 CRLF；chcp 65001 让命令行按 UTF-8 显示中文。
// 运行时数据放在 app 外面，升级时只替换 app 和 node 文件夹，学员数据不丢
const BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'set "MYRTA_RUNTIME_DIR=%~dp0runtime"',
  '"%~dp0node\\node.exe" --disable-warning=ExperimentalWarning "%~dp0app\\src\\main.ts"',
  'if errorlevel 1 pause',
  '',
].join('\r\n');

const zip = await nodeZip();
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'node'), { recursive: true });

// Windows 10 以上和 macOS 自带的 tar 都能解 zip
const tmp = join(cacheDir, 'unpack');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
execFileSync('tar', ['-xf', zip, '-C', tmp, `node-${NODE_VERSION}-win-x64/node.exe`, `node-${NODE_VERSION}-win-x64/LICENSE`]);
cpSync(join(tmp, `node-${NODE_VERSION}-win-x64`), join(outDir, 'node'), { recursive: true });
rmSync(tmp, { recursive: true, force: true });

cpSync(join(root, 'src'), join(appDir, 'src'), { recursive: true });
cpSync(join(root, 'data'), join(appDir, 'data'), { recursive: true, filter: (p) => !p.includes(`${join(root, 'data', 'local')}`) });
cpSync(join(root, 'package.json'), join(appDir, 'package.json'));
const pkgs = productionPackages();
for (const p of pkgs) cpSync(join(root, p), join(appDir, p), { recursive: true });
writeFileSync(join(outDir, '启动.bat'), BAT);
const guide = join(root, 'docs', 'user-guide.md');
if (existsSync(guide)) writeFileSync(join(outDir, '使用手册.txt'), readFileSync(guide, 'utf8').replace(/\r?\n/g, '\r\n'));

console.log(`已生成 ${outDir}（依赖：${pkgs.map((p) => p.replace('node_modules/', '')).join(', ')}）`);

const archive = join(releaseDir, `myrta-rebook-${pkg.version}-win-x64.zip`);
const n = zipDir(outDir, archive);
console.log(`已打包 ${archive}（${n} 个文件）`);
