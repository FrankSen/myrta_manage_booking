import { render } from '../src/i18n.ts';
import { describe, expect, test } from 'vitest';
import { checkStudent } from '../src/engine/checker.ts';
import { sydneyInstant } from '../src/domain/time.ts';
import { NOW, SILVERWATER, SILVERWATER_NAME, baseTarget, harness, siteError, slot } from './helpers/fakes.ts';

describe('停止条件', () => {
  test('原考试不足 48 小时：停止，没有访问站点', async () => {
    const h = harness({ current: { centreName: SILVERWATER_NAME, date: '2026-11-13', time: '09:59' } });
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.session.calls).toEqual([]);
    expect(h.repo.getStudent(h.studentId)!.status).toBe('stopped');
    expect(h.events[0]).toMatchObject({ type: 'stopped' });
  });

  test('原考试恰好 48 小时：不算锁定，正常检查', async () => {
    const h = harness({ current: { centreName: SILVERWATER_NAME, date: '2026-11-13', time: '10:00' } });
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(h.session.calls[0]).toBe('login');
  });

  test('登录后才发现预约已锁定：也停止', async () => {
    const h = harness();
    h.session.current = { centreName: SILVERWATER_NAME, date: '2026-11-12', time: '09:00' };
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.session.calls).toEqual(['login']);
  });

  test('目标日期范围已全部进入 48 小时线：停止', async () => {
    const h = harness({ target: { ...baseTarget, dateFrom: '2026-11-11', dateTo: '2026-11-12' } });
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.session.calls).toEqual([]);
    expect(render('zh', h.repo.getStudent(h.studentId)!.statusNote)).toContain('48 小时');
  });

  test('学员状态不是 running 时不动作', async () => {
    const h = harness({ status: 'idle' });
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.session.calls).toEqual([]);
  });
});

describe('自动改约关闭（默认）', () => {
  test('完全符合：走到确认页，绝不点 Finish', async () => {
    const h = harness({ autoRebook: false });
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    expect(await checkStudent(h.studentId, h.deps)).toBe('hold');
    expect(h.session.calls).toContain('reachConfirm:241:2026-11-17:10:30');
    expect(h.session.calls).not.toContain('finish');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('pending_confirm');
    expect(h.events.find((e) => e.type === 'dry_run_ready')).toBeTruthy();
  });
});

describe('自动改约开启', () => {
  test('完全符合：点 Finish，核实新预约后标记完成', async () => {
    const h = harness({ autoRebook: true });
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.session.calls.filter((c) => c === 'finish')).toHaveLength(1);
    expect(h.session.calls.at(-1)).toBe('readCurrent');
    const s = h.repo.getStudent(h.studentId)!;
    expect(s.status).toBe('done');
    expect(s.current).toMatchObject({ date: '2026-11-17', time: '10:30' });
    expect(h.events.find((e) => e.type === 'rebooked')).toBeTruthy();
    expect(h.dropped).toBe(1);
  });

  test('页面说成功，但重新读取的预约没变：不算成功，暂停并报警', async () => {
    const h = harness({ autoRebook: true });
    h.session.finishChangesBooking = false;
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    const s = h.repo.getStudent(h.studentId)!;
    expect(s.status).toBe('paused');
    expect(render('zh', s.statusNote)).toContain('无法确认改约结果');
    expect(h.events.find((e) => e.type === 'rebooked')).toBeUndefined();
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({ kind: 'finish_unverified' });
  });

  test('Finish 过程中抛异常：当作"可能已提交"，暂停，不重试', async () => {
    const h = harness({ autoRebook: true });
    h.session.finishThrows = new Error('页面崩了');
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    await checkStudent(h.studentId, h.deps);
    expect(h.session.calls.filter((c) => c === 'finish')).toHaveLength(1);
    expect(h.repo.getStudent(h.studentId)!.status).toBe('paused');
  });

  test('页面明确说失败（考位被抢）且预约没变：继续下一轮', async () => {
    const h = harness({ autoRebook: true });
    h.session.finishResult = 'failed';
    h.session.finishChangesBooking = false;
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('running');
  });

  test('确认页内容和所选考位不一致：不点 Finish，暂停', async () => {
    const h = harness({ autoRebook: true });
    h.session.confirmOverride = { centreName: SILVERWATER_NAME, date: '2026-11-17', time: '11:00' };
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '10:30')]);
    await checkStudent(h.studentId, h.deps);
    expect(h.session.calls).not.toContain('finish');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('paused');
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({ kind: 'confirm_mismatch' });
  });

  test('有多个完全符合的考位：选最早的', async () => {
    const h = harness({ autoRebook: true });
    h.session.slotsByCentre.set(SILVERWATER, [
      slot(SILVERWATER, '2026-11-19', '09:00'),
      slot(SILVERWATER, '2026-11-17', '11:00'),
      slot(SILVERWATER, '2026-11-17', '09:30'),
    ]);
    await checkStudent(h.studentId, h.deps);
    expect(h.session.calls).toContain('reachConfirm:241:2026-11-17:09:30');
  });

  test('同时有完全符合和接近：只处理完全符合，不产生待确认', async () => {
    const h = harness({ autoRebook: true });
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '13:00'), slot(SILVERWATER, '2026-11-18', '10:00')]);
    await checkStudent(h.studentId, h.deps);
    expect(h.session.calls).toContain('reachConfirm:241:2026-11-18:10:00');
    expect(h.repo.listOffers()).toHaveLength(0);
  });
});

describe('过滤与待确认', () => {
  test('不足 48 小时的考位被忽略，即使完全符合', async () => {
    const h = harness();
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-12', '10:00')]);
    await checkStudent(h.studentId, h.deps);
    expect(h.session.calls.some((c) => c.startsWith('reachConfirm'))).toBe(false);
    expect(h.repo.listOffers()).toHaveLength(0);
  });

  test('当前这个预约本身出现在列表里：忽略', async () => {
    const h = harness({ target: { ...baseTarget, dateFrom: '2026-12-28', dateTo: '2026-12-31' } });
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-12-30', '11:30')]);
    await checkStudent(h.studentId, h.deps);
    expect(h.session.calls.some((c) => c.startsWith('reachConfirm'))).toBe(false);
  });

  test('接近的考位：生成待确认并通知，连续两轮只通知一次', async () => {
    const h = harness();
    h.session.slotsByCentre.set(SILVERWATER, [slot(SILVERWATER, '2026-11-17', '13:00')]);
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(h.repo.listOffers()).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'offer')).toHaveLength(1);
    expect(h.repo.getStudent(h.studentId)!.status).toBe('running');
  });

  test('只查目标考点，不查附近考点', async () => {
    const h = harness({ target: { ...baseTarget, centreIds: [SILVERWATER, 17] } });
    for (let i = 0; i < 3; i++) await checkStudent(h.studentId, h.deps);
    const listed = h.session.calls.filter((c) => c.startsWith('listSlots')).map((c) => Number(c.split(':')[1]));
    expect(listed).toEqual([241, 17, 241, 17, 241, 17]);
  });

  test('每次 listSlots 之前都先排队等全局限速', async () => {
    const h = harness();
    await checkStudent(h.studentId, h.deps);
    const lists = h.session.calls.filter((c) => c.startsWith('listSlots')).length;
    expect(h.acquired).toBe(lists);
    expect(lists).toBe(1);
  });

  test('只查"现在起 48 小时之后"的日期', async () => {
    const h = harness({ target: { ...baseTarget, dateFrom: '2026-11-10', dateTo: '2026-11-20' } });
    let seenFrom = '';
    h.session.listSlots = async (_centreId: number, from: string) => ((seenFrom = from), []);
    await checkStudent(h.studentId, h.deps);
    expect(seenFrom).toBe('2026-11-13');
    expect(sydneyInstant('2026-11-13', '10:00') - NOW).toBe(48 * 3_600_000);
  });
});

describe('错误处理', () => {
  test('被拦截：记一次失败、换全新会话，学员保持 running 继续刷新（不再退避）', async () => {
    const h = harness();
    h.session.loginError = siteError('blocked');
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(h.deps.state.failStreak.get(h.studentId)).toBe(1);
    expect(h.dropped).toBe(1);
    expect(h.repo.getStudent(h.studentId)!.status).toBe('running');
    expect(h.events).toEqual([]);
  });

  test('姓名或 Booking number 不对：暂停并通知', async () => {
    const h = harness();
    h.session.loginError = siteError('bad_credentials');
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('paused');
    expect(h.events[0]).toMatchObject({ type: 'error', kind: 'bad_credentials' });
  });

  test('登录页控件没初始化：丢弃会话重试一次，成功就不报警', async () => {
    const h = harness();
    let n = 0;
    h.session.login = async () => {
      if (n++ === 0) throw siteError('widgets_missing');
      return h.session.current;
    };
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(n).toBe(2);
    expect(h.dropped).toBe(1);
    expect(h.events).toEqual([]);
  });

  test('控件连续两次都没初始化：暂停并通知', async () => {
    const h = harness();
    h.session.loginError = siteError('widgets_missing');
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('paused');
  });

  test('验证码：暂停，不继续访问', async () => {
    const h = harness();
    h.session.loginError = siteError('captcha');
    await checkStudent(h.studentId, h.deps);
    expect(h.repo.getStudent(h.studentId)!.status).toBe('paused');
    expect(h.events[0]).toMatchObject({ kind: 'captcha' });
  });

  test('超时：前两次只记日志继续，连续第三次才暂停', async () => {
    const h = harness();
    h.session.loginError = siteError('timeout');
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('running');
    expect(await checkStudent(h.studentId, h.deps)).toBe('stop');
    expect(h.repo.getStudent(h.studentId)!.status).toBe('paused');
  });

  test('一次成功后超时计数清零', async () => {
    const h = harness();
    h.session.loginError = siteError('timeout');
    await checkStudent(h.studentId, h.deps);
    await checkStudent(h.studentId, h.deps);
    h.session.loginError = null;
    await checkStudent(h.studentId, h.deps);
    h.session.loginError = siteError('timeout');
    expect(await checkStudent(h.studentId, h.deps)).toBe('continue');
  });

  test('未知的普通异常按超时处理，不会让调度器崩溃', async () => {
    const h = harness();
    h.session.login = async () => {
      throw new Error('net::ERR_FAILED');
    };
    await expect(checkStudent(h.studentId, h.deps)).resolves.toBe('continue');
  });
});
