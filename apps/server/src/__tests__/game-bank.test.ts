/**
 * 题库完整性单测：题库是「学生看到的题目」本身，必须逐条可校验。
 *
 * 覆盖：数量下限、题干唯一、选项 4 个且互不相同、答案下标合法、解析齐全，
 * 以及选项里不应出现占位/疑问残渣（曾经手写出过 “rain?” 这种脏数据）。
 */
import { describe, it, expect } from 'vitest';
import { GAME_SUBJECTS } from '@boen/shared';
import { BANK } from '../game-bank.js';
import { fallbackBankSize } from '../game-core.js';

const BANDS = ['primary', 'middle'] as const;
const MIN_PER_BAND = 50;

describe('题库完整性', () => {
  for (const subject of GAME_SUBJECTS) {
    for (const band of BANDS) {
      const items = BANK[subject][band];

      it(`${subject}/${band} 至少有 ${MIN_PER_BAND} 道题`, () => {
        expect(items.length).toBeGreaterThanOrEqual(MIN_PER_BAND);
        expect(fallbackBankSize(subject, band === 'primary' ? '3' : '8')).toBe(items.length);
      });

      it(`${subject}/${band} 题干互不重复`, () => {
        const stems = items.map((q) => q.stem);
        expect(new Set(stems).size).toBe(stems.length);
      });

      it(`${subject}/${band} 每题都有 4 个互不相同的选项与合法答案`, () => {
        items.forEach((q, i) => {
          const where = `${subject}/${band} #${i} ${q.stem}`;
          expect(q.stem.trim().length, where).toBeGreaterThan(1);
          expect(q.options.length, where).toBe(4);
          expect(q.options.every((o) => typeof o === 'string' && o.trim().length > 0), where).toBe(true);
          expect(new Set(q.options).size, `${where} 选项重复`).toBe(4);
          expect(Number.isInteger(q.correctIndex), where).toBe(true);
          expect(q.correctIndex, where).toBeGreaterThanOrEqual(0);
          expect(q.correctIndex, where).toBeLessThan(4);
          expect(q.explain.trim().length, `${where} 缺解析`).toBeGreaterThan(0);
        });
      });

      it(`${subject}/${band} 选项里没有占位符或疑问残渣`, () => {
        // 只拦「明显是脏数据」的形态：全角问号、占位词、疑问符出现在中间（如 “rain?”）
        const bad = /？|无效|待补|TODO|xxx|.\?./i;
        items.forEach((q) => {
          q.options.forEach((o) => {
            expect(bad.test(o), `${subject}/${band} 选项脏数据: ${o}`).toBe(false);
          });
        });
      });
    }
  }
});
