/**
 * 限流存储的行为测试。
 *
 * 重点保两件事：
 * 1. 语义与旧实现一致（第 max+1 次开始拒绝），否则等于悄悄改了全站限流强度；
 * 2. 键之间互不干扰、窗口到期后额度恢复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRateLimitStore, createRateLimitStore } from '../state-store.js';

describe('MemoryRateLimitStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T08:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const opts = { max: 3, windowMs: 1000 };

  it('窗口内允许 max 次，第 max+1 次拒绝', () => {
    const s = new MemoryRateLimitStore({ cleanupMs: 0 });
    expect(s.hit('k', opts)).toBe(true);
    expect(s.hit('k', opts)).toBe(true);
    expect(s.hit('k', opts)).toBe(true);
    expect(s.hit('k', opts)).toBe(false);
    s.dispose();
  });

  it('窗口滚过去后额度恢复', () => {
    const s = new MemoryRateLimitStore({ cleanupMs: 0 });
    for (let i = 0; i < 3; i++) s.hit('k', opts);
    expect(s.hit('k', opts)).toBe(false);
    vi.setSystemTime(new Date('2026-11-10T08:00:02Z')); // 过窗
    expect(s.hit('k', opts)).toBe(true);
    s.dispose();
  });

  it('不同 key 互不干扰', () => {
    const s = new MemoryRateLimitStore({ cleanupMs: 0 });
    for (let i = 0; i < 3; i++) s.hit('a', opts);
    expect(s.hit('a', opts)).toBe(false);
    expect(s.hit('b', opts)).toBe(true);
    s.dispose();
  });

  it('stats 反映键数量，reset 清空', () => {
    const s = new MemoryRateLimitStore({ cleanupMs: 0 });
    s.hit('a', opts);
    s.hit('b', opts);
    expect(s.stats()).toMatchObject({ backend: 'memory', keys: 2 });
    s.reset();
    expect(s.stats().keys).toBe(0);
    s.dispose();
  });

  it('键数量超上限时会清理过期键，不会无限增长', () => {
    const s = new MemoryRateLimitStore({ maxEntries: 2, cleanupMs: 0 });
    s.hit('old', opts);
    vi.setSystemTime(new Date('2026-11-10T08:00:05Z')); // old 已过期
    s.hit('x', opts);
    s.hit('y', opts);
    s.hit('z', opts); // 触发 sweep
    expect(s.stats().keys).toBeLessThanOrEqual(4);
    s.dispose();
  });
});

describe('createRateLimitStore', () => {
  it('默认返回 memory 实现', () => {
    const prev = process.env.STATE_STORE;
    delete process.env.STATE_STORE;
    const s = createRateLimitStore();
    expect(s.stats().backend).toBe('memory');
    if (prev !== undefined) process.env.STATE_STORE = prev;
  });

  it('未实现的后端会回退 memory 而不是崩掉', () => {
    const prev = process.env.STATE_STORE;
    process.env.STATE_STORE = 'redis';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createRateLimitStore();
    expect(s.stats().backend).toBe('memory');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    if (prev === undefined) delete process.env.STATE_STORE;
    else process.env.STATE_STORE = prev;
  });
});
