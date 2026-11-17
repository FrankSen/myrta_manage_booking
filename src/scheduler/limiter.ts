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
  /** 退避到什么时候；0 表示没有在退避 */
  private blockedUntil = 0;

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

  /**
   * 正在退避时等到退避结束；没在退避就立刻返回。不占访问间隔。
   * 登录、开浏览器之前调用：被拦后连登录页也不能碰，否则会延长拦截
   */
  async waitBackoff(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const wait = this.blockedUntil - this.clock.now();
      if (wait <= 0) return;
      await this.clock.sleep(wait, signal);
    }
  }

  /** 退避结束的时刻；没在退避时为 null */
  backoffUntil(): number | null {
    return this.blockedUntil > this.clock.now() ? this.blockedUntil : null;
  }

  /** 现在申请的话要等多久（排队加退避） */
  waitLeft(): number {
    return Math.max(0, this.nextFree - this.clock.now());
  }

  /** 被拦截：整体退避，返回本次退避时长 */
  reportBlocked(): number {
    const now = this.clock.now();
    // 同一次拦截里别的学员也碰上了（退避开始前已经在访问）：不再翻倍
    if (this.blockedUntil > now) return this.blockedUntil - now;
    const wait = Math.min(this.s.backoffBaseMs * 2 ** this.blockedStreak, this.s.backoffMaxMs);
    this.blockedStreak++;
    this.blockedUntil = now + wait;
    this.nextFree = Math.max(this.nextFree, this.blockedUntil);
    return wait;
  }

  reportOk(): void {
    this.blockedStreak = 0;
  }
}
