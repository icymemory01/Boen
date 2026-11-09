/**
 * game-store.ts —— 知识跑酷：局记录落库、积分奖励、错题回流、每日挑战、关卡、排行榜
 *
 * 设计原则：
 * - **不采信客户端上报**：分数 / 对错 / 连击全部由出题账本核验后重算（见 game.ts）
 * - 结算在**一个事务**里完成「写局记录 → 回写 Elo → 记错题」，失败不半途生效
 * - 排行榜只暴露匿名昵称（user_id 哈希），不泄露账号标识
 * - 周榜按**北京时间自然周（周一 00:00）**统计，不是滚动 7 天
 */
import { randomUUID } from 'node:crypto';
import {
  GAME_DAILY_SIZE,
  GAME_STAGE_PASS,
  GAME_STAGE_SIZE,
  type GameMode,
  type GameSubject,
} from '@boen/shared';
import db from './db.js';
import { earnPoints } from './currency.js';
import { updateProficiency } from './knowledge-profile.js';
import { verifySubmittedAnswers, type GameQuestion, type SubmittedAnswer } from './game.js';
import { computeGamePoints } from './game-core.js';
import { beijingDateStr, startOfBeijingDay, startOfBeijingWeek } from './game-time.js';

// 计分与时间边界都抽成了纯函数（game-core / game-time），这里转出去方便调用方统一引用
export { computeGamePoints, GAME_POINTS_MAX } from './game-core.js';
export { beijingDateStr, startOfBeijingDay, startOfBeijingWeek } from './game-time.js';

/** 每日挑战完成额外奖励 */
const DAILY_BONUS = 15;
/** 单局回写错题本的上限，避免一次刷满 */
const MAX_MISTAKES_PER_SESSION = 5;
/** 单局最大时长，用于 clamp 异常上报 */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

/* ── 结算 ── */

export interface FinishGameInput {
  userId: string;
  subject: GameSubject;
  grade?: string;
  mode?: GameMode;
  stage?: number;
  durationMs?: number;
  answers: SubmittedAnswer[];
}

export interface StageOutcome {
  stage: number;
  passed: boolean;
  need: number;
  size: number;
  nextStage: number;
  clearedStages: number;
}

export interface FinishGameResult {
  sessionId: string;
  mode: GameMode;
  /** 服务端核验后重算的分数 */
  score: number;
  correctCount: number;
  totalQuestions: number;
  maxCombo: number;
  /** 账本里查不到、未计分的题数 */
  unverified: number;
  points: number;
  capped: boolean;
  balance: number;
  proficiencyUpdated: number;
  mistakesCreated: number;
  isBest: boolean;
  stage?: StageOutcome;
  dailyCompleted?: boolean;
}

/**
 * 单局积分：答对数为主（每题 3 分）+ 满分奖励 + 连击奖励，整体封顶。
 * 实现见 game-core.computeGamePoints（纯函数，可单测）。
 */

function clampDuration(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.round(n));
}

/** 把一道答错的题写进错题本（已带正确答案与解析，直接标为 analyzed） */
function recordMistake(
  userId: string,
  subject: GameSubject,
  grade: string,
  answer: { stem: string; correctText: string; chosenText?: string; explain?: string; kgNodeId?: number },
): boolean {
  if (!answer.stem) return false;
  const dup = db.prepare(`SELECT 1 FROM mistake_items WHERE user_id=? AND prompt_text=? AND status!='archived'`)
    .get(userId, answer.stem);
  if (dup) return false;

  const id = `mistake-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO mistake_items
      (id, user_id, subject, grade, source_type, status, title, prompt_text,
       student_answer, correct_answer, explanation, error_type, error_reason,
       analysis_confidence, created_at, updated_at, proficiency_applied_at)
    VALUES (?, ?, ?, ?, 'text', 'analyzed', ?, ?, ?, ?, ?, 'game', '知识跑酷中答错', 1, ?, ?, ?)
  `).run(
    id, userId, subject, grade,
    answer.stem.slice(0, 40), answer.stem,
    answer.chosenText ?? '', answer.correctText,
    answer.explain ?? '', now, now, now, // proficiency_applied_at：Elo 已由游戏结算回写，避免重复计入
  );
  return true;
}

/** 读关卡进度（不存在则视为第 1 关） */
export function getStageProgress(userId: string, subject: GameSubject): StageOutcome & { bestAccuracy: number } {
  const row = db.prepare(`SELECT stage, cleared_stages, best_accuracy FROM game_progress WHERE user_id=? AND subject=?`)
    .get(userId, subject) as { stage: number; cleared_stages: number; best_accuracy: number } | undefined;
  const stage = row?.stage ?? 1;
  return {
    stage,
    passed: false,
    need: GAME_STAGE_PASS,
    size: GAME_STAGE_SIZE,
    nextStage: stage,
    clearedStages: row?.cleared_stages ?? 0,
    bestAccuracy: row?.best_accuracy ?? 0,
  };
}

/** 所有学科的关卡进度（用于选科页展示「第 N 关」） */
export function getAllStageProgress(userId: string): Record<string, { stage: number; clearedStages: number; bestAccuracy: number }> {
  const rows = db.prepare(`SELECT subject, stage, cleared_stages, best_accuracy FROM game_progress WHERE user_id=?`)
    .all(userId) as Array<{ subject: string; stage: number; cleared_stages: number; best_accuracy: number }>;
  const out: Record<string, { stage: number; clearedStages: number; bestAccuracy: number }> = {};
  for (const r of rows) {
    out[r.subject] = { stage: r.stage, clearedStages: r.cleared_stages, bestAccuracy: r.best_accuracy };
  }
  return out;
}

/** 结算一局：核验 → 落库 → 回写熟练度 → 错题回流 → 发积分（成绩以服务端为准） */
export function finishGameSession(input: FinishGameInput): FinishGameResult {
  const mode: GameMode = input.mode ?? 'endless';
  const verified = verifySubmittedAnswers(input.subject, input.answers ?? []);
  const durationMs = clampDuration(input.durationMs);

  // 全部题目都未通过核验 → 不留脏数据、不发积分
  if (verified.totalQuestions === 0) {
    return {
      sessionId: '',
      mode,
      score: 0,
      correctCount: 0,
      totalQuestions: 0,
      maxCombo: 0,
      unverified: verified.unverified,
      points: 0,
      capped: false,
      balance: 0,
      proficiencyUpdated: 0,
      mistakesCreated: 0,
      isBest: false,
    };
  }

  const prevBest = db.prepare(`SELECT MAX(score) AS best FROM game_sessions WHERE user_id=? AND subject=? AND mode=?`)
    .get(input.userId, input.subject, mode) as { best: number | null } | undefined;
  const isBest = verified.score > (prevBest?.best ?? 0);

  const sessionId = `g_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const grade = input.grade;

  // 1) 局记录 + 熟练度 + 错题（一个事务，计数与实际作答不会脱节）
  const { proficiencyUpdated, mistakesCreated } = db.transaction(() => {
    db.prepare(`
      INSERT INTO game_sessions
        (id, user_id, subject, grade, score, total_count, correct_count, max_combo, duration_ms, answers, mode, client_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web')
    `).run(
      sessionId, input.userId, input.subject, grade ?? null,
      verified.score, verified.totalQuestions, verified.correctCount, verified.maxCombo, durationMs,
      JSON.stringify(verified.answers.map((a) => ({
        questionId: a.questionId, kgNodeId: a.kgNodeId, correct: a.correct,
      }))),
      mode,
    );

    let updated = 0;
    for (const a of verified.answers) {
      if (typeof a.kgNodeId !== 'number' || !Number.isInteger(a.kgNodeId) || a.kgNodeId <= 0) continue;
      try {
        const exists = db.prepare(`SELECT 1 FROM kg_nodes WHERE id=?`).get(a.kgNodeId);
        if (!exists) continue;
        updateProficiency(input.userId, a.kgNodeId, a.correct ? 1 : 0, 1, 'game');
        updated++;
      } catch (e) {
        console.warn('[game] 熟练度回写失败:', e instanceof Error ? e.message : String(e));
      }
    }

    // 错题自动进错题本（需要年级才能建错题；无年级则跳过）
    let mistakes = 0;
    if (grade) {
      for (const a of verified.answers) {
        if (a.correct) continue;
        if (mistakes >= MAX_MISTAKES_PER_SESSION) break;
        try {
          if (recordMistake(input.userId, input.subject, grade, a)) mistakes++;
        } catch (e) {
          console.warn('[game] 错题回流失败:', e instanceof Error ? e.message : String(e));
        }
      }
    }

    return { proficiencyUpdated: updated, mistakesCreated: mistakes };
  })();

  // 2) 关卡进度（过关才推进）
  let stage: StageOutcome | undefined;
  if (mode === 'stage') {
    const current = getStageProgress(input.userId, input.subject);
    const stageNo = Math.max(1, Math.trunc(input.stage ?? current.stage));
    const passed = verified.correctCount >= GAME_STAGE_PASS && verified.totalQuestions >= GAME_STAGE_SIZE;
    const accuracy = Math.round((verified.correctCount / verified.totalQuestions) * 100);
    const cleared = passed ? Math.max(current.clearedStages, stageNo) : current.clearedStages;
    const nextStage = passed ? stageNo + 1 : stageNo;
    db.prepare(`
      INSERT INTO game_progress (user_id, subject, stage, cleared_stages, best_accuracy, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(user_id, subject) DO UPDATE SET
        stage=excluded.stage,
        cleared_stages=MAX(game_progress.cleared_stages, excluded.cleared_stages),
        best_accuracy=MAX(game_progress.best_accuracy, excluded.best_accuracy),
        updated_at=unixepoch()
    `).run(input.userId, input.subject, nextStage, cleared, accuracy);
    stage = {
      stage: stageNo,
      passed,
      need: GAME_STAGE_PASS,
      size: GAME_STAGE_SIZE,
      nextStage,
      clearedStages: cleared,
    };
  }

  // 3) 积分（含每日挑战完成奖励；每日上限由 earnPoints 统一处理）
  const dailyCompleted = mode === 'daily';
  const basePoints = computeGamePoints(verified.correctCount, verified.totalQuestions, verified.maxCombo)
    + (dailyCompleted ? DAILY_BONUS : 0);
  const earned = earnPoints(input.userId, basePoints, 'game', sessionId);
  if (earned.earned > 0) {
    db.prepare(`UPDATE game_sessions SET points_awarded=? WHERE id=?`).run(earned.earned, sessionId);
  }

  return {
    sessionId,
    mode,
    score: verified.score,
    correctCount: verified.correctCount,
    totalQuestions: verified.totalQuestions,
    maxCombo: verified.maxCombo,
    unverified: verified.unverified,
    points: earned.earned,
    capped: earned.capped,
    balance: earned.balance,
    proficiencyUpdated,
    mistakesCreated,
    isBest,
    stage,
    dailyCompleted,
  };
}

/* ── 每日挑战 ── */

export interface DailyChallengeState {
  date: string;
  completed: boolean;
  bestScore: number;
  size: number;
}

/**
 * 取（或创建）今天的挑战题集。题集按 (user, date) 固定下来，
 * 刷新页面不会换题；换天自动失效。
 */
export function getDailyChallenge(
  userId: string,
  subject: GameSubject,
  generate: () => GameQuestion[],
): { state: DailyChallengeState; questions: GameQuestion[] } {
  const date = beijingDateStr();
  const row = db.prepare(`SELECT questions FROM game_daily_challenges WHERE user_id=? AND date=?`)
    .get(userId, date) as { questions: string } | undefined;

  let questions: GameQuestion[] = [];
  if (row) {
    try {
      const parsed = JSON.parse(row.questions) as GameQuestion[];
      if (Array.isArray(parsed) && parsed.length > 0) questions = parsed;
    } catch { /* 损坏则重生成 */ }
  }
  if (questions.length === 0) {
    questions = generate();
    try {
      db.prepare(`
        INSERT INTO game_daily_challenges (user_id, date, subject, questions)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, date) DO UPDATE SET questions=excluded.questions, subject=excluded.subject
      `).run(userId, date, subject, JSON.stringify(questions));
    } catch (e) {
      console.warn('[game] 每日挑战落库失败:', e instanceof Error ? e.message : String(e));
    }
  }

  const stats = db.prepare(`
    SELECT COUNT(*) AS n, MAX(score) AS best
    FROM game_sessions WHERE user_id=? AND mode='daily' AND created_at>=?
  `).get(userId, startOfBeijingDay()) as { n: number; best: number | null };

  return {
    state: {
      date,
      completed: (stats?.n ?? 0) > 0,
      bestScore: stats?.best ?? 0,
      size: GAME_DAILY_SIZE,
    },
    questions,
  };
}

/* ── 排行榜（匿名昵称） ── */

export interface LeaderboardRow {
  rank: number;
  handle: string;
  score: number;
  correct: number;
  games: number;
  isMe: boolean;
}

/**
 * user_id → 稳定的匿名昵称。
 * 24 × 24 词表 + 两位哈希后缀，避免「勤学少年」满屏重名。
 */
function anonHandle(userId: string): string {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const adjectives = [
    '勤学', '好奇', '专注', '敏捷', '深思', '灵巧', '笃行', '博闻',
    '澄明', '坚韧', '从容', '善问', '明辨', '日新', '静思', '进击',
    '阳光', '踏实', '锐意', '沉稳', '向学', '乐知', '惜时', '拓野',
  ];
  const nouns = [
    '少年', '学者', '小将', '书虫', '探路者', '追风者', '解题家', '守望者',
    '行路人', '拾光者', '求索者', '问道人', '算术师', '读书郎', '点灯人', '摘星者',
    '赶路人', '观察家', '绘梦人', '登高者', '望月人', '纪录家', '闯关者', '开路者',
  ];
  const a = adjectives[h % adjectives.length];
  const n = nouns[(h >>> 5) % nouns.length];
  const suffix = String((h >>> 11) % 97).padStart(2, '0');
  return `${a}${n}·${suffix}`;
}

export function getLeaderboard(
  userId: string | null,
  subject: GameSubject | null,
  period: 'week' | 'all' = 'week',
  limit = 20,
): LeaderboardRow[] {
  const since = period === 'week' ? startOfBeijingWeek() : 0;
  const params: unknown[] = [since];
  let sql = `
    SELECT user_id, SUM(correct_count) AS correct, SUM(score) AS score, COUNT(*) AS games
    FROM game_sessions
    WHERE created_at >= ?
  `;
  if (subject) { sql += ' AND subject=?'; params.push(subject); }
  sql += ' GROUP BY user_id ORDER BY correct DESC, score DESC, games ASC LIMIT ?';
  params.push(Math.min(50, Math.max(1, limit)));

  const rows = db.prepare(sql).all(...params) as Array<{
    user_id: string; correct: number; score: number; games: number;
  }>;

  return rows.map((r, i) => ({
    rank: i + 1,
    handle: anonHandle(r.user_id),
    score: r.score ?? 0,
    correct: r.correct ?? 0,
    games: r.games ?? 0,
    isMe: !!userId && r.user_id === userId,
  }));
}

/* ── 个人战绩 ── */

export interface GameStats {
  games: number;
  bestScore: number;
  bestCorrect: number;
  totalCorrect: number;
  totalQuestions: number;
  accuracy: number;
  lastPlayedAt: number | null;
  todayGames: number;
}

export function getGameStats(userId: string): GameStats {
  const row = db.prepare(`
    SELECT COUNT(*) AS games,
           COALESCE(MAX(score), 0) AS best_score,
           COALESCE(MAX(correct_count), 0) AS best_correct,
           COALESCE(SUM(correct_count), 0) AS total_correct,
           COALESCE(SUM(total_count), 0) AS total_questions,
           MAX(created_at) AS last_played
    FROM game_sessions WHERE user_id=?
  `).get(userId) as {
    games: number; best_score: number; best_correct: number;
    total_correct: number; total_questions: number; last_played: number | null;
  };

  const today = db.prepare(`SELECT COUNT(*) AS n FROM game_sessions WHERE user_id=? AND created_at>=?`)
    .get(userId, startOfBeijingDay()) as { n: number };

  const totalQuestions = row.total_questions ?? 0;
  return {
    games: row.games ?? 0,
    bestScore: row.best_score ?? 0,
    bestCorrect: row.best_correct ?? 0,
    totalCorrect: row.total_correct ?? 0,
    totalQuestions,
    accuracy: totalQuestions > 0 ? Math.round(((row.total_correct ?? 0) / totalQuestions) * 100) : 0,
    lastPlayedAt: row.last_played ?? null,
    todayGames: today.n ?? 0,
  };
}

export interface RecentSessionRow {
  id: string;
  subject: string;
  mode: string;
  score: number;
  correct: number;
  total: number;
  points: number;
  createdAt: number;
}

export function getRecentSessions(userId: string, limit = 10): RecentSessionRow[] {
  return (db.prepare(`
    SELECT id, subject, mode, score, correct_count, total_count, points_awarded, created_at
    FROM game_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT ?
  `).all(userId, Math.min(50, Math.max(1, limit))) as Array<{
    id: string; subject: string; mode: string; score: number; correct_count: number;
    total_count: number; points_awarded: number; created_at: number;
  }>).map((r) => ({
    id: r.id,
    subject: r.subject,
    mode: r.mode,
    score: r.score,
    correct: r.correct_count,
    total: r.total_count,
    points: r.points_awarded,
    createdAt: r.created_at,
  }));
}
