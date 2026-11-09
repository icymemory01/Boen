// 博文 Boen —— 前后端共享类型

/** 三个面向的年龄段（驱动语气/深度） */
export type GradeBand = 'primary' | 'middle' | 'undergrad';

/** 具体年级：义务教育 1–9 年级细化 + 高中/大学粗档 */
export type Grade = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'high' | 'college';

/** 具体年级 → 语气年龄段 */
export function gradeToBand(grade: Grade): GradeBand {
  if (grade === 'college') return 'undergrad';
  if (grade === 'high') return 'middle';
  return Number(grade) <= 6 ? 'primary' : 'middle';
}

/** 具体年级 → 中文标签（用于 UI 与 prompt） */
export function gradeLabel(grade: Grade): string {
  if (grade === 'high') return '高中';
  if (grade === 'college') return '大学及以上';
  const n = Number(grade);
  return n <= 6 ? `小学${['一','二','三','四','五','六'][n - 1]}年级` : `初${['一', '二', '三'][n - 7]}`;
}

/** 智能体工作模式 */
export type BoenMode = 'qa' | 'review' | 'preview' | 'weakness' | 'practice' | 'ai-learning' | 'exam' | 'explore';

/** Base64 编码的 JPEG/PNG 图片数据（不含 data: URI 前缀），可选 */
export interface Attachment {
  type: 'image';
  /** Base64 编码的图片数据（不含 data: URI 前缀） */
  data: string;
  /** MIME 类型，如 'image/jpeg' */
  mimeType: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 附件列表（用于用户消息中的图片等） */
  attachments?: Attachment[];
}

/** POST /api/chat 请求体 */
export interface ChatRequest {
  threadId: string;
  message: string;
  /** 附件列表（支持图片等），可选 */
  attachments?: Attachment[];
  gradeBand: GradeBand;
  grade?: Grade;
  userName?: string;
  mode?: BoenMode;
  practiceType?: string;
}

// ─────────────────────────────────────────────────────────────
// 测评（answer card）模块 —— 对话内嵌入式答题
// ─────────────────────────────────────────────────────────────

export type QuestionType = 'multiple_choice' | 'fill_blank' | 'true_false' | 'short_answer';
export type Difficulty = 'easy' | 'medium' | 'hard';

interface BaseQuestion {
  type: QuestionType;
  stem: string;
  passage?: string;
  /** Canonical ID resolved from the published curriculum knowledge graph. */
  knowledgePointId?: number;
  knowledgePoint?: string;
  /** Canonical literacy labels resolved from the knowledge graph. */
  literacies?: string[];
  difficulty?: Difficulty;
}

export type QuestionPayload =
  | (BaseQuestion & {
      type: 'multiple_choice';
      options: { key: string; text: string }[];
      multiSelect: boolean;
    })
  | (BaseQuestion & { type: 'fill_blank'; blankCount: number })
  | (BaseQuestion & { type: 'true_false' })
  | (BaseQuestion & { type: 'short_answer' });

export type AnswerPayload =
  | { type: 'multiple_choice'; selectedKeys: string[] }
  | { type: 'fill_blank'; answers: string[] }
  | { type: 'true_false'; value: boolean }
  | { type: 'short_answer'; text: string };

/** 判分结果 */
export interface GradingResult {
  correct: boolean | null;
  score: number;
  maxScore: number;
  reference: string;
  explanation: string;
  perBlank?: boolean[];
  /** 填空题逐空详细匹配信息（含层级，供 Level 3 LLM 语义判定） */
  perBlankDetails?: Array<{
    matched: boolean;
    level: 1 | 2 | 'miss' | 'llm';
    userNorm: string;
    acceptedNorms: string[];
  }>;
  knowledgePoints?: string[];
  literacies?: string[];
  /** LLM 出题时直接引用的知识图谱节点 ID，优先于此 ID 更新画像 */
  knowledgePointId?: number;
}

export interface AnswerRequest {
  threadId: string;
  toolCallId: string;
  answer: AnswerPayload;
  conversationId?: string;
}

// ─────────────────────────────────────────────────────────────
// 知识画像类型
// ─────────────────────────────────────────────────────────────

export type ProficiencyLevel = 'needs_practice' | 'developing' | 'proficient' | 'mastered';

export interface KpProficiency {
  kgNodeId: number;
  title: string;
  correctCount: number;
  totalCount: number;
  weightedScore: number;
  level: ProficiencyLevel;
  lastUpdated: number;
  /** Elo rating (0-100), progressively stabilized */
  rating?: number;
  /** Uncertainty of the Elo rating (0-25) */
  ratingSigma?: number;
}

export interface LiteracyProficiency {
  literacy: string;
  score: number;
  totalScore: number;
  percentage: number;
}

export interface ProfileRecommendation {
  kgNodeId: number;
  title: string;
  weightedScore: number;
  level: ProficiencyLevel;
  weight: number;
  reason: string;
  /** Elo rating (0-100) */
  rating?: number;
  /** Uncertainty of the Elo rating */
  ratingSigma?: number;
}

// ─────────────────────────────────────────────────────────────
// Mistake notebook
// ─────────────────────────────────────────────────────────────

export type MistakeSourceType = 'image' | 'text';
export type MistakeStatus = 'processing' | 'analyzed' | 'needs_review' | 'archived';
export type MistakeKpRole = 'primary' | 'related' | 'prerequisite';

export interface MistakeAsset {
  id: number;
  mistakeId: string;
  assetKind: 'original' | 'annotated';
  mimeType: string;
  fileSize: number;
  width?: number;
  height?: number;
  createdAt: number;
}

export interface MistakeKpMapping {
  mistakeId: string;
  kgNodeId: number;
  title: string;
  unitId?: number;
  unitTitle?: string;
  role: MistakeKpRole;
  confidence: number;
  beforeScore?: number;
  afterScore?: number;
  evidence?: string;
}

export interface MistakeStyleFeature {
  id?: number;
  mistakeId: string;
  questionType: string;
  difficulty: Difficulty;
  scenarioType: string;
  reasoningPattern: string;
  distractorPattern?: string;
  presentationFeatures?: Record<string, unknown>;
  styleText: string;
  createdAt?: number;
}

export interface MistakeItem {
  id: string;
  userId?: string;
  subject: string;
  grade: string;
  sourceType: MistakeSourceType;
  status: MistakeStatus;
  title: string;
  promptText: string;
  originalText?: string;
  studentAnswer?: string;
  correctAnswer?: string;
  explanation?: string;
  errorType?: string;
  errorReason?: string;
  analysisConfidence?: number;
  ocrProvider?: string;
  ocrRaw?: unknown;
  /** 学生答案与正确答案的匹配度 (0-1)，由后端归一化计算 */
  answerMatchScore?: number;
  /** 匹配度≥阈值时判定为大概率做对：前端错题列表过滤，后端题型风格仍沉淀 */
  isCorrect?: boolean;
  createdAt: number;
  updatedAt: number;
  proficiencyAppliedAt?: number;
  assets?: MistakeAsset[];
  mappings?: MistakeKpMapping[];
  styleFeature?: MistakeStyleFeature;
}

export interface CreateMistakeRequest {
  sourceType: MistakeSourceType;
  subject: string;
  grade: string;
  promptText?: string;
  studentAnswer?: string;
  note?: string;
}

export type AnalyzeMistakeStep = 'ocr' | 'analyze' | 'map' | 'profile' | 'style' | 'complete';

export type AnalyzeMistakeEvent =
  | { type: 'mistake_progress'; step: AnalyzeMistakeStep; message: string; progress: number }
  | { type: 'mistake_ready'; mistake: MistakeItem }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface MistakeListResponse {
  mistakes: MistakeItem[];
}

export interface MistakeDetailResponse {
  mistake: MistakeItem;
}

// ─────────────────────────────────────────────────────────────
// 考试类型
// ─────────────────────────────────────────────────────────────

export interface ExamQuestion {
  index: number;
  type: QuestionType;
  points: number;
  stem: string;
  passage?: string;
  options?: { key: string; text: string }[];
  correctKeys?: string[];
  multiSelect?: boolean;
  blanks?: { acceptedAnswers: string[] }[];
  /** 填空数量（前端渲染输入框用） */
  blankCount?: number;
  answer?: boolean;
  referenceAnswer?: string;
  keyPoints?: string[];
  knowledgePoint?: string;
  /** 知识图谱节点 ID（出题时从课程上下文引用，精确更新画像用） */
  knowledgePointId?: number;
  literacies?: string[];
  difficulty?: Difficulty;
  explanation: string;
  /** 分步设问分组 ID：同 groupId 的题目共享 passage/stem，前端合并展示 */
  groupId?: number;
  /** 预渲染的 TikZ 图形 SVG，key 为 TikZ 代码的 hash */
  tikzSvgs?: Record<string, string>;
}

export interface ExamQuestionResult {
  index: number;
  correct: boolean | null;
  score: number;
  maxScore: number;
  reference: string;
  explanation: string;
  knowledgePoint?: string;
  knowledgePointId?: number;
  literacy?: string[];
  /** 针对性错误分析（仅在用户请求"查看详解"后由 LLM 生成） */
  detailedExplanation?: string;
}

export interface ProficiencyChange {
  kpTitle: string;
  /** 变化前的 EMA 值 (0-100) */
  before: number;
  /** 变化后的 EMA 值 (0-100) */
  after: number;
  /** 本条得分/满分 */
  score: number;
  maxScore: number;
  /** 变化前的 Elo rating */
  ratingBefore?: number;
  /** 变化后的 Elo rating */
  ratingAfter?: number;
  /** 变化前的不确定度 */
  sigmaBefore?: number;
  /** 变化后的不确定度 */
  sigmaAfter?: number;
}

export interface ExamResults {
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
  questionResults: ExamQuestionResult[];
  tierBreakdown: Array<{ tier: string; correct: number; total: number; percentage: number }>;
  kpBreakdown: Array<{ kp: string; score: number; maxScore: number; percentage: number }>;
  literacyBreakdown: Array<{ literacy: string; score: number; maxScore: number; percentage: number }>;
  /** 博文对本次考试的综合分析总结（Markdown），包括考查知识点、答题情况、失分点与薄弱点 */
  analysis?: string;
  /** 各知识点熟练度变化 */
  proficiencyChanges?: ProficiencyChange[];
  /** 自动归入错题本的信息 */
  mistakesCollected?: { count: number; mistakeIds: string[] };
  /** 本次结算获得的星月积分（已按日上限封顶） */
  pointsEarned?: number;
  /** 入账后的积分余额 */
  pointsBalance?: number;
  /** 是否因日上限被截断 */
  pointsCapped?: boolean;
}

/** 考试历史列表项（概要） */
export interface ExamSummary {
  examId: string;
  title: string;
  subject: string;
  grade: string;
  totalScore: number;
  status: 'pending' | 'completed';
  createdAt: number;
  submittedAt?: number;
  /** 已完成考试的成绩概要 */
  result?: { totalScore: number; maxScore: number; percentage: number; grade: string };
}

/** 考试回顾详情：已完成考试返回完整题目（含答案）+ 用户作答 + 评分 */
export interface ExamReviewDetail {
  examId: string;
  title: string;
  subject: string;
  grade: string;
  totalScore: number;
  durationMinutes: number;
  status: 'pending' | 'completed';
  createdAt: number;
  submittedAt?: number;
  questions: ExamQuestion[];
  answers?: Array<{ questionIndex: number; answer: AnswerPayload }>;
  results?: ExamResults;
  blueprint?: ExamBlueprint;
  qualityReport?: ExamQualityReport;
}

// ─────────────────────────────────────────────────────────────
// 试卷蓝图（重构后三阶段流水线产物）
// ─────────────────────────────────────────────────────────────

export interface BlueprintKnowledgePoint {
  id?: number;
  title: string;
  /** 本 section 内的权重 (0-1) */
  weight: number;
}

export interface BlueprintQuestionTypePlan {
  type: QuestionType;
  count: number;
  pointsPer: number;
  focusKps: string[];
}

export interface BlueprintSection {
  title: string;
  knowledgePoints: BlueprintKnowledgePoint[];
  difficulty: Difficulty;
  questionTypes: BlueprintQuestionTypePlan[];
}

export interface BlueprintCoveragePlan {
  must: string[];
  focus: string[];
  stretch?: string[];
}

export interface BlueprintDifficultyDistribution {
  easy: number;
  medium: number;
  hard: number;
}

export interface ExamBlueprint {
  title: string;
  sections: BlueprintSection[];
  totalScore: number;
  coveragePlan: BlueprintCoveragePlan;
  difficultyDistribution: BlueprintDifficultyDistribution;
}

// ─────────────────────────────────────────────────────────────
// 试卷质量审核评分
// ─────────────────────────────────────────────────────────────

/** 审核维度标识 */
export type ReviewDimension = 'correctness' | 'similarity' | 'blueprint_match' | 'format' | 'discrimination';

/** 单题单维度的审核结果 */
export interface DimensionScore {
  dimension: ReviewDimension;
  score: number;       // 0-100
  issues: string[];    // 具体问题描述
  similarTo?: number[]; // 仅 similarity 维度：与哪些题号雷同
}

/** 单题的综合质量评分 */
export interface QuestionQualityScore {
  index: number;
  total: number;                    // 加权总分 0-100
  dimensions: Record<ReviewDimension, DimensionScore>;
  needsRegeneration: boolean;       // total < 70 或任一维度 < 60
  regenerationFeedback?: string;    // 注入重出 prompt 的反馈
}

/** 全卷质量报告 */
export interface ExamQualityReport {
  scores: QuestionQualityScore[];
  regeneratedIndices: number[];     // 实际重出的题号
  qualityWarnings: number[];        // 重出后仍不达标的题号
}

// ─────────────────────────────────────────────────────────────
// 订阅系统
// ─────────────────────────────────────────────────────────────

export type BillingStatus = 'none' | 'pending' | 'trialing' | 'active' | 'canceling' | 'past_due' | 'canceled';
export type MembershipPlanKey = 'monthly' | 'yearly';
export const MEMBERSHIP_TERMS_VERSION = '1.2';
export const MEMBERSHIP_PLANS = [
  { key: 'monthly', name: '皓月卡', days: 30, amount: '2.99', currency: 'USD', intervalLabel: '月', trialDays: 7 },
  { key: 'yearly', name: '星耀卡', days: 365, amount: '29.99', currency: 'USD', intervalLabel: '年', trialDays: 7 },
] as const;
export interface MembershipDetails {
  membership: { active: boolean; source: 'waffo' | 'legacy' | 'reward' | 'none'; accessEndsAt: number | null; legacyTier: 'monthly' | 'yearly' | null };
  billing: { status: BillingStatus; currentPeriodStart: number | null; currentPeriodEnd: number | null;
    renewsAt: number | null; cancelAtPeriodEnd: boolean; amount: string; currency: string; planKey: MembershipPlanKey;
    trialEligible: boolean; checkoutAllowed: boolean; portalUrl: string };
  rewards: { bankedSeconds: number; activeUntil: number | null };
}

export interface SubscriptionStatus extends MembershipDetails {
  tier: 'free' | 'monthly' | 'yearly';
  isPremium: boolean;
  expiresAt: number | null;
  activatedAt: number | null;
  dailyLimit: number | null;
  dailyUsed: number | null;
  dailyRemaining: number | null;
  /** Waffo 现金购卡通道是否可用（未配置时为 false，前端隐藏购买入口） */
  payEnabled?: boolean;
  /** 当前可现金购买的星月卡档位 */
  plans?: PurchasablePlan[];
}

/** 可通过 Waffo 收银台购买的星月卡档位 */
export interface PurchasablePlan {
  key: MembershipPlanKey;
  name: string;
  days: number;
  amount: string;
  currency: string;
  intervalLabel: string;
  trialDays: number;
}

/** 星月积分（局内货币）可兑换的会员产品 */
export interface CurrencyProduct {
  key: string;
  name: string;
  days: number;
  cost: number;
}

/** 星月积分状态（/api/currency/status 返回） */
export interface CurrencyStatus {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  todayEarned: number;
  dailyCap: number;
  dailyRemaining: number;
  products: CurrencyProduct[];
  /** 今日（北京时间）是否已领取登录奖励 */
  claimedToday: boolean;
  /** 每日登录奖励积分数 */
  loginReward: number;
}

// ─────────────────────────────────────────────────────────────
// SSE 事件
// ─────────────────────────────────────────────────────────────

/** 类课堂步骤状态：待进行 / 进行中 / 已完成 / 失败 */
export type TodoStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** 类课堂 TODO 单步（备课工具 plan_steps 生成的步骤清单项） */
export interface TodoStep {
  id: number;
  label: string;
  status: TodoStepStatus;
}

export type SseEvent =
  | { type: 'token'; value: string }
  | { type: 'mode'; value: BoenMode }
  | { type: 'quiz_generating' }
  | { type: 'question'; toolCallId: string; question: QuestionPayload }
  | { type: 'grading'; toolCallId: string; result: GradingResult }
  | { type: 'title_updated'; conversationId: string; title: string }
  | { type: 'review_complete'; summary: string; score: number; totalQuestions: number; correctAnswers: number }
  | { type: 'exam_generating' }
  | { type: 'exam_progress'; step: 'blueprint' | 'write' | 'review' | 'regenerate' | 'analyze' | 'complete'; message: string; progress: number }
  | { type: 'exam_ready'; examId: string; title: string; totalQuestions: number; totalScore: number; durationMinutes: number }
  | { type: 'exam_grading_progress'; step: 'grade' | 'analyze' | 'profile' | 'save' | 'complete'; message: string; progress: number }
  | { type: 'exam_grading_progress'; graded: number; total: number }
  | { type: 'exam_graded'; examId: string; results: ExamResults }
  | { type: 'loading_knowledge_base' }
  | { type: 'usage'; dailyLimit: number; dailyUsed: number; dailyRemaining: number }
  | { type: 'conversation_created'; conversationId: string; title: string }
  | { type: 'todo_plan'; steps: TodoStep[]; currentStep: number }
  | { type: 'todo_step'; action: 'plan' | 'advance' | 'exit' | 'query' | 'switch' | 'quiz'; detail: string }
  | { type: 'todo_done'; action: 'plan' | 'advance' | 'exit' | 'query' | 'switch' | 'quiz'; detail: string }
  | { type: 'todo_fail'; action: 'plan' | 'advance' | 'exit' | 'query' | 'switch' | 'quiz'; error: string }
  | { type: 'subject_changed'; subject: string }
  | { type: 'settlement'; summary: string; score: number; stepsCompleted: number; totalSteps: number; updatedKps: number; proficiencyChanges?: Array<{ kpTitle: string; before: number; after: number }>; pointsEarned?: number; pointsBalance?: number; pointsCapped?: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string };

/* ══════════════════════════════════════════════════════════════
 * 教育游戏（知识跑酷）——前后端共享常量
 *
 * 学科表、跑道数、计分与关卡规则只在这一处定义：
 * 服务端出题、前端选科卡片、跑酷场景都从这里取，避免三处硬编码各自漂移。
 * ══════════════════════════════════════════════════════════════ */

export const GAME_SUBJECTS = ['math', 'chinese', 'english', 'science'] as const;
export type GameSubject = (typeof GAME_SUBJECTS)[number];

/** 学科展示信息（选科卡片、主题色、Emoji） */
export const GAME_SUBJECT_META: Record<GameSubject, {
  label: string;
  emoji: string;
  desc: string;
  accent: string;
  accentSoft: string;
  accentStrong: string;
}> = {
  math: { label: '数学', emoji: '🔢', desc: '数与运算、几何、逻辑', accent: '#14b48a', accentSoft: '#d9f4ec', accentStrong: '#0e9b76' },
  chinese: { label: '语文', emoji: '📖', desc: '古诗、阅读理解、字词', accent: '#ff7a4d', accentSoft: '#ffe5d7', accentStrong: '#e06530' },
  english: { label: '英语', emoji: '🔤', desc: '词汇、语法、日常对话', accent: '#6c5ce7', accentSoft: '#e8e4ff', accentStrong: '#5a4bd1' },
  science: { label: '科学', emoji: '🔬', desc: '物理、生物、天文常识', accent: '#3498db', accentSoft: '#d4e6f1', accentStrong: '#2c7bc7' },
};

/** 跑酷跑道数 = 每道题的选项数 */
export const GAME_LANES = 4;
/** 答对一题的基础分（服务端按同一常量重算，不信任客户端上报） */
export const GAME_QUESTION_BONUS = 10;
/** 关卡模式：每关题数与过关所需正确数 */
export const GAME_STAGE_SIZE = 5;
export const GAME_STAGE_PASS = 4;
/** 每日挑战题数 */
export const GAME_DAILY_SIZE = 10;

/** 游戏局类型 */
export type GameMode = 'endless' | 'daily' | 'stage';
