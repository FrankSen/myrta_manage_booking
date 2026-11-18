import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  booking_id_enc  TEXT NOT NULL,
  surname_enc     TEXT NOT NULL,
  current_json    TEXT NOT NULL,
  target_json     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'idle',
  status_note     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  centre_id   INTEGER NOT NULL,
  date        TEXT NOT NULL,
  time        TEXT NOT NULL,
  notes_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open',
  UNIQUE (student_id, centre_id, date, time)
);
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  student_id  INTEGER,
  level       TEXT NOT NULL,
  msg         TEXT NOT NULL
);
`;

/** 给旧数据库补上后来新增的列。可以重复执行 */
export function migrate(db: DatabaseSync): void {
  const cols = new Set((db.prepare('PRAGMA table_info(students)').all() as { name: string }[]).map((c) => c.name));
  const add = (name: string, def: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE students ADD COLUMN ${name} ${def}`);
  };
  // 已完成的刷新轮数、最近一轮结束时间、单独设置的刷新间隔（毫秒，空表示用全局设置）
  add('rounds', 'INTEGER NOT NULL DEFAULT 0');
  add('last_round_at', 'INTEGER');
  add('interval_ms', 'INTEGER');
}

/** 打开（必要时创建）数据库。':memory:' 用于测试 */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
