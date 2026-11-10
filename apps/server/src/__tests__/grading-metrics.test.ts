/**
 * 判分评测的指标与评测集校验。
 *
 * 指标本身必须可手算复现，否则「我们的 LLM 判分和人工差 8 分」这种结论没有意义；
 * 评测集本身也要有校验，避免样本缺字段或分数越界导致指标失真。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeGrading } from '../grading-metrics.js';

describe('summarizeGrading', () => {
  it('空样本返回全 0，不产生 NaN', () => {
    const r = summarizeGrading([]);
    expect(r.samples).toBe(0);
    for (const k of ['mae', 'bias', 'maxError', 'withinTolerance', 'rankingAgreement'] as const) {
      expect(Number.isFinite(r[k]), k).toBe(true);
    }
  });

  it('完全一致：MAE 0、容差内 100%、偏差 0、排序一致 100%', () => {
    const r = summarizeGrading([{ human: 90, model: 90 }, { human: 60, model: 60 }, { human: 75, model: 75 }]);
    expect(r.mae).toBe(0);
    expect(r.withinTolerance).toBe(1);
    expect(r.bias).toBe(0);
    expect(r.rankingAgreement).toBe(1);
  });

  it('偏差正负抵消时的 MAE 与偏差（手算可复现）', () => {
    // 差 -10 与 +10 → MAE 10，偏差 0
    const r = summarizeGrading([{ human: 100, model: 90 }, { human: 60, model: 70 }], 10);
    expect(r.mae).toBe(10);
    expect(r.bias).toBe(0);
    expect(r.maxError).toBe(10);
    expect(r.withinTolerance).toBe(1);
  });

  it('整体给分偏松会被 bias 抓到', () => {
    const r = summarizeGrading([{ human: 80, model: 95 }, { human: 80, model: 95 }], 10);
    expect(r.bias).toBe(15);
    expect(r.mae).toBe(15);
    expect(r.withinTolerance).toBe(0);
  });

  it('人工分相同不参与排序比较，排序一致率按 1 处理', () => {
    const r = summarizeGrading([{ human: 80, model: 60 }, { human: 80, model: 95 }]);
    expect(r.rankingAgreement).toBe(1);
  });

  it('排序被完全颠倒时一致率为 0', () => {
    const r = summarizeGrading([
      { human: 90, model: 50 },
      { human: 60, model: 80 },
      { human: 30, model: 95 },
    ]);
    expect(r.rankingAgreement).toBe(0);
  });

  it('越界分数被裁剪到 0–100', () => {
    const r = summarizeGrading([{ human: 100, model: 150 }, { human: 0, model: -20 }]);
    expect(r.maxError).toBeLessThanOrEqual(100);
    expect(r.samples).toBe(2);
  });

  it('自定义容差生效', () => {
    const pairs = [{ human: 70, model: 88 }];
    expect(summarizeGrading(pairs, 10).withinTolerance).toBe(0);
    expect(summarizeGrading(pairs, 20).withinTolerance).toBe(1);
    expect(summarizeGrading(pairs, 20).tolerance).toBe(20);
  });
});

describe('评测集（golden set）', () => {
  const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/grading-golden.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    version: string;
    items: Array<{ id: string; subject: string; grade: string; stem: string; reference: string; studentAnswer: string; humanScore: number }>;
  };

  it('样本数量足够做初步评测', () => {
    expect(fixture.items.length).toBeGreaterThanOrEqual(10);
  });

  it('字段完整、id 唯一、人工分在 0–100', () => {
    const ids = new Set<string>();
    for (const it of fixture.items) {
      expect(it.id, 'id 缺失').toBeTruthy();
      expect(ids.has(it.id), `id 重复：${it.id}`).toBe(false);
      ids.add(it.id);
      expect(it.stem.length, `${it.id} 题干为空`).toBeGreaterThan(1);
      expect(it.reference.length, `${it.id} 参考答案为空`).toBeGreaterThan(1);
      expect(typeof it.studentAnswer, `${it.id} 缺学生作答`).toBe('string');
      expect(it.humanScore, `${it.id} 人工分越界`).toBeGreaterThanOrEqual(0);
      expect(it.humanScore, `${it.id} 人工分越界`).toBeLessThanOrEqual(100);
    }
  });

  it('覆盖多学科与多个分数段（避免只测高分或只测单一学科）', () => {
    const subjects = new Set(fixture.items.map((i) => i.subject));
    expect(subjects.size).toBeGreaterThanOrEqual(3);
    expect(fixture.items.some((i) => i.humanScore < 50)).toBe(true);
    expect(fixture.items.some((i) => i.humanScore >= 80)).toBe(true);
  });
});
