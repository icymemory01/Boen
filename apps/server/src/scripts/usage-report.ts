/**
 * usage-report.ts —— 用量与成本报表
 *
 * 用法：
 *   npx tsx src/scripts/usage-report.ts --days=7
 *   npx tsx src/scripts/usage-report.ts --days=30 --json
 *
 * 输出：按功能聚合的调用数 / token / 折算成本，以及最贵的用户 Top10。
 * 单价按 usage.ts 里的 DEFAULT_PRICES 折算，可在代码里按实际合同价调整。
 */
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeUsage } from '../usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

const args = process.argv.slice(2);
const getNum = (name: string, fallback: number): number => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const days = getNum('days', 7);
const asJson = args.includes('--json');
const since = Math.floor(Date.now() / 1000) - days * 86400;
const summary = summarizeUsage({ since, topUsers: 10 });

if (asJson) {
  console.log(JSON.stringify({ days, ...summary }, null, 2));
} else {
  const fmt = (n: number) => n.toLocaleString('en-US');
  console.log(`\n用量报表：最近 ${days} 天`);
  console.log('─'.repeat(72));
  console.log(`调用总数 ${fmt(summary.calls)}　失败 ${fmt(summary.failures)}　` +
    `token ${fmt(summary.promptTokens + summary.completionTokens)}（入 ${fmt(summary.promptTokens)} / 出 ${fmt(summary.completionTokens)}）　` +
    `折算成本 ¥${summary.costYuan}`);
  console.log('─'.repeat(72));
  console.log('按功能：');
  if (summary.byFeature.length === 0) {
    console.log('  （暂无数据）');
  } else {
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - [...s].length));
    console.log(`  ${pad('功能', 18)}${pad('调用', 10)}${pad('token', 14)}${pad('失败', 8)}成本`);
    for (const f of summary.byFeature) {
      console.log(`  ${pad(f.feature, 18)}${pad(fmt(f.calls), 10)}` +
        `${pad(fmt(f.promptTokens + f.completionTokens), 14)}${pad(fmt(f.failures), 8)}¥${f.costYuan.toFixed(4)}`);
    }
  }
  console.log('─'.repeat(72));
  console.log('最贵用户 Top10：');
  if (summary.topUsers.length === 0) {
    console.log('  （暂无数据）');
  } else {
    for (const u of summary.topUsers) {
      console.log(`  ${u.userId.slice(0, 12)}…  调用 ${u.calls}  token ${fmt(u.tokens)}  约 ¥${u.costYuan}`);
    }
  }
  console.log('');
}
