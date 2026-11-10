/**
 * calibration-store.ts —— 逐次口径的校准样本读写
 *
 * 与 calibration.ts 的分工：那边是纯数学（Brier / ECE / 分箱），这边只碰数据库。
 */
import db from './db.js';
import { expectedCorrectRate, type CalibrationSample } from './calibration.js';

export interface StoredSample extends CalibrationSample {
  userId: string;
  kgNodeId: number;
  source: string;
  createdAt: number;
}

/**
 * 记录一次「作答前的预测 vs 作答后的实际」。
 * 必须在 `updateProficiency` **之前**调用：拿到的是更新前的 rating，才是真正的预测。
 */
export function recordCalibrationSample(params: {
  userId: string;
  kgNodeId: number;
  /** 作答前的 rating（拿不到就按 0 处理） */
  ratingBefore: number | null | undefined;
  correct: boolean;
  source?: string;
  /** 题目难度（0–100），默认 50 */
  difficulty?: number;
}): void {
  try {
    const predicted = expectedCorrectRate(params.ratingBefore ?? 0, params.difficulty ?? 50);
    db.prepare(`
      INSERT INTO calibration_samples (user_id, kg_node_id, predicted, actual, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.kgNodeId,
      Number(predicted.toFixed(4)),
      params.correct ? 1 : 0,
      params.source ?? 'game',
    );
  } catch {
    // 校准埋点不能影响主流程（作答结算）
  }
}

/** 读取逐次样本（可按用户过滤，默认取最近 5000 条） */
export function listCalibrationSamples(options: { userId?: string; limit?: number } = {}): StoredSample[] {
  const limit = Math.min(50_000, Math.max(1, options.limit ?? 5000));
  const rows = (options.userId
    ? db.prepare(`
        SELECT user_id, kg_node_id, predicted, actual, source, created_at
        FROM calibration_samples WHERE user_id=? ORDER BY id DESC LIMIT ?
      `).all(options.userId, limit)
    : db.prepare(`
        SELECT user_id, kg_node_id, predicted, actual, source, created_at
        FROM calibration_samples ORDER BY id DESC LIMIT ?
      `).all(limit)) as Array<{
        user_id: string; kg_node_id: number; predicted: number; actual: number; source: string; created_at: number;
      }>;

  return rows.map((r) => ({
    userId: r.user_id,
    kgNodeId: r.kg_node_id,
    predicted: r.predicted,
    actual: r.actual === 1,
    source: r.source,
    createdAt: r.created_at,
  }));
}

/** 逐次样本条数（用于脚本判断是否已积累足够数据） */
export function countCalibrationSamples(userId?: string): number {
  const row = (userId
    ? db.prepare(`SELECT COUNT(*) AS n FROM calibration_samples WHERE user_id=?`).get(userId)
    : db.prepare(`SELECT COUNT(*) AS n FROM calibration_samples`).get()) as { n: number } | undefined;
  return row?.n ?? 0;
}
