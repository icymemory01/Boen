/**
 * 画像校准度计算单测。
 *
 * 校准报告是用来「自证画像不是玄学」的，所以数学本身必须正确：
 * - 完美预测 Brier = 0；
 * - 恒定猜 0.5 的 Brier = 0.25；
 * - 分箱后的加权误差（ECE）要和手算一致。
 */
import { describe, it, expect } from 'vitest';
import { calibrate, expectedCorrectRate } from '../calibration.js';

const yes = (p: number) => ({ predicted: p, actual: true });
const no = (p: number) => ({ predicted: p, actual: false });

describe('calibrate', () => {
  it('空样本返回零值而不是 NaN', () => {
    const r = calibrate([]);
    expect(r.samples).toBe(0);
    expect(Number.isFinite(r.brier)).toBe(true);
    expect(r.bins).toHaveLength(0);
  });

  it('完美预测的 Brier 为 0', () => {
    const r = calibrate([yes(1), no(0), yes(1), no(0)]);
    expect(r.brier).toBe(0);
    expect(r.ece).toBe(0);
    expect(r.actualRate).toBe(0.5);
  });

  it('恒定猜 0.5 的 Brier 为 0.25', () => {
    const r = calibrate([yes(0.5), no(0.5), yes(0.5), no(0.5)]);
    expect(r.brier).toBeCloseTo(0.25, 10);
    expect(r.ece).toBeCloseTo(0.0, 10); // 预测均值 0.5 = 实际 0.5，校准反而很好
  });

  it('系统高估（预测 0.9 但全错）会被 ECE 抓到', () => {
    const r = calibrate([no(0.9), no(0.9), no(0.9), no(0.9)]);
    expect(r.predictedMean).toBeCloseTo(0.9, 10);
    expect(r.actualRate).toBe(0);
    expect(r.ece).toBeCloseTo(0.9, 10);
    expect(r.brier).toBeCloseTo(0.81, 10);
  });

  it('分箱统计与加权误差和手算一致', () => {
    // 3 个样本落在 [0.8,1)，其中 2 对 1 错 → 实际 2/3，预测均值 0.9
    const r = calibrate([yes(0.9), yes(0.9), no(0.9)], 5);
    const bin = r.bins[4]!;
    expect(bin.count).toBe(3);
    expect(bin.predictedMean).toBeCloseTo(0.9, 10);
    expect(bin.actualRate).toBeCloseTo(2 / 3, 10);
    expect(r.ece).toBeCloseTo(Math.abs(0.9 - 2 / 3), 10);
  });

  it('概率 1 归入最后一箱（边界处理）', () => {
    const r = calibrate([yes(1)], 5);
    expect(r.bins[4]!.count).toBe(1);
    expect(r.bins.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it('非法预测值被裁剪/剔除', () => {
    const r = calibrate([{ predicted: Number.NaN, actual: true }, { predicted: 2, actual: true }, yes(0.5)]);
    expect(r.samples).toBe(2);
    expect(r.predictedMean).toBeGreaterThanOrEqual(0);
    expect(r.predictedMean).toBeLessThanOrEqual(1);
  });
});

describe('expectedCorrectRate', () => {
  it('能力等于难度时答对率是 0.5', () => {
    expect(expectedCorrectRate(50, 50)).toBeCloseTo(0.5, 10);
  });

  it('能力越高答对率越高，且落在 (0,1)', () => {
    const low = expectedCorrectRate(20, 60);
    const mid = expectedCorrectRate(60, 60);
    const high = expectedCorrectRate(95, 60);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});
