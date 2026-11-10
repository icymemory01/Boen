/**
 * grading-metrics.ts —— 简答题 LLM 判分的评测指标（纯函数，可单测）
 *
 * 「LLM 判分准不准」不能靠感觉，需要一组固定样本 + 可复算的指标：
 * - MAE：与人工分的平均绝对误差（越小越接近教研口径）
 * - 在容差内的比例：教育场景通常 ±10 分即可接受
 * - 系统性偏差：模型平均分 − 人工平均分（正数说明整体给分偏松）
 * - 排序一致性：换成人话是「好答案有没有比差答案得分高」
 */
export interface GradingPair {
  /** 人工评分 0–100 */
  human: number;
  /** 模型评分 0–100 */
  model: number;
}

export interface GradingReport {
  samples: number;
  /** 平均绝对误差 */
  mae: number;
  /** 容差内（默认 ±10）比例，0–1 */
  withinTolerance: number;
  tolerance: number;
  /** 模型均分 − 人工均分（正 = 偏松） */
  bias: number;
  /** 最大误差 */
  maxError: number;
  /** 排序一致率：两两比较中模型与人工方向一致的比例 */
  rankingAgreement: number;
}

function clampScore(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

export function summarizeGrading(pairs: GradingPair[], tolerance = 10): GradingReport {
  const clean = pairs
    .filter((p) => p && Number.isFinite(p.human) && Number.isFinite(p.model))
    .map((p) => ({ human: clampScore(p.human), model: clampScore(p.model) }));

  if (clean.length === 0) {
    return { samples: 0, mae: 0, withinTolerance: 0, tolerance, bias: 0, maxError: 0, rankingAgreement: 0 };
  }

  const diffs = clean.map((p) => p.model - p.human);
  const mae = diffs.reduce((s, d) => s + Math.abs(d), 0) / clean.length;
  const withinTolerance = clean.filter((p) => Math.abs(p.model - p.human) <= tolerance).length / clean.length;
  const bias = diffs.reduce((s, d) => s + d, 0) / clean.length;
  const maxError = Math.max(...diffs.map(Math.abs));

  // 两两比较：只在人工分数不同时才有意义
  let comparable = 0;
  let agree = 0;
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const humanDiff = clean[i]!.human - clean[j]!.human;
      if (Math.abs(humanDiff) < 1e-9) continue;
      comparable++;
      const modelDiff = clean[i]!.model - clean[j]!.model;
      if (Math.sign(humanDiff) === Math.sign(modelDiff)) agree++;
    }
  }

  return {
    samples: clean.length,
    mae: Number(mae.toFixed(2)),
    withinTolerance: Number(withinTolerance.toFixed(4)),
    tolerance,
    bias: Number(bias.toFixed(2)),
    maxError: Number(maxError.toFixed(2)),
    rankingAgreement: comparable === 0 ? 1 : Number((agree / comparable).toFixed(4)),
  };
}
