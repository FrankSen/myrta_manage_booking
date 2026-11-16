import type { Clock } from '../scheduler/clock.ts';
import type { Limiter } from '../scheduler/limiter.ts';
import { nearbyCentres } from '../domain/geo.ts';
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
  /** 每个学员下一个要查的"附近考点"序号 */
  rotation: Map<number, number>;
  /** 连续失败次数（超时或未知错误） */
  failStreak: Map<number, number>;
}

export function newCheckState(): CheckState {
  return { rotation: new Map(), failStreak: new Map() };
}

export interface CheckDeps {
  repo: Repo;
  limiter: Pick<Limiter, 'acquire' | 'reportBlocked' | 'reportOk'>;
  clock: Clock;
  /** 程序退出或学员被暂停时触发，用来中断限速等待 */
  signal?: AbortSignal;
  getSession(studentId: number): Promise<SiteSession>;
  /** 会话可能已损坏时丢弃，下一轮重新建 */
  dropSession(studentId: number): Promise<void>;
  tolerance: Tolerance;
  centres: CentreIndex;
  autoRebookEnabled: boolean;
  notify(event: NotifyEvent): void;
  state: CheckState;
  /** 报告本轮正在做什么，界面显示用 */
  onPhase?: (studentId: number, phase: Text) => void;
}

/** continue：下一轮继续；stop：这个学员不用再排队了 */
export type CheckOutcome = 'continue' | 'stop';

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
  phase(msg('phase.open_browser'));
  const session = await deps.getSession(student.id);

  phase(msg('phase.login'));
  const current = await session.login(student.bookingId, student.surname);
  repo.setCurrent(student.id, current);
  const early = preflight(student, current, deps);
  if (early) return stopStudent(student, early, deps);

  const target = student.target;
  const earliest = sydneyDateOf(clock.now() + LOCK_MS);
  const from = maxDate(addDays(target.dateFrom, -tolerance.maxDateDays), earliest);
  const to = addDays(target.dateTo, tolerance.maxDateDays);

  for (const centreId of centresToCheck(student, deps)) {
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

/** 一轮要访问站点几次：每个目标考点一次，有附近考点时再加一次 */
export function visitsPerRound(centreIds: readonly number[], tolerance: Tolerance, centres: CentreIndex): number {
  if (centreIds.length === 0) return 0;
  return centreIds.length + (nearbyCentres(centreIds, tolerance.maxDistanceKm, centres).length > 0 ? 1 : 0);
}

/** 目标考点每轮都查；附近考点每轮轮流查一个 */
function centresToCheck(student: Student, deps: CheckDeps): number[] {
  const ids = [...student.target.centreIds];
  const nearby = nearbyCentres(student.target.centreIds, deps.tolerance.maxDistanceKm, deps.centres);
  if (nearby.length > 0) {
    const i = deps.state.rotation.get(student.id) ?? 0;
    ids.push(nearby[i % nearby.length]!.id);
    deps.state.rotation.set(student.id, i + 1);
  }
  return ids;
}

function isCurrentBooking(slot: Slot, current: BookingInfo, deps: CheckDeps): boolean {
  const c = deps.centres.get(slot.centreId);
  return !!c && sameName(c.name, current.centreName) && slot.date === current.date && slot.time === current.time;
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

  if (!deps.autoRebookEnabled) {
    repo.setStatus(student.id, 'pending_confirm', msg('status.at_confirm', where));
    repo.log(student.id, 'info', msg('log.exact_dry_run', where), clock.now());
    deps.notify({ type: 'dry_run_ready', studentId: student.id, slot });
    return 'stop';
  }

  // 从这里开始，任何异常都意味着"可能已经提交"，不能当作普通失败重试
  let page: 'success' | 'failed' | 'unknown';
  let after: BookingInfo;
  try {
    page = await session.finish();
    after = await session.readCurrent();
  } catch (err) {
    throw new SiteError('finish_unverified', msg('err.finish_error', { detail: errorText(err) }));
  }

  const changed = sameName(after.centreName, centre.name) && after.date === slot.date && after.time === slot.time;
  if (changed) {
    repo.setCurrent(student.id, after);
    const to = { centre: after.centreName, date: after.date, time: after.time };
    repo.setStatus(student.id, 'done', msg('status.rebooked', to));
    repo.log(student.id, 'info', msg('log.rebooked', to), clock.now());
    deps.notify({ type: 'rebooked', studentId: student.id, to: after });
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
