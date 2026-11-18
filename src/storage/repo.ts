import type { DatabaseSync } from 'node:sqlite';
import type { BookingInfo, Target } from '../domain/types.ts';
import { decrypt, encrypt } from './crypto.ts';
import { decodeText, encodeText, type Text } from '../i18n.ts';

export type StudentStatus = 'idle' | 'running' | 'pending_confirm' | 'done' | 'stopped' | 'paused';
export type OfferState = 'open' | 'accepted' | 'dismissed' | 'gone';
export type LogLevel = 'info' | 'warn' | 'error';

export interface Student {
  id: number;
  /** 教练自己看的备注，不放全名 */
  label: string;
  bookingId: string;
  surname: string;
  current: BookingInfo;
  target: Target;
  status: StudentStatus;
  /** 状态说明（可翻译）；旧数据是中文句子 */
  statusNote: Text;
  /** 本次开始刷新以来完成的轮数 */
  rounds: number;
  lastRoundAt: number | null;
  /** 单独设置的刷新间隔（毫秒）；null 表示用全局设置 */
  intervalMs: number | null;
}

export interface Offer {
  id: number;
  studentId: number;
  centreId: number;
  date: string;
  time: string;
  notes: Text[];
  createdAt: number;
  state: OfferState;
}

export interface LogEntry {
  at: number;
  studentId: number | null;
  level: string;
  msg: Text;
}

type Row = Record<string, string | number | null>;

export class Repo {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(db: DatabaseSync, key: Buffer) {
    this.db = db;
    this.key = key;
  }

  addStudent(s: Omit<Student, 'id' | 'status' | 'statusNote' | 'rounds' | 'lastRoundAt' | 'intervalMs'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO students (label, booking_id_enc, surname_enc, current_json, target_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(s.label, encrypt(s.bookingId, this.key), encrypt(s.surname, this.key), JSON.stringify(s.current), JSON.stringify(s.target));
    return Number(r.lastInsertRowid);
  }

  getStudent(id: number): Student | undefined {
    const row = this.db.prepare('SELECT * FROM students WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toStudent(row) : undefined;
  }

  listStudents(): Student[] {
    return (this.db.prepare('SELECT * FROM students ORDER BY id').all() as Row[]).map((r) => this.toStudent(r));
  }

  updateTarget(id: number, target: Target): void {
    this.db.prepare('UPDATE students SET target_json = ? WHERE id = ?').run(JSON.stringify(target), id);
  }

  setStatus(id: number, status: StudentStatus, note: Text = ''): void {
    this.db.prepare('UPDATE students SET status = ?, status_note = ? WHERE id = ?').run(status, encodeText(note), id);
  }

  setCurrent(id: number, current: BookingInfo): void {
    this.db.prepare('UPDATE students SET current_json = ? WHERE id = ?').run(JSON.stringify(current), id);
  }

  countRound(id: number, nowMs: number): void {
    this.db.prepare('UPDATE students SET rounds = rounds + 1, last_round_at = ? WHERE id = ?').run(nowMs, id);
  }

  resetRounds(id: number): void {
    this.db.prepare('UPDATE students SET rounds = 0, last_round_at = NULL WHERE id = ?').run(id);
  }

  setInterval(id: number, ms: number | null): void {
    this.db.prepare('UPDATE students SET interval_ms = ? WHERE id = ?').run(ms, id);
  }

  deleteStudent(id: number): void {
    this.db.prepare('DELETE FROM students WHERE id = ?').run(id);
  }

  /** 新增待确认考位。同一学员同一考位已存在（含已忽略的）返回 null */
  addOffer(o: Omit<Offer, 'id' | 'createdAt' | 'state'>, nowMs: number): number | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO offers (student_id, centre_id, date, time, notes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(o.studentId, o.centreId, o.date, o.time, JSON.stringify(o.notes), nowMs);
    return r.changes === 0 ? null : Number(r.lastInsertRowid);
  }

  getOffer(id: number): Offer | undefined {
    const row = this.db.prepare('SELECT * FROM offers WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toOffer(row) : undefined;
  }

  listOffers(studentId?: number): Offer[] {
    const rows =
      studentId === undefined
        ? (this.db.prepare('SELECT * FROM offers ORDER BY id').all() as Row[])
        : (this.db.prepare('SELECT * FROM offers WHERE student_id = ? ORDER BY id').all(studentId) as Row[]);
    return rows.map((r) => this.toOffer(r));
  }

  setOfferState(id: number, state: OfferState): void {
    this.db.prepare('UPDATE offers SET state = ? WHERE id = ?').run(state, id);
  }

  /** 程序自己用的小数据（如授权检查记录的最晚时间） */
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? (row.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  log(studentId: number | null, level: LogLevel, msg: Text, nowMs: number): void {
    this.db.prepare('INSERT INTO logs (at, student_id, level, msg) VALUES (?, ?, ?, ?)').run(nowMs, studentId, level, encodeText(msg));
  }

  recentLogs(limit: number): LogEntry[] {
    const rows = this.db.prepare('SELECT at, student_id, level, msg FROM logs ORDER BY id DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({ at: r.at as number, studentId: r.student_id as number | null, level: r.level as string, msg: decodeText(r.msg as string) }));
  }

  private toStudent(r: Row): Student {
    return {
      id: r.id as number,
      label: r.label as string,
      bookingId: decrypt(r.booking_id_enc as string, this.key),
      surname: decrypt(r.surname_enc as string, this.key),
      current: JSON.parse(r.current_json as string) as BookingInfo,
      target: JSON.parse(r.target_json as string) as Target,
      status: r.status as StudentStatus,
      statusNote: decodeText(r.status_note as string),
      rounds: (r.rounds as number | null) ?? 0,
      lastRoundAt: (r.last_round_at as number | null) ?? null,
      intervalMs: (r.interval_ms as number | null) ?? null,
    };
  }

  private toOffer(r: Row): Offer {
    return {
      id: r.id as number,
      studentId: r.student_id as number,
      centreId: r.centre_id as number,
      date: r.date as string,
      time: r.time as string,
      notes: JSON.parse(r.notes_json as string) as Text[],
      createdAt: r.created_at as number,
      state: r.state as OfferState,
    };
  }
}
