/**
 * 知识跑酷出题引擎的纯逻辑单测。
 *
 * 重点覆盖历史 P0 缺陷：
 * - 旧实现用「此选项无效」把不足 4 个的选项补满 → 学生看到 3 个假选项
 * - 旧实现把无法解析的 correctKey 猜成 'A' → 答案随机
 * - 旧实现按「选项文本」重新定位正确答案 → 文本重复时答案错位
 */
import { describe, it, expect } from 'vitest';
import {
  LANE_COUNT,
  GAME_SUBJECTS,
  parseLLMQuestion,
  shuffleByIndex,
  getFallbackQuestion,
  gradeBand,
  fallbackBankSize,
  type GameOption,
} from '../game-core.js';
import { BANK } from '../game-bank.js';

/** 构造一份合法的 LLM 返回 */
function payload(options: unknown[], correctKey: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ stem: '测试题干是什么？', options, correctKey, ...extra });
}

const OPTS4 = [
  { key: 'A', text: '选项一' },
  { key: 'B', text: '选项二' },
  { key: 'C', text: '选项三' },
  { key: 'D', text: '选项四' },
];

describe('parseLLMQuestion — 不合格题目一律丢弃', () => {
  it('选项少于 4 个时返回 null（不再用占位符补位）', () => {
    expect(parseLLMQuestion(payload(OPTS4.slice(0, 3), 'A'))).toBeNull();
  });

  it('选项多于 4 个时返回 null（不再截断可能丢掉正确答案）', () => {
    expect(parseLLMQuestion(payload([...OPTS4, { key: 'E', text: '选项五' }], 'A'))).toBeNull();
  });

  it('题干缺失时返回 null', () => {
    expect(parseLLMQuestion(JSON.stringify({ options: OPTS4, correctKey: 'A' }))).toBeNull();
  });

  it('答案无法解析时返回 null（绝不猜 A）', () => {
    expect(parseLLMQuestion(payload(OPTS4, 'Z'))).toBeNull();
    expect(parseLLMQuestion(payload(OPTS4, ''))).toBeNull();
    expect(parseLLMQuestion(JSON.stringify({ stem: '题干', options: OPTS4 }))).toBeNull();
  });

  it('文字残缺（非 JSON）时返回 null', () => {
    expect(parseLLMQuestion('抱歉，我无法出题')).toBeNull();
    expect(parseLLMQuestion('{ 不是合法 JSON ')).toBeNull();
  });

  it('重复选项导致有效选项不足时返回 null', () => {
    const dup = [
      { key: 'A', text: '此选项无效' },
      { key: 'B', text: '此选项无效' },
      { key: 'C', text: '此选项无效' },
      { key: 'D', text: '选项四' },
    ];
    expect(parseLLMQuestion(payload(dup, 'D'))).toBeNull();
  });
});

describe('parseLLMQuestion — 合格题目正确解析', () => {
  it('解析带 markdown 代码块的返回', () => {
    const raw = '```json\n' + payload(OPTS4, 'C', { explain: '因为三比二大' }) + '\n```';
    const q = parseLLMQuestion(raw);
    expect(q).not.toBeNull();
    expect(q!.options).toHaveLength(LANE_COUNT);
    expect(q!.options[q!.correctIndex]!.text).toBe('选项三');
    expect(q!.explain).toBe('因为三比二大');
  });

  it('支持纯字符串选项与 correctIndex 数字', () => {
    const q = parseLLMQuestion(JSON.stringify({ stem: '题干在这里', options: ['甲', '乙', '丙', '丁'], correctIndex: 1 }));
    expect(q).not.toBeNull();
    expect(q!.options[q!.correctIndex]!.text).toBe('乙');
  });

  it('支持用 answer 字段给出选项全文', () => {
    const q = parseLLMQuestion(JSON.stringify({ stem: '题干在这里', options: ['甲', '乙', '丙', '丁'], answer: '丙' }));
    expect(q).not.toBeNull();
    expect(q!.options[q!.correctIndex]!.text).toBe('丙');
  });

  it('选项 key 一律被重排为 A/B/C/D', () => {
    const q = parseLLMQuestion(payload(OPTS4, 'B'))!;
    expect(q.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('shuffleByIndex — 正确答案跟随选项移动', () => {
  it('洗牌后 correctKey 始终指向正确文本', () => {
    const base: GameOption[] = ['a', 'b', 'c', 'd'].map((t, i) => ({ key: String.fromCharCode(65 + i), text: t }));
    for (const correctIndex of [0, 1, 2, 3]) {
      for (let round = 0; round < 100; round++) {
        const { options, correctKey } = shuffleByIndex(base, correctIndex);
        expect(options).toHaveLength(4);
        expect(options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
        // 文本集合不变、且 correctKey 指向原正确项
        expect([...options].map((o) => o.text).sort()).toEqual(['a', 'b', 'c', 'd']);
        expect(options.find((o) => o.key === correctKey)!.text).toBe(base[correctIndex]!.text);
      }
    }
  });

  it('文本完全相同的选项也不会错位（旧实现按文本匹配会中招）', () => {
    const base: GameOption[] = [
      { key: 'A', text: '同文本' },
      { key: 'B', text: '同文本' },
      { key: 'C', text: '其它' },
      { key: 'D', text: '别的' },
    ];
    // 正确项是索引 1 的那一个；洗牌后 correctKey 必须落在它的新位置
    for (let round = 0; round < 50; round++) {
      const { options, correctKey } = shuffleByIndex(base, 1);
      const idx = options.findIndex((o) => o.key === correctKey);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    }
  });
});

describe('兜底题库', () => {
  it('每个学科 / 学段都能出合法题目', () => {
    for (const subject of GAME_SUBJECTS) {
      for (const grade of ['1', '6', '7', '9', 'high', 'college']) {
        const q = getFallbackQuestion(subject, grade);
        expect(q.stem.length).toBeGreaterThan(0);
        expect(q.options).toHaveLength(LANE_COUNT);
        expect(new Set(q.options.map((o) => o.text)).size).toBe(LANE_COUNT);
        expect(['A', 'B', 'C', 'D']).toContain(q.correctKey);
        expect(q.options.some((o) => o.key === q.correctKey)).toBe(true);
        expect(q.explain).toBeTruthy();
      }
    }
  });

  it('小学与初中使用不同题库（年级分层生效）', () => {
    expect(gradeBand('3')).toBe('primary');
    expect(gradeBand('8')).toBe('middle');
    expect(gradeBand('high')).toBe('middle');
    expect(gradeBand(undefined)).toBe('middle');

    expect(fallbackBankSize('math', '3')).toBeGreaterThanOrEqual(50);
    expect(fallbackBankSize('math', '8')).toBeGreaterThanOrEqual(50);

    // 直接断言题库内容，不用随机抽样（抽样可能恰好抽不到某一题）
    const primary = BANK.math.primary.map((q) => q.stem);
    const middle = BANK.math.middle.map((q) => q.stem);
    expect(primary.some((s) => s.includes('平方根') || s.includes('长方形'))).toBe(true);
    expect(primary.some((s) => s.includes('等差数列') || s.includes('x²'))).toBe(false);
    expect(middle.some((s) => s.includes('等差数列'))).toBe(true);
    expect(middle.some((s) => s.includes('平方根') || s.includes('长方形'))).toBe(false);
  });
});
