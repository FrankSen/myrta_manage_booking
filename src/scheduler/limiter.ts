import type { HiddenSettings } from '../config/settings.ts';
import type { Clock } from './clock.ts';

/**
 * 全局限速：所有学员共用一个出口 IP，所以限速是全局的。
 * 保证任意两次访问至少隔 globalMinGapMs；被站点拦截后整体退避，连续拦截时间翻倍。
 */
export class Limiter {
  private readonly clock: Clock;
  private readonly s: Pick<HiddenSettings, 'globalMinGapMs' | 'backoffBaseMs' | 'backoffMaxMs'>;
  /** 下一个可以放行的时刻 */
  private nextFree = 0;
  private blockedStreak = 0;

  constructor(clock: Clock, s: Pick<HiddenSettings, 'globalMinGapMs' | 'backoffBaseMs' | 'backoffMaxMs'>) {
    this.clock = clock;
    this.s = s;
  }

  /** 等到可以访问为止。排队：每个调用占一个时间槽 */
  async acquire(signal?: AbortSignal): Promise<void> {
    const slot = Math.max(this.nextFree, this.clock.now());
    this.nextFree = slot + this.s.globalMinGapMs;
    const wait = slot - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait, signal);
    else if (signal?.aborted) throw new Error('aborted');
  }

  /** 被拦截：整体退避，返回本次退避时长 */
  reportBlocked(): number {
    const wait = Math.min(this.s.backoffBaseMs * 2 ** this.blockedStreak, this.s.backoffMaxMs);
    this.blockedStreak++;
    this.nextFree = Math.max(this.nextFree, this.clock.now() + wait);
    return wait;
  }

  reportOk(): void {
    this.blockedStreak = 0;
  }
}
