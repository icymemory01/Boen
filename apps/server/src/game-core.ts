/**
 * game-core.ts —— 知识跑酷的**纯逻辑**层（不碰数据库、不调 LLM）
 *
 * 单独抽出来有两个原因：
 * 1. 出题解析/洗牌是学生看到对不对题的**正确性关键**，必须能被单元测试覆盖，
 *    而数据库层依赖 better-sqlite3 原生模块，不该拖累这部分测试
 * 2. 服务端启动、单测、脚本都能复用同一套题库与校验规则
 *
 * 题库本身在 game-bank*.ts（纯数据，成百上千题也能直接堆），这里只负责挑题与校验。
 * 学科表与跑道数来自 @boen/shared，前后端共用一份。
 */
import { GAME_SUBJECTS, GAME_LANES, type GameSubject } from '@boen/shared';
import { BANK, type BankItem } from './game-bank.js';

export { GAME_SUBJECTS };
export type { GameSubject, BankItem };

/** 跑酷固定 4 条跑道 → 题目必须是 4 选 1 */
export const LANE_COUNT = GAME_LANES;

export interface GameOption {
  key: string;
  text: string;
}

export interface GameQuestion {
  id: string;
  stem: string;
  options: GameOption[];
  correctKey: string;
  /** 一句话解析，答错时展示 */
  explain?: string;
  /** 对应的课程知识图谱节点，局末用于回写熟练度 */
  kgNodeId?: number;
  kgTitle?: string;
}

export const GRADE_LABEL: Record<string, string> = {
  '1': '小学一年级',
  '2': '小学二年级',
  '3': '小学三年级',
  '4': '小学四年级',
  '5': '小学五年级',
  '6': '小学六年级',
  '7': '初中一年级',
  '8': '初中二年级',
  '9': '初中三年级',
  high: '高中',
  college: '大学通识',
};

export type GradeBand = 'primary' | 'middle';

/** 年级 → 学段（题库分层用） */
export function gradeBand(grade?: string): GradeBand {
  const n = Number(grade);
  if (Number.isFinite(n) && n >= 1 && n <= 6) return 'primary';
  return 'middle';
}

export function gradeLabel(grade?: string): string | null {
  if (!grade) return null;
  return GRADE_LABEL[grade] ?? null;
}

/** 校验并规范化学科参数 */
export function normalizeSubject(input: unknown): GameSubject | null {
  return typeof input === 'string' && (GAME_SUBJECTS as readonly string[]).includes(input)
    ? (input as GameSubject)
    : null;
}

/* ══════════════════════════════════════════════════════════════
 * 解析 LLM 输出
 * ══════════════════════════════════════════════════════════════ */

interface RawQuestionJson {
  stem?: unknown;
  options?: unknown;
  correctKey?: unknown;
  correctIndex?: unknown;
  answer?: unknown;
  explain?: unknown;
}

export interface ParsedQuestion {
  stem: string;
  /** 已按原顺序重排为 A/B/C/D */
  options: GameOption[];
  correctIndex: number;
  explain?: string;
}

/** 从选项条目里抽出文本，兼容 string / {text|label|content|value} */
function optionText(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    for (const k of ['text', 'label', 'content', 'value']) {
      if (typeof o[k] === 'string') return (o[k] as string).trim();
    }
  }
  return '';
}

/** 把答案声明解析成原始 options 数组中的下标；解析不出返回 -1（绝不猜 A） */
function resolveCorrectIndex(raw: RawQuestionJson, texts: string[], originalKeys: string[]): number {
  if (typeof raw.correctIndex === 'number' && Number.isInteger(raw.correctIndex)
    && raw.correctIndex >= 0 && raw.correctIndex < texts.length) {
    return raw.correctIndex;
  }
  const keyCandidates = [raw.correctKey, raw.answer].filter((v): v is string => typeof v === 'string');
  for (const rawKey of keyCandidates) {
    const k = rawKey.trim().toUpperCase();
    if (!k) continue;
    const byKey = originalKeys.findIndex((ok) => ok.toUpperCase() === k);
    if (byKey >= 0) return byKey;
    if (k.length === 1) {
      const byOrdinal = 'ABCD'.indexOf(k);
      if (byOrdinal >= 0 && byOrdinal < texts.length) return byOrdinal;
    }
    const byText = texts.findIndex((t) => t === rawKey.trim());
    if (byText >= 0) return byText;
  }
  return -1;
}

/**
 * 解析 LLM 返回文本为题目。
 * 任何字段不合格一律返回 null（由调用方兜底）——绝不用占位符补选项，也绝不猜答案。
 */
export function parseLLMQuestion(text: string): ParsedQuestion | null {
  if (!text) return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn('[game] LLM 返回内容不含有效 JSON');
    return null;
  }

  let parsed: RawQuestionJson;
  try {
    parsed = JSON.parse(jsonMatch[0]) as RawQuestionJson;
  } catch {
    console.warn('[game] LLM 返回 JSON 解析失败');
    return null;
  }

  const stem = typeof parsed.stem === 'string' ? parsed.stem.trim() : '';
  if (stem.length < 2) {
    console.warn('[game] LLM 题目缺少题干');
    return null;
  }
  if (!Array.isArray(parsed.options)) {
    console.warn('[game] LLM 题目 options 非数组');
    return null;
  }

  const texts: string[] = [];
  const originalKeys: string[] = [];
  const seen = new Set<string>();
  parsed.options.forEach((item, idx) => {
    const t = optionText(item);
    if (!t || seen.has(t)) return;
    seen.add(t);
    texts.push(t);
    const explicitKey = item && typeof item === 'object'
      ? (item as Record<string, unknown>).key
      : undefined;
    originalKeys.push(
      typeof explicitKey === 'string' && explicitKey.trim()
        ? explicitKey.trim()
        : String.fromCharCode(65 + idx),
    );
  });

  if (texts.length !== LANE_COUNT) {
    console.warn(`[game] LLM 选项数 ${texts.length} ≠ ${LANE_COUNT}，丢弃该题`);
    return null;
  }

  const correctIndex = resolveCorrectIndex(parsed, texts, originalKeys);
  if (correctIndex < 0 || correctIndex >= texts.length) {
    console.warn('[game] LLM 未给出可解析的正确答案，丢弃该题');
    return null;
  }

  const rawExplain = typeof parsed.explain === 'string' ? parsed.explain.trim() : '';
  return {
    stem: stem.slice(0, 200),
    options: texts.map((t, i) => ({ key: String.fromCharCode(65 + i), text: t })),
    correctIndex,
    explain: rawExplain ? rawExplain.slice(0, 160) : undefined,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 洗牌（按索引定位正确答案，不依赖文本匹配）
 * ══════════════════════════════════════════════════════════════ */

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  const buf = new Uint32Array(a.length);
  crypto.getRandomValues(buf);
  for (let i = a.length - 1; i > 0; i--) {
    const j = buf[i]! % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 打乱选项并重排 key 为 A/B/C/D，同时给出新的正确答案 key */
export function shuffleByIndex(
  options: GameOption[],
  correctIndex: number,
): { options: GameOption[]; correctKey: string } {
  const indexed = options.map((o, i) => ({ text: o.text, isCorrect: i === correctIndex }));
  const shuffled = shuffleArray(indexed);
  const finalOptions = shuffled.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o.text }));
  const idx = shuffled.findIndex((o) => o.isCorrect);
  return {
    options: finalOptions,
    correctKey: finalOptions[idx >= 0 ? idx : 0]!.key,
  };
}

export function newQuestionId(): string {
  const rand = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 6)
    : Math.random().toString(16).slice(2, 8);
  return `q_${Date.now()}_${rand}`;
}

/* ══════════════════════════════════════════════════════════════
 * 题库：内置种子库 + 离线题库（按学科 + 学段/年级）
 * ══════════════════════════════════════════════════════════════ */

/** 离线题库：由 scripts/build-game-bank.mjs 预生成，按学科 + 精确年级注册 */
const extraBanks = new Map<string, BankItem[]>();

function extraKey(subject: GameSubject, grade?: string): string {
  return `${subject}|${grade ?? '-'}`;
}

/** 校验一条离线题库题目是否可用（与服务端解析规则一致） */
function isValidBankItem(item: unknown): item is BankItem {
  if (!item || typeof item !== 'object') return false;
  const it = item as Record<string, unknown>;
  if (typeof it.stem !== 'string' || !it.stem.trim()) return false;
  if (!Array.isArray(it.options) || it.options.length !== LANE_COUNT) return false;
  if (!it.options.every((o) => typeof o === 'string' && o.trim())) return false;
  if (new Set(it.options.map((o) => (o as string).trim())).size !== LANE_COUNT) return false;
  if (typeof it.correctIndex !== 'number' || !Number.isInteger(it.correctIndex)) return false;
  if (it.correctIndex < 0 || it.correctIndex >= LANE_COUNT) return false;
  return true;
}

/** 注册离线题库（不合规的题目会被静默丢弃） */
export function registerExtraBank(subject: GameSubject, grade: string | undefined, items: unknown[]): number {
  const valid = items.filter(isValidBankItem);
  if (valid.length === 0) return 0;
  const key = extraKey(subject, grade);
  const merged = [...(extraBanks.get(key) ?? [])];
  const seen = new Set(merged.map((m) => m.stem));
  for (const item of valid) {
    if (seen.has(item.stem)) continue;
    seen.add(item.stem);
    merged.push(item);
  }
  extraBanks.set(key, merged);
  return merged.length;
}

/** 离线题库规模 */
export function extraBankSize(subject: GameSubject, grade?: string): number {
  return extraBanks.get(extraKey(subject, grade))?.length ?? 0;
}

/** 内置种子题库规模（测试用） */
export function fallbackBankSize(subject: GameSubject, grade?: string): number {
  return BANK[subject][gradeBand(grade)].length;
}

/** 某学科某年级可用的题库：离线题库优先，否则用内置种子库 */
function candidates(subject: GameSubject, grade?: string): BankItem[] {
  const extra = extraBanks.get(extraKey(subject, grade));
  if (extra && extra.length > 0) return extra;
  return BANK[subject][gradeBand(grade)];
}

/** 记录最近出过的题干，避免连续两次抽到同一题 */
const lastPicked = new Map<string, string>();

function pickFromBank(subject: GameSubject, grade?: string): BankItem {
  const pool = candidates(subject, grade);
  if (pool.length === 1) return pool[0]!;
  const key = extraKey(subject, grade);
  const lastStem = lastPicked.get(key);
  for (let attempt = 0; attempt < 6; attempt++) {
    const item = pool[Math.floor(Math.random() * pool.length)]!;
    if (item.stem !== lastStem) {
      lastPicked.set(key, item.stem);
      return item;
    }
  }
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/** 取一道题库题目（随机，避免连续重复），保证 4 个互不相同的选项 */
export function getFallbackQuestion(subject: GameSubject, grade?: string): GameQuestion {
  const item = pickFromBank(subject, grade);
  const baseOptions: GameOption[] = item.options.map((text, i) => ({ key: String.fromCharCode(65 + i), text }));
  const { options, correctKey } = shuffleByIndex(baseOptions, item.correctIndex);
  return {
    id: newQuestionId(),
    stem: item.stem,
    options,
    correctKey,
    explain: item.explain,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 计分规则（纯函数，服务端与单测共用）
 * ══════════════════════════════════════════════════════════════ */

/** 单局可获得的积分上限 */
export const GAME_POINTS_MAX = 60;

/**
 * 单局积分：答对数为主（每题 3 分）+ 满分奖励 + 连击奖励，整体封顶。
 * 与货币体系其他来源一样受「每日 100 分」上限约束（由 earnPoints 负责）。
 */
export function computeGamePoints(correct: number, total: number, maxCombo = 0): number {
  if (total <= 0 || correct <= 0) return 0;
  const accuracy = correct / total;
  const base = correct * 3;
  const perfect = accuracy === 1 && total >= 3 ? 8 : 0;
  const combo = Math.min(6, Math.floor(Math.max(0, maxCombo) / 3) * 2);
  return Math.min(GAME_POINTS_MAX, Math.round(base + perfect + combo));
}
