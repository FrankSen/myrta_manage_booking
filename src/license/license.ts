import { createPublicKey, verify } from 'node:crypto';
import { sydneyInstant } from '../domain/time.ts';
import { PUBLIC_KEY_DER_B64 } from './public-key.ts';

/** 授权文件内容。sig 是对 payload() 的 Ed25519 签名（base64） */
export interface License {
  name: string;
  /** 到期日期（悉尼时间，含当天），YYYY-MM-DD */
  until: string;
  issuedAt: string;
  sig: string;
}

export type LicenseState =
  | { ok: true; name: string; until: string; expiresAt: number }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'clock_back'; name?: string; until?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 当前时间比记录过的最晚时间早这么多，认为系统时间被调回 */
export const CLOCK_BACK_TOLERANCE_MS = 60 * 60_000;

export function payload(l: Pick<License, 'name' | 'until' | 'issuedAt'>): Buffer {
  return Buffer.from(`myrta-rebook-license-v1|${l.name}|${l.until}|${l.issuedAt}`, 'utf8');
}

/** 到期时刻：悉尼时间 until 当天结束（次日 00:00） */
export function expiresAt(until: string): number {
  const [y, m, d] = until.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const iso = next.toISOString().slice(0, 10);
  return sydneyInstant(iso, '00:00');
}

/** 解析并校验签名。不合法返回 null */
export function parseLicense(text: string, publicKeyB64: string = PUBLIC_KEY_DER_B64): License | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const name = str('name');
  const until = str('until');
  const issuedAt = str('issuedAt');
  const sig = str('sig');
  if (!name || !until || !issuedAt || !sig || !DATE.test(until) || !DATE.test(issuedAt)) return null;
  const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
  let good = false;
  try {
    good = verify(null, payload({ name, until, issuedAt }), key, Buffer.from(sig, 'base64'));
  } catch {
    good = false;
  }
  return good ? { name, until, issuedAt, sig } : null;
}

/**
 * 判断授权状态。lastSeen 是之前记录过的最晚时间，用来发现系统时间被调回。
 * 顺序：没有文件 → 签名不对 → 时间被调回 → 过期
 */
export function checkLicense(text: string | null, now: number, lastSeen: number, publicKeyB64?: string): LicenseState {
  if (text === null) return { ok: false, reason: 'missing' };
  const l = parseLicense(text, publicKeyB64);
  if (!l) return { ok: false, reason: 'invalid' };
  const at = expiresAt(l.until);
  if (now < lastSeen - CLOCK_BACK_TOLERANCE_MS) return { ok: false, reason: 'clock_back', name: l.name, until: l.until };
  if (now >= at) return { ok: false, reason: 'expired', name: l.name, until: l.until };
  return { ok: true, name: l.name, until: l.until, expiresAt: at };
}
