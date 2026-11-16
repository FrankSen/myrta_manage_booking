import { describe, expect, test } from 'vitest';
import { DICT, decodeText, encodeText, fmtDate, fmtStamp, msg, render, t } from '../src/i18n.ts';
import { openDb } from '../src/storage/db.ts';
import { Repo } from '../src/storage/repo.ts';
import { randomBytes } from 'node:crypto';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('翻译表', () => {
  test('中英文的键完全一致', () => {
    expect(Object.keys(DICT.en).sort()).toEqual(Object.keys(DICT.zh).sort());
  });
  test('每个键两种语言的占位符一致', () => {
    for (const k of Object.keys(DICT.zh)) expect([k, placeholders(DICT.en[k]!)]).toEqual([k, placeholders(DICT.zh[k]!)]);
  });
  test('代码里用到的键都在表里', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../src/', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js|html)$/.test(n) && !n.startsWith('i18n')) files.push(p);
      }
    };
    walk(root);
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:msg|tr|t)\(\s*(?:lang,\s*)?'([a-z_]+\.[a-z0-9_]+)'/g)) if (!(m[1]! in DICT.zh)) missing.push(`${f}: ${m[1]}`);
      for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([a-z_]+\.[a-z0-9_]+)"/g)) if (!(m[1]! in DICT.zh)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('翻译', () => {
  test('参数替换，嵌套消息和列表', () => {
    const m = msg('log.stopped', { reason: msg('stop.locked') });
    expect(render('zh', m)).toBe('停止：原考试距现在不足 48 小时，预约已锁定，不能再改');
    expect(render('en', m)).toBe('Stopped: The current test is less than 48 hours away, so the booking is locked');
    expect(t('zh', 'v.interval', { list: ['1', '2'] })).toBe('刷新间隔只能选 1、2 分钟');
    expect(t('en', 'v.interval', { list: ['1', '2'] })).toBe('The interval must be one of 1, 2 minutes');
  });
  test('普通字符串（旧数据、站点原文）原样显示', () => {
    expect(render('en', '资料不符')).toBe('资料不符');
  });
  test('没有的键显示键本身', () => {
    expect(t('en', 'no.such')).toBe('no.such');
  });
});

describe('存储', () => {
  test('消息编码后能还原；普通字符串不变', () => {
    const m = msg('status.rebooked', { centre: 'X', date: '2026-12-01', time: '09:00' });
    expect(decodeText(encodeText(m))).toEqual(m);
    expect(encodeText('教练手动暂停')).toBe('教练手动暂停');
    expect(decodeText('教练手动暂停')).toBe('教练手动暂停');
  });
  test('旧数据库里的中文状态说明和记录照常读出', () => {
    const db = openDb(':memory:');
    const repo = new Repo(db, randomBytes(32));
    const id = repo.addStudent({ label: 'A', bookingId: '1234567890', surname: 'T', current: { centreName: 'X', date: '2026-12-01', time: '09:00' }, target: { centreIds: [241], dateFrom: '2026-12-01', dateTo: '2026-12-01', timeFrom: '08:00', timeTo: '17:00' } });
    db.prepare('UPDATE students SET status_note = ? WHERE id = ?').run('站点暂时拒绝访问：旧版本写的', id);
    db.prepare('INSERT INTO logs (at, student_id, level, msg) VALUES (1, ?, ?, ?)').run(id, 'info', '旧记录');
    expect(repo.getStudent(id)!.statusNote).toBe('站点暂时拒绝访问：旧版本写的');
    expect(repo.recentLogs(1)[0]!.msg).toBe('旧记录');
    repo.setStatus(id, 'paused', msg('status.manual_pause'));
    expect(render('en', repo.getStudent(id)!.statusNote)).toBe('Paused by you');
  });
});

describe('日期时间显示', () => {
  test('日期', () => {
    expect(fmtDate('zh', '2026-12-30')).toBe('2026年12月30日 周三');
    expect(fmtDate('en', '2026-12-30')).toBe('Wed 30 Dec 2026');
  });
  test('时间戳按悉尼时间显示，和电脑时区无关', () => {
    const ms = Date.UTC(2026, 11, 30, 0, 30, 5); // 悉尼夏令时 11:30:05
    expect(fmtStamp('zh', ms)).toContain('11:30:05');
    expect(fmtStamp('en', ms)).toContain('11:30:05');
    expect(fmtStamp('en', ms)).toContain('30/12');
  });
});
