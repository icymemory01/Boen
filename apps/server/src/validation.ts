/**
 * validation.ts — 请求体运行时校验（Zod 4）
 *
 * 在关键 POST/PUT 入口前验证输入，替代裸 `as` 类型断言。
 * 校验失败时抛出 ZodError，由调用方 catch 后返回 400。
 */
import { z } from 'zod';

/** POST /api/model/switch */
export const SwitchModelSchema = z.object({
  provider: z.enum(['default', 'deepseek', 'deepseek-pro']),
}).strict();

/** POST /api/mistakes — JSON body */
export const CreateMistakeSchema = z.object({
  sourceType: z.enum(['image', 'canvas', 'text']).optional(),
  subject: z.string().min(1).max(20).optional(),
  grade: z.string().min(1).max(10).optional(),
  promptText: z.string().optional(),
  studentAnswer: z.string().optional(),
  note: z.string().optional(),
}).strict();

/** POST /api/mistakes/:id/analyze */
export const AnalyzeMistakeSchema = z.object({
}).strict();

/** POST /api/exam/generate */
export const ExamGenerateSchema = z.object({
  subject: z.string().min(1),
  grade: z.string().min(1),
  difficulty: z.string().optional(),
  durationMinutes: z.number().int().positive().optional(),
  notes: z.string().optional(),
  totalScore: z.number().positive().optional(),
  examId: z.string().optional(),
}).strict();

/** POST /api/exam/submit */
export const ExamSubmitSchema = z.object({
  examId: z.string().min(1),
  answers: z.array(z.object({
    questionIndex: z.number().int().min(0),
    answer: z.any(),
  })).optional().default([]),
}).strict();

/** POST /api/chat */
export const ChatSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().optional(),
  subject: z.string().optional(),
  grade: z.string().optional(),
  gradeBand: z.string().optional(),
  mode: z.string().optional(),
  threadId: z.string().optional(),
  practiceType: z.string().optional(),
  attachments: z.array(z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  })).optional(),
  userName: z.string().optional(),
}).strict();

/** POST /api/explore */
export const ExploreSchema = z.object({
  title: z.string().min(1),
  subject: z.string().optional(),
  grade: z.string().optional(),
}).strict();

/** POST /api/mistakes (multipart) */
export const CreateMistakeMultipartSchema = z.object({
  sourceType: z.enum(['image', 'canvas', 'text']).optional(),
  subject: z.string().optional(),
  grade: z.string().optional(),
  promptText: z.string().optional(),
  studentAnswer: z.string().optional(),
  note: z.string().optional(),
});

/** REDEEM 兑换码 */
export const RedeemCodeSchema = z.object({
  code: z.string().min(1),
}).strict();

/** 游戏支持的年级（与 shared 的 Grade 对齐） */
const GAME_GRADES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'high', 'college'] as const;
const GAME_SUBJECTS = ['math', 'chinese', 'english', 'science'] as const;

/** GET /api/game/question */
export const GameQuestionSchema = z.object({
  subject: z.enum(GAME_SUBJECTS).default('math'),
  grade: z.enum(GAME_GRADES).optional(),
});

/** GET /api/game/questions —— 批量出题 */
export const GameBatchQuerySchema = z.object({
  subject: z.enum(GAME_SUBJECTS).default('math'),
  grade: z.enum(GAME_GRADES).optional(),
  count: z.coerce.number().int().min(1).max(10).default(5),
});

/** POST /api/game/finish —— 局末结算上报
 *
 * 只上报「哪些题、撞了哪个选项」。分数 / 对错 / 连击一律由服务端按出题账本重算，
 * 客户端报了也不采信。
 */
export const GameFinishSchema = z.object({
  subject: z.enum(GAME_SUBJECTS),
  grade: z.enum(GAME_GRADES).optional(),
  mode: z.enum(['endless', 'daily', 'stage']).default('endless'),
  /** 关卡模式下上报当前关卡号 */
  stage: z.number().int().min(1).max(999).optional(),
  durationMs: z.number().int().min(0).max(6 * 60 * 60 * 1000).optional(),
  answers: z.array(z.object({
    questionId: z.string().min(1).max(80),
    chosenKey: z.enum(['A', 'B', 'C', 'D']).optional(),
  })).max(200),
}).strict();

/** GET /api/game/leaderboard */
export const GameLeaderboardQuerySchema = z.object({
  subject: z.enum(GAME_SUBJECTS).optional(),
  period: z.enum(['week', 'all']).default('week'),
});

/** REDEEM 积分兑换 */
export const RedeemPointsSchema = z.object({
  productKey: z.string().min(1),
}).strict();

/**
 * sanitizeError — 将错误对象转为安全的面向客户端消息
 * 只暴露第一行、限制长度，不暴露堆栈或内部路径
 */
export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // 只取第一行，限制 200 字符
  let firstLine = msg.split('\n')[0].trim();
  // 过滤可能泄露内部信息的关键词：文件路径、SQL 片段、堆栈信息等
  const sensitivePatterns = [
    /File\s+"[^"]+"/gi,
    /at\s+\S+\s+\(/g,
    /node_modules/g,
    /SELECT\s|INSERT\s|UPDATE\s|DELETE\s|DROP\s|CREATE\s/gi,
    /SQLITE_/g,
    /(?:\\|\/)[\w.-]+(?:\\|\/)[\w.-]+(?:\\|\/)[\w.-]+/g, // Unix/Windows 路径
  ];
  for (const pattern of sensitivePatterns) {
    firstLine = firstLine.replace(pattern, '');
  }
  firstLine = firstLine.trim();
  if (!firstLine) return '系统处理出错，请稍后再试';
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine;
}
