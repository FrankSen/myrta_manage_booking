import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Repo } from '../storage/repo.ts';
import { checkLicense, type LicenseState } from './license.ts';

const LAST_SEEN = 'license.lastSeen';

/** 授权检查：读授权文件、记录见过的最晚时间。每次调用 state() 都按当前时间重新判断 */
export class LicenseGate {
  private readonly path: string;
  private readonly repo: Repo;
  private readonly now: () => number;
  private readonly publicKey: string | undefined;

  constructor(opts: { path: string; repo: Repo; now: () => number; publicKey?: string }) {
    this.path = opts.path;
    this.repo = opts.repo;
    this.now = opts.now;
    this.publicKey = opts.publicKey;
  }

  state(): LicenseState {
    const now = this.now();
    const lastSeen = Number(this.repo.getMeta(LAST_SEEN) ?? 0);
    const text = existsSync(this.path) ? readFileSync(this.path, 'utf8') : null;
    const s = checkLicense(text, now, lastSeen, this.publicKey);
    // 时间被调回时不更新，否则调回去再调回来就绕过了
    if (s.ok || s.reason !== 'clock_back') {
      if (now > lastSeen) this.repo.setMeta(LAST_SEEN, String(now));
    }
    return s;
  }

  ok(): boolean {
    return this.state().ok;
  }

  /** 导入授权文件内容。有效（未过期）才保存，返回导入后的状态 */
  import(text: string): LicenseState {
    const s = checkLicense(text, this.now(), Number(this.repo.getMeta(LAST_SEEN) ?? 0), this.publicKey);
    if (s.ok) {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.path);
    }
    return s;
  }
}
