export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function abortError(): Error {
  return new Error('aborted');
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

interface Sleeper {
  at: number;
  seq: number;
  resolve: () => void;
}

/** 测试用时钟：时间只在 advance 时前进，到期的 sleep 按顺序唤醒 */
export class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private sleepers: Sleeper[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const s: Sleeper = { at: this.t + ms, seq: this.seq++, resolve };
      this.sleepers.push(s);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((x) => x !== s);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  /** 时间前进 ms，期间到期的 sleep 依次唤醒；每次唤醒后让出事件循环，让后续异步逻辑跑完 */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await this.flush();
    for (;;) {
      const due = this.sleepers.filter((s) => s.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.sleepers = this.sleepers.filter((s) => s !== due);
      this.t = Math.max(this.t, due.at);
      due.resolve();
      await this.flush();
    }
    this.t = target;
    await this.flush();
  }

  private async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
}
