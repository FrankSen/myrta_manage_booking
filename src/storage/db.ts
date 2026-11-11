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
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  student_id  INTEGER,
  level       TEXT NOT NULL,
  msg         TEXT NOT NULL
);
`;

/** 打开（必要时创建）数据库。':memory:' 用于测试 */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
