import type { Clock } from '../scheduler/clock.ts';
import type { Limiter } from '../scheduler/limiter.ts';
import { evaluate, refreshDeadline } from '../domain/matcher.ts';
import { LOCK_MS, addDays, sydneyDateOf, sydneyInstant } from '../domain/time.ts';
import type { BookingInfo, CentreIndex, LocalDate, Slot, Tolerance } from '../domain/types.ts';
import { SiteError, type SiteErrorKind } from '../site/errors.ts';
import type { SiteSession } from '../site/session.ts';
import type { Repo, Student } from '../storage/repo.ts';
import { errorText, msg, type Text } from '../i18n.ts';

export type NotifyEvent =
  | { type: 'offer'; studentId: number; offerId: number }
  | { type: 'rebooked'; studentId: number; to: BookingInfo }
  /** 自动改约关闭时，已走到确认页，没有点 Finish */
  | { type: 'dry_run_ready'; studentId: number; slot: Slot }
  | { type: 'stopped'; studentId: number; reason: Text }
  | { type: 'error'; studentId: number; kind: SiteErrorKind; message: Text };

/** 跨轮次保留的内存状态 */
export interface CheckState {
  /** 连续失败次数（超时或未知错误） */
  failStreak: Map<number, number>;
  /** 教练在确认页选择放弃的考位（"日期 时间 考点"），之后不再停下 */
  skipped: Map<number, Set<string>>;
}

export const slotKey = (s: Slot) => `${s.date} ${s.time} ${s.centreId}`;

export function newCheckState(): CheckState {
  return { failStreak: new Map(), skipped: new Map() };
}

export interface CheckDeps {
  repo: Repo;
  limiter: Pick<Limiter, 'acquire' | 'reportBlocked' | 'reportOk'> & Partial<Pick<Limiter, 'waitBackoff'>>;
  clock: Clock;
  /** 程序退出或学员被暂停时触发，用来中断限速等待 */
  signal?: AbortSignal;
  getSession(studentId: number): Promise<SiteSession>;
  /** 会话可能已损坏时丢弃，下一轮重新建 */
  dropSession(studentId: number): Promise<void>;
  tolerance: Tolerance;
  centres: CentreIndex;
  autoRebookEnabled: boolean;
  /** 这个学员是否自动提交（点 Finish），即使全局自动改约关闭。让位的双方是 */
  autoSubmit?: (studentId: number) => boolean;
  notify(event: NotifyEvent): void;
  state: CheckState;
  /** 报告本轮正在做什么，界面显示用 */
  onPhase?: (studentId: number, phase: Text) => void;
  /** 自动改约关闭时停在了确认页，浏览器要保留给教练 */
  onConfirmReady?: (studentId: number, slot: Slot) => Promise<void>;
  /** 学员的预约变了，原来的考位放回了网站（old 是原预约） */
  onReleased?: (studentId: number, old: BookingInfo) => void;
}

/** continue：下一轮继续；stop：这个学员不用再排队了；hold：停在确认页等教练，不再排队，浏览器不关 */
export type CheckOutcome = 'continue' | 'stop' | 'hold';

const MAX_TRANSIENT_FAILURES = 3;

const kindText = (k: SiteErrorKind) => msg(`kind.${k}`);
const centreText = (id: number, centres: CentreIndex): Text => centres.get(id)?.name ?? msg('centre.unknown', { id });

/** 对一个学员检查一轮 */
export async function checkStudent(studentId: number, deps: CheckDeps): Promise<CheckOutcome> {
  const student = deps.repo.getStudent(studentId);
  if (!student || student.status !== 'running') return 'stop';

  const early = preflight(student, student.current, deps);
  if (early) return stopStudent(student, early, deps);

  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await runRound(student, deps);
      deps.state.failStreak.delete(studentId);
      return outcome;
    } catch (err) {
      if (deps.signal?.aborted) return 'stop';
      // 登录页控件偶尔没初始化：重来一次，仍失败才报警
      if (err instanceof SiteError && err.kind === 'widgets_missing' && attempt === 0) {
        await deps.dropSession(studentId);
        continue;
      }
      return reportError(student, err, deps);
    }
  }
}

/** R2、R3：不需要访问站点就能判断的停止条件。返回停止原因 */
function preflight(student: Student, current: BookingInfo, deps: CheckDeps): Text | null {
  const d = refreshDeadline(current, student.target, deps.tolerance.maxDateDays);
  if (deps.clock.now() <= d.at) return null;
  return msg(d.reason === 'locked' ? 'stop.locked' : 'stop.target_passed');
}

async function runRound(student: Student, deps: CheckDeps): Promise<CheckOutcome> {
  const { repo, limiter, clock, tolerance, centres } = deps;
  const phase = (p: Text) => deps.onPhase?.(student.id, p);
  // 网站刚拦截过：退避结束前连浏览器都不开、不登录。旧做法只在查考点前等，登录照样访问网站，拦截越来越长
  if (limiter.waitBackoff) {
    phase(msg('phase.backoff'));
    await limiter.waitBackoff(deps.signal);
  }
  phase(msg('phase.open_browser'));
  const session = await deps.getSession(student.id);

  phase(msg('phase.login'));
  const current = await session.login(student.bookingId, student.surname);
  repo.setCurrent(student.id, current);
  // 预约在软件外被改了（教练在网站上改的）：原考位放回了网站
  if (!sameBooking(current, student.current)) deps.onReleased?.(student.id, student.current);
  const early = preflight(student, current, deps);
  if (early) return stopStudent(student, early, deps);

  const target = student.target;
  const earliest = sydneyDateOf(clock.now() + LOCK_MS);
  const from = maxDate(addDays(target.dateFrom, -tolerance.maxDateDays), earliest);
  const to = addDays(target.dateTo, tolerance.maxDateDays);

  for (const centreId of student.target.centreIds) {
    phase(msg('phase.queue'));
    await limiter.acquire(deps.signal);
    phase(msg('phase.check', { centre: centreText(centreId, centres) }));
    const slots = await session.listSlots(centreId, from, to);
    limiter.reportOk();

    const exact: Slot[] = [];
    const near: { slot: Slot; notes: Text[] }[] = [];
    const now = clock.now();
    for (const slot of slots) {
      if (isCurrentBooking(slot, current, deps)) continue;
      if (deps.state.skipped.get(student.id)?.has(slotKey(slot))) continue;
      const r = evaluate(slot, target, tolerance, centres, now);
      if (r.kind === 'exact') exact.push(slot);
      else if (r.kind === 'near') near.push({ slot, notes: r.notes });
    }

    if (exact.length > 0) {
      exact.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return rebookSlot(student, exact[0]!, session, deps);
    }
    for (const { slot, notes } of near) {
      const offerId = repo.addOffer({ studentId: student.id, centreId: slot.centreId, date: slot.date, time: slot.time, notes }, clock.now());
      if (offerId !== null) deps.notify({ type: 'offer', studentId: student.id, offerId });
    }
  }
  return 'continue';
}

/** 一轮要访问站点几次：每个目标考点一次（不查附近考点，2026-11-17 教练要求去掉，避免误解） */
export function visitsPerRound(centreIds: readonly number[]): number {
  return centreIds.length;
}

function isCurrentBooking(slot: Slot, current: BookingInfo, deps: CheckDeps): boolean {
  const c = deps.centres.get(slot.centreId);
  return !!c && sameName(c.name, current.centreName) && slot.date === current.date && slot.time === current.time;
}

function sameBooking(a: BookingInfo, b: BookingInfo): boolean {
  return sameName(a.centreName, b.centreName) && a.date === b.date && a.time === b.time;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a > b ? a : b;
}

/** 完全符合的考位：走到确认页；自动改约开启才点 Finish，并用重新读取预约的结果核实 */
export async function rebookSlot(student: Student, slot: Slot, session: SiteSession, deps: CheckDeps): Promise<CheckOutcome> {
  const { repo, clock } = deps;
  const centre = deps.centres.get(slot.centreId)!;

  // 改约是抢时间的操作，只有几次页面跳转，不再排队等全局限速
  const where = { centre: centre.name, date: slot.date, time: slot.time };
  deps.onPhase?.(student.id, msg('phase.confirm', where));
  const confirm = await session.reachConfirm(slot);
  if (!sameName(confirm.centreName, centre.name) || confirm.date !== slot.date || confirm.time !== slot.time) {
    throw new SiteError(
      'confirm_mismatch',
      msg('err.confirm_mismatch', { ...where, c2: confirm.centreName, d2: confirm.date, t2: confirm.time }),
    );
  }

  if (!deps.autoRebookEnabled && !deps.autoSubmit?.(student.id)) {
    repo.setStatus(student.id, 'pending_confirm', msg('status.at_confirm', where));
    repo.log(student.id, 'info', msg('log.exact_dry_run', where), clock.now());
    deps.notify({ type: 'dry_run_ready', studentId: student.id, slot });
    await deps.onConfirmReady?.(student.id, slot);
    return 'hold';
  }

  // 从这里开始，任何异常都意味着"可能已经提交"，不能当作普通失败重试
  let page: 'success' | 'failed' | 'unknown';
  let after: BookingInfo;
  try {
    page = await session.finish();
    after = await session.readCurrent();
  } catch (err) {
    // 点 Finish 之前就停下了（找不到电话选项、条款或按钮）：确定没有提交，不能说成"可能已提交"
    if (err instanceof SiteError && err.kind === 'not_submitted') throw err;
    throw new SiteError('finish_unverified', msg('err.finish_error', { detail: errorText(err) }));
  }

  const changed = sameName(after.centreName, centre.name) && after.date === slot.date && after.time === slot.time;
  if (changed) {
    repo.setCurrent(student.id, after);
    const to = { centre: after.centreName, date: after.date, time: after.time };
    repo.setStatus(student.id, 'done', msg('status.rebooked', to));
    repo.log(student.id, 'info', msg('log.rebooked', to), clock.now());
    deps.notify({ type: 'rebooked', studentId: student.id, to: after });
    deps.onReleased?.(student.id, student.current);
    await deps.dropSession(student.id);
    return 'stop';
  }
  if (page === 'failed') {
    repo.log(student.id, 'warn', msg('log.rebook_lost', where), clock.now());
    return 'continue';
  }
  throw new SiteError('finish_unverified', msg('err.finish_mismatch', { page, date: slot.date, time: slot.time }));
}

function stopStudent(student: Student, reason: Text, deps: CheckDeps): CheckOutcome {
  deps.repo.setStatus(student.id, 'stopped', reason);
  deps.repo.log(student.id, 'info', msg('log.stopped', { reason }), deps.clock.now());
  deps.notify({ type: 'stopped', studentId: student.id, reason });
  return 'stop';
}

export async function reportError(student: Student, err: unknown, deps: CheckDeps): Promise<CheckOutcome> {
  const { repo, clock } = deps;
  const message = errorText(err);
  const kind: SiteErrorKind = err instanceof SiteError ? err.kind : 'timeout';

  if (kind === 'blocked') {
    const wait = deps.limiter.reportBlocked();
    repo.log(student.id, 'warn', msg('log.blocked_backoff', { kind: kindText('blocked'), min: Math.round(wait / 60_000) }), clock.now());
    await deps.dropSession(student.id);
    return 'continue';
  }

  // 浏览器窗口被关掉了（教练手动关的，或浏览器崩溃）：不是网站的问题，下一轮重新打开
  if (!(err instanceof SiteError) && /has been closed|Target closed|Browser closed|browser has disconnected/i.test(String((err as Error)?.message ?? err))) {
    repo.log(student.id, 'warn', msg('log.browser_closed'), clock.now());
    await deps.dropSession(student.id);
    return 'continue';
  }

  // 考位被别人抢先：正常竞争，记下来继续刷新，不算失败
  if (kind === 'slot_gone') {
    repo.log(student.id, 'warn', msg('log.slot_gone'), clock.now());
    return 'continue';
  }

  if (kind === 'timeout') {
    const n = (deps.state.failStreak.get(student.id) ?? 0) + 1;
    deps.state.failStreak.set(student.id, n);
    repo.log(student.id, 'warn', msg('log.timeout_n', { kind: kindText('timeout'), n, detail: message }), clock.now());
    await deps.dropSession(student.id);
    if (n < MAX_TRANSIENT_FAILURES) return 'continue';
  }

  const note = msg('status.error', { kind: kindText(kind), detail: message });
  repo.setStatus(student.id, 'paused', note);
  repo.log(student.id, 'error', note, clock.now());
  deps.notify({ type: 'error', studentId: student.id, kind, message });
  await deps.dropSession(student.id);
  return 'stop';
}
