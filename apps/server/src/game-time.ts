/**
 * game-time.ts —— 游戏用的时间边界（纯函数，可单测）
 *
 * 全站统计口径统一走北京时间（UTC+8，无夏令时）：
 * - 每日挑战 / 今日局数按「北京时间自然日」切分
 * - 排行榜按「北京时间自然周（周一 00:00）」切分，而不是滚动 168 小时
 */

export const TZ_OFFSET = 8 * 3600;

/** 北京时间当天 00:00 的 epoch 秒 */
export function startOfBeijingDay(nowMs = Date.now()): number {
  const shifted = Math.floor(nowMs / 1000) + TZ_OFFSET;
  return shifted - (shifted % 86400) - TZ_OFFSET;
}

/** 本周一 00:00（北京时间）的 epoch 秒 */
export function startOfBeijingWeek(nowMs = Date.now()): number {
  const dayStart = startOfBeijingDay(nowMs);
  // 1970-01-01 是周四 → 距上一个周一 3 天
  const daysSinceEpoch = Math.floor((dayStart + TZ_OFFSET) / 86400);
  const daysSinceMonday = (((daysSinceEpoch + 3) % 7) + 7) % 7;
  return dayStart - daysSinceMonday * 86400;
}

/** 北京时间 YYYY-MM-DD */
export function beijingDateStr(nowMs = Date.now()): string {
  return new Date(nowMs + TZ_OFFSET * 1000).toISOString().slice(0, 10);
}
