import type { HiddenSettings } from '../config/settings.ts';
import type { Clock } from './clock.ts';

interface Entry {
  ac: AbortController;
  running: boolean;
  /** 跑的时候被 runNow 请求过，跑完后补一次 */
  rerun: boolean;
  /** 当前正在等待的下一轮的取消器 */
  timerAc: AbortController | null;
}

/** 每个学员一个循环：跑一轮 → 等 间隔×(1±抖动) → 再跑。受学员上限约束 */
export class Scheduler {
  private readonly clock: Clock;
  private readonly s: HiddenSettings;
  private readonly run: (studentId: number) => Promise<void>;
  private readonly random: () => number;
  private readonly entries = new Map<number, Entry>();

  constructor(clock: Clock, s: HiddenSettings, run: (studentId: number) => Promise<void>, random: () => number = Math.random) {
    this.clock = clock;
    this.s = s;
    this.run = run;
    this.random = random;
  }

  start(studentId: number): boolean {
    if (this.entries.has(studentId)) return true;
    if (this.entries.size >= this.s.maxActiveStudents) return false;
    const e: Entry = { ac: new AbortController(), running: false, rerun: false, timerAc: null };
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

  activeIds(): number[] {
    return [...this.entries.keys()];
  }

  private nextDelay(): number {
    const j = this.s.jitterRatio;
    return Math.round(this.s.checkIntervalMs * (1 - j + 2 * j * this.random()));
  }

  private async loop(id: number, e: Entry): Promise<void> {
    while (!e.ac.signal.aborted) {
      e.running = true;
      try {
        await this.run(id);
      } catch {
        // 错误由调用方记录；调度器本身不能因为一轮失败而停
      }
      e.running = false;
      if (e.ac.signal.aborted) return;
      if (e.rerun) {
        e.rerun = false;
        continue;
      }
      e.timerAc = new AbortController();
      const onStop = () => e.timerAc?.abort();
      e.ac.signal.addEventListener('abort', onStop, { once: true });
      try {
        await this.clock.sleep(this.nextDelay(), e.timerAc.signal);
      } catch {
        // 被 runNow 或 stop 打断，回到循环顶部由 aborted 判断是否退出
      } finally {
        e.ac.signal.removeEventListener('abort', onStop);
        e.timerAc = null;
      }
    }
  }
}
