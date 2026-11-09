/**
 * 知识跑酷 —— 前端 API 封装
 *
 * 结算只上报「撞了哪个选项」，分数 / 对错由服务端按出题账本核验后重算。
 */
import { getToken } from './auth';
import type { GameQuestion, Subject } from '@/game/RunnerScene';

export type GameMode = 'endless' | 'daily' | 'stage';

export interface GameAnswerPayload {
  questionId: string;
  chosenKey: string;
}

export interface FinishPayload {
  subject: Subject;
  grade?: string;
  mode: GameMode;
  stage?: number;
  durationMs: number;
  answers: GameAnswerPayload[];
}

export interface GameStatsSummary {
  games: number;
  bestScore: number;
  bestCorrect: number;
  totalCorrect: number;
  totalQuestions: number;
  accuracy: number;
  lastPlayedAt: number | null;
  todayGames: number;
}

export interface StageProgress {
  stage: number;
  clearedStages: number;
  bestAccuracy: number;
}

export interface StageOutcome {
  stage: number;
  passed: boolean;
  need: number;
  size: number;
  nextStage: number;
  clearedStages: number;
}

export interface FinishResult {
  ok: boolean;
  sessionId: string;
  mode: GameMode;
  /** 服务端核验后重算的分数 */
  score: number;
  correctCount: number;
  totalQuestions: number;
  maxCombo: number;
  /** 账本中查不到、未计分的题数 */
  unverified: number;
  points: number;
  capped: boolean;
  balance: number;
  proficiencyUpdated: number;
  /** 本局自动进错题本的题数 */
  mistakesCreated: number;
  isBest: boolean;
  stage?: StageOutcome;
  dailyCompleted?: boolean;
  stats: GameStatsSummary;
}

export interface LeaderboardRow {
  rank: number;
  handle: string;
  score: number;
  correct: number;
  games: number;
  isMe: boolean;
}

export interface RecentSession {
  id: string;
  subject: string;
  mode: string;
  score: number;
  correct: number;
  total: number;
  points: number;
  createdAt: number;
}

export interface DailyChallengeState {
  date: string;
  completed: boolean;
  bestScore: number;
  size: number;
}

export interface StatsResponse {
  stats: GameStatsSummary;
  recent: RecentSession[];
  stages: Record<string, StageProgress>;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 局末结算：核验 + 落库 + 回写画像 + 错题回流 + 发积分。未登录返回 null。 */
export async function finishGame(payload: FinishPayload): Promise<FinishResult | null> {
  if (!getToken()) return null;
  try {
    const res = await fetch('/api/game/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('[game] 结算失败:', res.status);
      return null;
    }
    return (await res.json()) as FinishResult;
  } catch (e) {
    console.warn('[game] 结算请求异常:', e);
    return null;
  }
}

/** 个人战绩 + 最近 10 局 + 各科关卡进度 */
export async function fetchGameStats(): Promise<StatsResponse | null> {
  if (!getToken()) return null;
  try {
    const res = await fetch('/api/game/stats', { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as StatsResponse;
  } catch {
    return null;
  }
}

/** 排行榜（自然周 / 全部） */
export async function fetchLeaderboard(
  subject?: Subject,
  period: 'week' | 'all' = 'week',
): Promise<LeaderboardRow[]> {
  try {
    const params = new URLSearchParams({ period });
    if (subject) params.set('subject', subject);
    const res = await fetch(`/api/game/leaderboard?${params.toString()}`, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = (await res.json()) as { rows?: LeaderboardRow[] };
    return data.rows ?? [];
  } catch {
    return [];
  }
}

function gameQuery(subject: Subject, grade?: string): string {
  const params = new URLSearchParams({ subject });
  if (grade) params.set('grade', grade);
  return params.toString();
}

/** 每日挑战：当天固定的题集（刷新不换题） */
export async function fetchDailyChallenge(
  subject: Subject,
  grade?: string,
): Promise<{ state: DailyChallengeState; questions: GameQuestion[] } | null> {
  if (!getToken()) return null;
  try {
    const res = await fetch(`/api/game/daily?${gameQuery(subject, grade)}`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as { state: DailyChallengeState; questions: GameQuestion[] };
  } catch {
    return null;
  }
}

/** 关卡：进度 + 本关题目 */
export async function fetchStage(
  subject: Subject,
  grade?: string,
): Promise<{ progress: StageOutcome & { bestAccuracy: number }; questions: GameQuestion[] } | null> {
  if (!getToken()) return null;
  try {
    const res = await fetch(`/api/game/stage?${gameQuery(subject, grade)}`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as { progress: StageOutcome & { bestAccuracy: number }; questions: GameQuestion[] };
  } catch {
    return null;
  }
}
