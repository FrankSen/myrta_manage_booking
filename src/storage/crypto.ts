import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ALGO = 'aes-256-gcm';

/** 读取密钥文件；不存在就生成 32 字节随机密钥并写入（仅当前用户可读） */
export function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error(`密钥文件长度不对: ${path}`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows 上忽略 */ }
  return key;
}

/** 加密成 "iv.tag.密文"（均为 base64） */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(token: string, key: Buffer): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('密文格式不对');
  const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
