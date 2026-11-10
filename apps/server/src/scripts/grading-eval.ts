/**
 * grading-eval.ts —— 简答题 LLM 判分的基线评测
 *
 * 用法：
 *   npx tsx src/scripts/grading-eval.ts --dry-run        # 只校验评测集（不需要 key）
 *   npx tsx src/scripts/grading-eval.ts --limit=5        # 先跑 5 条看稳定性
 *   npx tsx src/scripts/grading-eval.ts --json
 *
 * 需要 DEEPSEEK_API_KEY；没有 key 时非 dry-run 会明确报错退出。
 * 指标定义见 grading-metrics.ts（MAE / 容差内比例 / 系统性偏差 / 排序一致率）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { getChatModel } from '@boen/agent-core';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { summarizeGrading, type GradingPair } from '../grading-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

interface GoldenItem {
  id: string;
  subject: string;
  grade: string;
  stem: string;
  reference: string;
  studentAnswer: string;
  humanScore: number;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const asJson = args.includes('--json');
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const limit = Number(getArg('limit') ?? 0) || undefined;
const tolerance = Number(getArg('tolerance') ?? 10);

const fixturePath = resolve(__dirname, '../__fixtures__/grading-golden.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { version: string; items: GoldenItem[] };

// ── 评测集自检（任何模式下都做）──
function validate(items: GoldenItem[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(items) || items.length === 0) problems.push('评测集为空');
  const ids = new Set<string>();
  for (const [i, it] of items.entries()) {
    if (!it.id) problems.push(`#${i} 缺 id`);
    if (ids.has(it.id)) problems.push(`#${i} id 重复：${it.id}`);
    ids.add(it.id);
    if (!it.stem || !it.reference || it.studentAnswer === undefined) problems.push(`${it.id} 字段不全`);
    if (!(it.humanScore >= 0 && it.humanScore <= 100)) problems.push(`${it.id} humanScore 越界：${it.humanScore}`);
  }
  return problems;
}

const problems = validate(fixture.items);
if (problems.length > 0) {
  console.error('评测集不合法：');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}

const items = limit ? fixture.items.slice(0, limit) : fixture.items;

if (dryRun) {
  console.log(`评测集 ${fixture.version}：${items.length} 条，字段与分数范围校验通过。`);
  console.log('（--dry-run 不调用模型；去掉该参数并配置 DEEPSEEK_API_KEY 即可跑基线）');
  process.exit(0);
}

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY，无法调用模型。先用 --dry-run 校验评测集。');
  process.exit(1);
}

const model = getChatModel({
  provider: 'deepseek',
  model: getArg('model') ?? 'deepseek-v4-flash',
  apiKey,
  enableThinking: false,
  maxTokens: 256,
  timeout: 60_000,
});

const SYSTEM = [
  '你是教研老师，负责给学生的简答题打分。',
  '请参考“标准答案要点”，按 0–100 给分：要点齐全且表述清楚给高分，缺要点按缺失比例扣分。',
  '只输出一个 0–100 的整数，不要任何解释、不要单位。',
].join('\n');

async function scoreOne(item: GoldenItem): Promise<number | null> {
  try {
    const res = await model.invoke([
      new SystemMessage(SYSTEM),
      new HumanMessage([
        `题目：${item.stem}`,
        `标准答案要点：${item.reference}`,
        `学生作答：${item.studentAnswer}`,
        '请给分（0-100 的整数）：',
      ].join('\n')),
    ]);
    const text = typeof res.content === 'string'
      ? res.content
      : Array.isArray(res.content)
        ? res.content.map((b) => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? ''))).join('')
        : '';
    const m = text.match(/\d{1,3}/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  } catch (e) {
    console.warn(`  [${item.id}] 调用失败：${e instanceof Error ? e.message.slice(0, 80) : e}`);
    return null;
  }
}

const pairs: GradingPair[] = [];
const failures: string[] = [];

for (const item of items) {
  const modelScore = await scoreOne(item);
  if (modelScore === null) {
    failures.push(item.id);
    continue;
  }
  pairs.push({ human: item.humanScore, model: modelScore });
  if (!asJson) {
    const delta = modelScore - item.humanScore;
    console.log(`  ${item.id.padEnd(12)} 人工 ${String(item.humanScore).padStart(3)}  模型 ${String(modelScore).padStart(3)}` +
      `  Δ${delta >= 0 ? '+' : ''}${delta}`);
  }
}

const report = summarizeGrading(pairs, tolerance);

if (asJson) {
  console.log(JSON.stringify({ fixture: fixture.version, model: getArg('model') ?? 'deepseek-v4-flash', failures, ...report }, null, 2));
} else {
  console.log('\n' + '─'.repeat(56));
  console.log(`样本 ${report.samples} 条　容差 ±${report.tolerance}`);
  console.log(`MAE（平均绝对误差） ${report.mae}`);
  console.log(`容差内比例        ${(report.withinTolerance * 100).toFixed(1)}%`);
  console.log(`系统性偏差        ${report.bias > 0 ? '+' : ''}${report.bias}（正 = 给分偏松）`);
  console.log(`最大误差          ${report.maxError}`);
  console.log(`排序一致率        ${(report.rankingAgreement * 100).toFixed(1)}%`);
  if (failures.length) console.log(`调用失败          ${failures.length} 条：${failures.join(', ')}`);
  console.log('─'.repeat(56));
  if (report.samples < 10) console.log('提示：样本偏少（< 10），结论仅作参考。');
}
