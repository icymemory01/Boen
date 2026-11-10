/**
 * calibration.ts —— 学习画像的校准度（纯函数，可单测）
 *
 * 画像最怕「自己说自己准」。这里用两个标准指标量化：
 * - **Brier 分数**：Σ(p − y)² / n，越小越好（0 = 完美，0.25 = 永远猜 0.5）；
 * - **可靠性曲线（分箱）**：把预测概率分箱，比较每箱的「预测均值 vs 实际正确率」，
 *   两者接近说明概率是有意义的，而不是随口给的信心值。
 */

export interface CalibrationSample {
  /** 模型/画像预测的答对概率 0–1 */
  predicted: number;
  /** 实际是否答对 */
  actual: boolean;
}

export interface CalibrationBin {
  /** 区间下界（含） */
  from: number;
  /** 区间上界（不含） */
  to: number;
  count: number;
  /** 该箱平均预测概率 */
  predictedMean: number;
  /** 该箱实际正确率 */
  actualRate: number;
}

export interface CalibrationReport {
  samples: number;
  brier: number;
  /** 预测均值（应接近总体正确率） */
  predictedMean: number;
  actualRate: number;
  bins: CalibrationBin[];
  /** 平均绝对校准误差（各箱 |predictedMean − actualRate| 的加权平均） */
  ece: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 计算校准报告。
 * @param samples 样本（预测概率 + 实际结果）
 * @param binCount 分箱数，默认 5 箱
 */
export function calibrate(samples: CalibrationSample[], binCount = 5): CalibrationReport {
  const clean = samples
    .filter((s) => Number.isFinite(s.predicted))
    .map((s) => ({ predicted: clamp01(s.predicted), actual: !!s.actual }));

  if (clean.length === 0) {
    return { samples: 0, brier: 0, predictedMean: 0, actualRate: 0, bins: [], ece: 0 };
  }

  const brier = clean.reduce((sum, s) => sum + (s.predicted - (s.actual ? 1 : 0)) ** 2, 0) / clean.length;
  const predictedMean = clean.reduce((sum, s) => sum + s.predicted, 0) / clean.length;
  const actualRate = clean.filter((s) => s.actual).length / clean.length;

  const bins: CalibrationBin[] = [];
  const width = 1 / binCount;
  for (let i = 0; i < binCount; i++) {
    const from = i * width;
    const to = i === binCount - 1 ? 1.000001 : (i + 1) * width; // 最后一箱含 1
    const inBin = clean.filter((s) => s.predicted >= from && s.predicted < to);
    if (inBin.length === 0) {
      bins.push({ from, to: Math.min(1, to), count: 0, predictedMean: 0, actualRate: 0 });
      continue;
    }
    bins.push({
      from,
      to: Math.min(1, to),
      count: inBin.length,
      predictedMean: inBin.reduce((sum, s) => sum + s.predicted, 0) / inBin.length,
      actualRate: inBin.filter((s) => s.actual).length / inBin.length,
    });
  }

  const ece = bins.reduce((sum, b) => sum + (b.count / clean.length) * Math.abs(b.predictedMean - b.actualRate), 0);

  return { samples: clean.length, brier, predictedMean, actualRate, bins, ece };
}

/**
 * 把连续评分折算成「答对概率」，用于和画像对比。
 * 采用 Elo 期望胜率公式：p = 1 / (1 + 10^((难度 − 能力) / 40))。
 * 这里的 40 是教育测评中常用的缩放常数（约 400 分对应 10 倍胜率）。
 */
export function expectedCorrectRate(rating: number, difficulty = 50): number {
  return clamp01(1 / (1 + 10 ** ((difficulty - rating) / 40)));
}
