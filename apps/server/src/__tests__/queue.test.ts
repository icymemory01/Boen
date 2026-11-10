/**
 * 并发队列的行为测试。
 *
 * 队列最容易错的地方不是「跑不跑」，而是：
 * - 并发超限（本来要保护进程，结果自己把进程打满）
 * - 队满不该静默挂起（必须快速失败）
 * - 任务抛错后槽位没释放（一次失败让队列永久卡死）
 */
import { describe, it, expect } from 'vitest';
import { TaskQueue, QueueFullError, createQueue, queueStats } from '../queue.js';

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TaskQueue', () => {
  it('并发不超过上限', async () => {
    const q = new TaskQueue({ name: 't1', concurrency: 2, maxQueue: 10 });
    let peak = 0;
    let running = 0;
    const jobs = Array.from({ length: 8 }, () =>
      q.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(8);
        running--;
      }));
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(2);
    expect(q.stats().completed).toBe(8);
    expect(q.stats().running).toBe(0);
    expect(q.stats().queued).toBe(0);
  });

  it('按提交顺序执行（FIFO）', async () => {
    const q = new TaskQueue({ name: 't2', concurrency: 1, maxQueue: 10 });
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) => q.run(async () => { order.push(n); })),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('队满时快速失败，不无限堆积', async () => {
    const q = new TaskQueue({ name: 't3', concurrency: 1, maxQueue: 1 });
    const blocker = q.run(() => delay(30));
    const queued = q.run(() => delay(1));          // 占满队列
    const overflow = q.run(() => delay(1));        // 应立刻拒绝
    await expect(overflow).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all([blocker, queued]);
    expect(q.stats().rejected).toBe(1);
  });

  it('任务抛错后槽位释放，后续任务不受影响', async () => {
    const q = new TaskQueue({ name: 't4', concurrency: 1, maxQueue: 2 });
    await expect(q.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await q.run(async () => 'fine');
    expect(ok).toBe('fine');
    expect(q.stats().failed).toBe(1);
    expect(q.stats().completed).toBe(1);
  });

  it('返回值透传', async () => {
    const q = new TaskQueue({ name: 't5', concurrency: 2, maxQueue: 4 });
    await expect(q.run(async () => 42)).resolves.toBe(42);
  });

  it('注册表能汇总多个队列', () => {
    createQueue('reg-a', 1, 1);
    createQueue('reg-b', 2, 2);
    const all = queueStats();
    expect(all.some((s) => s.name === 'reg-a')).toBe(true);
    expect(all.some((s) => s.name === 'reg-b')).toBe(true);
  });

  it('非法配置直接抛错', () => {
    expect(() => new TaskQueue({ name: 'bad', concurrency: 0, maxQueue: 1 })).toThrow();
    expect(() => new TaskQueue({ name: 'bad', concurrency: 1, maxQueue: -1 })).toThrow();
  });
});
