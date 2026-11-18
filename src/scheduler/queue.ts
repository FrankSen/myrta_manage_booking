import type { HiddenSettings } from '../config/settings.ts';
import type { Clock } from './clock.ts';

interface Entry {
  ac: AbortController;
  running: boolean;
  /** 跑的时候被 runNow 请求过，跑完后补一次 */
  rerun: boolean;
  /** 当前正在等待的下一轮的取消器 */
  timerAc: AbortController | null;
  /** 上一轮结束的时刻 */
  lastEnd: number;
  /** 下一轮的时刻；正在跑时为 null */
  nextAt: number | null;
  /** 本次等待的抖动系数，改间隔时保持不变，避免倒计时跳来跳去 */
  factor: number;
  /** reschedule 打断等待时为 true：按新间隔重新等，而不是立刻跑 */
  rearm: boolean;
  /** 第一轮不立刻跑，先等一个间隔 */
  skipFirst: boolean;
}

export interface ScheduleInfo {
  running: boolean;
  nextAt: number | null;
}

/** 每个学员一个循环：跑一轮 → 等 间隔×(1±抖动) → 再跑。受学员上限约束 */
export class Scheduler {
  private readonly clock: Clock;
  private readonly s: HiddenSettings;
  private readonly run: (studentId: number) => Promise<void>;
  private readonly random: () => number;
  private readonly entries = new Map<number, Entry>();
  private readonly intervalFor: (studentId: number) => number;

  /** intervalFor：每个学员的刷新间隔（毫秒），每次计时都重新读，改了设置立即生效 */
  constructor(
    clock: Clock,
    s: HiddenSettings,
    run: (studentId: number) => Promise<void>,
    random: () => number = Math.random,
    intervalFor?: (studentId: number) => number,
  ) {
    this.clock = clock;
    this.s = s;
    this.run = run;
    this.random = random;
    this.intervalFor = intervalFor ?? (() => this.s.checkIntervalMs);
  }

  /** delayFirst：第一轮也要先等一个间隔（刚访问过网站，比如刚放弃确认页） */
  start(studentId: number, delayFirst = false): boolean {
    if (this.entries.has(studentId)) return true;
    if (this.entries.size >= this.s.maxActiveStudents) return false;
    const e: Entry = { ac: new AbortController(), running: false, rerun: false, timerAc: null, lastEnd: 0, nextAt: null, factor: 1, rearm: false, skipFirst: delayFirst };
    this.entries.set(studentId, e);
    void this.loop(studentId, e);
    return true;
  }

  stop(studentId: number): void {
    const e = this.entries.get(studentId);
    if (!e) return;
    e.ac.abort();
    e.timerAc?.abort();
    this.entries.delete(studentId);
  }

  /** 立刻跑一次并重新计时。正在跑的话，跑完后立刻补一次 */
  runNow(studentId: number): void {
    const e = this.entries.get(studentId);
    if (!e) return;
    if (e.running) e.rerun = true;
    else e.timerAc?.abort();
  }

  /** 间隔改了之后调用：正在等待的话按新间隔重新计时（从上一轮结束算起） */
  reschedule(studentId: number): void {
    const e = this.entries.get(studentId);
    if (!e || e.running || !e.timerAc) return;
    e.rearm = true;
    e.timerAc.abort();
  }

  info(studentId: number): ScheduleInfo | null {
    const e = this.entries.get(studentId);
    return e ? { running: e.running, nextAt: e.running ? null : e.nextAt } : null;
  }

  activeIds(): number[] {
    return [...this.entries.keys()];
  }

  private delayFor(id: number, e: Entry): number {
    return Math.round(this.intervalFor(id) * e.factor);
  }

  private async loop(id: number, e: Entry): Promise<void> {
    while (!e.ac.signal.aborted) {
      if (e.skipFirst) {
        e.skipFirst = false;
      } else {
        e.running = true;
        e.nextAt = null;
        try {
          await this.run(id);
        } catch {
          // 错误由调用方记录；调度器本身不能因为一轮失败而停
        }
        e.running = false;
      }
      e.lastEnd = this.clock.now();
      if (e.ac.signal.aborted) return;
      if (e.rerun) {
        e.rerun = false;
        continue;
      }
      const j = this.s.jitterRatio;
      e.factor = 1 - j + 2 * j * this.random();
      const onStop = () => e.timerAc?.abort();
      e.ac.signal.addEventListener('abort', onStop, { once: true });
      try {
        // 改了间隔会被打断并按新间隔重新等；runNow 或 stop 打断则直接结束等待
        for (;;) {
          e.nextAt = e.lastEnd + this.delayFor(id, e);
          const wait = e.nextAt - this.clock.now();
          if (wait <= 0) break;
          e.timerAc = new AbortController();
          try {
            await this.clock.sleep(wait, e.timerAc.signal);
            break;
          } catch {
            if (!e.rearm || e.ac.signal.aborted) break;
            e.rearm = false;
          }
        }
      } finally {
        e.ac.signal.removeEventListener('abort', onStop);
        e.timerAc = null;
        e.rearm = false;
      }
    }
  }
}
