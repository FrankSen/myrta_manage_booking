import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../../src/config/settings.ts';
import { indexCentres } from '../../src/domain/geo.ts';
import { sydneyInstant } from '../../src/domain/time.ts';
import type { BookingInfo, Centre, LocalDate, Slot, Target } from '../../src/domain/types.ts';
import { newCheckState, type CheckDeps, type NotifyEvent } from '../../src/engine/checker.ts';
import { FakeClock } from '../../src/scheduler/clock.ts';
import { SiteError } from '../../src/site/errors.ts';
import type { SiteSession } from '../../src/site/session.ts';
import { openDb } from '../../src/storage/db.ts';
import { Repo } from '../../src/storage/repo.ts';

export const centreList: Centre[] = JSON.parse(readFileSync(new URL('../../data/nsw-test-centres.json', import.meta.url), 'utf8'));
export const centres = indexCentres(centreList);

export const SILVERWATER = 241;
export const AUBURN = 112;
export const BANKSTOWN = 20;

export const SILVERWATER_NAME = 'Silverwater Service NSW Centre';

/** 假站点：按脚本返回结果，同时记录被调用的情况 */
export class FakeSession implements SiteSession {
  calls: string[] = [];
  current: BookingInfo = { centreName: SILVERWATER_NAME, date: '2026-12-30', time: '11:30' };
  slotsByCentre = new Map<number, Slot[]>();
  loginError: Error | null = null;
  /** 返回 undefined 时，确认页如实显示所选考位 */
  confirmOverride: BookingInfo | undefined;
  finishResult: 'success' | 'failed' | 'unknown' = 'success';
  /** finish 成功后预约是否真的改变 */
  finishChangesBooking = true;
  finishThrows: Error | null = null;
  private selected: Slot | null = null;
  closed = false;

  async login(): Promise<BookingInfo> {
    this.calls.push('login');
    if (this.loginError) throw this.loginError;
    return this.current;
  }
  async listSlots(centreId: number, _dateFrom: LocalDate, _dateTo: LocalDate): Promise<Slot[]> {
    this.calls.push(`listSlots:${centreId}`);
    return this.slotsByCentre.get(centreId) ?? [];
  }
  async reachConfirm(slot: Slot): Promise<BookingInfo> {
    this.calls.push(`reachConfirm:${slot.centreId}:${slot.date}:${slot.time}`);
    this.selected = slot;
    if (this.confirmOverride) return this.confirmOverride;
    return { centreName: centres.get(slot.centreId)!.name, date: slot.date, time: slot.time };
  }
  async finish(): Promise<'success' | 'failed' | 'unknown'> {
    this.calls.push('finish');
    if (this.finishThrows) throw this.finishThrows;
    if (this.finishChangesBooking && this.selected) {
      this.current = { centreName: centres.get(this.selected.centreId)!.name, date: this.selected.date, time: this.selected.time };
    }
    return this.finishResult;
  }
  async readCurrent(): Promise<BookingInfo> {
    this.calls.push('readCurrent');
    return this.current;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export const NOW = sydneyInstant('2026-11-11', '10:00');

export const baseTarget: Target = {
  centreIds: [SILVERWATER],
  dateFrom: '2026-11-16',
  dateTo: '2026-11-20',
  timeFrom: '09:00',
  timeTo: '12:00',
};

export interface Harness {
  deps: CheckDeps;
  repo: Repo;
  clock: FakeClock;
  session: FakeSession;
  events: NotifyEvent[];
  acquired: number;
  blocked: number;
  dropped: number;
  studentId: number;
}

export function harness(opts: { autoRebook?: boolean; target?: Target; current?: BookingInfo; status?: 'running' | 'idle' } = {}): Harness {
  const repo = new Repo(openDb(':memory:'), randomBytes(32));
  const clock = new FakeClock(NOW);
  const session = new FakeSession();
  if (opts.current) session.current = opts.current;
  const studentId = repo.addStudent({
    label: '测试学员',
    bookingId: '1234567890',
    surname: 'Testsurname',
    current: session.current,
    target: opts.target ?? baseTarget,
  });
  repo.setStatus(studentId, opts.status ?? 'running');

  const h = { events: [] as NotifyEvent[], acquired: 0, blocked: 0, dropped: 0 };
  const deps: CheckDeps = {
    repo,
    clock,
    limiter: {
      acquire: async () => void h.acquired++,
      reportBlocked: () => (h.blocked++, 5 * 60_000),
      reportOk: () => {},
    },
    getSession: async () => session,
    dropSession: async () => void h.dropped++,
    tolerance: DEFAULT_SETTINGS.tolerance,
    centres,
    autoRebookEnabled: opts.autoRebook ?? false,
    notify: (e) => h.events.push(e),
    state: newCheckState(),
  };
  return Object.assign(h, { deps, repo, clock, session, studentId }) as Harness;
}

export const slot = (centreId: number, date: string, time: string): Slot => ({ centreId, date, time });
export const siteError = (kind: ConstructorParameters<typeof SiteError>[0], msg = 'x') => new SiteError(kind, msg);
