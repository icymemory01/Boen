import { dirname, resolve, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopedResource } from './request-scope.js';
import { initPrivacyRetention, runPrivacyRetention } from './privacy-retention.js';
import { ASSET_ROOT, DATA_DIR } from './paths.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

// ── 全局未捕获异常兜底（防止进程静默退出导致 SSE 流中断） ──────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err instanceof Error ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});

// ── 优雅关闭：刷新熟练度缓存后退出 ──────────────────────────
function shutdown(signal: string) {
  console.log(`[shutdown] 收到 ${signal}，正在刷新熟练度缓存...`);
  const flushed = flushAllProficiencyCaches();
  console.log(`[shutdown] 已刷新 ${flushed} 条熟练度记录，进程退出`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
import { HumanMessage, SystemMessage, type BaseMessage, type AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  getChatModel,
  buildBoenGraph,
  QUIZ_TOOL_NAMES,
  COMPLETE_REVIEW_TOOL,
  toQuestionPayload,
  gradeAnswer,
  EXIT_SESSION_TOOL, ADVANCE_STEP_TOOL, PLAN_STEPS_TOOL, SWITCH_SUBJECT_TOOL, LOOKUP_KNOWLEDGE_POINT_TOOL,
} from '@boen/agent-core';
import type { QuestionInterrupt, QuestionResume } from '@boen/agent-core';
import type { AnalyzeMistakeEvent, ChatRequest, AnswerRequest, AnswerPayload, SseEvent } from '@boen/shared';
import { MEMBERSHIP_TERMS_VERSION } from '@boen/shared';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import db from './db.js';
import { lookupKnowledgePoint, retrieveCurriculum } from './curriculum.js';
import { ensureFtsTable, rebuildFtsIndex } from './fts.js';
import { setRewriteModel } from './query-rewriter.js';
import { generateConversationSummaryAsync } from './conversation-memory.js';
import { z } from 'zod';
import { SwitchModelSchema, RedeemCodeSchema, RedeemPointsSchema, sanitizeError } from './validation.js';
import { getNodesByType, getNeighbors, getKgContextForUnit, ensureKnowledgeGraphTables } from './knowledge-graph.js';
import { getWeightDistribution, formatWeightGuide } from './kg-weights.js';
import { getPublishedKnowledgePointIds, getQuestionTaxonomyById, resolveQuestionTaxonomy } from './question-taxonomy.js';
import { updateProficiency, cacheProficiencyUpdate, flushProficiencyCache, discardProficiencyCache, getCachedProficiencySum, getCachedProficiencyExpected, setCachedProficiencyExpected, computeProficiencyDelta, difficultyLevelToValue, expectedCorrectness, ELO_RATING_INIT, ELO_SIGMA_INIT, getAllProficiencies, getWeakPoints, getStrongPoints, getLiteracyProficiency, getRecommendedKPs, getPrerequisiteWeaknessChain, getProfileOutline, seedProficiencyFromHistory, flushAllProficiencyCaches } from './knowledge-profile.js';
import {
  createConversation,
  getConversations,
  getConversation,
  updateConversationTitle,
  deleteConversation,
  addMessage,
  getMessages,
  updateQuestionMessage,
} from './conversation.js';
import {
  analyzeMistake,
  archiveMistake,
  createMistake,
  formatMistakePracticePrompt,
  getMistakeAssetFile,
  getMistakeDetail,
  listMistakes,
  readMistakeAsset,
  retrieveGlobalStyleSkills,
  updateMistake,
} from './mistakes.js';
import { consumeTikzRateLimit, renderTikzSvg, TikzRenderError, validateTikzCode } from './tikz-renderer.js';
import { membershipDetails } from './membership.js';
import { earnPoints, computeScorePoints, computeStarBonus, getCurrencyStatus, redeemMembershipWithPoints, listLedger, CURRENCY_PRODUCTS, claimDailyLogin, beijingDateStr } from './currency.js';
import { createMembershipCheckout, handleWaffoWebhook, isWaffoEnabled, listPurchasablePlans, listPaymentOrders, manageSubscription, reconcileMembership } from './waffo.js';
import { initQuestionPool, getPooledQuestion, getPooledQuestions, purgeOldGameData } from './game.js';
import { finishGameSession, getGameStats, getLeaderboard, getRecentSessions, getDailyChallenge, getStageProgress, getAllStageProgress } from './game-store.js';
import { GAME_DAILY_SIZE, GAME_STAGE_SIZE } from '@boen/shared';

// 从仓库根加载 .env
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../.env') });

// 已下线讯飞 provider，全部走 DeepSeek（OpenAI 兼容）。
// 旧 BOEN_API_KEY 作为 DEEPSEEK_API_KEY 的兜底，方便本地复用同一份密钥。
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? process.env.BOEN_API_KEY ?? '';

// 用户可选档位 → 实际 DeepSeek 模型。default = 免费 Flash 档。
const DEEPSEEK_MODELS: Record<string, string> = {
  default: 'deepseek-v4-flash',
  deepseek: 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
};

/** 出卷专用：开启 thinking，放大输出上限与超时（思考耗时长，质量优先）。 */
const EXAM_MODEL_OPTS = { thinking: true, maxTokens: 8192, timeout: 300000 } as const;

function createModel(
  provider: string,
  opts?: { thinking?: boolean; maxTokens?: number; timeout?: number },
): BaseChatModel {
  const modelName = DEEPSEEK_MODELS[provider] ?? 'deepseek-v4-flash';
  return getChatModel({
    provider: 'deepseek',
    model: modelName,
    apiKey: DEEPSEEK_API_KEY,
    enableThinking: opts?.thinking ?? false, // 默认关闭：聊天追求快速出结果
    maxTokens: opts?.maxTokens,
    timeout: opts?.timeout,
  });
}
const providerScope = new AsyncLocalStorage<string>();
const model = scopedResource(providerScope, (provider) => createModel(provider));
// 出卷沿用用户所选档位，但开启 thinking（延迟被异步进度条吸收）
const examModel = scopedResource(providerScope, (provider) => createModel(provider, EXAM_MODEL_OPTS));
// 游戏题目池：全局共享一份（不随用户档位切换），启动时预填充，请求秒出
initQuestionPool(createModel('default'));

// LangGraph 对话状态持久化到 SQLite（重启不丢失）
const checkpointer = new SqliteSaver(db);

// 初始化 FTS5 全文搜索索引（幂等）
ensureFtsTable();
// 从已有课程数据重建 FTS 索引（幂等，已有数据则跳过）
try { rebuildFtsIndex(); } catch (e) { console.warn('[fts] rebuildFtsIndex 失败:', e instanceof Error ? e.message : e); }
// 注入查询改写模型
setRewriteModel(model);

const graph = scopedResource(providerScope, (provider) => buildBoenGraph(createModel(provider), { retrieveCurriculum, lookupKnowledgePoint }, checkpointer));

/** 切换模型并重建 LangGraph 图 */
function switchModel(userId: string, provider: string) {
  db.prepare('INSERT INTO user_model_preferences(user_id,provider) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider').run(userId, provider);
  return provider;
}

// ── Frost ID：服务端换 token（内网直连，client_secret 只留服务端）──
const FROST_ID_INTERNAL_URL = process.env.FROST_ID_INTERNAL_URL ?? 'http://127.0.0.1:4000';
const FROST_ID_CLIENT_ID = process.env.FROST_ID_CLIENT_ID ?? 'boen-client';
const FROST_ID_CLIENT_SECRET = process.env.FROST_ID_CLIENT_SECRET;
if (!FROST_ID_CLIENT_SECRET) {
  console.error('[FATAL] FROST_ID_CLIENT_SECRET 未配置，Frost ID OAuth 依赖此密钥，拒绝启动');
  process.exit(1);
}

// 兑换码签名密钥（自描述签名码用，仅存服务端 .env）。未配置则兑换接口拒绝服务。

// 用 Bearer token 经 Frost ID 内网 userinfo 解析出用户 id（sub），带短缓存避免每请求开销
const userIdCache = new Map<string, { sub: string; exp: number; subscription?: { tier: string; isPremium: boolean; expiresAt: number | null; activatedAt: number | null } }>();
const MAX_USER_CACHE = 5000;
/** 反向索引：userId → Set<token>，用于 O(1) 失效 */
const userIdTokens = new Map<string, Set<string>>();
/** 定期清理过期的 userIdCache 条目，防止内存泄漏 */
const userCacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of userIdCache) {
    if (entry.exp <= now) {
      userIdCache.delete(token);
      const tokens = userIdTokens.get(entry.sub);
      if (tokens) { tokens.delete(token); if (!tokens.size) userIdTokens.delete(entry.sub); }
    }
  }
}, 5 * 60_000); // 每 5 分钟清理
if (userCacheCleanup?.unref) userCacheCleanup.unref();
async function resolveUserId(c: Context): Promise<string | null> {
  const authz = c.req.header('authorization');
  if (!authz?.startsWith('Bearer ')) return null;
  const token = authz.slice(7);
  const cached = userIdCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.sub;
  try {
    const res = await fetch(`${FROST_ID_INTERNAL_URL}/oauth/userinfo`, { headers: { Authorization: authz } });
    if (!res.ok) return null;
    const data = (await res.json()) as { sub?: string };
    if (!data.sub) return null;
    // 缓存上限保护：超出时删除最旧的 10%
    if (userIdCache.size >= MAX_USER_CACHE) {
      const entries = [...userIdCache.entries()];
      entries.sort((a, b) => a[1].exp - b[1].exp);
      for (let i = 0; i < Math.max(1, Math.floor(MAX_USER_CACHE * 0.1)); i++) {
        const oldSub = entries[i][1].sub;
        userIdCache.delete(entries[i][0]);
        const tokens = userIdTokens.get(oldSub);
        if (tokens) { tokens.delete(entries[i][0]); if (!tokens.size) userIdTokens.delete(oldSub); }
      }
    }
    userIdCache.set(token, { sub: data.sub, exp: Date.now() + 5 * 60_000 });
    let tokens = userIdTokens.get(data.sub);
    if (!tokens) { tokens = new Set(); userIdTokens.set(data.sub, tokens); }
    tokens.add(token);
    return data.sub;
  } catch (err) {
    console.error('[auth] userinfo failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 失效某用户的订阅缓存，同时删除对应 token 缓存条目（令牌撤销安全） */
function invalidateSubscriptionCache(userId: string) {
  const tokens = userIdTokens.get(userId);
  if (tokens) {
    for (const t of tokens) userIdCache.delete(t);
    userIdTokens.delete(userId);
  }
}

// 兑换尝试限流：每用户每分钟 5 次，防签名爆破
const redeemAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_REDEEM_ENTRIES = 10000;
function checkRedeemRate(userId: string): boolean {
  const now = Date.now();
  const e = redeemAttempts.get(userId);
  if (!e || e.resetAt < now) {
    // 缓存上限保护：超出时清空过期条目
    if (redeemAttempts.size >= MAX_REDEEM_ENTRIES) {
      for (const [k, v] of redeemAttempts) {
        if (v.resetAt < now) redeemAttempts.delete(k);
      }
      if (redeemAttempts.size >= MAX_REDEEM_ENTRIES) {
        const entries = [...redeemAttempts.entries()];
        entries.sort((a, b) => a[1].resetAt - b[1].resetAt);
        for (let i = 0; i < Math.floor(MAX_REDEEM_ENTRIES * 0.1); i++) {
          redeemAttempts.delete(entries[i][0]);
        }
      }
    }
    redeemAttempts.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (e.count >= 5) return false;
  e.count += 1;
  return true;
}

// ── 订阅系统辅助函数 ──────────────────────────────
const FREE_DAILY_LIMIT = 10;

interface SubscriptionInfo {
  tier: 'free' | 'monthly' | 'yearly';
  isPremium: boolean;
  expiresAt: number | null;
  activatedAt: number | null;
}

/** 解析用户 ID 并查询订阅状态（复用 userIdCache，5 分钟 TTL） */
async function resolveSubscription(c: Context): Promise<{ userId: string; sub: SubscriptionInfo } | null> {
  const userId = await resolveUserId(c);
  if (!userId) return null;
  // Resolve access against the clock on every request; a cached boolean can outlive its period.
  const details = membershipDetails(db, userId);
  return { userId, sub: {
    tier: details.membership.active ? details.membership.legacyTier ?? (details.membership.source === 'waffo' ? details.billing.planKey : 'monthly') : 'free',
    isPremium: details.membership.active, expiresAt: details.membership.accessEndsAt,
    activatedAt: details.billing.currentPeriodStart,
  } };
}

/** 守卫：要求 premium 订阅，否则返回 403 */
function requirePremium(c: Context, result: { userId: string; sub: SubscriptionInfo } | null) {
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  if (!result.sub.isPremium) {
    return c.json({ error: 'premium_required', message: '此功能需开通星月卡' }, 403);
  }
  return null;
}

/** 查询当日消息用量（北京时间） */
function getDailyUsage(userId: string): number {
  const today = beijingDateStr();
  const row = db.prepare('SELECT message_count FROM daily_chat_usage WHERE user_id = ? AND date = ?').get(userId, today) as
    | { message_count: number }
    | undefined;
  return row?.message_count ?? 0;
}

/** 检查并原子递增用户今日用量，防止并发绕过限额 */
function checkUsage(userId: string): { allowed: boolean; remaining: number } {
  const today = beijingDateStr();
  // 在事务中原子完成 读取+递增，杜绝 check-then-act TOCTOU 竞态
  return db.transaction((): { allowed: boolean; remaining: number } => {
    const row = db.prepare('SELECT message_count FROM daily_chat_usage WHERE user_id=? AND date=?')
      .get(userId, today) as { message_count: number } | undefined;
    const current = row?.message_count ?? 0;
    if (current >= FREE_DAILY_LIMIT) {
      return { allowed: false, remaining: 0 };
    }
    db.prepare(`
      INSERT INTO daily_chat_usage (user_id, date, message_count) VALUES (?, ?, 1)
      ON CONFLICT(user_id, date) DO UPDATE SET message_count = message_count + 1
    `).run(userId, today);
    return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
  })();
}

/** SSE 异常时退还已扣除的免费配额，避免用户无结果却被扣次数 */
function refundUsage(userId: string) {
  const today = beijingDateStr();
  db.transaction(() => {
    const row = db.prepare('SELECT message_count FROM daily_chat_usage WHERE user_id=? AND date=?')
      .get(userId, today) as { message_count: number } | undefined;
    if (!row || row.message_count <= 0) return;
    db.prepare('UPDATE daily_chat_usage SET message_count = message_count - 1 WHERE user_id=? AND date=? AND message_count > 0')
      .run(userId, today);
  })();
}

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };
const runConfig = (threadId: string) => ({ version: 'v2' as const, configurable: { thread_id: threadId }, recursionLimit: 50 });

type GraphRunResult = {
  last?: BaseMessage;
  question?: ToolCall;
};

function getPendingQuestion(state: { tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }> }): ToolCall | undefined {
  for (const task of state.tasks ?? []) {
    for (const interrupt of task.interrupts ?? []) {
      const value = interrupt.value as Partial<QuestionInterrupt> | undefined;
      if (
        value?.type === 'question'
        && typeof value.toolCallId === 'string'
        && typeof value.toolName === 'string'
        && value.args
        && typeof value.args === 'object'
      ) {
        return { id: value.toolCallId, name: value.toolName, args: value.args as Record<string, unknown> };
      }
    }
  }
  return undefined;
}

/**
 * 从 Command 工具输出（plan_steps/advance_step 返回）提取 todoState 并下发给前端。
 * 避免在 on_chain_end 中依赖 checkpoint 读取时序（superstep 刚结束时可能尚未持久化）。
 */
async function sendTodoPlanFromCommand(
  command: { update?: { todoState?: unknown } },
  send: (e: SseEvent) => Promise<void>,
): Promise<boolean> {
  const raw = command?.update?.todoState;
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = JSON.parse(raw) as {
      steps?: Array<{ id: number; label: string; status: string }>;
      currentStep?: number;
    };
    if (!parsed.steps?.length) return false;
    const steps = parsed.steps.map((s) => ({
      id: s.id,
      label: s.label,
      // todoState 仅有 pending/in_progress/completed；failed 由 todo_fail 事件在前端叠加
      status: (['pending', 'in_progress', 'completed'].includes(s.status) ? s.status : 'pending') as
        'pending' | 'in_progress' | 'completed',
    }));
    await send({ type: 'todo_plan', steps, currentStep: parsed.currentStep ?? 1 });
    console.log(`[Boen 类课堂] 📋 todo_plan 下发（来自 Command）— ${steps.length} 步，当前第 ${parsed.currentStep ?? 1} 步 | ${new Date().toLocaleTimeString()}`);
    return true;
  } catch (err) {
    console.warn('[Boen 类课堂] ⚠️ 从 Command 解析 todoState 失败:', err);
    return false;
  }
}

/**
 * 从 checkpoint 读取最新 todoState，并把完整步骤清单实时下发给前端。
 * 数据源是 plan_steps/advance_step 工具维护的权威状态机，确保每步状态
 * （pending / in_progress / completed）与服务端一致。
 */
async function sendTodoPlan(
  threadId: string,
  send: (e: SseEvent) => Promise<void>,
): Promise<void> {
  try {
    // tools 节点（含 Command 工具更新）结束后 checkpoint 即为最新，直接读取
    const ckpt = await graph.getState(runConfig(threadId));
    const raw = ckpt?.values?.todoState as string | undefined;
    if (!raw) {
      console.warn(`[Boen 类课堂] ⚠️ sendTodoPlan 读取 checkpoint 为空，跳过下发 | ${new Date().toLocaleTimeString()}`);
      return;
    }
    const parsed = JSON.parse(raw) as {
      steps?: Array<{ id: number; label: string; status: string }>;
      currentStep?: number;
    };
    if (!parsed.steps?.length) {
      console.warn(`[Boen 类课堂] ⚠️ sendTodoPlan 读取到 steps 为空，跳过下发 | ${new Date().toLocaleTimeString()}`);
      return;
    }
    const steps = parsed.steps.map((s) => ({
      id: s.id,
      label: s.label,
      // todoState 仅有 pending/in_progress/completed；failed 由 todo_fail 事件在前端叠加
      status: (['pending', 'in_progress', 'completed'].includes(s.status) ? s.status : 'pending') as
        'pending' | 'in_progress' | 'completed',
    }));
    await send({ type: 'todo_plan', steps, currentStep: parsed.currentStep ?? 1 });
    console.log(`[Boen 类课堂] 📋 todo_plan 下发（来自 checkpoint）— ${steps.length} 步，当前第 ${parsed.currentStep ?? 1} 步 | ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.warn('[Boen 类课堂] ⚠️ sendTodoPlan 解析失败:', err);
  }
}

/** 流式跑一次图：推送 token，并返回最后消息及持久化的人机题目暂停点。 */
async function runGraph(
  input: Record<string, unknown> | Command<QuestionResume>,
  threadId: string,
  send: (e: SseEvent) => Promise<void>,
  signal?: AbortSignal,
): Promise<GraphRunResult> {
  const events = graph.streamEvents(input as any, runConfig(threadId));
  let quizSignaled = false; // 「博文正在出题」只发一次
  let toolNameBuf = '';     // 累积可能被切分到多个 chunk 的工具名片段
  // 出题工具名均以 ask_ 开头；前缀 + 全名双重匹配，兼容模型分片/整块返回 tool_call
  const looksLikeQuiz = (n?: string | null): boolean => !!n && (QUIZ_TOOL_NAMES.has(n) || n.startsWith('ask_'));
  const signalQuiz = async () => {
    if (quizSignaled) return;
    quizSignaled = true;
    await send({ type: 'quiz_generating' });
  };
  // TODO 状态机工具检测缓存 + 计时
  let todoStepSent = new Set<string>();
  let todoPlanSent = false; // 避免 on_tool_end 与 on_chain_end 重复下发 todo_plan
  // 从 checkpoint 读取已完成的步数，避免每轮重置
  let stepCount = 0;
  try {
    const ckpt = await graph.getState(runConfig(threadId));
    const existingTodo = ckpt?.values?.todoState as string | undefined;
    if (existingTodo) {
      const parsed = JSON.parse(existingTodo);
      stepCount = parsed.steps?.filter((s: any) => s.status === 'completed').length ?? 0;
    }
  } catch (e) { console.warn('[runGraph] 读取初始 checkpoint 失败:', e instanceof Error ? e.message : e); }
  const stepTimestamps: number[] = [Date.now()];

  // SSE keepalive：LLM 长时间思考时每 30s 发一次空事件，防止 nginx/proxy 断开
  const pingTimer = setInterval(() => {
    send({ type: 'token' as any, value: '' }).catch((e) => { console.warn('[runGraph] keepalive send 失败:', e); });
  }, 30_000);

  try {
      for await (const ev of events) {
        // 客户端断连时提前终止，避免浪费 LLM API 调用
        if (signal?.aborted) {
          console.log('[runGraph] 客户端断连，提前终止流');
          break;
        }
    if (ev.event === 'on_chat_model_stream') {
      const chunk = ev.data?.chunk as
        | { content?: unknown; tool_call_chunks?: Array<{ name?: string }>; tool_calls?: Array<{ name?: string }> }
        | undefined;
      const text = typeof chunk?.content === 'string' ? chunk.content : '';
      if (text) await send({ type: 'token', value: text });

      // 检测类课堂工具调用（advance_step / exit_session）
      const toolNames = [
        ...(chunk?.tool_call_chunks ?? []).map((t) => t.name).filter(Boolean),
        ...(chunk?.tool_calls ?? []).map((t) => t.name).filter(Boolean),
      ] as string[];
      for (const name of toolNames) {
        if (name === ADVANCE_STEP_TOOL && !todoStepSent.has(name)) {
          todoStepSent.add(name);
          stepCount++;
          stepTimestamps.push(Date.now());
          const elapsed = ((stepTimestamps[stepTimestamps.length - 1] - stepTimestamps[stepTimestamps.length - 2]) / 1000).toFixed(1);
          const total = ((stepTimestamps[stepTimestamps.length - 1] - stepTimestamps[0]) / 1000).toFixed(1);
          await send({ type: 'todo_step', action: 'advance', detail: '正在进入下一阶段' });
          console.log(`[Boen 类课堂] 🎯 第${stepCount}步完成 — 耗时 ${elapsed}s | 总 ${total}s | ${new Date().toLocaleTimeString()}`);
        }
        if (name === EXIT_SESSION_TOOL && !todoStepSent.has(name)) {
          todoStepSent.add(name);
          // exit 的 toast 由 handleSessionExit 在 settlement 时发送
          const args = (chunk as any)?.tool_calls?.[0]?.args ?? (chunk as any)?.tool_call_chunks?.[0] ?? {};
          const total = ((Date.now() - stepTimestamps[0]) / 1000).toFixed(1);
          console.log(`[Boen 类课堂] ✅ exit_session — ${stepCount}/${args?.totalSteps ?? '?'}步 | ${args?.score ?? '?'}分 | 总耗时 ${total}s | ${new Date().toLocaleTimeString()}`);
        }
        if (name === PLAN_STEPS_TOOL && !todoStepSent.has(name)) {
          todoStepSent.add(name);
          await send({ type: 'todo_step', action: 'plan', detail: '博文正在备课' });
          const args = (chunk as any)?.tool_calls?.[0]?.args ?? (chunk as any)?.tool_call_chunks?.[0] ?? {};
          const count = args?.steps?.length ?? '?';
          console.log(`[Boen 类课堂] 📋 plan_steps — 规划了 ${count} 步 | ${new Date().toLocaleTimeString()}`);
        }
        if (name === LOOKUP_KNOWLEDGE_POINT_TOOL && !todoStepSent.has(name)) {
          todoStepSent.add(name);
          await send({ type: 'todo_step', action: 'query', detail: '正在查询教材库' });
          console.log(`[Boen 类课堂] 📖 lookup_knowledge_point — 查询教材库 | ${new Date().toLocaleTimeString()}`);
        }
        if (name === SWITCH_SUBJECT_TOOL && !todoStepSent.has(name)) {
          todoStepSent.add(name);
          await send({ type: 'todo_step', action: 'switch', detail: '正在切换学科' });
          console.log(`[Boen 类课堂] 🔄 switch_subject 检测到 | ${new Date().toLocaleTimeString()}`);
        }
      }

      // 出题工具检测
      if (!quizSignaled) {
        for (const tc of chunk?.tool_call_chunks ?? []) if (tc.name) toolNameBuf += tc.name;
        const names = [...toolNames, toolNameBuf];
        if (names.some(looksLikeQuiz)) await signalQuiz();
      }
    } else if (ev.event === 'on_chat_model_end') {
      // 兜底：模型不分片流式输出 tool_call
      if (!quizSignaled) {
        const out = ev.data?.output as { tool_calls?: Array<{ name?: string }> } | undefined;
        if ((out?.tool_calls ?? []).some((t) => looksLikeQuiz(t.name))) await signalQuiz();
      }
      // 兜底检测 exit_session（不分片流时最后一帧拿完整 args）
      if (!todoStepSent.has(EXIT_SESSION_TOOL)) {
        const out = ev.data?.output as { tool_calls?: Array<{ name: string; args?: Record<string, unknown> }> } | undefined;
        const exitCall = out?.tool_calls?.find((t) => t.name === EXIT_SESSION_TOOL);
        if (exitCall) {
          const total = ((Date.now() - stepTimestamps[0]) / 1000).toFixed(1);
          console.log(`[Boen 类课堂] ✅ exit_session — ${stepCount}/${(exitCall.args as any)?.totalSteps ?? '?'}步 | ${(exitCall.args as any)?.score ?? '?'}分 | 总耗时 ${total}s | ${new Date().toLocaleTimeString()}`);
        }
      }
      // 兜底：用完整 args 重新发送 subject_changed（流式检测时 args 可能不完整）
      const out = ev.data?.output as { tool_calls?: Array<{ name: string; args?: Record<string, unknown> }> } | undefined;
      const switchCall = out?.tool_calls?.find((t) => t.name === SWITCH_SUBJECT_TOOL);
      if (switchCall?.args) {
        const subject = String((switchCall.args as any)?.subject ?? 'math');
        await send({ type: 'subject_changed', subject });
        console.log(`[Boen 类课堂] 🔄 switch_subject(完整args) → ${subject} | ${new Date().toLocaleTimeString()}`);
      }
    } else if (ev.event === 'on_tool_end') {
      // Command 型工具（plan_steps/advance_step）返回的 update.todoState 是最新权威状态，
      // 在 on_chain_end 读取 checkpoint 前直接下发，避免 checkpoint 保存时序导致的空态。
      const name = (ev as any)?.name ?? '';
      const output = (ev as any)?.data?.output;
      if (name === PLAN_STEPS_TOOL || name === ADVANCE_STEP_TOOL) {
        const sent = await sendTodoPlanFromCommand(output, send);
        if (sent) todoPlanSent = true;
      }
    } else if (ev.event === 'on_chain_end') {
      const nodeName = (ev as any)?.name ?? '';
      if (nodeName === 'tools' && todoStepSent.size > 0) {
        if (todoStepSent.has(PLAN_STEPS_TOOL)) {
          await send({ type: 'todo_done', action: 'plan', detail: '博文备课完成' });
        }
        if (todoStepSent.has(ADVANCE_STEP_TOOL)) {
          await send({ type: 'todo_done', action: 'advance', detail: '已进入下一阶段' });
        }
        if (todoStepSent.has(EXIT_SESSION_TOOL)) {
          await send({ type: 'todo_done', action: 'exit', detail: '课堂已结束' });
        }
        if (todoStepSent.has(SWITCH_SUBJECT_TOOL)) {
          // 等待 CSS 渐变动画播放完毕（0.7s）再结束 pending
          await new Promise(r => setTimeout(r, 800));
          await send({ type: 'todo_done', action: 'switch', detail: '学科已切换' });
        }
        if (todoStepSent.has(LOOKUP_KNOWLEDGE_POINT_TOOL)) {
          await send({ type: 'todo_done', action: 'query', detail: '教材库查询完成' });
        }
        // plan_steps / advance_step 现在由自包含的 Command 工具在 tools 节点内更新 todoState。
        // 优先从 ToolNode 返回的 Command 输出中直接提取 todoState 下发；若取不到（如非 Command 输出），
        // 再回退到读取 checkpoint，避免 checkpoint 保存时序导致的空态。
        if (!todoPlanSent && (todoStepSent.has(PLAN_STEPS_TOOL) || todoStepSent.has(ADVANCE_STEP_TOOL))) {
          const output = (ev as any)?.data?.output;
          const commands = Array.isArray(output) ? output : [output];
          for (const cmd of commands) {
            const sent = await sendTodoPlanFromCommand(cmd, send);
            if (sent) {
              todoPlanSent = true;
              break;
            }
          }
          if (!todoPlanSent) {
            await sendTodoPlan(threadId, send);
          }
        }
      }
    } else if (ev.event === 'on_chain_error') {
      const nodeName = (ev as any)?.name ?? '';
      if (nodeName === 'tools') {
        if (todoStepSent.has(PLAN_STEPS_TOOL)) {
          await send({ type: 'todo_fail', action: 'plan', error: '备课工具执行失败' });
        }
        if (todoStepSent.has(ADVANCE_STEP_TOOL)) {
          await send({ type: 'todo_fail', action: 'advance', error: '步骤推进工具执行失败' });
        }
        if (todoStepSent.has(EXIT_SESSION_TOOL)) {
          await send({ type: 'todo_fail', action: 'exit', error: '退出工具执行失败' });
        }
        if (todoStepSent.has(LOOKUP_KNOWLEDGE_POINT_TOOL)) {
          await send({ type: 'todo_fail', action: 'query', error: '教材库查询失败' });
        }
        if (todoStepSent.has(SWITCH_SUBJECT_TOOL)) {
          await send({ type: 'todo_fail', action: 'switch', error: '学科切换失败' });
        }
      }
    }
  }
  } catch (err) {
    console.error('[runGraph] 流式执行异常:', err instanceof Error ? err.message : err);
  } finally {
    clearInterval(pingTimer);
  }
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const msgs = (state.values?.messages ?? []) as BaseMessage[];
  const question = getPendingQuestion(state);
  // 返回最后一条 AI 消息（含 tool_calls），而非 exitSession 节点产生的 ToolMessage
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].getType() === 'ai') return { last: msgs[i], question };
  }
  return { last: msgs[msgs.length - 1], question };
}

/** 检测 exit_session 工具调用 → 结算 + 清缓存 */
/** 按 LLM 评分（主）+ 星级跨越奖（额外）结算积分并入账。
 *  scorePoints + starBonus 合并后走 earnPoints 日上限封顶。
 *  均为 0 时返回 undefined（不附带积分字段）。 */
function awardSessionPoints(
  userId: string,
  changes: Array<{ before: number; after: number }>,
  subject: string | undefined,
  grade: string | undefined,
  reason: 'session' | 'exam',
  refId?: string,
  sessionScore?: number,
): { pointsEarned: number; pointsBalance: number; pointsCapped: boolean } | undefined {
  try {
    let S = 0;
    if (subject && grade) {
      const outline = getProfileOutline(subject, grade, userId) as { overall?: { weightedScore?: number } };
      S = Math.max(0, outline.overall?.weightedScore ?? 0);
    }
    const scorePoints = computeScorePoints(sessionScore ?? 0, S);
    const starBonus = computeStarBonus(changes, S);
    const total = Math.max(0, Math.round(scorePoints + starBonus));
    if (total <= 0) return undefined;
    const res = earnPoints(userId, total, reason, refId);
    if (res.earned <= 0 && !res.capped) return undefined;
    return { pointsEarned: res.earned, pointsBalance: res.balance, pointsCapped: res.capped };
  } catch (e) { console.warn('[awardSessionPoints] 结算失败:', e instanceof Error ? e.message : e);
    return undefined;
  }
}

async function handleSessionExit(last: BaseMessage | undefined, send: (e: SseEvent) => Promise<void>, userId?: string, threadId?: string, subject?: string, grade?: string, settled = false) {
  // MODE_SCORE 路径已经完成结算，跳过避免重复发送
  if (settled) return;
  let exitCall: ToolCall | undefined;

  // Case 1: last 本身是带 exit_session 的 AI 消息
  const lastCalls = ((last as AIMessage | undefined)?.tool_calls ?? []) as ToolCall[];
  exitCall = lastCalls.find((c) => c.name === EXIT_SESSION_TOOL);

  // Case 2: 消息已被 exitSession 节点处理 → 从 state 历史中回溯查找
  if (!exitCall && threadId) {
    try {
      const state = await graph.getState({ configurable: { thread_id: threadId } });
      const msgs = (state?.values?.messages ?? []) as BaseMessage[];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const aiMsg = msgs[i] as AIMessage;
        if (aiMsg?.tool_calls?.length) {
          const found = (aiMsg.tool_calls as ToolCall[]).find((c) => c.name === EXIT_SESSION_TOOL);
          if (found) { exitCall = found; break; }
        }
      }
    } catch (e) { console.warn('[handleSessionExit] 回溯 exit_session 失败:', e instanceof Error ? e.message : e); }
  }

  if (exitCall?.args && userId && threadId) {
    const args = exitCall.args as Record<string, unknown>;
    const { count: updatedKps, changes: profChanges } = flushProficiencyCache(userId, threadId);
    await send({ type: 'todo_done', action: 'exit', detail: '课堂已结束' });
    // 仅当 cache 非空才发结算事件（MODE_SCORE 路径已发过时跳过）
    if (updatedKps > 0) {
      const points = awardSessionPoints(userId, profChanges, subject, grade, 'session', threadId, Number(args.score ?? 0));
      await send({
        type: 'settlement',
        summary: String(args.summary ?? ''),
        score: Number(args.score ?? 0),
        stepsCompleted: Number(args.stepsCompleted ?? 0),
        totalSteps: Number(args.totalSteps ?? 0),
        updatedKps,
        proficiencyChanges: profChanges.length > 0 ? profChanges : undefined,
        ...points,
      });
    }
  }
}

async function emitReviewCompleteIfAny(last: BaseMessage | undefined, send: (e: SseEvent) => Promise<void>) {
  const calls = ((last as AIMessage | undefined)?.tool_calls ?? []) as ToolCall[];
  const reviewCall = calls.find((c) => c.name === COMPLETE_REVIEW_TOOL);
  if (reviewCall?.args) {
    const args = reviewCall.args as Record<string, unknown>;
    await send({
      type: 'review_complete',
      summary: String(args.summary ?? ''),
      score: Number(args.overallScore ?? 0),
      totalQuestions: Number(args.totalQuestions ?? 0),
      correctAnswers: Number(args.correctAnswers ?? 0),
    });
  }
}

/** 为新对话自动生成标题（基于首轮用户消息） */
async function autoGenerateTitle(conversationId: string, userMessage: string, onTitle: (title: string) => Promise<void>) {
  try {
    const result = await Promise.race([
      model.invoke([
        new SystemMessage('用 2-8 个字概括用户提问的主题，直接输出标题，不要引号和标点。'),
        new HumanMessage(userMessage),
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TITLE_TIMEOUT')), 5000)),
    ]);
    let title = (typeof result.content === 'string' ? result.content : '').trim().replace(/["""']/g, '');
    if (!title) return;
    // 限制标题长度
    if (title.length > 20) title = title.slice(0, 20);
    const conv = getConversation(conversationId);
    if (conv && conv.title === '新对话') {
      updateConversationTitle(conversationId, title);
      await onTitle(title);
    }
  } catch (e) { console.warn('[title] auto-generation failed:', e instanceof Error ? e.message : e); }
}

/** 若最后一条消息触发了出题工具，推送 question 事件（每次只呈现第一道） */
type QuestionScope = { subject: string; grade?: string };

/**
 * The LLM is allowed to choose a published node ID, never to supply the
 * learner-visible knowledge-point or literacy labels.  Resolve both labels
 * from the graph immediately before persistence/SSE delivery.
 */
function databaseQuestionPayload(quiz: ToolCall, scope: QuestionScope): import('@boen/shared').QuestionPayload {
  const payload = toQuestionPayload(quiz.name, quiz.args);
  const allowedKnowledgePointIds = scope.grade
    ? getPublishedKnowledgePointIds(scope.subject, scope.grade)
    : [];
  const taxonomy = resolveQuestionTaxonomy({
    subject: scope.subject,
    grade: scope.grade,
    knowledgePointId: payload.knowledgePointId,
    // Compatibility lookup only: even in this path the displayed label still
    // comes from the database and is limited to this published scope.
    knowledgePointTitle: quiz.args.knowledgePoint,
    allowedKnowledgePointIds,
  });
  if (!taxonomy) {
    throw new Error('题目没有绑定当前学科、年级的已发布知识点，已拒绝展示');
  }
  return { ...payload, ...taxonomy };
}

/**
 * 把出题失败原因作为该出题工具的结果回灌给模型（type:'answer' → 路由回 agent），
 * 让它据此重新出题。返回重试后新的 pending 题目（若有）。
 */
async function resumeQuestionWithError(
  threadId: string,
  toolCallId: string,
  reason: string,
  send: (e: SseEvent) => Promise<void>,
): Promise<ToolCall | undefined> {
  const { question } = await runGraph(new Command<QuestionResume>({
    resume: {
      type: 'answer', // 'answer' 会路由回 agent，让模型看到错误结果后重试
      toolCallId,
      toolContent: `出题失败：${reason}。请改用一个【当前学科、年级下已发布】的知识点，重新调用出题工具生成一道新题。`,
    },
  }), threadId, send);
  return question;
}

/**
 * 安全下发题目：构建题卡失败（如题目未绑定当前学科年级的已发布知识点）时，
 * **不抛错中断本轮 SSE**，而是把失败原因回灌给模型让它重试出题（最多 maxRetry 次）；
 * 仍失败则跳空 interrupt + 统一 fail 工具卡片收尾，避免线程卡死、后续输入无响应。
 * @returns 是否最终成功下发了题卡
 */
async function safeDeliverQuestion(
  quiz: ToolCall | undefined,
  send: (e: SseEvent) => Promise<void>,
  scope: QuestionScope,
  threadId: string,
  persistConversationId?: string,
  maxRetry = 2,
): Promise<boolean> {
  let current = quiz;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (!current?.id) return false; // 模型未再出题（如改为文字回复）→ 不再处理
    let payload: import('@boen/shared').QuestionPayload | null = null;
    let reason = '';
    try {
      payload = databaseQuestionPayload(current, scope);
    } catch (err) {
      reason = sanitizeError(err);
    }
    if (payload) {
      if (persistConversationId) {
        addMessage(persistConversationId, 'system', JSON.stringify({ __boen_type: 'question', toolCallId: current.id, payload, answered: false }));
      }
      await send({ type: 'question', toolCallId: current.id, question: payload });
      return true;
    }
    console.warn(`[question] 题卡构建失败（第 ${attempt + 1} 次）:`, reason);
    if (attempt < maxRetry) {
      // 回灌错误让模型重试出题（重试中模型再次调用出题工具会自动再发 quiz_generating）
      try {
        current = await resumeQuestionWithError(threadId, current.id, reason, send);
      } catch (err) {
        console.warn('[question] 重试出题失败:', err instanceof Error ? err.message : err);
        break;
      }
    }
  }
  // 重试用尽：清空中断 + 统一 fail 工具卡片，保证 done 正常收尾、线程不卡
  await drainPendingQuestions(threadId, send);
  await send({ type: 'todo_fail', action: 'quiz', error: '这道题没能生成，我们继续吧' });
  return false;
}

/**
 * 对尚未作答的题目执行原生 interrupt 恢复，并将其标为跳过。
 * awaitQuestion 节点会直接结束该轮，因此下一条用户消息可安全启动新一轮图执行。
 */
async function resumePendingQuestionAsSkipped(threadId: string, send: (e: SseEvent) => Promise<void>): Promise<boolean> {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const question = getPendingQuestion(state);
  if (!question?.id) return false;
  await runGraph(new Command<QuestionResume>({
    resume: {
      type: 'skip',
      toolCallId: question.id,
      toolContent: '（用户未作答此题，已跳过）',
    },
  }), threadId, send);
  return true;
}

/**
 * 在开始新一轮前，循环清空线程里残留的未作答 interrupt（最多 max 次）。
 * 单次 skip 后 agent 可能再次出题导致新的 interrupt；不清空会与新输入的图执行
 * 冲突，表现为"再输入无响应"。任何异常都吞掉，绝不阻断新回合。
 */
async function drainPendingQuestions(
  threadId: string,
  send: (e: SseEvent) => Promise<void>,
  max = 3,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    let cleared = false;
    try {
      cleared = await resumePendingQuestionAsSkipped(threadId, send);
    } catch (err) {
      console.warn('[drain] 跳过残留题目失败:', err instanceof Error ? err.message : err);
      return;
    }
    if (!cleared) return;
  }
  console.warn('[drain] 连续跳过仍有残留 interrupt，已达上限，放弃');
}


/** Strip unverifiable labels from historical conversation payloads on read. */
function sanitizeConversationQuestionMessage<T extends { role: string; content: string }>(message: T, subject: string): T {
  if (message.role !== 'system') return message;
  try {
    const meta = JSON.parse(message.content) as Record<string, any>;
    if (meta.__boen_type !== 'question') return message;
    const canonicalize = (value: Record<string, any> | undefined) => {
      if (!value) return value;
      const taxonomy = getQuestionTaxonomyById(Number(value.knowledgePointId), subject);
      return taxonomy
        ? { ...value, ...taxonomy, knowledgePoints: [taxonomy.knowledgePoint] }
        : { ...value, knowledgePointId: undefined, knowledgePoint: undefined, knowledgePoints: undefined, literacies: [] };
    };
    meta.payload = canonicalize(meta.payload);
    meta.grading = canonicalize(meta.grading);
    return { ...message, content: JSON.stringify(meta) };
  } catch (e) { console.warn('[sanitizeConversationQuestionMessage] 解析失败:', e instanceof Error ? e.message : e);
    return message;
  }
}

const app = new Hono();
initPrivacyRetention(db);
app.use('/api/*', cors());
app.use('/api/*', async (c, next) => {
  const userId = c.req.header('authorization')?.startsWith('Bearer ') ? await resolveUserId(c) : null;
  if (userId && db.prepare('SELECT 1 FROM privacy_deletion_requests WHERE user_id=?').get(userId)) {
    return c.json({ error: 'account_deletion_requested', message: '该账户的数据删除申请正在处理或已经完成，请联系支持。' }, 410);
  }
  const preference = userId ? db.prepare('SELECT provider FROM user_model_preferences WHERE user_id=?').get(userId) as { provider: string } | undefined : undefined;
  const provider = userId && preference?.provider === 'deepseek-pro' && membershipDetails(db, userId).membership.active ? 'deepseek-pro' : 'default';
  return providerScope.run(provider, next);
});

// 全局 Zod 校验错误处理
app.onError((err, c) => {
  if (err instanceof z.ZodError) {
    return c.json({ error: 'validation_error', message: err.errors?.[0]?.message ?? '请求参数校验失败' }, 400);
  }
  console.error('[onError] 未捕获异常:', err instanceof Error ? err.stack : err);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true, provider: 'deepseek', model: (model as any)?.modelName ?? 'deepseek-v4-flash' }));

// ── 模型切换 API ────────────────────────────
/** POST /api/model/switch — 切换模型提供商（需认证；deepseek-pro 需要有效会员） */
app.post('/api/model/switch', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const body = SwitchModelSchema.parse(await c.req.json());
  const p = body.provider;
  if (!p || !DEEPSEEK_MODELS[p]) return c.json({ error: '不支持的 provider' }, 400);
  // V4 Pro 对所有有效星月卡开放
  if (p === 'deepseek-pro') {
    if (!membershipDetails(db, userId).membership.active) return c.json({ error: 'premium_required', message: 'DeepSeek V4 Pro 需要有效的星月卡权益' }, 403);
  }
  const switched = switchModel(userId, p);
  return c.json({ success: true, provider: switched });
});

/** GET /api/model/status — 当前模型状态 */
app.get('/api/model/status', (c) => {
  const current = model as any;
  return c.json({
    provider: 'deepseek',
    model: current.modelName ?? 'deepseek-v4-flash',
    models: DEEPSEEK_MODELS,
  });
});

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === 'string' ? value : undefined;
}

function isFormFile(value: unknown): value is { name?: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return !!value && typeof value === 'object' && 'arrayBuffer' in value && typeof (value as any).arrayBuffer === 'function';
}

// ── TiKZ 渲染 API（安全加固版） ──────────────

/** POST /api/render-tikz — 安全加固的 TikZ → SVG 渲染 */
app.post('/api/render-tikz', async (c) => {
  // 1. 鉴权
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  const { code } = await c.req.json<{ code?: unknown }>();

  try {
    validateTikzCode(code);
    consumeTikzRateLimit(userId);
    const requestId = crypto.randomUUID();
    const svg = await renderTikzSvg(code, requestId);
    return c.json({ svg });
  } catch (err) {
    if (err instanceof TikzRenderError) return c.json({ error: err.message }, err.status as 400 | 429 | 500);
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
    console.error('[tikz] request_failed', JSON.stringify({ message }));
    return c.json({ error: 'TikZ request failed' }, 500);
  }
});

// ── 知识图谱 API ────────────────────────────
// 初始化表（幂等）
ensureKnowledgeGraphTables();

/** GET /api/kg/nodes?type=theme&subject=math — 按类型查节点 */
app.get('/api/kg/nodes', async (c) => {
  if (!await resolveUserId(c)) return c.json({ error: 'unauthorized' }, 401);
  const type = c.req.query('type') as any;
  const subject = c.req.query('subject');
  if (!type) return c.json({ error: 'type 参数必填' }, 400);
  const nodes = getNodesByType(type, subject);
  return c.json({ nodes });
});

/** GET /api/kg/neighbors/:nodeId — 查某节点的相邻节点 */
app.get('/api/kg/neighbors/:nodeId', async (c) => {
  if (!await resolveUserId(c)) return c.json({ error: 'unauthorized' }, 401);
  const nodeId = Number(c.req.param('nodeId'));
  const edgeType = c.req.query('edgeType') as any;
  if (isNaN(nodeId)) return c.json({ error: 'nodeId 无效' }, 400);
  const neighbors = getNeighbors(nodeId, edgeType);
  return c.json({ neighbors });
});

/** GET /api/kg/unit/:unitId — 查某章节的知识图谱上下文 */
app.get('/api/kg/unit/:unitId', async (c) => {
  if (!await resolveUserId(c)) return c.json({ error: 'unauthorized' }, 401);
  const unitId = Number(c.req.param('unitId'));
  if (isNaN(unitId)) return c.json({ error: 'unitId 无效' }, 400);
  const context = getKgContextForUnit(unitId);
  return c.json({ unitId, context });
});

// ── 知识点权重 API ────────────────────────────
/** GET /api/kg/weights/distribution?subject=math&grade=7 — 权重分布 */
app.get('/api/kg/weights/distribution', async (c) => {
  if (!await resolveUserId(c)) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const dist = getWeightDistribution(subject, grade);
  return c.json({ subject, grade, total: dist.length, distribution: dist });
});

/** GET /api/kg/weights/guide?subject=math&grade=7 — 出题参考文本 */
app.get('/api/kg/weights/guide', async (c) => {
  if (!await resolveUserId(c)) return c.json({ error: 'unauthorized' }, 401);
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const guide = formatWeightGuide(subject, grade);
  return c.json({ subject, grade, guide });
});
// ── 知识画像 API ────────────────────────────
/** GET /api/profile/outline?subject=math&grade=7 — 章节树+掌握度 */
app.get('/api/profile/outline', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const outline = getProfileOutline(subject, grade, userId);
  return c.json(outline);
});

/** GET /api/profile/proficiency — 用户熟练度数据 */
app.get('/api/profile/proficiency', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const profs = getAllProficiencies(userId, subject, grade);
  return c.json({ proficiencies: profs });
});

/** GET /api/profile/report — LLM 生成诊断报告 */
app.get('/api/profile/report', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const profs = getAllProficiencies(userId, subject, grade);
  const weak = profs.filter(p => p.weightedScore < 60).slice(0, 8);
  const strong = profs.filter(p => p.weightedScore >= 80).slice(0, 5);
  const literacy = getLiteracyProficiency(userId, subject);
  const subjectLabel: Record<string, string> = { chinese: '语文', math: '数学', english: '英语', science: '科学' };

  const prompt = [
    `你是一位经验丰富的学科教师。请根据以下学习数据，生成一份简短的学习诊断报告。`,
    `学科：${subjectLabel[subject] ?? subject}`,
    `年级：${grade}，掌握知识点：${profs.length} 个`,
    weak.length ? `薄弱点（< 60%）：${weak.map(w => `${w.title}(${w.weightedScore}%)`).join('、')}` : '暂无薄弱点',
    strong.length ? `掌握良好（≥ 80%）：${strong.map(s => `${s.title}(${s.weightedScore}%)`).join('、')}` : '',
    literacy.length ? `核心素养：${literacy.map(l => `${l.literacy} ${l.percentage}%`).join('、')}` : '',
    '',
    '请用 Markdown 格式输出：',
    '1. **总体评价** — 一两句话概括，语气鼓励',
    '2. **需要优先突破** — 列出 2-3 个最该先抓的薄弱点及原因',
    '3. **学习建议** — 针对每个薄弱点给具体做法',
    '4. **下一步方向** — 下一阶段建议',
  ].join('\n');
  try {
    const response = await model.invoke([new SystemMessage(prompt)]);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    return c.json({ report: content.trim() });
  } catch (e) { console.error('[profile/report] 生成报告失败:', e instanceof Error ? e.message : e); return c.json({ error: '生成报告失败' }, 500); }
});

/** GET /api/profile/weak-points — 薄弱知识点 */
app.get('/api/profile/weak-points', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const threshold = c.req.query('threshold') ? Number(c.req.query('threshold')) : 60;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 10;
  const weak = getWeakPoints(userId, subject, grade, threshold, limit);
  return c.json({ weakPoints: weak });
});

/** GET /api/profile/strong-points — 优势知识点 */
app.get('/api/profile/strong-points', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade');
  const threshold = c.req.query('threshold') ? Number(c.req.query('threshold')) : 75;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 10;
  const strong = getStrongPoints(userId, subject, grade, threshold, limit);
  return c.json({ strongPoints: strong });
});

/** GET /api/profile/literacies — 素养熟练度 */
app.get('/api/profile/literacies', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const lits = getLiteracyProficiency(userId, subject);
  return c.json({ literacies: lits });
});

/** GET /api/profile/recommendations — 练习推荐 */
app.get('/api/profile/recommendations', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const subject = c.req.query('subject') || 'math';
  const grade = c.req.query('grade') || '7';
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 5;
  const recs = getRecommendedKPs(userId, subject, grade, limit);
  return c.json({ recommendations: recs });
});

/** GET /api/profile/weakness-chain/:nodeId — 前置弱点追溯 */
app.get('/api/profile/weakness-chain/:nodeId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const nodeId = Number(c.req.param('nodeId'));
  if (isNaN(nodeId)) return c.json({ error: 'nodeId 无效' }, 400);
  const chain = getPrerequisiteWeaknessChain(userId, nodeId);
  return c.json({ chain });
});

/** POST /api/profile/seed — 从历史答题记录回填熟练度 */
app.post('/api/profile/seed', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const { updated } = seedProficiencyFromHistory(userId);
  return c.json({ updated });
});

// ── 错题本 API ─────────────────────────────────────────────
app.get('/api/mistakes', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  return c.json(listMistakes(userId, {
    subject: c.req.query('subject') || undefined,
    grade: c.req.query('grade') || undefined,
    status: (c.req.query('status') as any) || undefined,
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    includeCorrect: c.req.query('includeCorrect') === '1' || c.req.query('includeCorrect') === 'true',
  }));
});

app.post('/api/mistakes', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  try {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('image') ?? form.get('file');
      const asset = isFormFile(file)
        ? {
            bytes: Buffer.from(await file.arrayBuffer()),
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
          }
        : undefined;
      const mistake = createMistake(userId, {
        sourceType: (formString(form, 'sourceType') as any) || (asset ? 'image' : 'text'),
        subject: formString(form, 'subject') || 'math',
        grade: formString(form, 'grade') || '7',
        promptText: formString(form, 'promptText'),
        studentAnswer: formString(form, 'studentAnswer'),
        note: formString(form, 'note'),
        asset,
      });
      return c.json({ mistake }, 201);
    }
    const body = await c.req.json<{
      sourceType?: string;
      subject?: string;
      grade?: string;
      promptText?: string;
      studentAnswer?: string;
      note?: string;
    }>();
    const mistake = createMistake(userId, {
      sourceType: (body.sourceType as any) || 'text',
      subject: body.subject || 'math',
      grade: body.grade || '7',
      promptText: body.promptText,
      studentAnswer: body.studentAnswer,
      note: body.note,
    });
    return c.json({ mistake }, 201);
  } catch (err) {
    return c.json({ error: sanitizeError(err) }, 400);
  }
});

app.post('/api/mistakes/:id/analyze', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const mistakeId = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const send = (e: AnalyzeMistakeEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    // SSE keepalive：图片错题的多模态识别为单次调用，密集整页可达 60~90s 无业务事件，
    // 每 20s 发一个 SSE 注释帧（: 开头，前端 data: 解析会跳过）防止 nginx proxy 断流。
    const ping = setInterval(() => { stream.write(': keepalive\n\n').catch(() => {}); }, 20_000);
    const ac = new AbortController();
    stream.onAbort(() => { ac.abort(); clearInterval(ping); });
    try {
      await analyzeMistake(mistakeId, userId, model,
        (p) => send({ type: 'mistake_progress', step: p.step, message: p.message, progress: p.progress }),
        (mistake) => send({ type: 'mistake_ready', mistake }),
      );
      await send({ type: 'done' });
    } catch (err) {
      try { await send({ type: 'error', message: sanitizeError(err) }); } catch (e2) { console.warn('[mistakes/analyze] SSE send 失败:', e2); }
    } finally {
      clearInterval(ping);
    }
  });
});

app.get('/api/mistakes/:id', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const detail = getMistakeDetail(c.req.param('id'), userId);
  if (!detail) return c.json({ error: '错题不存在' }, 404);
  return c.json(detail);
});

app.patch('/api/mistakes/:id', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  try {
    const body = await c.req.json<{ promptText?: string; studentAnswer?: string; correctAnswer?: string; errorReason?: string }>();
    const mistake = updateMistake(c.req.param('id'), userId, body);
    return c.json({ mistake });
  } catch (err) {
    return c.json({ error: sanitizeError(err) }, 400);
  }
});

app.delete('/api/mistakes/:id', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const ok = archiveMistake(c.req.param('id'), userId);
  if (!ok) return c.json({ error: '错题不存在' }, 404);
  return c.json({ success: true });
});

app.get('/api/mistakes/:id/assets/:assetId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const asset = getMistakeAssetFile(c.req.param('id'), Number(c.req.param('assetId')), userId);
  if (!asset) return c.json({ error: '图片不存在' }, 404);
  const bytes = await readMistakeAsset(asset.filePath);
  return c.body(new Uint8Array(bytes), 200, { 'Content-Type': asset.mimeType, 'Cache-Control': 'private, max-age=3600' });
});

app.post('/api/mistakes/:id/practice', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const detail = getMistakeDetail(c.req.param('id'), userId);
  if (!detail) return c.json({ error: '错题不存在' }, 404);
  return c.json({ prompt: formatMistakePracticePrompt(detail.mistake) });
});

import { generateExam, createExamSession, updateExamSession, getExamSession, submitExamSession, listExamSessions, deleteExamSession, createShortAnswerGrader, generateDetailedReview } from './exam.js';
import { postExamRecommendation } from './exam-recommendation.js';

/** POST /api/exam/generate — 生成新试卷（SSE 流式：实时推送规划→出题→审核进度） */
app.post('/api/exam/generate', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { subject: string; grade: string; difficulty?: string; durationMinutes?: number; notes?: string; totalScore?: number; examId?: string };
  if (!body.subject || !body.grade) return c.json({ error: '缺少必填字段：subject, grade' }, 400);
  // 如果前端传入了 examId（来自 POST /api/exam 的预创建记录），直接用这个 ID
  const preCreatedId = body.examId;
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const ac = new AbortController();
    stream.onAbort(() => { ac.abort(); });
    try {
      await send({ type: 'exam_generating' });
      const exam = await generateExam(
        examModel,
        { subject: body.subject, grade: body.grade, durationMinutes: body.durationMinutes, notes: body.notes, totalScore: body.totalScore },
        (p) => {
          if (ac.signal.aborted) throw new DOMException('SSE stream aborted by client', 'AbortError');
          return send({ type: 'exam_progress', step: p.step, message: p.message, progress: p.progress ?? 0 });
        },
        userId,
        ac.signal,
      );
      // 使用预创建的 examId 更新记录，否则新建
      const session = preCreatedId
        ? updateExamSession(preCreatedId, userId, { subject: body.subject, grade: body.grade }, exam)!
        : createExamSession(userId, { subject: body.subject, grade: body.grade }, exam);
      await send({
        type: 'exam_ready',
        examId: session.id,
        title: exam.title,
        totalQuestions: exam.questions.length,
        totalScore: exam.totalScore,
        durationMinutes: exam.durationMinutes,
      });
      await send({ type: 'done' });
    } catch (err) {
      const msg = sanitizeError(err);
      console.error('出卷失败:', msg.slice(0, 200));
      try { await send({ type: 'error', message: msg }); } catch (e2) { console.warn('[exam/generate] SSE send 失败:', e2); }
    }
  });
});

/** POST /api/exam/submit — 提交考试答案 */
app.post('/api/exam/submit', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { examId: string; answers?: Array<{ questionIndex: number; answer: any }> };
  if (!body.examId) return c.json({ error: '缺少必填字段：examId' }, 400);
  // 允许 answers 为空数组（用户可能留空全部题目），未作答的题由评分逻辑按 0 分处理
  const answers = Array.isArray(body.answers) ? body.answers : [];
  try {
    const results = await submitExamSession(body.examId, userId, answers as any, model);
    // Attach post-exam adaptive recommendations
    try {
      const session = getExamSession(body.examId, userId);
      if (session) {
        const recommendation = postExamRecommendation(userId, session.subject, session.grade ?? '7', results);
        (results as any).recommendation = recommendation;
      }
    } catch (err) {
      console.warn('[exam] recommendation generation failed:', sanitizeError(err));
    }
    return c.json({ success: true, results });
  } catch (err) {
    return c.json({ error: sanitizeError(err) }, 400);
  }
});

/** POST /api/exam/submit/stream - stream real grading progress */
app.post('/api/exam/submit/stream', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { examId: string; answers?: Array<{ questionIndex: number; answer: any }> };
  if (!body.examId) return c.json({ error: '缺少必填字段：examId' }, 400);
  const answers = Array.isArray(body.answers) ? body.answers : [];

  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const ac = new AbortController();
    stream.onAbort(() => { ac.abort(); });
    try {
      const results = await submitExamSession(
        body.examId,
        userId,
        answers as any,
        model,
        (p) => send({ type: 'exam_grading_progress', step: p.step, message: p.message, progress: p.progress }),
      );
      // Attach post-exam adaptive recommendations
      try {
        const session = getExamSession(body.examId, userId);
        if (session) {
          const recommendation = postExamRecommendation(userId, session.subject, session.grade ?? '7', results);
          (results as any).recommendation = recommendation;
        }
      } catch (err) {
        console.warn('[exam] recommendation generation failed:', sanitizeError(err));
      }
      await send({ type: 'exam_graded', examId: body.examId, results });
      await send({ type: 'done' });
    } catch (err) {
      const msg = sanitizeError(err);
      try { await send({ type: 'error', message: msg }); } catch (e2) { console.warn('[exam/submit/stream] SSE send 失败:', e2); }
    }
  });
});

/** POST /api/exam — 创建空考试记录（立即返回 examId，用于断线恢复 */
app.post('/api/exam', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const body = await c.req.json() as { subject: string; grade: string; durationMinutes?: number; notes?: string };
  if (!body.subject || !body.grade) return c.json({ error: '缺少必填字段：subject, grade' }, 400);
  const id = `exam-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO exam_sessions (id, user_id, subject, grade, title, questions, total_score, duration_minutes, status, created_at, updated_at) VALUES (?, ?, ?, ?, '', '[]', 0, ?, 'generating', ?, ?)`).run(
    id, userId, body.subject, body.grade, body.durationMinutes ?? 45, now, now,
  );
  return c.json({ examId: id });
});

/** GET /api/exams — 当前用户的考试历史列表（概要） */
app.get('/api/exams', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  return c.json({ exams: listExamSessions(userId) });
});

/** DELETE /api/exam/:examId — 删除一场考试（任意状态，仅限本人） */
app.delete('/api/exam/:examId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const ok = deleteExamSession(c.req.param('examId'), userId);
  if (!ok) return c.json({ error: '考试未找到' }, 404);
  return c.json({ success: true });
});

/** GET /api/exam/:examId — 获取考试详情和结果
 *  - 进行中（pending）：返回脱敏题目（不含正确答案），用于答题
 *  - 已完成（completed）：返回完整题目（含答案）+ 用户作答，用于历史回顾
 */
app.get('/api/exam/:examId', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const examId = c.req.param('examId');
  const session = getExamSession(examId, userId);
  if (!session) return c.json({ error: '考试未找到' }, 404);
  const completed = session.status === 'completed';
  const questions = completed
    ? session.questions // 已交卷：揭示完整题目（正确答案/解析）供回顾
    : session.questions.map(q => ({
        index: q.index, type: q.type, stem: q.stem, passage: q.passage, points: q.points,
        knowledgePointId: q.knowledgePointId, knowledgePoint: q.knowledgePoint, literacies: q.literacies, difficulty: q.difficulty,
        options: q.type === 'multiple_choice' ? q.options : undefined,
        multiSelect: q.type === 'multiple_choice' ? q.multiSelect : undefined,
        blankCount: q.type === 'fill_blank' ? (q.blankCount ?? q.blanks?.length ?? 1) : undefined,
        tikzSvgs: q.tikzSvgs,
      }));
  return c.json({
    exam: {
      id: session.id,
      examId: session.id,
      title: session.title,
      subject: session.subject,
      grade: session.grade,
      totalScore: session.totalScore,
      durationMinutes: session.durationMinutes,
      status: session.status,
      createdAt: session.createdAt,
      submittedAt: session.submittedAt,
      questions,
      answers: completed ? session.answers : undefined,
      results: session.results,
      blueprint: session.blueprint,
      qualityReport: session.qualityReport,
    },
  });
});

/** POST /api/exam/:examId/detailed-review - Generate detailed review for wrong answers */
app.post('/api/exam/:examId/detailed-review', async (c) => {
  const authResult = await resolveSubscription(c);
  const gate = requirePremium(c, authResult);
  if (gate) return gate;
  const userId = authResult!.userId;
  const examId = c.req.param('examId');
  const session = getExamSession(examId, userId);
  if (!session) return c.json({ error: '考试未找到' }, 404);
  if (session.status !== 'completed') return c.json({ error: '考试尚未完成' }, 400);
  if (!session.results || !session.answers) return c.json({ error: '暂无判分结果' }, 400);

  try {
    const enhancedResults = await generateDetailedReview(
      model,
      session.questions,
      session.answers,
      session.results,
    );

    // Update the stored results with detailed explanations
    const updatedResults = { ...session.results, questionResults: enhancedResults };
    db.prepare(`UPDATE exam_sessions SET results=? WHERE id=?`).run(JSON.stringify(updatedResults), examId);

    return c.json({ questionResults: enhancedResults });
  } catch (err) {
    console.error('[detailed-review] failed:', sanitizeError(err));
    return c.json({ error: '生成详解失败' }, 500);
  }
});



// ── 订阅状态 API ────────────────────────────
app.get('/api/subscription/status', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  try { await reconcileMembership(userId); } catch { /* Keep the last confirmed period; never extend it on failure. */ }
  const result = await resolveSubscription(c);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  const dailyUsed = result.sub.isPremium ? null : getDailyUsage(result.userId);
  return c.json({
    ...membershipDetails(db, result.userId),
    tier: result.sub.tier,
    isPremium: result.sub.isPremium,
    expiresAt: result.sub.expiresAt,
    activatedAt: result.sub.activatedAt,
    dailyLimit: result.sub.isPremium ? null : FREE_DAILY_LIMIT,
    dailyUsed,
    dailyRemaining: result.sub.isPremium ? null : Math.max(0, FREE_DAILY_LIMIT - (dailyUsed ?? 0)),
    // 现金购卡通道状态：前端据此决定是否渲染「立即开通」入口
    payEnabled: isWaffoEnabled(),
    plans: listPurchasablePlans(),
  });
});

// ── 星月积分 API ────────────────────────────
const CURRENCY_PRODUCT_LIST = Object.values(CURRENCY_PRODUCTS).map((p) => ({
  key: p.key, name: p.name, days: p.days, cost: p.cost,
}));

app.get('/api/currency/status', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const status = getCurrencyStatus(userId);
  return c.json({ ...status, products: CURRENCY_PRODUCT_LIST });
});

app.get('/api/currency/ledger', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ entries: listLedger(userId, 30) });
});

// 领取每日登录奖励（北京时间每天一次，+50 星月积分）
app.post('/api/currency/claim-daily', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  if (!checkRedeemRate(userId)) return c.json({ error: 'rate_limited', message: '尝试过于频繁，请稍后再试' }, 429);
  const r = claimDailyLogin(userId);
  if (!r.ok) {
    return c.json({ error: r.error, message: '今日已领取', claimedToday: true, balance: r.balance }, 400);
  }
  return c.json({ ok: true, reward: r.reward, balance: r.balance, claimedToday: true });
});

// 用积分兑换会员（皓月卡/星耀卡）
app.post('/api/currency/redeem-membership', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  if (!checkRedeemRate(userId)) return c.json({ error: 'rate_limited', message: '尝试过于频繁，请稍后再试' }, 429);

  const { productKey } = RedeemPointsSchema.parse(await c.req.json());

  const result = redeemMembershipWithPoints(userId, productKey);
  if (!result.ok) {
    const msgMap: Record<string, string> = {
      invalid_product: '会员产品不存在',
      insufficient: '星月积分不足',
    };
    return c.json({ error: result.error, message: msgMap[result.error] ?? '兑换失败', balance: result.balance, cost: result.cost }, 400);
  }

  // 即时生效：清掉订阅缓存，返回订阅 + 余额
  invalidateSubscriptionCache(userId);
  return c.json({
    ...membershipDetails(db, userId),
    tier: membershipDetails(db, userId).membership.active ? 'monthly' : 'free',
    isPremium: membershipDetails(db, userId).membership.active,
    expiresAt: membershipDetails(db, userId).membership.accessEndsAt,
    dailyLimit: null,
    dailyUsed: null,
    dailyRemaining: null,
    balance: result.balance,
    redeemed: { days: result.days, until: result.until },
  });
});

// ── Waffo Pancake 支付（星月卡现金购卡）──────────────────────
// 与兑换码/积分并列的第三条发卡路径。前端拿 checkoutUrl 后新标签页打开收银台，
// 支付结果由 Waffo 服务端回调 /api/payment/webhook 落库并发卡。
const WAFFO_WEB_ORIGIN = process.env.WAFFO_WEB_ORIGIN ?? 'https://boen.frostrain.tech';

/** 收银台支付完成后的回跳地址（带 paid=1 供前端触发状态轮询） */
function paymentSuccessUrl(c: Context): string {
  // 优先用请求来源（本地开发/多域名自动适配），否则回落生产域名
  return `${WAFFO_WEB_ORIGIN.replace(/\/$/, '')}/setup?paid=1`;
}

/** POST /api/payment/checkout - 创建订阅收银台会话，返回 checkoutUrl */
app.post('/api/payment/checkout', async (c) => {
  if (!isWaffoEnabled()) {
    return c.json({ error: 'unavailable', message: '支付功能未启用' }, 503);
  }
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  if (!checkRedeemRate(userId)) return c.json({ error: 'rate_limited', message: '请求过于频繁，请稍后再试' }, 429);

  let planKey = '';
  let buyerEmail: string | undefined;
  try {
    const body = await c.req.json<{ planKey?: string; email?: string; acceptedTermsVersion?: string }>();
    if (body.acceptedTermsVersion !== MEMBERSHIP_TERMS_VERSION) return c.json({ error: 'consent_required', message: '请阅读条款并确认自动续费授权' }, 400);
    planKey = String(body.planKey ?? '').trim();
    buyerEmail = body.email ? String(body.email).trim() : undefined;
  } catch { /* 忽略 body 解析错误，下方按无效档位处理 */ }

  const result = await createMembershipCheckout({
    userId,
    planKey,
    buyerEmail,
    successUrl: paymentSuccessUrl(c),
  });
  if (!result.ok) {
    const status = result.error === 'invalid_plan' ? 400 : result.error === 'conflict' ? 409 : result.error === 'rate_limited' ? 429 : 502;
    return c.json({ error: result.error, message: result.message }, status);
  }
  return c.json({
    sessionId: result.sessionId,
    checkoutUrl: result.checkoutUrl,
    expiresAt: result.expiresAt,
  });
});

/**
 * POST /api/payment/webhook - Waffo 支付结果回调。
 * ⚠️ 必须用 c.req.text() 读原始体：任何 JSON 解析都会让 RSA-SHA256 验签失败。
 * 处理失败返回 500，使 Waffo 重试；仅成功落库后确认。
 */
app.post('/api/payment/webhook', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('x-waffo-signature') ?? null;
  const outcome = await handleWaffoWebhook(raw, sig, {
    invalidateSubscription: (userId) => invalidateSubscriptionCache(userId),
  });
  if (!outcome.ok) return c.text(outcome.reason === 'invalid_signature' ? 'Invalid signature' : 'Retry required', outcome.reason === 'invalid_signature' ? 401 : 500);
  return c.json({ received: true, ...(outcome.detail ?? {}) });
});

for (const action of ['cancel', 'reactivate'] as const) {
  app.post(`/api/payment/subscription/${action}`, async (c) => {
    const userId = await resolveUserId(c);
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    if (!checkRedeemRate(userId)) return c.json({ error: 'rate_limited', message: '请稍后再试' }, 429);
    const result = await manageSubscription(userId, action);
    if (!result.ok) return c.json(result, result.error === 'not_found' ? 404 : result.error === 'conflict' ? 409 : 502);
    invalidateSubscriptionCache(userId);
    return c.json({ ok: true, ...membershipDetails(db, userId) });
  });
}

/** GET /api/payment/orders - 当前用户的购卡订单流水 */
app.get('/api/payment/orders', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ orders: listPaymentOrders(userId, 20) });
});

// ── Frost ID 认证代理（服务端换 token，浏览器只与本服务同源通信）──

/** POST /api/auth/token - 用授权码换 access_token（携带 client_secret + code_verifier）*/
app.post('/api/auth/token', async (c) => {
  const { code, codeVerifier, redirectUri } = await c.req.json<{
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }>();
  const upstream = await fetch(`${FROST_ID_INTERNAL_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: FROST_ID_CLIENT_ID,
      client_secret: FROST_ID_CLIENT_SECRET,
      code_verifier: codeVerifier,
    }),
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
});

/** GET /api/auth/userinfo - 透传 Bearer 取用户信息 */
app.get('/api/auth/userinfo', async (c) => {
  const auth = c.req.header('authorization');
  if (!auth) return c.json({ error: 'invalid_token' }, 401);
  const upstream = await fetch(`${FROST_ID_INTERNAL_URL}/oauth/userinfo`, { headers: { Authorization: auth } });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
});

/** POST /api/auth/revoke - 服务端撤销 token */
app.post('/api/auth/revoke', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const { token } = await c.req.json<{ token: string }>();
  await fetch(`${FROST_ID_INTERNAL_URL}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token,
      client_id: FROST_ID_CLIENT_ID,
      client_secret: FROST_ID_CLIENT_SECRET,
    }),
  });
  invalidateSubscriptionCache(userId);
  return c.json({ success: true });
});

// ── 对话管理 API ────────────────────────────

/** GET /api/conversations - 获取当前登录用户的所有对话 */
app.get('/api/conversations', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const conversations = getConversations(userId);
  return c.json({ conversations });
});

/** POST /api/conversations - 创建新对话 */
app.post('/api/conversations', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ title?: string; subject: string }>();
  const conversation = createConversation(userId, body.title ?? '新对话', body.subject ?? 'math');
  return c.json({ conversation }, 201);
});

/** GET /api/conversations/:id - 获取单个对话（仅限本人） */
app.get('/api/conversations/:id', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation || conversation.userId !== userId) return c.json({ error: 'Conversation not found' }, 404);
  const messages = getMessages(id).map((message) => sanitizeConversationQuestionMessage(message, conversation.subject));
  return c.json({ conversation, messages });
});

/** PATCH /api/conversations/:id - 更新对话标题（仅限本人） */
app.patch('/api/conversations/:id', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation || conversation.userId !== userId) return c.json({ error: 'Conversation not found' }, 404);
  const body = await c.req.json<{ title?: string }>();
  if (body.title) updateConversationTitle(id, body.title);
  return c.json({ success: true });
});

/** DELETE /api/conversations/:id - 删除对话（仅限本人） */
app.delete('/api/conversations/:id', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const conversation = getConversation(id);
  if (!conversation || conversation.userId !== userId) return c.json({ error: 'Conversation not found' }, 404);
  deleteConversation(id);
  return c.json({ success: true });
});

// ── 聊天 API ────────────────────────────────

app.post('/api/chat', async (c) => {
  const body = (await c.req.json()) as ChatRequest & { conversationId?: string; subject: string };
  // 硬认证：必须登录才能对话
  const result = await resolveSubscription(c);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  const userId = result.userId;

  // 免费用户每日限额检查（已原子递增，无需 later 再 increment）
  let usageInfo: { dailyLimit: number; dailyUsed: number; dailyRemaining: number } | null = null;
  if (!result.sub.isPremium) {
    const usage = checkUsage(userId);
    if (!usage.allowed) {
      return c.json({ error: 'daily_limit_reached', message: '今日免费对话已用完，请明日再试或开通星月卡', dailyLimit: FREE_DAILY_LIMIT, dailyUsed: FREE_DAILY_LIMIT, dailyRemaining: 0 }, 429);
    }
    usageInfo = { dailyLimit: FREE_DAILY_LIMIT, dailyUsed: FREE_DAILY_LIMIT - usage.remaining, dailyRemaining: usage.remaining };
  }

  const owned =
    !!body.conversationId && getConversation(body.conversationId)?.userId === userId;
  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const ac = new AbortController();
    stream.onAbort(() => { ac.abort(); });
    try {
      // 如果有归属本人的 conversationId，保存用户消息
      if (owned) {
        const userContent = body.attachments?.length
          ? JSON.stringify({ text: body.message, attachments: body.attachments })
          : body.message;
        addMessage(body.conversationId!, 'user', userContent);
      }

      // 新对话标题：与主回复并发生成（隐藏延迟），在流关闭前回填 title_updated 事件
      const titlePromise =
        owned && getConversation(body.conversationId!)?.title === '新对话'
          ? autoGenerateTitle(body.conversationId!, body.message, async (title) => {
              await send({ type: 'title_updated', conversationId: body.conversationId!, title });
            })
          : null;

      // 若上一轮正暂停等待作答，先以原生 interrupt 恢复并标记跳过（循环清空残留），
      // 再开始新的用户回合，保证 ToolMessage 在历史中的顺序合法、线程不卡。
      await drainPendingQuestions(body.threadId, send);

      // 突破模式：加载知识画像中的薄弱点数据
      let weaknessData: string | undefined;
      if (body.mode === 'weakness' && userId) {
        try {
          const weakPoints = getWeakPoints(userId, body.subject ?? 'math', body.grade, 60, 8);
          if (weakPoints.length > 0) {
            weaknessData = '【你的薄弱知识点（来自知识画像）】\n' + weakPoints.map(w =>
              `- ${w.title}（当前掌握度 ${w.weightedScore}%，等级：${w.level === 'needs_practice' ? '需练习' : w.level === 'developing' ? '发展中' : w.level === 'proficient' ? '熟练' : '掌握'}，最近更新：${new Date(w.lastUpdated * 1000).toLocaleDateString('zh-CN')}）`
            ).join('\n');
          } else {
            weaknessData = '【知识画像】当前暂无明显的薄弱知识点记录。可以通过考试或练习来建立你的知识画像。';
          }
        } catch (err) {
          console.warn('[profile] weakness data retrieval failed:', err);
          weaknessData = undefined;
        }
      }

      // 通知前端开始加载知识库
      let styleExamples: string | undefined;
      if (userId && (body.mode === 'weakness' || body.practiceType || /错题|举一反三|出题|练习|测验|测试|考我|quiz/i.test(body.message))) {
        try {
          styleExamples = await retrieveGlobalStyleSkills(body.subject ?? 'math', body.grade ?? '7', body.message, [], 3);
        } catch (err) {
          console.warn('[mistakes] style samples retrieval failed:', err);
          styleExamples = undefined;
        }
      }

      // 结构化模式：注入教学 prompt（TODO 由 plan_steps 工具在图中创建）
      let modeSystemMsg: SystemMessage | undefined;
      if (body.mode && !['qa', 'explore'].includes(body.mode) && userId) {
        const { getModePrompt } = await import('./mode-prompts.js');
        const modePrompt = getModePrompt(body.mode, body.message);
        if (modePrompt) modeSystemMsg = new SystemMessage(modePrompt);
      }

      // 构建可能含图片的 HumanMessage
      const humanMsg: HumanMessage = body.attachments?.length
        ? new HumanMessage({
            content: [
              { type: 'text', text: body.message },
              ...body.attachments.map((a) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${a.mimeType};base64,${a.data}` },
              })),
            ],
          })
        : new HumanMessage(body.message);

      const { last, question } = await runGraph(
        {
          messages: [modeSystemMsg, humanMsg].filter(Boolean),
          gradeBand: body.gradeBand ?? 'middle',
          grade: body.grade,
          subject: body.subject ?? 'math',
          userName: body.userName,
          weaknessData,
          styleExamples,
          practiceType: body.practiceType,
          ...(body.mode ? { mode: body.mode } : {}),
        },
        body.threadId,
        send,
        ac.signal,
      );

      // 用于防止 MODE_SCORE 和 exit_session 双重结算
      let settled = false;

      // 保存助手回复
      if (owned && last) {
        let content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        addMessage(body.conversationId!, 'assistant', content);

        // 检测结构化学习结束标记 → 批量写入熟练度 + 发送结算事件
        const scoreMatch = content.match(/【MODE_SCORE:\s*(\d+)】/);
        const stepsMatch = content.match(/已完成\s*(\d+)\s*\/\s*(\d+)\s*步/);
        if (scoreMatch && userId && body.threadId) {
          settled = true;
          const sessionScore = parseInt(scoreMatch[1]);
          const stepsCompleted = stepsMatch ? parseInt(stepsMatch[1]) : 0;
          const totalSteps = stepsMatch ? parseInt(stepsMatch[2]) : 0;
          const { count: updatedKps, changes: profChanges } = flushProficiencyCache(userId, body.threadId);
          const points = awardSessionPoints(userId, profChanges, body.subject, body.grade, 'session', body.threadId, sessionScore);
          await send({
            type: 'settlement',
            summary: content.replace(/【MODE_SCORE:\s*\d+】/g, '').trim(),
            score: sessionScore,
            stepsCompleted,
            totalSteps,
            updatedKps,
            proficiencyChanges: profChanges.length > 0 ? profChanges : undefined,
            ...points,
          });
          // 从前端展示中移除评分标记
          content = content.replace(/【MODE_SCORE:\s*\d+】/g, '');
        }
      }

      // 出题：构建+持久化+下发一体化，失败自动跳空中断（不卡线程、不断流）
      await safeDeliverQuestion(
        question, send,
        { subject: body.subject ?? 'math', grade: body.grade },
        body.threadId,
        owned ? body.conversationId! : undefined,
      );
      // 检测 exit_session 工具调用 → 发送结算事件 + 清缓存
      await handleSessionExit(last, send, userId, body.threadId, body.subject ?? 'math', body.grade, settled);
      await emitReviewCompleteIfAny(last, send);
      // 等标题生成完成，确保 title_updated 在流关闭（done）之前送达前端
      if (titlePromise) await titlePromise;
      // 发送每日用量信息（供前端更新剩余次数）
      if (usageInfo) await send({ type: 'usage', ...usageInfo });
      await send({ type: 'done' });

      // 非阻塞：异步生成对话摘要并存储（不等待）
      if (owned && body.conversationId && userId) {
        generateConversationSummaryAsync(userId, body.conversationId, body.subject ?? 'math', model)
          .catch(err => console.warn('[memory] summary generation failed:', err));
      }
    } catch (err) {
      // SSE 异常时丢弃缓存的熟练度更新，避免陈旧数据残留
      if (userId && body.threadId) discardProficiencyCache(userId, body.threadId);
      // 退还已扣除的免费配额（用户无结果不应扣次）
      if (usageInfo) refundUsage(userId);
      try { await send({ type: 'error', message: sanitizeError(err) }); } catch (e2) { console.warn('[chat] SSE send 失败:', e2); }
    }
  });
});

// ── 探索课对话 ─────────────────────────
app.post('/api/explore', async (c) => {
  const body = await c.req.json<{ title: string; subject: string; grade: string }>();
  const result = await resolveSubscription(c);
  if (!result) return c.json({ error: 'unauthorized' }, 401);
  const userId = result.userId;

  const { getExplorePrompt } = await import('./explore-prompts.js');
  const entry = getExplorePrompt(body.title);
  if (!entry) return c.json({ error: 'not_found', message: '该主题暂无探索课程' }, 404);

  const conversation = createConversation(userId, entry.label, body.subject ?? 'math');
  const threadId = conversation.id;
  addMessage(threadId, 'system', JSON.stringify({ __boen_type: 'explore_prompt', prompt: entry.prompt }));
  addMessage(threadId, 'user', `探索学习：${body.title}`);

  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const ac = new AbortController();
    stream.onAbort(() => { ac.abort(); });
    await send({ type: 'conversation_created', conversationId: threadId, title: entry.label });
    try {
      const { last, question } = await runGraph(
        {
          messages: [
            new SystemMessage(entry.prompt),
            new HumanMessage(`我准备好探索「${body.title}」了，请开始吧。`),
          ],
          gradeBand: 'middle',
          grade: body.grade,
          subject: body.subject ?? 'math',
          mode: 'explore',
        },
        threadId,
        send,
        ac.signal,
      );
      if (last) {
        let content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        addMessage(threadId, 'assistant', content);

        // 解析探索评分标记 → 批量写入 + 结算事件
        const scoreMatch = content.match(/【EXPLORE_SCORE:\s*(\d+)】/);
        if (scoreMatch && userId) {
          const stepsMatch = content.match(/已完成\s*(\d+)\s*\/\s*(\d+)\s*步/);
          const sessionScore = Math.max(0, Math.min(100, parseInt(scoreMatch[1])));
          const stepsCompleted = stepsMatch ? parseInt(stepsMatch[1]) : 0;
          const totalSteps = stepsMatch ? parseInt(stepsMatch[2]) : 0;

          const { count: flushedCount, changes: profChanges } = flushProficiencyCache(userId, threadId);
          const { findKnowledgePointNode } = await import('./exam.js');
          const node = findKnowledgePointNode(body.title, body.subject);
          if (node) {
            updateProficiency(userId, node.id, sessionScore, 100, 'explore');
          }

          const points = awardSessionPoints(userId, profChanges, body.subject, body.grade, 'session', threadId, sessionScore);
          await send({
            type: 'settlement',
            summary: content.replace(/【EXPLORE_SCORE:\s*\d+】/g, '').trim(),
            score: sessionScore,
            stepsCompleted,
            totalSteps,
            updatedKps: flushedCount + (node ? 1 : 0),
            proficiencyChanges: profChanges.length > 0 ? profChanges : undefined,
            ...points,
          });
          content = content.replace(/【EXPLORE_SCORE:\s*\d+】/g, '');
        }
      }
      await safeDeliverQuestion(
        question, send,
        { subject: body.subject ?? 'math', grade: body.grade },
        threadId, threadId,
      );
      await send({ type: 'done' });
    } catch (err) {
      if (userId && threadId) discardProficiencyCache(userId, threadId);
      try { await send({ type: 'error', message: sanitizeError(err) }); } catch (e2) { console.warn('[answer] SSE send 失败:', e2); }
    }
  });
});

function extractStudentAnswerText(answer: AnswerPayload): string | null {
  if (answer.type === 'multiple_choice') return answer.selectedKeys?.join(', ') ?? null;
  if (answer.type === 'fill_blank') return answer.answers?.join(' | ') ?? null;
  if (answer.type === 'true_false') return answer.value ? '正确' : '错误';
  if (answer.type === 'short_answer') return answer.text ?? null;
  return null;
}

function autoCollectChatMistake(
  userId: string,
  subject: string,
  grade: string,
  mode: string,
  _toolName: string,
  toolArgs: Record<string, any>,
  answer: AnswerPayload,
  result: { correct: boolean | null; score: number; maxScore: number; reference?: string; explanation?: string; knowledgePoints?: string[]; knowledgePointId?: number },
  chatModel?: BaseChatModel,
  /** 答题前的熟练度分数（用于 before_score，未传则读 DB 当前值） */
  beforeProficiencyScore?: number | null,
  /** 缓存模式下的预期熟练度分数（用于 after_score，优先于 DB 值） */
  afterExpectedScore?: number | null,
): void {
  // 仅归集得分率 < 60% 的题目
  if (result.maxScore <= 0 || result.score / result.maxScore >= 0.6) return;

  const now = Math.floor(Date.now() / 1000);
  const id = `mistake-${Date.now()}-${randomUUID().slice(0, 10)}`;

  const stem: string = toolArgs.stem ?? toolArgs.question ?? '';
  const knowledgePoint: string | undefined = result.knowledgePoints?.[0];
  const correctAnswer = (result.reference ?? toolArgs.answer ?? toolArgs.referenceAnswer ?? '').slice(0, 2000) || null;
  const studentAnswerText = extractStudentAnswerText(answer);
  const matchScore = result.maxScore > 0 ? result.score / result.maxScore : 0;

  // 推断错误类型（无 LLM，基于题型简单判断）
  let errorType = '其他';
  if (answer.type === 'multiple_choice') errorType = '概念混淆';
  else if (answer.type === 'fill_blank') errorType = '表达不完整';
  else if (answer.type === 'true_false') errorType = '概念混淆';
  else if (answer.type === 'short_answer') errorType = '步骤跳步';

  try {
    db.prepare(`
      INSERT INTO mistake_items (
        id, user_id, subject, grade, source_type, status, title, prompt_text,
        student_answer, correct_answer, explanation,
        error_type, error_reason, analysis_confidence,
        answer_match_score, is_correct,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'text', 'analyzed', ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?
      )
    `).run(
      id,
      userId,
      subject,
      grade,
      (stem.split(/\n|。|\./)[0] ?? '对话错题').slice(0, 32),
      stem.slice(0, 8000) ?? '',
      studentAnswerText,
      correctAnswer,
      (result.explanation ?? toolArgs.explanation ?? '').slice(0, 2000) || null,
      errorType,
      `答题错误（${result.score}/${result.maxScore} 分）`,
      0.3,
      matchScore,
      0,
      now,
      now,
    );

    // 知识点映射（before 用传入的前值，after 读 DB 当前值）
    if (result.knowledgePointId && knowledgePoint) {
      const node = db.prepare("SELECT id FROM kg_nodes WHERE id=? AND type='knowledge_point' AND subject=?")
        .get(result.knowledgePointId, subject) as { id: number } | undefined;
      if (node) {
        const profRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
        const afterScore = profRow?.weighted_score ?? null;
        const finalAfterScore = afterExpectedScore ?? afterScore;
        db.prepare(`
          INSERT OR IGNORE INTO mistake_kp_map (mistake_id, kg_node_id, role, confidence, before_score, after_score, evidence_json)
          VALUES (?, ?, 'primary', 0.7, ?, ?, ?)
        `).run(id, node.id, beforeProficiencyScore ?? finalAfterScore, finalAfterScore, JSON.stringify({ evidence: '来源：课堂对话', source: 'auto_collect_chat' }));
      }
    }

    console.log(`[mistake] 对话错题归集：${id} (${subject}/${grade}/${mode}) ${result.score}/${result.maxScore}`);

    // 异步生成标题（fire-and-forget，不阻塞主流程）
    if (chatModel) {
      const stemText = stem.slice(0, 300);
      chatModel.invoke(
        [new SystemMessage('你是标题生成助手，只输出纯文本，不超过10个字。'), new HumanMessage(`为以下错题生成一个精炼标题（10字以内，概括核心考点）：\n${stemText}`)],
      ).then((res) => {
        const titleText = typeof res.content === 'string' ? res.content.trim().slice(0, 32) : '';
        if (titleText) {
          db.prepare('UPDATE mistake_items SET title=?, updated_at=? WHERE id=? AND user_id=?').run(
            titleText, Math.floor(Date.now() / 1000), id, userId,
          );
        }
      }).catch((err) => {
        console.warn('[mistake] 错题标题异步生成失败:', err instanceof Error ? err.message : err);
      });
    }
  } catch (err) {
    console.warn('[mistake] 对话错题归集失败:', err instanceof Error ? err.message : err);
  }
}

app.post('/api/answer', async (c) => {
  const body = (await c.req.json()) as AnswerRequest;
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  // 免费用户每次 AI 调用都计为一次（checkUsage 内原子递增）
  let usageDecremented = false;
  const subInfo = userId ? await resolveSubscription(c).catch(() => null) : null;
  if (subInfo && !subInfo.sub.isPremium) {
    const usage = checkUsage(userId);
    if (!usage.allowed) {
      return c.json({ error: 'daily_limit_reached', message: '今日免费对话已用完，请明日再试或开通星月卡', dailyLimit: FREE_DAILY_LIMIT, dailyUsed: FREE_DAILY_LIMIT, dailyRemaining: 0 }, 429);
    }
    usageDecremented = true;
  }

  return streamSSE(c, async (stream) => {
    const send = (e: SseEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    const ac = new AbortController();
    stream.onAbort(() => { ac.abort(); });
    try {
      const state = await graph.getState({ configurable: { thread_id: body.threadId } });
      const target = getPendingQuestion(state);
      if (!target?.id || target.id !== body.toolCallId) {
        throw new Error('题目已结束或与当前等待作答的题目不匹配，请重新开始一轮。');
      }

      // 简答题/填空题走 LLM 语义评分（填空题的模糊匹配无法覆盖数学表达式等价性等场景）
      const shortAnswerGrader = (target.name === 'ask_short_answer' || target.name === 'ask_fill_blank') ? createShortAnswerGrader(model) : undefined;

      // 判分
      const { result, toolContent } = await gradeAnswer(target.name, target.args, body.answer, shortAnswerGrader);

      const subject = String((state.values as any)?.subject ?? 'math');
      const grade = String((state.values as any)?.grade ?? '');
      const taxonomy = resolveQuestionTaxonomy({
        subject,
        grade: grade || undefined,
        knowledgePointId: (target.args as Record<string, unknown>).knowledgePointId,
        knowledgePointTitle: (target.args as Record<string, unknown>).knowledgePoint,
        allowedKnowledgePointIds: grade ? getPublishedKnowledgePointIds(subject, grade) : [],
      });
      if (!taxonomy) throw new Error('题目知识点不属于当前已发布课程，已拒绝写入画像或展示');
      result.knowledgePointId = taxonomy.knowledgePointId;
      result.knowledgePoints = [taxonomy.knowledgePoint];
      result.literacies = taxonomy.literacies;
      const persistedQuestion = databaseQuestionPayload(target, { subject, grade: grade || undefined });
      const safeToolContent = JSON.stringify({
        ...JSON.parse(toolContent),
        databaseTaxonomy: taxonomy,
      });

      // 先读取答题前的熟练度（供错题归集用，必须在画像更新前）
      let beforeProfScore: number | null = null;
      if (userId && result.knowledgePointId) {
        const br = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, result.knowledgePointId) as { weighted_score: number } | undefined;
        if (br) beforeProfScore = br.weighted_score;
      }

      // 更新知识画像：只使用经数据库校验的知识点 ID。
      const profChanges: Array<{ kp: string; before: number; after: number }> = [];
      if (userId) {
        // 收集要更新的节点：ID 唯一来源
        const nodesToUpdate: Array<{ id: number; title: string }> = [];
        if (result.knowledgePointId) {
          const node = db.prepare("SELECT id, title FROM kg_nodes WHERE id=? AND type='knowledge_point' AND subject=?").get(result.knowledgePointId, subject) as { id: number; title: string } | undefined;
          if (node) nodesToUpdate.push(node);
        }
        for (const node of nodesToUpdate) {
          const currentMode = ((state.values as any)?.mode as string) ?? 'qa';
          const isCached = ['review', 'preview', 'weakness', 'practice', 'explore'].includes(currentMode);
          // 题目难度影响 expected 正确率：easy→35, medium→50(默认), hard→65
          const qDifficulty = difficultyLevelToValue((target.args as Record<string, unknown>)?.difficulty as string | undefined);

          if (isCached) {
            // 结构化学习模式：不写库，用缓存累计 score/maxScore 用于结算 flush。
            // 逐题展示时不用累计值（否则 oldRating 来自 DB 静态值，展示的是从
            // 会话起点累计的总额），而是追踪内存中的预期 Running Rating：
            // 每道题用 result.score/maxScore 算单题变化，并累进到
            // expectedRating，下一题的 oldRating 就是上一题的 newRating。
            cacheProficiencyUpdate(userId, body.threadId, node.id, result.score, result.maxScore, currentMode);
            const dbRow = db.prepare('SELECT rating, rating_sigma, last_updated FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { rating?: number; rating_sigma?: number; last_updated?: number } | undefined;
            const { rating: oldRating, sigma: oldSigma, lastUpdated } = getCachedProficiencyExpected(
              userId, body.threadId, node.id,
              dbRow?.rating ?? ELO_RATING_INIT,
              dbRow?.rating_sigma ?? ELO_SIGMA_INIT,
              dbRow?.last_updated ?? 0,
            );
            // 用本次答题的得分（非累计值）算单题 Elo 增量
            const { newRating, newSigma } = computeProficiencyDelta(oldRating, oldSigma, result.score, result.maxScore, currentMode, lastUpdated, qDifficulty);
            setCachedProficiencyExpected(userId, body.threadId, node.id, newRating, newSigma);
            // before 始终用 oldRating（首次答题时为 ELO_RATING_INIT=0），不再显示「新」
            profChanges.push({ kp: node.title, before: Math.round(oldRating), after: newRating });

            // ── 前驱反向传播：明显答对时给前置知识点小幅 boost ──
            if (result.score > result.maxScore * 0.6) {
              try {
                const prereqRows = db.prepare(`
                  SELECT e.source_id AS id, n.title FROM kg_edges e
                  JOIN kg_nodes n ON n.id=e.source_id
                  WHERE e.target_id=? AND e.type='prerequisite'
                `).all(node.id) as Array<{ id: number; title: string }>;
                for (const pre of prereqRows) {
                  const preDbRow = db.prepare('SELECT rating, rating_sigma, last_updated FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, pre.id) as { rating?: number; rating_sigma?: number; last_updated?: number } | undefined;
                  cacheProficiencyUpdate(userId, body.threadId, pre.id, 0, 0, currentMode);
                  const preState = getCachedProficiencyExpected(
                    userId, body.threadId, pre.id,
                    preDbRow?.rating ?? ELO_RATING_INIT,
                    preDbRow?.rating_sigma ?? ELO_SIGMA_INIT,
                    preDbRow?.last_updated ?? 0,
                  );
                  const preExpected = expectedCorrectness(preState.rating, qDifficulty);
                  const preDelta = 2 * (1.0 - preExpected);
                  const preNewRating = Math.max(0, Math.min(100, preState.rating + preDelta));
                  setCachedProficiencyExpected(userId, body.threadId, pre.id, preNewRating, preState.sigma);
                  profChanges.push({ kp: pre.title, before: preState.rating, after: preNewRating });
                  console.log(`[前驱传播] ${pre.title}: ${Math.round(preState.rating)} → ${preNewRating.toFixed(1)} (delta=${preDelta.toFixed(2)})`);
                }
              } catch (preErr) {
                console.warn('[前驱传播] 执行异常:', preErr instanceof Error ? preErr.message : preErr);
              }
            }
          } else {
            // 普通模式：直接写库后读取新值
            const oldRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
            const before = oldRow?.weighted_score ?? 0;
            updateProficiency(userId, node.id, result.score, result.maxScore, currentMode, qDifficulty);
            const newRow = db.prepare('SELECT weighted_score FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, node.id) as { weighted_score: number } | undefined;
            const after = newRow?.weighted_score ?? 0;
            profChanges.push({ kp: node.title, before, after: Math.max(0, after) });
          }
        }
      }
      if (profChanges.length) { (result as any).proficiencyChanges = profChanges; }

      // 发送判分结果（含熟练度变化）
      await send({ type: 'grading', toolCallId: body.toolCallId, result });

      // 缓存模式下读取预期熟练度（供错题归集用，比 DB 值更准确）
      let afterExpectedScore: number | null = null;
      const isCachedMistake = ['review', 'preview', 'weakness', 'practice', 'explore'].includes(((state.values as any)?.mode as string) ?? '');
      if (isCachedMistake && userId && result.knowledgePointId) {
        try {
          const sum = getCachedProficiencySum(userId, body.threadId, result.knowledgePointId);
          if (sum && sum.score > 0) {
            const dbR = db.prepare('SELECT rating, rating_sigma, last_updated FROM user_kp_proficiency WHERE user_id=? AND kg_node_id=?').get(userId, result.knowledgePointId) as any;
            const cachedState = getCachedProficiencyExpected(userId, body.threadId, result.knowledgePointId, dbR?.rating ?? 0, dbR?.rating_sigma ?? 20, dbR?.last_updated ?? 0);
            if (cachedState.rating > 0) afterExpectedScore = cachedState.rating;
          }
        } catch (e) { console.warn('[answer] 熟练度预期计算失败:', e instanceof Error ? e.message : e); }
      }

      // 错题自动归集（得分率 < 60% 时写入错题本）
      try {
        const chatSubject = (state.values as any)?.subject ?? 'math';
        const chatGrade = String((state.values as any)?.grade ?? '7');
        const chatMode = ((state.values as any)?.mode as string) ?? 'qa';
        autoCollectChatMistake(userId, chatSubject, chatGrade, chatMode, target.name, target.args, body.answer, result, model, beforeProfScore, afterExpectedScore);
      } catch (e) { console.warn('[answer] 错题自动归集失败:', e instanceof Error ? e.message : e); }

      // 持久化判分结果：更新题目消息为已作答状态（含答案 + 判分），避免重载时状态分裂
      if (body.conversationId && body.answer) {
        updateQuestionMessage(body.conversationId, body.toolCallId, JSON.stringify({
          __boen_type: 'question',
          toolCallId: body.toolCallId,
          payload: persistedQuestion,
          answered: true,
          grading: result,
          userAnswer: body.answer,
        }));
      }

      // 通过 LangGraph 的原生 Command.resume 回到 awaitQuestion 节点。
      // 节点会写入 ToolMessage 后继续 agent，而非由 HTTP 层手动拼接消息。
      const { last, question } = await runGraph(new Command<QuestionResume>({
        resume: {
          type: 'answer',
          toolCallId: target.id,
          toolContent: safeToolContent,
        },
      }), body.threadId, send, ac.signal);
      await handleSessionExit(last, send, userId, body.threadId, subject, grade || undefined);
      await safeDeliverQuestion(
        question, send,
        { subject, grade: grade || undefined },
        body.threadId,
        body.conversationId || undefined,
      );
      await emitReviewCompleteIfAny(last, send);
      await send({ type: 'done' });
    } catch (err) {
      if (userId && body.threadId) discardProficiencyCache(userId, body.threadId);
      if (usageDecremented) refundUsage(userId);
      try { await send({ type: 'error', message: sanitizeError(err) }); } catch (e2) { console.warn('[answer-sse] SSE send 最终失败:', e2); }
    }
  });
});

// ── 教育游戏 ─────────────────────────────────────────
import { GameQuestionSchema, GameBatchQuerySchema, GameFinishSchema, GameLeaderboardQuerySchema } from './validation.js';

/* ── 通用限流工具 ── */
const RATE_LIMIT_MAX_ENTRIES = 10000;
const RATE_LIMIT_CLEANUP_MS = 5 * 60_000; // 每 5 分钟清理

function getRateLimitMap(): Map<string, number[]> {
  if (!(globalThis as any).__rateLimitMap) {
    (globalThis as any).__rateLimitMap = new Map<string, number[]>();
    // 定期清理过期条目，防止内存泄漏
    (globalThis as any).__rateLimitCleanupTimer = setInterval(() => {
      const map: Map<string, number[]> = (globalThis as any).__rateLimitMap;
      const cutoff = Date.now() - 60_000; // 清理超过 1 分钟未活动的条目
      for (const [k, ts] of map) {
        const active = ts.filter(t => t > cutoff);
        if (active.length === 0) map.delete(k);
        else map.set(k, active);
      }
    }, RATE_LIMIT_CLEANUP_MS);
    // 防止定时器阻止进程退出
    if ((globalThis as any).__rateLimitCleanupTimer?.unref) {
      (globalThis as any).__rateLimitCleanupTimer.unref();
    }
  }
  return (globalThis as any).__rateLimitMap;
}

function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const map = getRateLimitMap();
  // 条目数超过上限时全局清理
  if (map.size > RATE_LIMIT_MAX_ENTRIES) {
    const cutoff = Date.now() - windowMs;
    for (const [k, ts] of map) {
      if (ts.every(t => t <= cutoff)) map.delete(k);
    }
  }
  const now = Date.now();
  const timestamps = map.get(key) ?? [];
  timestamps.push(now);
  const recent = timestamps.filter(t => now - t < windowMs);
  map.set(key, recent);
  return recent.length <= maxRequests;
}

/**
 * 游戏出题的「个性化上下文」：取当前用户的薄弱知识点，作为优先出题主题。
 * 未登录 / 无画像时返回空数组，退化为「按年级随机知识点」出题。
 */
async function gameWeakKgNodeIds(userId: string | null, subject: string, grade?: string): Promise<number[]> {
  if (!userId) return [];
  try {
    return getWeakPoints(userId, subject, grade, 60, 8).map((p) => p.kgNodeId);
  } catch (err) {
    console.warn('[game] 薄弱点读取失败:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** 解析游戏查询参数（缺失字段走 schema 默认值，非法值降级而非报错） */
function parseGameQuery(c: Context, keys: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const v = c.req.query(k);
    if (v) raw[k] = v;
  }
  return raw;
}

/** GET /api/game/question — 获取一道游戏用选择题（优先从题目池秒出） */
app.get('/api/game/question', async (c) => {
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (!checkRateLimit(`rate:game:${clientIp}`, 8, 1000)) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  try {
    const parsed = GameQuestionSchema.safeParse(parseGameQuery(c, ['subject', 'grade']));
    if (!parsed.success) console.warn('[game] 出题参数不合法，已降级为默认学科/年级');
    const subject = parsed.success ? parsed.data.subject : 'math';
    const grade = parsed.success ? parsed.data.grade : undefined;
    const userId = await resolveUserId(c);
    const preferKgNodeIds = await gameWeakKgNodeIds(userId, subject, grade);
    const question = getPooledQuestion(subject, { userId, grade, mode: 'endless', preferKgNodeIds });
    return c.json({ question });
  } catch (err) {
    console.error('[game] 出题失败:', sanitizeError(err));
    return c.json({ error: '出题失败，请稍后重试' }, 500);
  }
});

/** GET /api/game/questions — 批量获取游戏选择题 */
app.get('/api/game/questions', async (c) => {
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  // 一次拉 5 题、切学科会重拉：3 次/秒太紧（实测会被自己的请求打到 429），放宽到 8 次/秒
  if (!checkRateLimit(`rate:game:batch:${clientIp}`, 8, 1000)) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  try {
    const parsed = GameBatchQuerySchema.safeParse(parseGameQuery(c, ['subject', 'grade', 'count']));
    if (!parsed.success) console.warn('[game] 批量出题参数不合法，已降级为默认学科/年级');
    const subject = parsed.success ? parsed.data.subject : 'math';
    const grade = parsed.success ? parsed.data.grade : undefined;
    const count = parsed.success ? parsed.data.count : 5;
    const userId = await resolveUserId(c);
    const preferKgNodeIds = await gameWeakKgNodeIds(userId, subject, grade);
    const questions = getPooledQuestions(subject, count, { userId, grade, mode: 'endless', preferKgNodeIds });
    return c.json({ questions });
  } catch (err) {
    console.error('[game] 批量出题失败:', sanitizeError(err));
    return c.json({ error: '出题失败，请稍后重试' }, 500);
  }
});

/** POST /api/game/finish — 局末结算：落库 + 回写知识点熟练度 + 发放积分 */
app.post('/api/game/finish', async (c) => {
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  // 一局最多打几十分钟，10 次/分钟足够正常游玩，也挡住批量刷分
  if (!checkRateLimit(`rate:game:finish:${clientIp}`, 10, 60_000)) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const parsed = GameFinishSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', detail: parsed.error.issues[0]?.message }, 400);
  }

  try {
    const result = finishGameSession({ userId, ...parsed.data });
    return c.json({ ok: true, ...result, stats: getGameStats(userId) });
  } catch (err) {
    console.error('[game] 结算失败:', sanitizeError(err));
    return c.json({ error: '结算失败，请稍后重试' }, 500);
  }
});

/** GET /api/game/leaderboard — 排行榜（匿名昵称，标注「我」） */
app.get('/api/game/leaderboard', async (c) => {
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (!checkRateLimit(`rate:game:board:${clientIp}`, 20, 60_000)) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  try {
    const parsed = GameLeaderboardQuerySchema.safeParse(parseGameQuery(c, ['subject', 'period']));
    const period = parsed.success ? parsed.data.period : 'week';
    const subject = parsed.success ? parsed.data.subject ?? null : null;
    const userId = await resolveUserId(c);
    return c.json({ period, rows: getLeaderboard(userId, subject, period, 20) });
  } catch (err) {
    console.error('[game] 排行榜读取失败:', sanitizeError(err));
    return c.json({ error: '排行榜读取失败' }, 500);
  }
});

/** GET /api/game/stats — 个人战绩 + 最近 10 局 */
app.get('/api/game/stats', async (c) => {
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json({ stats: getGameStats(userId), recent: getRecentSessions(userId, 10), stages: getAllStageProgress(userId) });
  } catch (err) {
    console.error('[game] 战绩读取失败:', sanitizeError(err));
    return c.json({ error: '战绩读取失败' }, 500);
  }
});

/** GET /api/game/daily — 每日挑战：当天固定的题集（刷新不换题） */
app.get('/api/game/daily', async (c) => {
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (!checkRateLimit(`rate:game:daily:${clientIp}`, 20, 60_000)) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  try {
    const parsed = GameQuestionSchema.safeParse(parseGameQuery(c, ['subject', 'grade']));
    const subject = parsed.success ? parsed.data.subject : 'math';
    const grade = parsed.success ? parsed.data.grade : undefined;
    const preferKgNodeIds = await gameWeakKgNodeIds(userId, subject, grade);
    const result = getDailyChallenge(userId, subject, () =>
      getPooledQuestions(subject, GAME_DAILY_SIZE, { userId, grade, mode: 'daily', preferKgNodeIds }));
    return c.json(result);
  } catch (err) {
    console.error('[game] 每日挑战读取失败:', sanitizeError(err));
    return c.json({ error: '每日挑战读取失败' }, 500);
  }
});

/** GET /api/game/stage — 关卡进度 + 本关题目（每关 5 题，答对 4 题过关） */
app.get('/api/game/stage', async (c) => {
  const clientIp = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
  if (!checkRateLimit(`rate:game:stage:${clientIp}`, 20, 60_000)) {
    return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
  }

  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'unauthorized' }, 401);

  try {
    const parsed = GameQuestionSchema.safeParse(parseGameQuery(c, ['subject', 'grade']));
    const subject = parsed.success ? parsed.data.subject : 'math';
    const grade = parsed.success ? parsed.data.grade : undefined;
    const preferKgNodeIds = await gameWeakKgNodeIds(userId, subject, grade);
    const progress = getStageProgress(userId, subject);
    const questions = getPooledQuestions(subject, GAME_STAGE_SIZE, { userId, grade, mode: 'stage', preferKgNodeIds });
    return c.json({ progress, questions });
  } catch (err) {
    console.error('[game] 关卡读取失败:', sanitizeError(err));
    return c.json({ error: '关卡读取失败' }, 500);
  }
});

const port = Number(process.env.PORT ?? 8787);
const retentionTimer = setInterval(() => {
  try { runPrivacyRetention(db, ASSET_ROOT, join(DATA_DIR, 'backups')); }
  catch (error: unknown) { console.error('[privacy] retention failed:', error instanceof Error ? error.message : 'unknown'); }
  // 出题账本只保留 24 小时；冷题目缓存与过期每日挑战一并清理
  try { purgeOldGameData(); }
  catch (error: unknown) { console.error('[game] 清理失败:', error instanceof Error ? error.message : 'unknown'); }
}, 60 * 60 * 1000);
retentionTimer.unref();
serve({ fetch: app.fetch, port });
console.log(`博文 Boen server → http://localhost:${port}`);
