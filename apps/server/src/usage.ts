/**
 * usage.ts —— LLM 用量与成本记账
 *
 * 按 token 计费的生意，必须能回答三个问题：
 * 1. 今天花了多少 token / 多少钱？
 * 2. 哪个功能最贵？（聊天 / 出卷 / 批改 / 游戏出题 / 查询改写）
 * 3. 哪个用户最贵？
 *
 * 每次调用模型后调 `recordUsage()` 落一行；汇总由 `summarizeUsage()` 或
 * `scripts/usage-report.mjs` 输出。token 数从 LangChain 返回的
 * `usage_metadata` / `response_metadata.usage` 里尽力提取，取不到就记 0（仍然保留条数与时延）。
 */
import db from './db.js';
import { log } from './logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 当前请求的用量上下文。
 * 入口（聊天 / 出卷）用 `usageScope.enterWith({ userId })` 设一次，
 * 模型回调触发记账时就能读到，从而回答「哪个用户最贵」。
 */
export const usageScope = new AsyncLocalStorage<{ userId?: string }>();

export type UsageFeature =
  | 'chat'
  | 'exam_generate'
  | 'exam_grade'
  | 'mistake_analyze'
  | 'game_question'
  | 'query_rewrite'
  | 'memory_summary'
  | 'other';

export interface UsageInput {
  userId?: string | null;
  feature: UsageFeature;
  model?: string;
  /** 直接给定 token 数（调用方已解析好） */
  promptTokens?: number;
  completionTokens?: number;
  /** 或直接传模型返回体，由本函数尽力提取 */
  response?: unknown;
  latencyMs?: number;
  ok?: boolean;
  error?: string;
}

interface TokenPair { prompt: number; completion: number }

/** 从 LangChain 的返回体里尽力挖出 token 数（各 provider 字段不一致） */
export function extractTokens(response: unknown): TokenPair {
  if (!response || typeof response !== 'object') return { prompt: 0, completion: 0 };
  const r = response as Record<string, unknown>;

  const usage = (r.usage_metadata ?? (r.response_metadata as Record<string, unknown> | undefined)?.usage_metadata) as
    | Record<string, number>
    | undefined;
  if (usage) {
    return {
      prompt: num(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens),
      completion: num(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens),
    };
  }

  const meta = r.response_metadata as Record<string, unknown> | undefined;
  const tokenUsage = meta?.tokenUsage as Record<string, number> | undefined;
  if (tokenUsage) {
    return { prompt: num(tokenUsage.promptTokens), completion: num(tokenUsage.completionTokens) };
  }
  const rawUsage = meta?.usage as Record<string, number> | undefined;
  if (rawUsage) {
    return { prompt: num(rawUsage.prompt_tokens), completion: num(rawUsage.completion_tokens) };
  }
  return { prompt: 0, completion: 0 };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 记一条用量。任何异常都不能影响主流程 */
export function recordUsage(input: UsageInput): void {
  try {
    const fromResponse = input.response !== undefined ? extractTokens(input.response) : { prompt: 0, completion: 0 };
    const prompt = num(input.promptTokens) || fromResponse.prompt;
    const completion = num(input.completionTokens) || fromResponse.completion;
    db.prepare(`
      INSERT INTO usage_events
        (user_id, feature, model, prompt_tokens, completion_tokens, latency_ms, ok, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.userId ?? usageScope.getStore()?.userId ?? null,
      input.feature,
      input.model ?? null,
      prompt,
      completion,
      Math.max(0, Math.round(input.latencyMs ?? 0)),
      input.ok === false ? 0 : 1,
      input.error ? input.error.slice(0, 200) : null,
    );
    log.debug('usage.recorded', { feature: input.feature, prompt, completion });
  } catch (e) {
    log.warn('usage.record_failed', { feature: input.feature }, e);
  }
}

/** 单价（元 / 百万 token），用于把 token 折算成钱。按公开报价的可配置近似值 */
export interface PriceTable {
  [model: string]: { input: number; output: number };
}

export const DEFAULT_PRICES: PriceTable = {
  'deepseek-v4-flash': { input: 1.0, output: 8.0 },
  'deepseek-v4-pro': { input: 2.0, output: 16.0 },
  default: { input: 1.0, output: 8.0 },
};

export interface UsageRow {
  feature: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  failures: number;
  costYuan: number;
}

export interface UsageSummary {
  since: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costYuan: number;
  failures: number;
  byFeature: UsageRow[];
  topUsers: Array<{ userId: string; calls: number; tokens: number; costYuan: number }>;
}

interface RawRow {
  feature: string;
  model: string | null;
  calls: number;
  prompt: number;
  completion: number;
  failures: number;
}

/** 汇总某个时间窗口内的用量 */
export function summarizeUsage(options: { since?: number; prices?: PriceTable; topUsers?: number } = {}): UsageSummary {
  const since = options.since ?? 0;
  const prices = options.prices ?? DEFAULT_PRICES;

  const rows = db.prepare(`
    SELECT feature,
           model,
           COUNT(*) AS calls,
           COALESCE(SUM(prompt_tokens), 0) AS prompt,
           COALESCE(SUM(completion_tokens), 0) AS completion,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failures
    FROM usage_events
    WHERE created_at >= ?
    GROUP BY feature, model
    ORDER BY (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0)) DESC
  `).all(since) as RawRow[];

  const byFeatureMap = new Map<string, UsageRow>();
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  let costYuan = 0;
  let failures = 0;

  for (const r of rows) {
    const price = prices[r.model ?? 'default'] ?? prices.default!;
    const cost = (r.prompt / 1_000_000) * price.input + (r.completion / 1_000_000) * price.output;
    promptTokens += r.prompt;
    completionTokens += r.completion;
    calls += r.calls;
    costYuan += cost;
    failures += r.failures;
    const prev = byFeatureMap.get(r.feature) ?? {
      feature: r.feature, calls: 0, promptTokens: 0, completionTokens: 0, failures: 0, costYuan: 0,
    };
    prev.calls += r.calls;
    prev.promptTokens += r.prompt;
    prev.completionTokens += r.completion;
    prev.failures += r.failures;
    prev.costYuan += cost;
    byFeatureMap.set(r.feature, prev);
  }

  const limit = Math.max(1, Math.min(50, options.topUsers ?? 10));
  const topUsers = (db.prepare(`
    SELECT user_id,
           COUNT(*) AS calls,
           COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
    FROM usage_events
    WHERE created_at >= ? AND user_id IS NOT NULL
    GROUP BY user_id
    ORDER BY tokens DESC
    LIMIT ?
  `).all(since, limit) as Array<{ user_id: string; calls: number; tokens: number }>).map((u) => ({
    userId: u.user_id,
    calls: u.calls,
    tokens: u.tokens,
    costYuan: Number(((u.tokens / 1_000_000) * prices.default!.input).toFixed(4)),
  }));

  return {
    since,
    calls,
    promptTokens,
    completionTokens,
    costYuan: Number(costYuan.toFixed(4)),
    failures,
    byFeature: [...byFeatureMap.values()].sort((a, b) => b.costYuan - a.costYuan),
    topUsers,
  };
}
