import { describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';
import type { Target } from '../src/domain/types.ts';

const target: Target = { centreIds: [241], dateFrom: '2026-11-16', dateTo: '2026-11-20', timeFrom: '09:00', timeTo: '12:00' };
const newStudent = () => ({
  label: '测试学员A',
  bookingId: '1234567890',
  surname: 'Testsurname',
  current: { centreName: 'Silverwater Service NSW Centre', date: '2026-12-30', time: '11:30' },
  target,
});
const setup = () => {
  const db = openDb(':memory:');
  return { db, repo: new Repo(db, randomBytes(32)) };
};

describe('学员', () => {
  test('新增后取回的 Booking number 和姓氏与输入一致，状态为 idle', () => {
    const { repo } = setup();
    const id = repo.addStudent(newStudent());
    const s = repo.getStudent(id)!;
    expect(s.bookingId).toBe('1234567890');
    expect(s.surname).toBe('Testsurname');
    expect(s.status).toBe('idle');
    expect(s.target).toEqual(target);
    expect(s.current.time).toBe('11:30');
  });

  test('数据库里的 Booking number 和姓氏是密文，不含明文', () => {
    const { db, repo } = setup();
    repo.addStudent(newStudent());
    const row = db.prepare('SELECT booking_id_enc, surname_enc FROM students').get() as Record<string, string>;
    expect(row.booking_id_enc).not.toContain('1234567890');
    expect(row.surname_enc).not.toContain('Testsurname');
  });

  test('换了密钥就读不出来', () => {
    const { db, repo } = setup();
    const id = repo.addStudent(newStudent());
    const other = new Repo(db, randomBytes(32));
    expect(() => other.getStudent(id)).toThrow();
  });

  test('更新目标、状态、当前预约', () => {
    const { repo } = setup();
    const id = repo.addStudent(newStudent());
    repo.updateTarget(id, { ...target, dateTo: '2026-11-27' });
    repo.setStatus(id, 'paused', '资料不符');
    repo.setCurrent(id, { centreName: 'Auburn Service NSW Centre', date: '2026-11-17', time: '10:00' });
    const s = repo.getStudent(id)!;
    expect(s.target.dateTo).toBe('2026-11-27');
    expect(s.status).toBe('paused');
    expect(s.statusNote).toBe('资料不符');
    expect(s.current.centreName).toBe('Auburn Service NSW Centre');
  });

  test('listStudents 按添加顺序返回；不存在的返回 undefined', () => {
    const { repo } = setup();
    const a = repo.addStudent({ ...newStudent(), label: 'A' });
    const b = repo.addStudent({ ...newStudent(), label: 'B' });
    expect(repo.listStudents().map((s) => s.id)).toEqual([a, b]);
    expect(repo.getStudent(999)).toBeUndefined();
  });
});

describe('待确认考位', () => {
  const offer = (studentId: number) => ({ studentId, centreId: 112, date: '2026-11-17', time: '08:30', notes: ['距目标考点 2.2 公里'] });

  test('同一考位重复添加返回 null', () => {
    const { repo } = setup();
    const sid = repo.addStudent(newStudent());
    expect(repo.addOffer(offer(sid), 1000)).toBeTypeOf('number');
    expect(repo.addOffer(offer(sid), 2000)).toBeNull();
    expect(repo.listOffers(sid)).toHaveLength(1);
  });

  test('教练忽略过的考位不再反复提醒', () => {
    const { repo } = setup();
    const sid = repo.addStudent(newStudent());
    const id = repo.addOffer(offer(sid), 1000)!;
    repo.setOfferState(id, 'dismissed');
    expect(repo.addOffer(offer(sid), 3000)).toBeNull();
    expect(repo.listOffers(sid)[0]!.state).toBe('dismissed');
  });

  test('不同学员可以有相同的考位', () => {
    const { repo } = setup();
    const a = repo.addStudent(newStudent());
    const b = repo.addStudent(newStudent());
    expect(repo.addOffer(offer(a), 1)).not.toBeNull();
    expect(repo.addOffer(offer(b), 1)).not.toBeNull();
    expect(repo.listOffers()).toHaveLength(2);
  });

  test('notes 能原样取回', () => {
    const { repo } = setup();
    const sid = repo.addStudent(newStudent());
    repo.addOffer(offer(sid), 1000);
    expect(repo.listOffers(sid)[0]!.notes).toEqual(['距目标考点 2.2 公里']);
  });

  test('删除学员时一并删除其待确认考位', () => {
    const { repo } = setup();
    const a = repo.addStudent(newStudent());
    const b = repo.addStudent(newStudent());
    repo.addOffer(offer(a), 1);
    repo.addOffer(offer(b), 1);
    repo.deleteStudent(a);
    expect(repo.getStudent(a)).toBeUndefined();
    expect(repo.listOffers().map((o) => o.studentId)).toEqual([b]);
  });
});

describe('日志', () => {
  test('recentLogs 只返回最新的几条，倒序', () => {
    const { repo } = setup();
    repo.log(null, 'info', 'one', 1);
    repo.log(null, 'warn', 'two', 2);
    repo.log(null, 'error', 'three', 3);
    expect(repo.recentLogs(2).map((l) => l.msg)).toEqual(['three', 'two']);
  });
});

describe('刷新轮数与单独间隔', () => {
  const mk2 = () => {
    const repo = new Repo(openDb(':memory:'), randomBytes(32));
    const id = repo.addStudent({
      label: 'A', bookingId: '1234567890', surname: 'Testsurname',
      current: { centreName: 'X', date: '2026-12-30', time: '11:30' },
      target: { centreIds: [241], dateFrom: '2026-12-01', dateTo: '2026-12-10', timeFrom: '09:00', timeTo: '12:00' },
    });
    return { repo, id };
  };
  test('新学员：0 轮，没有单独间隔', () => {
    const { repo, id } = mk2();
    const s = repo.getStudent(id)!;
    expect(s.rounds).toBe(0);
    expect(s.intervalMs).toBeNull();
    expect(s.lastRoundAt).toBeNull();
  });
  test('每完成一轮加 1 并记下时间；清零', () => {
    const { repo, id } = mk2();
    repo.countRound(id, 1000);
    repo.countRound(id, 2000);
    expect(repo.getStudent(id)!).toMatchObject({ rounds: 2, lastRoundAt: 2000 });
    repo.resetRounds(id);
    expect(repo.getStudent(id)!).toMatchObject({ rounds: 0, lastRoundAt: null });
  });
  test('单独间隔：设置与取消', () => {
    const { repo, id } = mk2();
    repo.setInterval(id, 5 * 60_000);
    expect(repo.getStudent(id)!.intervalMs).toBe(5 * 60_000);
    repo.setInterval(id, null);
    expect(repo.getStudent(id)!.intervalMs).toBeNull();
  });
  test('旧数据库（没有新列）打开后自动补列，数据不丢', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, booking_id_enc TEXT NOT NULL,
      surname_enc TEXT NOT NULL, current_json TEXT NOT NULL, target_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', status_note TEXT NOT NULL DEFAULT '')`);
    db.exec(`INSERT INTO students (label, booking_id_enc, surname_enc, current_json, target_json) VALUES ('old', 'x', 'y', '{}', '{}')`);
    migrate(db);
    const row = db.prepare('SELECT label, rounds, interval_ms FROM students').get() as Record<string, unknown>;
    expect(row).toEqual({ label: 'old', rounds: 0, interval_ms: null });
    migrate(db); // 再跑一次不报错
  });
});
