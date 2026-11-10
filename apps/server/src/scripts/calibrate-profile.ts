/**
 * calibrate-profile.ts —— 学习画像的校准度报告
 *
 * 回答一个很硬的问题：「画像给出的掌握度，真的能预测学生下次答对吗？」
 *
 * 用法：
 *   npx tsx src/scripts/calibrate-profile.ts
 *   npx tsx src/scripts/calibrate-profile.ts --user=<userId> --bins=5
 *   npx tsx src/scripts/calibrate-profile.ts --json
 *
 * 口径（当前实现）：
 * - 以「知识点 × 用户」为一个样本：预测值 = expectedCorrectRate(rating)，
 *   实际结果 = 该知识点历史正确率 ≥ 50% 视为「答对」。
 * - 这是**聚合口径**，比逐次口径弱；逐次口径需要在下一次答错/答对时
 *   记录「当时的预测概率」，那是下一步要补的埋点（见 docs）。
 *
 * 指标含义：
 * - Brier：0 完美，0.25 = 永远猜 0.5，越大越差；
 * - ECE：分箱后预测均值与实际正确率的加权偏差，< 0.05 通常算校准良好。
 */
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db.js';
import { calibrate, expectedCorrectRate, type CalibrationSample } from '../calibration.js';
import { listCalibrationSamples } from '../calibration-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../../../../.env') });

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const userId = getArg('user');
const bins = Number(getArg('bins') ?? 5);
const asJson = args.includes('--json');

interface Row {
  user_id: string;
  kg_node_id: number;
  title: string | null;
  rating: number | null;
  correct_count: number;
  total_count: number;
}

const sql = `
  SELECT p.user_id, p.kg_node_id, n.title, p.rating, p.correct_count, p.total_count
  FROM user_kp_proficiency p
  LEFT JOIN kg_nodes n ON n.id = p.kg_node_id
  WHERE p.total_count > 0 ${userId ? 'AND p.user_id = ?' : ''}
`;
const rows = (userId ? db.prepare(sql).all(userId) : db.prepare(sql).all()) as Row[];

// 优先用逐次样本（每道题作答前后的预测/实际），样本不足时退回聚合口径
const perAttempt = listCalibrationSamples({ userId, limit: 20000 });
const usePerAttempt = perAttempt.length >= 20;

const samples: CalibrationSample[] = usePerAttempt
  ? perAttempt.map((s) => ({ predicted: s.predicted, actual: s.actual }))
  : rows.map((r) => ({
      predicted: expectedCorrectRate(r.rating ?? 0),
      actual: r.correct_count / r.total_count >= 0.5,
    }));

const report = calibrate(samples, Number.isFinite(bins) ? bins : 5);

if (asJson) {
  console.log(JSON.stringify({ scope: userId ?? 'all-users', knowledgePoints: rows.length, ...report }, null, 2));
} else {
  console.log(`\n画像校准报告（${userId ? `用户 ${userId.slice(0, 12)}…` : '全站'}，样本 ${report.samples} 个知识点）`);
  console.log('─'.repeat(64));
  if (report.samples === 0) {
    console.log('暂无数据：需要至少一条知识点练习记录（考试 / 练习 / 游戏都会写入）。');
    console.log('');
  } else {
    console.log(`Brier 分数        ${report.brier.toFixed(4)}   （0 完美，0.25 = 恒定猜 0.5）`);
    console.log(`平均校准误差 ECE   ${report.ece.toFixed(4)}   （< 0.05 通常可认为校准良好）`);
    console.log(`预测均值 / 实际   ${report.predictedMean.toFixed(3)} / ${report.actualRate.toFixed(3)}`);
    console.log('─'.repeat(64));
    console.log('可靠性曲线（预测区间 → 实际正确率）：');
    for (const b of report.bins) {
      const range = `[${b.from.toFixed(1)}, ${Math.min(1, b.to).toFixed(1)})`;
      const bar = '█'.repeat(Math.round(b.actualRate * 20));
      console.log(`  ${range.padEnd(12)} n=${String(b.count).padEnd(5)} ` +
        `预测 ${b.predictedMean.toFixed(2)}  实际 ${b.actualRate.toFixed(2)} ${bar}`);
    }
    console.log('─'.repeat(64));
    if (report.samples < 30) {
      console.log('提示：样本量偏小（< 30），结论仅供参考，建议积累到班级规模后再评估。');
    }
    console.log('');
  }
}
