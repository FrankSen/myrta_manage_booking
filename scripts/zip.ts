import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * 把一个文件夹打成 zip（文件夹本身作为顶层目录）。
 * 文件名按 UTF-8 写入并设置 UTF-8 标志位（0x800），Windows 解压中文文件名才不会乱码。
 * macOS 自带的 zip 和 ditto 都不设这个标志。不支持单个文件超过 4GB（这里用不到）。
 * 同时记录 Unix 权限：Mac 版 .app 里的可执行文件解压后要保持可执行。
 * 符号链接按 Unix 约定保存（类型 0o120000，内容是链接目标）：Mac 的 .app 框架里有很多，展开成文件会坏掉签名结构、体积翻倍。
 * 超过 4GB 用 ZIP64，这里用不到，所以不支持。
 */
export function zipDir(dir: string, out: string): number {
  const base = join(dir, '..');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // DOS 时间用打包时的本地时间
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const name = Buffer.from(relative(base, file).split(sep).join('/'), 'utf8');
    const st = lstatSync(file);
    const link = st.isSymbolicLink();
    const data = link ? Buffer.from(readlinkSync(file), 'utf8') : readFileSync(file);
    const mode = st.mode & 0o777;
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    // 高字节 3 = Unix，这样解压程序才会读外部属性里的权限
    cen.writeUInt16LE((3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    // 外部属性高 16 位放 Unix 文件类型和权限（普通文件 0o100000，符号链接 0o120000）
    cen.writeUInt32LE((((link ? 0o120000 : 0o100000) | mode) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }

  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(out, Buffer.concat([...chunks, ...central, end]));
  return files.length;
}
