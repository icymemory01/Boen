/**
 * game-bank.ts —— 知识跑酷题库的类型与汇总入口
 *
 * 设计成「数据与逻辑分离」：
 * - 题目按学科 × 学段分组，每组是一个纯数据数组，追加题目只需往数组里加一行
 * - 线上真实规模应由离线脚本（scripts/build-game-bank.mjs）按教材批量生成，
 *   内置这 50 题/学科/学段只是演示用的种子库
 * - 一局之内不会重复出题（去重逻辑在 RunnerScene），所以题库越大体验越好
 */
import { PRIMARY_BANK } from './game-bank-primary.js';
import { MIDDLE_BANK } from './game-bank-middle.js';
import type { GameSubject } from '@boen/shared';

/** 紧凑题库条目：[题干, 4 个选项, 正确项下标, 一句话解析] */
export type RawQuestion = [
  stem: string,
  options: [string, string, string, string],
  correctIndex: number,
  explain: string,
];

/** 编译后的题库条目（game-core 消费） */
export interface BankItem {
  stem: string;
  options: string[];
  correctIndex: number;
  explain: string;
}

export type GradeBandKey = 'primary' | 'middle';

function compile(raw: RawQuestion[]): BankItem[] {
  return raw.map(([stem, options, correctIndex, explain]) => ({
    stem,
    options: [...options],
    correctIndex,
    explain,
  }));
}

/** 全部内置题库：学科 → 学段 → 题目 */
export const BANK: Record<GameSubject, Record<GradeBandKey, BankItem[]>> = {
  math: { primary: compile(PRIMARY_BANK.math), middle: compile(MIDDLE_BANK.math) },
  chinese: { primary: compile(PRIMARY_BANK.chinese), middle: compile(MIDDLE_BANK.chinese) },
  english: { primary: compile(PRIMARY_BANK.english), middle: compile(MIDDLE_BANK.english) },
  science: { primary: compile(PRIMARY_BANK.science), middle: compile(MIDDLE_BANK.science) },
};
