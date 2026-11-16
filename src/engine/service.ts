import type { Settings } from '../config/settings.ts';
import { isBookable } from '../domain/matcher.ts';
import type { CentreIndex } from '../domain/types.ts';
import type { Clock } from '../scheduler/clock.ts';
import type { Limiter } from '../scheduler/limiter.ts';
import { Scheduler } from '../scheduler/queue.ts';
import type { SiteSession } from '../site/session.ts';
import type { Repo, StudentStatus } from '../storage/repo.ts';
import { expectedCycleMs } from '../config/interval.ts';
import { checkStudent, newCheckState, reportError, rebookSlot, visitsPerRound, type CheckDeps, type NotifyEvent } from './checker.ts';

export interface ServiceDeps {
  repo: Repo;
  clock: Clock;
  limiter: Pick<Limiter, 'acquire' | 'reportBlocked' | 'reportOk'>;
  settings: Settings;
  centres: CentreIndex;
  /** 为某个学员创建站点会话（打开独立浏览器） */
  openSession(studentId: number): Promise<SiteSession>;
  notify(event: NotifyEvent): void;
  random?: () => number;
  /** 全局刷新间隔改了之后保存，返回前不应抛错以外的异常 */
  saveGlobalInterval?: (ms: number) => void;
}

export interface Progress {
  running: boolean;
  /** 下一轮开始的时刻；正在跑时为 null */
  nextAt: number | null;
  /** 正在跑时在做什么 */
  phase: string;
}

/**
 * success：改约成功；dry_run：自动改约关闭，停在确认页；
 * gone：考位已经不在了；not_open：这个待确认考位已处理过；
 * failed：提交时被别人抢走；error：出错，已暂停或退避
 */
export type AcceptResult = 'success' | 'dry_run' | 'gone' | 'not_open' | 'failed' | 'error';

const STARTABLE: StudentStatus[] = ['idle', 'paused', 'stopped', 'pending_confirm', 'running'];

export class Service {
  private readonly deps: ServiceDeps;
  private readonly scheduler: Scheduler;
  private readonly sessions = new Map<number, SiteSession>();
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly state = newCheckState();
  private readonly abort = new AbortController();
  private readonly phases = new Map<number, string>();
  private globalIntervalMs: number;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.globalIntervalMs = deps.settings.hidden.checkIntervalMs;
    this.scheduler = new Scheduler(deps.clock, deps.settings.hidden, (id) => this.runCheck(id), deps.random, (id) => this.intervalFor(id));
  }

  /** 开始为学员刷新。超过上限或学员已完成时返回 false，状态不变。resume 为 true 时（程序重启后继续）不清零轮数 */
  startStudent(id: number, resume = false): boolean {
    const s = this.deps.repo.getStudent(id);
    if (!s || !STARTABLE.includes(s.status)) return false;
    if (this.scheduler.activeIds().includes(id)) return true;
    const before = { status: s.status, note: s.statusNote };
    this.deps.repo.setStatus(id, 'running', '');
    if (!this.scheduler.start(id)) {
      this.deps.repo.setStatus(id, before.status, before.note);
      return false;
    }
    if (!resume) this.deps.repo.resetRounds(id);
    return true;
  }

  /** 学员的刷新间隔：单独设置的优先，否则用全局设置 */
  intervalFor(id: number): number {
    return this.deps.repo.getStudent(id)?.intervalMs ?? this.globalIntervalMs;
  }

  /** 学员一轮要访问站点几次 */
  visits(id: number): number {
    const s = this.deps.repo.getStudent(id);
    return s ? visitsPerRound(s.target.centreIds, this.deps.settings.tolerance, this.deps.centres) : 0;
  }

  /**
   * 预计每隔多久真正刷新一次（毫秒）。学员没在刷新时，按"加上它之后"估算。
   * 正在刷新的学员越多、考点越多，排队越久，比设定间隔慢
   */
  expectedCycle(id: number): number {
    const active = new Set(this.scheduler.activeIds());
    active.add(id);
    let total = 0;
    for (const a of active) total += this.visits(a);
    return expectedCycleMs({ intervalMs: this.intervalFor(id), ownVisits: this.visits(id), totalVisits: total, gapMs: this.deps.settings.hidden.globalMinGapMs });
  }

  globalInterval(): number {
    return this.globalIntervalMs;
  }

  setGlobalInterval(ms: number): void {
    this.globalIntervalMs = ms;
    this.deps.saveGlobalInterval?.(ms);
    for (const id of this.scheduler.activeIds()) this.scheduler.reschedule(id);
  }

  /** ms 为 null 表示改回用全局设置 */
  setStudentInterval(id: number, ms: number | null): void {
    this.deps.repo.setInterval(id, ms);
    this.scheduler.reschedule(id);
  }

  progress(id: number): Progress | null {
    const info = this.scheduler.info(id);
    if (!info) return null;
    return { running: info.running, nextAt: info.nextAt, phase: info.running ? (this.phases.get(id) ?? '') : '' };
  }

  pauseStudent(id: number): void {
    const s = this.deps.repo.getStudent(id);
    if (!s || s.status === 'done') return;
    this.scheduler.stop(id);
    this.deps.repo.setStatus(id, 'paused', '教练手动暂停');
    void this.withLock(id, () => this.dropSession(id));
  }

  /** 程序重启后，把上次还在运行的学员重新启动 */
  resumeAll(): void {
    for (const s of this.deps.repo.listStudents()) {
      if (s.status === 'running') this.startStudent(s.id, true);
    }
  }

  dismissOffer(offerId: number): void {
    this.deps.repo.setOfferState(offerId, 'dismissed');
  }

  /**
   * 教练确认一个"接近"的考位：重新读取该考点，考位还在才改。
   * 同一学员同一时刻只有一个操作，和定时检查互斥。
   */
  acceptOffer(offerId: number): Promise<AcceptResult> {
    const offer = this.deps.repo.getOffer(offerId);
    if (!offer) return Promise.resolve('not_open');
    return this.withLock(offer.studentId, () => this.doAccept(offerId));
  }

  /**
   * 程序退出。先关浏览器：正在进行的页面操作会立刻失败结束，而不是等页面超时（最长 90 秒）。
   * Windows 上直接关掉命令行窗口后只有几秒时间收尾。学员状态保持不变，重启后继续
   */
  async stopAll(): Promise<void> {
    this.abort.abort();
    for (const id of this.scheduler.activeIds()) this.scheduler.stop(id);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.dropSession(id)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.locks.values()]),
      new Promise((r) => (timer = setTimeout(r, 3000))),
    ]);
    clearTimeout(timer);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.dropSession(id)));
  }

  activeIds(): number[] {
    return this.scheduler.activeIds();
  }

  // ---- 内部 ----

  private checkDeps(): CheckDeps {
    const d = this.deps;
    return {
      repo: d.repo,
      limiter: d.limiter,
      clock: d.clock,
      signal: this.abort.signal,
      getSession: (id) => this.getSession(id),
      dropSession: (id) => this.dropSession(id),
      tolerance: d.settings.tolerance,
      centres: d.centres,
      autoRebookEnabled: d.settings.autoRebookEnabled,
      notify: (e) => d.notify(e),
      state: this.state,
      onPhase: (id, p) => this.phases.set(id, p),
    };
  }

  private runCheck(id: number): Promise<void> {
    return this.withLock(id, async () => {
      this.phases.set(id, '准备');
      let outcome;
      try {
        outcome = await checkStudent(id, this.checkDeps());
      } finally {
        this.phases.delete(id);
      }
      // 只要这一轮跑过（没有因为退出而中断），就算一轮
      if (!this.abort.signal.aborted && this.deps.repo.getStudent(id)) this.deps.repo.countRound(id, this.deps.clock.now());
      if (outcome === 'stop') {
        this.scheduler.stop(id);
        await this.dropSession(id);
      }
    });
  }

  private async doAccept(offerId: number): Promise<AcceptResult> {
    const { repo, clock, limiter } = this.deps;
    const offer = repo.getOffer(offerId);
    const student = offer && repo.getStudent(offer.studentId);
    if (!offer || !student || offer.state !== 'open' || student.status === 'done') return 'not_open';

    const slot = { centreId: offer.centreId, date: offer.date, time: offer.time };
    if (!isBookable(slot, clock.now())) {
      repo.setOfferState(offerId, 'gone');
      return 'gone';
    }

    const deps = this.checkDeps();
    try {
      const session = await this.getSession(student.id);
      repo.setCurrent(student.id, await session.login(student.bookingId, student.surname));
      await limiter.acquire(this.abort.signal);
      const listed = await session.listSlots(offer.centreId, offer.date, offer.date);
      limiter.reportOk();
      if (!listed.some((s) => s.centreId === slot.centreId && s.date === slot.date && s.time === slot.time)) {
        repo.setOfferState(offerId, 'gone');
        return 'gone';
      }
      repo.setOfferState(offerId, 'accepted');
      await rebookSlot(student, slot, session, deps);
    } catch (err) {
      if (this.abort.signal.aborted) return 'error';
      await reportError(student, err, deps);
      if (repo.getStudent(student.id)!.status !== 'running') this.scheduler.stop(student.id);
      return 'error';
    }

    const status = repo.getStudent(student.id)!.status;
    if (status === 'done' || status === 'pending_confirm') {
      this.scheduler.stop(student.id);
      await this.dropSession(student.id);
      return status === 'done' ? 'success' : 'dry_run';
    }
    repo.setOfferState(offerId, 'gone');
    return 'failed';
  }

  private async getSession(id: number): Promise<SiteSession> {
    // 退出过程中不再打开新的浏览器
    if (this.abort.signal.aborted) throw new Error('程序正在退出');
    let s = this.sessions.get(id);
    if (!s) {
      s = await this.deps.openSession(id);
      // 浏览器启动要十几秒，期间可能已经开始退出
      if (this.abort.signal.aborted) {
        await s.close().catch(() => {});
        throw new Error('程序正在退出');
      }
      this.sessions.set(id, s);
    }
    return s;
  }

  private async dropSession(id: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      await s.close();
    } catch {
      // 关闭失败不影响流程
    }
  }

  /** 同一学员的操作排队执行，保证不会两个流程同时操作同一个浏览器 */
  private withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }
}
