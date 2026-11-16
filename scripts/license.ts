// 生成试用授权文件。私钥只在开发者本机，绝不放进仓库或安装包。
//   第一次：node scripts/license.ts --init-key
//           生成密钥对到 ~/.myrta-license/（或 MYRTA_LICENSE_KEY 指定的路径），把打印出的公钥写进 src/license/public-key.ts
//   签发：  node scripts/license.ts --name 张教练 --until 2026-12-31 [--out license.json]
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { sydneyDateOf } from '../src/domain/time.ts';
import { parseLicense, payload, type License } from '../src/license/license.ts';

const keyPath = process.env.MYRTA_LICENSE_KEY ?? join(homedir(), '.myrta-license', 'private.pem');
const { values } = parseArgs({
  options: { 'init-key': { type: 'boolean' }, name: { type: 'string' }, until: { type: 'string' }, out: { type: 'string' } },
});

if (values['init-key']) {
  if (existsSync(keyPath)) {
    console.error(`私钥已存在，没有覆盖：${keyPath}`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  console.log(`私钥已保存：${keyPath}（请备份，丢了就无法再签发）`);
  console.log(`公钥（写进 src/license/public-key.ts）：\n${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`);
  process.exit(0);
}

const name = values.name?.trim();
const until = values.until;
if (!name || !until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
  console.error('用法：node scripts/license.ts --name 张教练 --until 2026-12-31 [--out license.json]');
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`找不到私钥 ${keyPath}，先运行 --init-key`);
  process.exit(1);
}
const key = createPrivateKey(readFileSync(keyPath));
const body = { name, until, issuedAt: sydneyDateOf(Date.now()) };
const license: License = { ...body, sig: sign(null, payload(body), key).toString('base64') };
const text = JSON.stringify(license, null, 2) + '\n';
// 用软件里的公钥核对一遍，防止私钥和公钥对不上
if (!parseLicense(text)) {
  console.error('签好的授权文件用软件里的公钥验证不通过：私钥和 src/license/public-key.ts 不是一对');
  process.exit(1);
}
const out = values.out ?? `license-${name}-${until}.json`;
writeFileSync(out, text);
console.log(`已生成 ${out}：${name}，到 ${until}（悉尼时间当天结束）`);
