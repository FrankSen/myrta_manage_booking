// 生成独立应用（Electron）。不用 electron-builder：它还要另外下载很多东西，本机网络慢。
//   node scripts/build.ts            默认 win-x64
//   node scripts/build.ts mac-arm64  Apple 芯片的 Mac
//   node scripts/build.ts mac-x64    Intel 芯片的 Mac
// 输出：release/<平台>/MyRTA Rebook/ 和 release/myrta-rebook-<版本>-<平台>.zip
//   Windows：MyRTA Rebook/MyRTA Rebook.exe（改了图标和版本信息），解压后双击即可，第一次运行会建桌面和开始菜单快捷方式
//   Mac：MyRTA Rebook/MyRTA Rebook.app，未签名，使用手册写了去隔离标记的方法
// 应用代码放在 resources/app/（不打 asar），Electron 直接运行 .ts。运行数据在系统的应用数据目录，和程序分开。
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELECTRON_PLATFORMS, electronZip, unzip, type Target } from './electron-bin.ts';
import { zipDir } from './zip.ts';

const PRODUCT = 'MyRTA Rebook';
const BUNDLE_ID = 'com.myrta.rebook';
const targetName = (process.argv[2] ?? 'win-x64') as Target;
if (!(targetName in ELECTRON_PLATFORMS)) {
  console.error(`不认识的平台：${process.argv[2]}。可选：${Object.keys(ELECTRON_PLATFORMS).join('、')}`);
  process.exit(1);
}
const isWin = targetName === 'win-x64';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
const releaseDir = join(root, 'release');
const outDir = join(releaseDir, targetName, PRODUCT);

/** package-lock 里非开发依赖的包目录 */
function productionPackages(): string[] {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean; optional?: boolean }>;
  };
  return Object.entries(lock.packages)
    .filter(([k, v]) => k.startsWith('node_modules/') && !v.dev)
    .map(([k]) => k);
}

/** 应用代码 → resources/app */
function copyApp(appDir: string): void {
  mkdirSync(appDir, { recursive: true });
  cpSync(join(root, 'src'), join(appDir, 'src'), { recursive: true, filter: (p) => !p.endsWith('.d.ts') || p.includes('public') });
  cpSync(join(root, 'data'), join(appDir, 'data'), { recursive: true, filter: (p) => !p.startsWith(join(root, 'data', 'local')) });
  cpSync(join(root, 'assets'), join(appDir, 'assets'), { recursive: true });
  // 只留运行需要的字段
  const appPkg = { name: 'myrta-rebook', productName: PRODUCT, version: pkg.version, private: true, type: 'module', main: 'src/electron/main.ts', dependencies: pkg.dependencies };
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n');
  for (const p of productionPackages()) cpSync(join(root, p), join(appDir, p), { recursive: true });
}

function guide(): string | null {
  const zh = join(root, 'docs', 'user-guide.md');
  const en = join(root, 'docs', 'user-guide.en.md');
  if (!existsSync(zh)) return null;
  return readFileSync(zh, 'utf8') + (existsSync(en) ? `\n\n---\n\n${readFileSync(en, 'utf8')}` : '');
}

async function buildWindows(): Promise<void> {
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit');
  unzip(await electronZip(targetName), outDir);
  rmSync(join(outDir, 'resources', 'default_app.asar'), { force: true });
  copyApp(join(outDir, 'resources', 'app'));

  // 改 exe 的图标和版本信息（文件属性里看到的名称），然后改名
  const exePath = join(outDir, 'electron.exe');
  const exe = NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const ico = Data.IconFile.from(readFileSync(join(root, 'assets', 'icon.ico')));
  const iconGroups = Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = iconGroups[0]?.id ?? 1;
  const lang = iconGroups[0]?.lang ?? 1033;
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
  const [vi] = Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const v = pkg.version.split('.').map(Number) as [number, number, number];
    vi.setFileVersion(v[0], v[1], v[2], 0, 1033);
    vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
    for (const l of vi.getAllLanguagesForStringValues()) {
      vi.setStringValues(l, {
        FileDescription: PRODUCT,
        ProductName: PRODUCT,
        InternalName: PRODUCT,
        OriginalFilename: `${PRODUCT}.exe`,
        CompanyName: PRODUCT,
        FileVersion: pkg.version,
        ProductVersion: pkg.version,
        LegalCopyright: '',
      });
    }
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  writeFileSync(join(outDir, `${PRODUCT}.exe`), Buffer.from(exe.generate()));
  rmSync(exePath);

  const g = guide();
  // 加 BOM：旧版记事本没有 BOM 会把 UTF-8 当成 GBK，中文乱码
  if (g) writeFileSync(join(outDir, '使用手册 User Guide.txt'), '\uFEFF' + g.replace(/\r?\n/g, '\r\n'));
}

async function buildMac(): Promise<void> {
  unzip(await electronZip(targetName), outDir);
  const app = join(outDir, `${PRODUCT}.app`);
  renameSync(join(outDir, 'Electron.app'), app);
  const res = join(app, 'Contents', 'Resources');
  rmSync(join(res, 'default_app.asar'), { force: true });
  copyApp(join(res, 'app'));
  cpSync(join(root, 'assets', 'icon.icns'), join(res, 'app.icns'));
  rmSync(join(res, 'electron.icns'), { force: true });

  // 改 Info.plist：名称、Bundle ID、版本、图标；去掉 default_app.asar 的完整性校验（已删除该文件）
  const plist = join(app, 'Contents', 'Info.plist');
  const set = (key: string, value: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  set('CFBundleName', PRODUCT);
  set('CFBundleDisplayName', PRODUCT);
  set('CFBundleIdentifier', BUNDLE_ID);
  set('CFBundleShortVersionString', pkg.version);
  set('CFBundleVersion', pkg.version);
  set('CFBundleIconFile', 'app.icns');
  set('LSApplicationCategoryType', 'public.app-category.productivity');
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', plist]);
  } catch {
    // 没有这一项
  }
  // 用不到摄像头、麦克风、蓝牙，去掉这些权限说明
  for (const k of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription']) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${k}`, plist]);
    } catch {
      // 没有这一项
    }
  }
  // 改了 Info.plist 和资源，原来的签名失效。Apple 芯片的 Mac 不允许运行没有签名的程序，重新做本机临时签名（不是开发者签名）
  if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
  const g = guide();
  if (g) writeFileSync(join(outDir, '使用手册 User Guide.txt'), g);
}

if (!isWin && process.platform !== 'darwin') {
  console.error('Mac 版只能在 macOS 上打包（要用 PlistBuddy 和 codesign）');
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
if (isWin) await buildWindows();
else await buildMac();
console.log(`已生成 ${outDir}`);

const archive = join(releaseDir, `myrta-rebook-${pkg.version}-${targetName}.zip`);
const n = zipDir(outDir, archive);
console.log(`已打包 ${archive}（${n} 个文件）`);
