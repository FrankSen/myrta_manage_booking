import type { Settings } from '../config/settings.ts';
import { evaluate, isBookable } from '../domain/matcher.ts';
import type { CentreIndex } from '../domain/types.ts';
import type { Clock } from '../scheduler/clock.ts';
import type { Limiter } from '../scheduler/limiter.ts';
import { Scheduler } from '../scheduler/queue.ts';
import type { SiteSession } from '../site/session.ts';
import type { Repo, Student, StudentStatus } from '../storage/repo.ts';
import type { BookingInfo, Slot } from '../domain/types.ts';
import { TextError, msg, type Text } from '../i18n.ts';
import { expectedCycleMs } from '../config/interval.ts';
import { checkStudent, newCheckState, reportError, rebookSlot, slotKey, visitsPerRound, type CheckDeps, type NotifyEvent } from './checker.ts';

export interface ServiceDeps {
  repo: Repo;
  clock: Clock;
  limiter: Pick<Limiter, 'acquire' | 'reportBlocked' | 'reportOk'> & Partial<Pick<Limiter, 'waitBackoff' | 'backoffUntil'>>;
  settings: Settings;
  centres: CentreIndex;
  /** 为某个学员创建站点会话（打开独立浏览器） */
  openSession(studentId: number): Promise<SiteSession>;
  notify(event: NotifyEvent): void;
  random?: () => number;
  /** 全局刷新间隔改了之后保存，返回前不应抛错以外的异常 */
  saveGlobalInterval?: (ms: number) => void;
  /** 授权是否有效。无效时到点不访问站点（学员状态不变，续期后自动继续）。默认有效 */
  allowed?: () => boolean;
}

export interface Progress {
  running: boolean;
  /** 下一轮开始的时刻；正在跑时为 null */
  nextAt: number | null;
  /** 正在跑时在做什么 */
  phase: Text;
}

/**
 * success：改约成功；dry_run：自动改约关闭，停在确认页；
 * gone：考位已经不在了；not_open：这个待确认考位已处理过；
 * failed：提交时被别人抢走；error：出错，已暂停或退避
 */
export type AcceptResult = 'success' | 'dry_run' | 'gone' | 'not_open' | 'failed' | 'error';

/**
 * 停在确认页最多保留多久。站点空闲 15 分钟会话失效，留出余量。
 * 期间浏览器窗口在前面，教练可以直接在里面提交
 */
export const HOLD_MS = 10 * 60_000;

/**
 * 结束保留：rebooked 预约已改成所选考位（教练在浏览器里提交了）；resumed 放弃确认页，继续刷新；
 * unchanged 教练说提交了但预约没变，继续刷新；changed 预约变成了别的，已暂停请教练核对；
 * unknown 读不到预约，无法核实，已暂停；not_held 没有在保留
 */
export type HoldResult = 'rebooked' | 'resumed' | 'unchanged' | 'changed' | 'unknown' | 'not_held';
export type HoldEnd = 'abandon' | 'submitted' | 'timeout';

/**
 * 设置让位的结果。ok：已设好（双方开始刷新）；no_student：学员不存在；same：不能让给自己；
 * done：有一方已经改约完成；taken：一对一，有一方已经在别的让位里；no_target：A 还没设目标；
 * unknown_centre：A 的考点不在考点列表里；not_bookable：A 的考位 48 小时内，网站不让改；
 * held：有一方停在确认页，先处理
 */
export type HandoverResult = 'ok' | 'no_student' | 'same' | 'done' | 'taken' | 'no_target' | 'unknown_centre' | 'not_bookable' | 'held';

/** 原考位放出后，过多久再补查一次（站点放回考位可能有延迟） */
export const RELEASE_RECHECK_MS = 60_000;

interface Hold {
  slot: Slot;
  until: number;
  cancel: AbortController;
}

const sameBooking = (a: BookingInfo, b: BookingInfo) => a.centreName.trim().toLowerCase() === b.centreName.trim().toLowerCase() && a.date === b.date && a.time === b.time;

const STARTABLE: StudentStatus[] = ['idle', 'paused', 'stopped', 'pending_confirm', 'running'];

export class Service {
  private readonly deps: ServiceDeps;
  private readonly scheduler: Scheduler;
  private readonly sessions = new Map<number, SiteSession>();
  /** 正在关闭的浏览器。退出时要等它们关完，否则程序先退出，浏览器会留在后台 */
  private readonly closing = new Set<Promise<void>>();
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly state = newCheckState();
  private readonly abort = new AbortController();
  private readonly phases = new Map<number, Text>();
  /** 停在确认页、等教练处理的学员 */
  private readonly holds = new Map<number, Hold>();
  /** 每个学员当前这次操作（一轮检查、确认考位）的中断器。暂停时用它立刻停下 */
  private readonly ops = new Map<number, AbortController>();
  private globalIntervalMs: number;
  private readonly notify: (e: NotifyEvent) => void;
  /** 自动改约开关：开启时完全符合的考位直接提交，关闭时停在确认页等教练。界面上可以随时切换 */
  private autoRebook: boolean;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.notify = (e) => {
      this.onEvent(e);
      deps.notify(e);
    };
    this.globalIntervalMs = deps.settings.hidden.checkIntervalMs;
    this.autoRebook = deps.settings.autoRebookEnabled;
    this.scheduler = new Scheduler(deps.clock, deps.settings.hidden, (id) => this.runCheck(id), deps.random, (id) => this.intervalFor(id));
  }

  /** 开始为学员刷新。超过上限或学员已完成时返回 false，状态不变。resume 为 true 时（程序重启后继续）不清零轮数 */
  startStudent(id: number, resume = false): boolean {
    const s = this.deps.repo.getStudent(id);
    if (!s || !STARTABLE.includes(s.status)) return false;
    // 停在确认页时点"继续"：先放弃确认页（回到查看预约页），再继续刷新
    if (this.holds.has(id)) {
      void this.endHold(id, 'abandon');
      return true;
    }
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
    return s ? visitsPerRound(s.target.centreIds) : 0;
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

  autoRebookEnabled(): boolean {
    return this.autoRebook;
  }

  /** 切换自动改约。下一轮检查起生效，正在进行的一轮按原来的设置 */
  setAutoRebook(enabled: boolean): void {
    this.autoRebook = enabled;
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
    this.cancelHold(id);
    this.scheduler.stop(id);
    this.deps.repo.setStatus(id, 'paused', msg('status.manual_pause'));
    // 立刻停下：中断正在进行的这一轮，并马上关浏览器（正在进行的页面操作随之失败结束），不等这一轮跑完
    this.ops.get(id)?.abort();
    void this.dropSession(id);
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
    // 停在确认页的学员状态保持"已找到"，浏览器随下面一起关掉
    for (const id of [...this.holds.keys()]) this.cancelHold(id);
    for (const id of this.scheduler.activeIds()) this.scheduler.stop(id);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.dropSession(id)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.locks.values()]),
      new Promise((r) => (timer = setTimeout(r, 3000))),
    ]);
    clearTimeout(timer);
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.dropSession(id)));
    // 暂停、出错时开始关闭、还没关完的浏览器
    await Promise.allSettled([...this.closing]);
  }

  activeIds(): number[] {
    return this.scheduler.activeIds();
  }

  /** 正在走改约流程（选位到确认页、提交）的学员。退出程序会打断它们 */
  rebookingIds(): number[] {
    return [...this.phases].filter(([, p]) => typeof p === 'object' && !Array.isArray(p) && p.k === 'phase.confirm').map(([id]) => id);
  }

  /** 全部学员暂停访问网站到什么时候（被拦后退避）；没在退避时为 null */
  backoffUntil(): number | null {
    return this.deps.limiter.backoffUntil?.() ?? null;
  }

  /** 立即为这个学员查一轮，不等刷新间隔。没在刷新或停在确认页时返回 false。仍受全局限速 */
  checkNow(id: number): boolean {
    if (!this.scheduler.activeIds().includes(id) || this.holds.has(id)) return false;
    this.scheduler.runNow(id);
    return true;
  }

  /**
   * 学员 fromId 的预约变了，原考位 old 放回了网站：目标正好包含它、正在刷新的其他学员立刻查一次，
   * 约 1 分钟后再补查一次。返回被触发的学员
   */
  released(fromId: number, old: BookingInfo): number[] {
    const { repo, clock, centres } = this.deps;
    const name = old.centreName.trim().toLowerCase();
    const centre = [...centres.values()].find((c) => c.name.trim().toLowerCase() === name);
    if (!centre) return [];
    const slot = { centreId: centre.id, date: old.date, time: old.time };
    if (!isBookable(slot, clock.now())) return [];
    const who = repo.getStudent(fromId)?.label ?? '';
    const wants = (id: number) => {
      const s = id !== fromId && !this.holds.has(id) ? repo.getStudent(id) : undefined;
      return !!s && s.status === 'running' && evaluate(slot, s.target, this.deps.settings.tolerance, centres, clock.now()).kind === 'exact';
    };
    // 让位：A 指定的 B 还没在刷新（比如被暂停了）时先启动它，启动后马上就会查一轮
    const started = new Set<number>();
    const toId = repo.getStudent(fromId)?.handoverTo ?? null;
    const to = toId === null ? undefined : repo.getStudent(toId);
    if (to && to.status !== 'done' && evaluate(slot, to.target, this.deps.settings.tolerance, centres, clock.now()).kind === 'exact') {
      repo.log(to.id, 'info', msg('log.handover_released', { who, centre: centre.name, date: old.date, time: old.time }), clock.now());
      if (!this.scheduler.activeIds().includes(to.id) && !this.holds.has(to.id) && this.startStudent(to.id, true)) started.add(to.id);
    }
    const ids = this.scheduler.activeIds().filter((id) => wants(id) && !started.has(id));
    for (const id of ids) {
      if (id === toId) {
        this.scheduler.runNow(id);
        continue;
      }
      repo.log(id, 'info', msg('log.released_check', { who, centre: centre.name, date: old.date, time: old.time }), clock.now());
      this.scheduler.runNow(id);
    }
    if (ids.length > 0) {
      clock.sleep(RELEASE_RECHECK_MS, this.abort.signal).then(
        () => {
          for (const id of ids) if (this.scheduler.activeIds().includes(id) && wants(id)) this.scheduler.runNow(id);
        },
        () => {},
      );
    }
    return [...started, ...ids];
  }

  /**
   * 设置让位：A（fromId）改约后，原考位由 B（toId）去抢。一对一。
   * B 的目标固定为 A 现在的考位（考点、日期、时间完全一致），不用另外设置；A 用它自己的目标找新考位。
   * 双方都自动提交（点 Finish），设好后双方开始刷新。toId 为 null 时解除
   */
  setHandover(fromId: number, toId: number | null): HandoverResult {
    const { repo, clock, centres } = this.deps;
    const a = repo.getStudent(fromId);
    if (!a) return 'no_student';
    if (toId === null) {
      const old = a.handoverTo === null ? undefined : repo.getStudent(a.handoverTo);
      if (a.handoverTo !== null) {
        repo.setHandover(fromId, null);
        repo.log(fromId, 'info', msg('log.handover_cleared', { who: old?.label ?? '' }), clock.now());
      }
      return 'ok';
    }
    const b = repo.getStudent(toId);
    if (!b) return 'no_student';
    if (fromId === toId) return 'same';
    if (a.status === 'done' || b.status === 'done') return 'done';
    // 一对一，也不串联（A 不能同时在接别人的让位，B 不能同时在让给别人）
    const bFrom = repo.handoverFrom(toId);
    if ((bFrom && bFrom.id !== fromId) || b.handoverTo !== null || repo.handoverFrom(fromId) || (a.handoverTo !== null && a.handoverTo !== toId)) return 'taken';
    if (a.target.centreIds.length === 0) return 'no_target';
    const name = a.current.centreName.trim().toLowerCase();
    const centre = [...centres.values()].find((c) => c.name.trim().toLowerCase() === name);
    if (!centre) return 'unknown_centre';
    if (!isBookable({ centreId: centre.id, date: a.current.date, time: a.current.time }, clock.now())) return 'not_bookable';
    if (this.holds.has(fromId) || this.holds.has(toId)) return 'held';

    const t = a.current.time;
    repo.updateTarget(toId, { centreIds: [centre.id], dateFrom: a.current.date, dateTo: a.current.date, timeFrom: t, timeTo: t, times: [t] });
    repo.setHandover(fromId, toId);
    const where = { centre: centre.name, date: a.current.date, time: t };
    repo.log(fromId, 'info', msg('log.handover_set_from', { who: b.label, ...where }), clock.now());
    repo.log(toId, 'info', msg('log.handover_set_to', { who: a.label, ...where }), clock.now());
    // B 刚换了目标：正在刷新的话下一轮就按新目标查
    this.startStudent(fromId);
    this.startStudent(toId);
    return 'ok';
  }

  /** 让位的双方自动提交（点 Finish），即使全局自动改约关闭 */
  autoSubmit(id: number): boolean {
    const s = this.deps.repo.getStudent(id);
    return !!s && (s.handoverTo !== null || !!this.deps.repo.handoverFrom(id));
  }

  /** 停在确认页的学员：所选考位和保留到什么时候 */
  holdInfo(id: number): { slot: Slot; until: number } | null {
    const h = this.holds.get(id);
    return h ? { slot: h.slot, until: h.until } : null;
  }

  heldIds(): number[] {
    return [...this.holds.keys()];
  }

  /** 再把确认页的浏览器窗口调到前面（教练不小心最小化了） */
  revealHold(id: number): Promise<boolean> {
    return this.withLock(id, async () => {
      if (!this.holds.has(id)) return false;
      await this.sessions.get(id)?.reveal?.().catch(() => {});
      return true;
    });
  }

  /**
   * 结束保留。不管教练说什么，都重新读取预约来判断结果：
   * 预约变成所选考位就是改好了（教练在浏览器里提交了），否则放弃确认页继续刷新
   */
  endHold(id: number, reason: HoldEnd): Promise<HoldResult> {
    return this.withLock(id, () => this.doEndHold(id, reason));
  }

  // ---- 内部 ----

  /** B 抢到了 A 让出的考位：让位完成，解除 */
  private onEvent(e: NotifyEvent): void {
    if (e.type !== 'rebooked') return;
    const { repo, clock } = this.deps;
    const a = repo.handoverFrom(e.studentId);
    if (!a) return;
    repo.setHandover(a.id, null);
    const b = repo.getStudent(e.studentId);
    repo.log(a.id, 'info', msg('log.handover_done', { who: b?.label ?? '' }), clock.now());
  }

  private async startHold(id: number, slot: Slot): Promise<void> {
    const cancel = new AbortController();
    this.holds.set(id, { slot, until: this.deps.clock.now() + HOLD_MS, cancel });
    await this.sessions.get(id)?.reveal?.().catch(() => {});
    this.deps.clock.sleep(HOLD_MS, cancel.signal).then(
      () => void this.endHold(id, 'timeout'),
      () => {},
    );
  }

  private cancelHold(id: number): void {
    const h = this.holds.get(id);
    if (!h) return;
    h.cancel.abort();
    this.holds.delete(id);
  }

  private async doEndHold(id: number, reason: HoldEnd): Promise<HoldResult> {
    const { repo, clock } = this.deps;
    const h = this.holds.get(id);
    if (!h) return 'not_held';
    this.cancelHold(id);
    const student = repo.getStudent(id);
    if (!student) {
      await this.dropSession(id);
      return 'not_held';
    }
    const centre = this.deps.centres.get(h.slot.centreId)?.name ?? '';
    const where = { centre, date: h.slot.date, time: h.slot.time };
    const session = this.sessions.get(id);

    // 回到查看预约页，读取当前预约（也就离开了确认页）。用 login：能后退就后退，
    // 教练在浏览器里提交后停在完成页、后退不回去时，重新登录读取。
    // 网站正在退避时不碰网站：放弃就直接关浏览器；教练说已提交的，等退避结束再读
    let after: BookingInfo | null = null;
    try {
      if (session && reason !== 'submitted' && this.deps.limiter.backoffUntil?.()) throw new Error('backoff');
      if (session) await this.deps.limiter.waitBackoff?.(this.abort.signal);
      if (session) after = await session.login(student.bookingId, student.surname);
    } catch {
      after = null;
    }

    if (!after) {
      await this.dropSession(id);
      if (reason === 'submitted') {
        // 教练说提交了，却读不到预约：不能当作没改，也不能当作改好了
        const note = msg('status.hold_unknown', where);
        repo.setStatus(id, 'paused', note);
        repo.log(id, 'error', note, clock.now());
        this.notify({ type: 'error', studentId: id, kind: 'finish_unverified', message: note });
        return 'unknown';
      }
    } else if (sameBooking(after, { centreName: centre, ...h.slot })) {
      repo.setCurrent(id, after);
      const to = { centre: after.centreName, date: after.date, time: after.time };
      repo.setStatus(id, 'done', msg('status.rebooked', to));
      repo.log(id, 'info', msg('log.rebooked', to), clock.now());
      this.notify({ type: 'rebooked', studentId: id, to: after });
      this.released(id, student.current);
      await this.dropSession(id);
      return 'rebooked';
    } else if (!sameBooking(after, student.current)) {
      // 预约变了，但不是所选考位：可能教练在浏览器里选了别的。目标可能要重新设置，先暂停
      repo.setCurrent(id, after);
      const note = msg('status.hold_changed', { centre: after.centreName, date: after.date, time: after.time });
      repo.setStatus(id, 'paused', note);
      repo.log(id, 'warn', note, clock.now());
      this.released(id, student.current);
      await this.dropSession(id);
      return 'changed';
    } else {
      await session?.conceal?.().catch(() => {});
    }
    // 教练明确放弃的考位，下次再出现不再停下（超时不算，可能只是人不在）
    if (reason === 'abandon') {
      const set = this.state.skipped.get(id) ?? new Set<string>();
      set.add(slotKey(h.slot));
      this.state.skipped.set(id, set);
    }

    const logKey = reason === 'timeout' ? 'log.hold_timeout' : reason === 'submitted' ? 'log.hold_unchanged' : 'log.hold_abandon';
    repo.log(id, reason === 'submitted' ? 'warn' : 'info', msg(logKey, { ...where, min: HOLD_MS / 60_000 }), clock.now());
    repo.setStatus(id, 'running', '');
    // 刚才回预约页已经访问过网站，下一轮按间隔来，不马上再查
    if (!this.scheduler.start(id, true)) {
      repo.setStatus(id, 'paused', msg('status.hold_no_slot'));
    }
    return reason === 'submitted' ? 'unchanged' : 'resumed';
  }

  /** 开始一次针对学员的操作，返回它的中断信号（退出程序或暂停这个学员时触发） */
  private beginOp(id: number): AbortSignal {
    const ac = new AbortController();
    this.ops.set(id, ac);
    return AbortSignal.any([this.abort.signal, ac.signal]);
  }

  private checkDeps(signal: AbortSignal = this.abort.signal): CheckDeps {
    const d = this.deps;
    return {
      repo: d.repo,
      limiter: d.limiter,
      clock: d.clock,
      signal,
      getSession: (id) => this.getSession(id, signal),
      dropSession: (id) => this.dropSession(id),
      tolerance: d.settings.tolerance,
      centres: d.centres,
      autoRebookEnabled: this.autoRebook,
      notify: (e) => this.notify(e),
      autoSubmit: (id) => this.autoSubmit(id),
      state: this.state,
      onPhase: (id, p) => this.phases.set(id, p),
      onConfirmReady: (id, slot) => this.startHold(id, slot),
      onReleased: (id, old) => void this.released(id, old),
    };
  }

  private runCheck(id: number): Promise<void> {
    return this.withLock(id, async () => {
      if (this.deps.allowed && !this.deps.allowed()) {
        // 试用到期：不访问站点、不算轮数，关掉浏览器；状态保持"刷新中"，续期后下一轮自动继续
        await this.dropSession(id);
        return;
      }
      this.phases.set(id, msg('phase.prepare'));
      const signal = this.beginOp(id);
      let outcome;
      try {
        outcome = await checkStudent(id, this.checkDeps(signal));
      } finally {
        this.phases.delete(id);
        this.ops.delete(id);
      }
      // 只要这一轮跑过（没有因为退出或暂停而中断），就算一轮
      if (!signal.aborted && this.deps.repo.getStudent(id)) this.deps.repo.countRound(id, this.deps.clock.now());
      if (outcome === 'stop') {
        this.scheduler.stop(id);
        await this.dropSession(id);
      }
      // 停在确认页：不再排队，浏览器留给教练
      if (outcome === 'hold') this.scheduler.stop(id);
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

    const signal = this.beginOp(student.id);
    const deps = this.checkDeps(signal);
    try {
      return await this.acceptChecked(offerId, student, slot, deps);
    } finally {
      this.phases.delete(student.id);
      this.ops.delete(student.id);
    }
  }

  private async acceptChecked(offerId: number, student: Student, slot: Slot, deps: CheckDeps): Promise<AcceptResult> {
    const { repo, limiter } = this.deps;
    const offer = repo.getOffer(offerId)!;
    try {
      await limiter.waitBackoff?.(deps.signal);
      const session = await this.getSession(student.id, deps.signal);
      repo.setCurrent(student.id, await session.login(student.bookingId, student.surname));
      await limiter.acquire(deps.signal);
      const listed = await session.listSlots(offer.centreId, offer.date, offer.date);
      limiter.reportOk();
      if (!listed.some((s) => s.centreId === slot.centreId && s.date === slot.date && s.time === slot.time)) {
        repo.setOfferState(offerId, 'gone');
        return 'gone';
      }
      repo.setOfferState(offerId, 'accepted');
      await rebookSlot(student, slot, session, deps);
    } catch (err) {
      if (deps.signal?.aborted) return 'error';
      await reportError(student, err, deps);
      if (repo.getStudent(student.id)!.status !== 'running') this.scheduler.stop(student.id);
      return 'error';
    }

    if (this.holds.has(student.id)) {
      this.scheduler.stop(student.id);
      return 'dry_run';
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

  private async getSession(id: number, signal: AbortSignal = this.abort.signal): Promise<SiteSession> {
    // 退出或暂停过程中不再打开新的浏览器
    if (signal.aborted) throw new TextError(msg('err.exiting'));
    let s = this.sessions.get(id);
    if (!s) {
      s = await this.deps.openSession(id);
      // 浏览器启动要十几秒，期间可能已经开始退出或被暂停
      if (signal.aborted) {
        await s.close().catch(() => {});
        throw new TextError(msg('err.exiting'));
      }
      this.sessions.set(id, s);
    }
    return s;
  }

  private async dropSession(id: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    const p = s.close().catch(() => {
      // 关闭失败不影响流程
    });
    this.closing.add(p);
    try {
      await p;
    } finally {
      this.closing.delete(p);
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
