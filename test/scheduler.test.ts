import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config/settings.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import { Limiter } from '../src/scheduler/limiter.ts';
import { Scheduler } from '../src/scheduler/queue.ts';

const H = DEFAULT_SETTINGS.hidden;
const MIN = 60_000;

describe('FakeClock', () => {
  test('advance 到期才唤醒，且按时间顺序', async () => {
    const c = new FakeClock(0);
    const order: number[] = [];
    void c.sleep(300).then(() => order.push(300));
    void c.sleep(100).then(() => order.push(100));
    await c.advance(99);
    expect(order).toEqual([]);
    await c.advance(1);
    expect(order).toEqual([100]);
    await c.advance(500);
    expect(order).toEqual([100, 300]);
    expect(c.now()).toBe(600);
  });
  test('abort 会取消 sleep', async () => {
    const c = new FakeClock(0);
    const ac = new AbortController();
    const p = c.sleep(1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('Limiter', () => {
  const mk = () => {
    const clock = new FakeClock(1_000_000);
    return { clock, limiter: new Limiter(clock, H) };
  };

  test('第一次立刻放行，第二次要等满最短间隔', async () => {
    const { clock, limiter } = mk();
    await limiter.acquire();
    let second = false;
    void limiter.acquire().then(() => (second = true));
    await clock.advance(H.globalMinGapMs - 1);
    expect(second).toBe(false);
    await clock.advance(1);
    expect(second).toBe(true);
  });

  test('多个并发请求依次排队，各隔一个间隔', async () => {
    const { clock, limiter } = mk();
    const times: number[] = [];
    for (let i = 0; i < 3; i++) void limiter.acquire().then(() => times.push(clock.now()));
    await clock.advance(H.globalMinGapMs * 3);
    expect(times).toEqual([1_000_000, 1_000_000 + H.globalMinGapMs, 1_000_000 + 2 * H.globalMinGapMs]);
  });

  test('acquire 可被取消', async () => {
    const { limiter } = mk();
    await limiter.acquire();
    const ac = new AbortController();
    const p = limiter.acquire(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('Scheduler', () => {
  // 调度行为用固定间隔测试，与生产默认值解耦（默认已改为 5 秒）
  const SCHED_INTERVAL = 2 * MIN;
  const mk = (run: (id: number) => Promise<void>, random = () => 0.5) => {
    const clock = new FakeClock(0);
    return { clock, sch: new Scheduler(clock, H, run, random, () => SCHED_INTERVAL) };
  };

  test('start 立刻跑第一轮，之后约每 2 分钟一轮', async () => {
    const calls: number[] = [];
    const { clock, sch } = mk(async (id) => void calls.push(clock.now()));
    sch.start(1);
    await clock.advance(0);
    expect(calls).toEqual([0]);
    await clock.advance(2 * MIN);
    expect(calls).toEqual([0, 2 * MIN]);
    await clock.advance(2 * MIN);
    expect(calls).toEqual([0, 2 * MIN, 4 * MIN]);
  });

  test('超过学员上限的 start 返回 false，已在运行的重复 start 返回 true', () => {
    const { sch } = mk(async () => {});
    for (let i = 1; i <= H.maxActiveStudents; i++) expect(sch.start(i)).toBe(true);
    expect(sch.start(H.maxActiveStudents + 1)).toBe(false);
    expect(sch.start(1)).toBe(true);
    expect(sch.activeIds()).toHaveLength(H.maxActiveStudents);
  });

  test('间隔在 ±20% 之内：random 取 0 和 1 的两个极端', async () => {
    for (const [rnd, expected] of [[0, 96_000], [1, 144_000]] as const) {
      const calls: number[] = [];
      const clock = new FakeClock(0);
      const sch = new Scheduler(clock, H, async () => void calls.push(clock.now()), () => rnd, () => 2 * MIN);
      sch.start(1);
      await clock.advance(expected);
      expect(calls).toEqual([0, expected]);
    }
  });

  test('run 抛异常后调度器不停，下一轮照常', async () => {
    let n = 0;
    const { clock, sch } = mk(async () => {
      n++;
      if (n === 1) throw new Error('boom');
    });
    sch.start(1);
    await clock.advance(0);
    await clock.advance(2 * MIN);
    expect(n).toBe(2);
  });

  test('runNow 立刻执行一次，并重新计时', async () => {
    const calls: number[] = [];
    const { clock, sch } = mk(async () => void calls.push(clock.now()));
    sch.start(1);
    await clock.advance(30_000);
    sch.runNow(1);
    await clock.advance(0);
    expect(calls).toEqual([0, 30_000]);
    await clock.advance(2 * MIN - 1);
    expect(calls).toEqual([0, 30_000]);
    await clock.advance(1);
    expect(calls).toEqual([0, 30_000, 30_000 + 2 * MIN]);
  });

  test('同一学员不会并发：正在跑的时候 runNow 不会再开一个，跑完后补一次', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const release: (() => void)[] = [];
    const { clock, sch } = mk(
      () =>
        new Promise<void>((resolve) => {
          calls++;
          running++;
          maxRunning = Math.max(maxRunning, running);
          release.push(() => {
            running--;
            resolve();
          });
        }),
    );
    sch.start(1);
    await clock.advance(0);
    expect(calls).toBe(1);
    sch.runNow(1);
    await clock.advance(0);
    expect(calls).toBe(1);
    release.shift()!();
    await clock.advance(0);
    expect(calls).toBe(2);
    expect(maxRunning).toBe(1);
  });

  test('stop 后不再触发，并且名额释放', async () => {
    let n = 0;
    const { clock, sch } = mk(async () => void n++);
    sch.start(1);
    sch.start(2);
    await clock.advance(0);
    sch.stop(1);
    await clock.advance(10 * MIN);
    expect(n).toBe(2 + 5);
    expect(sch.activeIds()).toEqual([2]);
    expect(sch.start(3)).toBe(true);
  });
});

describe('Scheduler：间隔可调与运行信息', () => {
  test('每个学员可以有自己的间隔', async () => {
    const calls: [number, number][] = [];
    const clock = new FakeClock(0);
    const sch = new Scheduler(clock, H, async (id) => void calls.push([id, clock.now()]), () => 0.5, (id) => (id === 2 ? 5 * MIN : 2 * MIN));
    sch.start(1);
    sch.start(2);
    await clock.advance(5 * MIN);
    expect(calls.filter(([id]) => id === 1).map(([, t]) => t)).toEqual([0, 2 * MIN, 4 * MIN]);
    expect(calls.filter(([id]) => id === 2).map(([, t]) => t)).toEqual([0, 5 * MIN]);
  });

  test('info：正在跑时 running 为 true；等待时给出下一轮时刻', async () => {
    let release!: () => void;
    const clock = new FakeClock(0);
    const sch = new Scheduler(clock, H, () => new Promise<void>((r) => (release = r)), () => 0.5, () => 2 * MIN);
    expect(sch.info(1)).toBeNull();
    sch.start(1);
    await clock.advance(0);
    expect(sch.info(1)).toEqual({ running: true, nextAt: null });
    await clock.advance(30_000);
    release();
    await clock.advance(0);
    expect(sch.info(1)).toEqual({ running: false, nextAt: 30_000 + 2 * MIN });
  });

  test('reschedule：等待中改了间隔，按新间隔从上一轮结束算起', async () => {
    let interval = 10 * MIN;
    const calls: number[] = [];
    const clock = new FakeClock(0);
    const sch = new Scheduler(clock, H, async () => void calls.push(clock.now()), () => 0.5, () => interval);
    sch.start(1);
    await clock.advance(3 * MIN);
    interval = 5 * MIN;
    sch.reschedule(1);
    await clock.advance(0);
    expect(sch.info(1)!.nextAt).toBe(5 * MIN);
    await clock.advance(2 * MIN);
    expect(calls).toEqual([0, 5 * MIN]);
  });

  test('reschedule：新间隔已经过了，立刻跑', async () => {
    let interval = 10 * MIN;
    const calls: number[] = [];
    const clock = new FakeClock(0);
    const sch = new Scheduler(clock, H, async () => void calls.push(clock.now()), () => 0.5, () => interval);
    sch.start(1);
    await clock.advance(4 * MIN);
    interval = 2 * MIN;
    sch.reschedule(1);
    await clock.advance(0);
    expect(calls).toEqual([0, 4 * MIN]);
  });
});