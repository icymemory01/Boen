/**
 * 计分规则与北京时间边界的纯函数单测。
 *
 * 周榜口径最容易悄悄错（滚动 7 天 vs 自然周），所以用 Intl 独立算一遍星期几交叉验证，
 * 而不是把期望值硬编码成日期字符串。
 */
import { describe, it, expect } from 'vitest';
import { computeGamePoints, GAME_POINTS_MAX } from '../game-core.js';
import { startOfBeijingDay, startOfBeijingWeek, beijingDateStr } from '../game-time.js';

const DAY = 86400;

/** 用 Intl 独立求某时刻在北京时间下的星期（'Mon' 等） */
function beijingWeekday(epochSec: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' })
    .format(new Date(epochSec * 1000));
}

/** 用 Intl 独立求某时刻的北京日期 YYYY-MM-DD */
function beijingDate(epochSec: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochSec * 1000));
}

describe('computeGamePoints', () => {
  it('没答对或没有题目时不给分', () => {
    expect(computeGamePoints(0, 10)).toBe(0);
    expect(computeGamePoints(3, 0)).toBe(0);
    expect(computeGamePoints(0, 0)).toBe(0);
  });

  it('答对 3 分/题', () => {
    expect(computeGamePoints(4, 5)).toBe(12);
    expect(computeGamePoints(1, 10)).toBe(3);
  });

  it('满分额外 +8（至少 3 题）', () => {
    expect(computeGamePoints(5, 5)).toBe(15 + 8);
    // 只有 2 题不算满分奖励
    expect(computeGamePoints(2, 2)).toBe(6);
  });

  it('连击奖励每 3 连 +2，最多 +6', () => {
    expect(computeGamePoints(5, 5, 3)).toBe(15 + 8 + 2);
    expect(computeGamePoints(10, 10, 9)).toBe(30 + 8 + 6);
    expect(computeGamePoints(10, 10, 30)).toBe(30 + 8 + 6);
  });

  it('单局封顶', () => {
    expect(computeGamePoints(50, 50, 50)).toBe(GAME_POINTS_MAX);
    expect(computeGamePoints(1000, 1000)).toBe(GAME_POINTS_MAX);
  });
});

describe('北京时间边界', () => {
  // 覆盖一年、每 6 小时一个采样点，含跨月 / 跨年 / 周末
  const samples: number[] = [];
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let h = 0; h < 366 * 24; h += 6) samples.push(base + h * 3600 * 1000);

  it('startOfBeijingDay 落在北京时区 00:00，且不晚于当前时刻', () => {
    for (const ms of samples) {
      const day = startOfBeijingDay(ms);
      expect(day).toBeLessThanOrEqual(Math.floor(ms / 1000));
      expect(Math.floor(ms / 1000) - day).toBeLessThan(DAY);
      // 北京时间 00:00 ⇔ (epoch + 8h) 能被 86400 整除
      expect((day + 8 * 3600) % DAY).toBe(0);
    }
  });

  it('beijingDateStr 与 Intl 结果一致', () => {
    for (const ms of samples) {
      expect(beijingDateStr(ms)).toBe(beijingDate(Math.floor(ms / 1000)));
    }
  });

  it('startOfBeijingWeek 是本周一 00:00（自然周，不是滚动 7 天）', () => {
    for (const ms of samples) {
      const nowSec = Math.floor(ms / 1000);
      const week = startOfBeijingWeek(ms);
      expect(week).toBeLessThanOrEqual(nowSec);
      expect(nowSec - week).toBeLessThan(7 * DAY);
      expect((week + 8 * 3600) % DAY).toBe(0);
      // 独立验证：这一天的北京星期必须是周一
      expect(beijingWeekday(week)).toBe('Mon');
    }
  });

  it('周日属于上一个周一所在的那一周（而不是新的一周）', () => {
    // 找几个落在周日的时刻
    const sundays = samples.filter((ms) => beijingWeekday(Math.floor(ms / 1000)) === 'Sun').slice(0, 5);
    expect(sundays.length).toBeGreaterThan(0);
    for (const ms of sundays) {
      const week = startOfBeijingWeek(ms);
      const diffDays = Math.round((startOfBeijingDay(ms) - week) / DAY);
      expect(diffDays).toBe(6); // 周一…周日 → 偏移 6 天
      expect(beijingWeekday(week)).toBe('Mon');
    }
  });
});
