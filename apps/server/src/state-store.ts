/**
 * state-store.ts —— 进程内状态的存储抽象
 *
 * 现状：限流计数、令牌缓存等都是**进程内 Map**。这在 pm2 单进程下没问题，
 * 一旦上多实例 / cluster，每个 worker 各记一份，限流就等于没有。
 *
 * 本文件是给这件事留的**换出口**：调用方只依赖 `RateLimitStore` 接口，
 * 以后接 Redis 只需新增一个实现并在 `createRateLimitStore()` 里分支，
 * 业务代码一行不用动。
 *
 * 注意：`STATE_STORE` 目前只有 `memory` 一种实现；配了别的值会**明确告警并回退**，
 * 不会静默降级成「以为接了 Redis 其实没接」。
 */

export interface RateLimitOptions {
  /** 窗口内允许的最大次数 */
  max: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
}

export interface RateLimitStore {
  /** 记一次请求；返回 false 表示本次应被限流 */
  hit(key: string, opts: RateLimitOptions): boolean;
  /** 当前存储水位（运维用） */
  stats(): { backend: string; keys: number };
  reset(): void;
}

export interface MemoryRateLimitStoreOptions {
  /** 键数量上限，超过时清理过期键 */
  maxEntries?: number;
  /** 后台清理间隔（毫秒），传 0 关掉定时器（测试用） */
  cleanupMs?: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, number[]>();
  private readonly maxEntries: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MemoryRateLimitStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    const cleanupMs = opts.cleanupMs ?? 5 * 60_000;
    if (cleanupMs > 0) {
      this.timer = setInterval(() => this.sweep(60_000), cleanupMs);
      // 不要因为一个定时器把进程钉住
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  hit(key: string, opts: RateLimitOptions): boolean {
    const now = Date.now();
    // 键太多时先清一遍过期键，避免长期运行内存膨胀
    if (this.map.size > this.maxEntries) this.sweep(opts.windowMs);

    const timestamps = this.map.get(key) ?? [];
    timestamps.push(now);
    const recent = timestamps.filter((t) => now - t < opts.windowMs);
    this.map.set(key, recent);
    // 与旧实现语义一致：第 max+1 次开始拒绝
    return recent.length <= opts.max;
  }

  stats(): { backend: string; keys: number } {
    return { backend: 'memory', keys: this.map.size };
  }

  reset(): void {
    this.map.clear();
  }

  /** 停止后台清理定时器（测试或优雅退出时用） */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sweep(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [k, ts] of this.map) {
      const active = ts.filter((t) => t > cutoff);
      if (active.length === 0) this.map.delete(k);
      else this.map.set(k, active);
    }
  }
}

/**
 * 按环境变量选择实现。
 * 未实现的后端（如 redis）会打印告警并回退 memory，避免线上误判。
 */
export function createRateLimitStore(): RateLimitStore {
  const backend = (process.env.STATE_STORE ?? 'memory').trim().toLowerCase();
  if (backend === 'memory' || backend === '') return new MemoryRateLimitStore();
  console.warn(
    `[state] STATE_STORE=${backend} 尚未实现，已回退为 memory。` +
    '多实例部署前请补齐分布式实现，否则限流在各进程间不共享。',
  );
  return new MemoryRateLimitStore();
}
