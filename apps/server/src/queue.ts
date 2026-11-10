/**
 * queue.ts —— 轻量并发队列（进程内）
 *
 * 解决的具体问题：出卷 / 批改这类重活是同步等 LLM 的，
 * 并发一高就把进程占满，所有请求（包括健康检查）一起变慢。
 *
 * 职责边界（刻意做小）：
 * - **限并发**：同一时刻最多 N 个任务在跑，其余排队
 * - **限排队**：队列超过上限直接拒绝（快速失败，而不是无限堆积拖垮内存）
 * - **可观测**：`stats()` 给出 running / queued / completed / failed / rejected
 *
 * 不做持久化、不做跨进程——真要跨进程时换成一个外部队列即可，
 * 调用方的 `queue.run(fn)` 形态不用改。
 */

export class QueueFullError extends Error {
  constructor(message = 'queue is full') {
    super(message);
    this.name = 'QueueFullError';
  }
}

export interface QueueStats {
  name: string;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  rejected: number;
  concurrency: number;
  maxQueue: number;
}

interface Pending {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class TaskQueue {
  private readonly pending: Pending[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;
  private rejected = 0;

  constructor(private readonly opts: {
    name: string;
    concurrency: number;
    maxQueue: number;
  }) {
    if (opts.concurrency < 1) throw new Error('concurrency 必须 >= 1');
    if (opts.maxQueue < 0) throw new Error('maxQueue 必须 >= 0');
  }

  /** 提交任务；队列满时立刻 reject（QueueFullError），不排队等待 */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.opts.concurrency && this.pending.length >= this.opts.maxQueue) {
      this.rejected++;
      return Promise.reject(new QueueFullError(`${this.opts.name} 队列已满（${this.opts.maxQueue}）`));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ fn: fn as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
      this.drain();
    });
  }

  stats(): QueueStats {
    return {
      name: this.opts.name,
      running: this.running,
      queued: this.pending.length,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
      concurrency: this.opts.concurrency,
      maxQueue: this.opts.maxQueue,
    };
  }

  private drain(): void {
    while (this.running < this.opts.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.running++;
      void Promise.resolve()
        .then(job.fn)
        .then(
          (v) => { this.completed++; job.resolve(v); },
          (e) => { this.failed++; job.reject(e); },
        )
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}

/** 进程内队列注册表：便于运维接口一次性看到所有队列的水位 */
const registry = new Map<string, TaskQueue>();

export function createQueue(name: string, concurrency: number, maxQueue: number): TaskQueue {
  const q = new TaskQueue({ name, concurrency, maxQueue });
  registry.set(name, q);
  return q;
}

export function queueStats(): QueueStats[] {
  return [...registry.values()].map((q) => q.stats());
}
