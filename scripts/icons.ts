// 由 src/ui/public/logo.svg 生成应用图标：assets/icon.png（512）、icon.ico（Windows）、icon.icns（Mac）。
// 生成结果入库，打包时不再转换。需要本机 Chrome（渲染 SVG）；icns 需要 macOS 的 iconutil。
//   node scripts/icons.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { realFindBrowser } from '../src/site/browser.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'assets');
mkdirSync(out, { recursive: true });
const svg = readFileSync(join(root, 'src', 'ui', 'public', 'logo.svg'), 'utf8');

const browser = await chromium.launch({ executablePath: realFindBrowser(), headless: true });
const render = async (size: number): Promise<Buffer> => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
};

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const png = new Map<number, Buffer>();
for (const s of sizes) png.set(s, await render(s));
await browser.close();

writeFileSync(join(out, 'icon.png'), png.get(512)!);

// ICO：每个尺寸直接放 PNG（Vista 以后都支持）
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
const entries: Buffer[] = [];
const images: Buffer[] = [];
let offset = 6 + 16 * icoSizes.length;
for (const s of icoSizes) {
  const data = png.get(s)!;
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); // 色彩平面
  e.writeUInt16LE(32, 6); // 位深
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(e);
  images.push(data);
}
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));

// ICNS：iconutil 要求 .iconset 目录里固定的文件名
if (process.platform === 'darwin') {
  const tmp = mkdtempSync(join(tmpdir(), 'icon-'));
  const set = join(tmp, 'icon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), png.get(s)!);
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), png.get(s * 2)!);
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(out, 'icon.icns')]);
  rmSync(tmp, { recursive: true, force: true });
} else {
  console.log('不是 macOS，跳过 icon.icns');
}
console.log(`图标已生成：${out}`);
