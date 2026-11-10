import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';
import { initMembership } from './membership.js';

const db = new Database(join(DATA_DIR, 'boen.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 对话表 ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '新对话',
    subject TEXT DEFAULT 'math',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
`);

// ── 消息表 ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

// ── 向量表 ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_conversation ON embeddings(conversation_id);
`);

// ── 课程知识库 ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_textbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    volume TEXT NOT NULL DEFAULT '全册',
    publisher TEXT NOT NULL DEFAULT '人教版',
    version TEXT,
    source_url TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(subject, grade, volume, publisher)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    textbook_id INTEGER NOT NULL,
    parent_id INTEGER,
    seq INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unit',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (textbook_id) REFERENCES curriculum_textbooks(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES curriculum_units(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_units_textbook ON curriculum_units(textbook_id);
  CREATE INDEX IF NOT EXISTS idx_units_parent ON curriculum_units(parent_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT,
    code TEXT,
    title TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_kp_subject_grade ON knowledge_points(subject, grade);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS unit_knowledge_map (
    unit_id INTEGER NOT NULL,
    knowledge_point_id INTEGER NOT NULL,
    PRIMARY KEY (unit_id, knowledge_point_id),
    FOREIGN KEY (unit_id) REFERENCES curriculum_units(id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS curriculum_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_type TEXT NOT NULL CHECK(ref_type IN ('unit', 'kp')),
    ref_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(ref_type, ref_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cemb_filter ON curriculum_embeddings(subject, grade);
`);

// ── 知识画像：用户知识点熟练度 ──────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS user_kp_proficiency (
    user_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    correct_count INTEGER DEFAULT 0,
    total_count INTEGER DEFAULT 0,
    weighted_score REAL DEFAULT 0,
    last_updated INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, kg_node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kp_prof_user ON user_kp_proficiency(user_id);
`);

// ── 版本化迁移 ──────────────────────────────
// 统一替代 PRAGMA table_info 逐列检查方案，避免每次启动全表扫描
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);
const currentVersion = (db.prepare(`SELECT MAX(version) FROM schema_version`).pluck().get() ?? 0) as number;

/** 安全添加列：仅在目标列不存在时执行 ALTER TABLE ADD COLUMN */
function addColumnIfNotExists(table: string, column: string, def: string): void {
  const exists = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

const MIGRATIONS: Array<{ version: number; run: () => void; description: string }> = [
  {
    version: 1,
    description: 'user_kp_proficiency 添加 Elo 列',
    run: () => {
      addColumnIfNotExists('user_kp_proficiency', 'rating', 'REAL DEFAULT 50');
      addColumnIfNotExists('user_kp_proficiency', 'rating_sigma', 'REAL DEFAULT 20');
      // 将已有的 weighted_score 回填到 rating（幂等，通过 WHERE 条件保证只执行一次）
      db.exec(`UPDATE user_kp_proficiency SET rating = weighted_score WHERE rating = 50 AND weighted_score != 50`);
    },
  },
  {
    version: 2,
    description: 'exam_sessions 添加 blueprint/quality_report/grading_checkpoint',
    run: () => {
      addColumnIfNotExists('exam_sessions', 'blueprint', 'TEXT');
      addColumnIfNotExists('exam_sessions', 'quality_report', 'TEXT');
      addColumnIfNotExists('exam_sessions', 'grading_checkpoint', 'TEXT');
    },
  },
  {
    version: 3,
    description: 'mistake_items 添加 answer_match_score/is_correct + 索引',
    run: () => {
      addColumnIfNotExists('mistake_items', 'answer_match_score', 'REAL NOT NULL DEFAULT 0');
      addColumnIfNotExists('mistake_items', 'is_correct', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mistakes_correct ON mistake_items(user_id, is_correct)`);
    },
  },
  {
    version: 4,
    description: 'mistake_proficiency_events 添加 Elo 列',
    run: () => {
      addColumnIfNotExists('mistake_proficiency_events', 'before_rating', 'REAL');
      addColumnIfNotExists('mistake_proficiency_events', 'after_rating', 'REAL');
      addColumnIfNotExists('mistake_proficiency_events', 'before_sigma', 'REAL');
      addColumnIfNotExists('mistake_proficiency_events', 'after_sigma', 'REAL');
    },
  },
  {
    version: 5,
    description: 'exam_sessions 添加 updated_at 并回填',
    run: () => {
      // SQLite only allows constant defaults when adding a column to an existing table.
      addColumnIfNotExists('exam_sessions', 'updated_at', 'INTEGER DEFAULT 0');
      db.exec(`UPDATE exam_sessions SET updated_at = COALESCE(created_at, unixepoch()) WHERE updated_at = 0`);
    },
  },
  {
    version: 6,
    description: 'game_sessions 添加 mode 列（无尽 / 每日挑战 / 关卡）',
    run: () => {
      // 该表在文件末尾才创建；全新库此时还不存在，跳过即可（建表语句已带该列）
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_sessions'").get();
      if (exists) addColumnIfNotExists('game_sessions', 'mode', "TEXT NOT NULL DEFAULT 'endless'");
    },
  },
];

for (const m of MIGRATIONS) {
  if (m.version > currentVersion) {
    try {
      db.transaction(() => {
        m.run();
        db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, unixepoch())').run(m.version);
      })();
      console.log(`[db] 迁移 v${m.version} 完成: ${m.description}`);
    } catch (e) {
      // 迁移失败必须阻断启动：带着残缺 schema 继续跑，会在业务层炸出更难查的错误。
      // 只有「列已存在」这类幂等失败可以放过（addColumnIfNotExists 内部已处理）。
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate column name/i.test(msg)) {
        console.warn(`[db] 迁移 v${m.version} 跳过（列已存在）: ${m.description}`);
        try {
          db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, unixepoch())').run(m.version);
        } catch { /* ignore */ }
        continue;
      }
      console.error(`[db] 迁移 v${m.version} 失败 (${m.description}): ${msg}`);
      console.error('[db] 数据库 schema 与应用版本不一致，拒绝启动。请先修复迁移或回滚到匹配版本。');
      process.exit(1);
    }
  }
}

// ── 复习课程记录 ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS review_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    topic TEXT NOT NULL,
    sections_covered TEXT,
    total_questions INTEGER DEFAULT 0,
    correct_answers INTEGER DEFAULT 0,
    overall_score REAL DEFAULT 0,
    started_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_review_user ON review_sessions(user_id);
`);

// ── 考试会话 ────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS exam_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    title TEXT,
    questions TEXT NOT NULL,
    total_score REAL NOT NULL DEFAULT 100,
    duration_minutes INTEGER DEFAULT 45,
    status TEXT NOT NULL DEFAULT 'pending',
    answers TEXT,
    results TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    submitted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_exam_user ON exam_sessions(user_id);
`);

// ── Mistake notebook ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('image', 'canvas', 'text')),
    status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'analyzed', 'needs_review', 'archived')),
    title TEXT NOT NULL DEFAULT '',
    prompt_text TEXT NOT NULL DEFAULT '',
    original_text TEXT,
    student_answer TEXT,
    correct_answer TEXT,
    explanation TEXT,
    error_type TEXT,
    error_reason TEXT,
    analysis_confidence REAL DEFAULT 0,
    ocr_provider TEXT,
    ocr_raw TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    proficiency_applied_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mistakes_user_updated ON mistake_items(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mistakes_filter ON mistake_items(user_id, subject, grade, status);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL DEFAULT 'original' CHECK(asset_kind IN ('original', 'annotated')),
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_assets_item ON mistake_assets(mistake_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_kp_map (
    mistake_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    unit_id INTEGER,
    role TEXT NOT NULL DEFAULT 'related' CHECK(role IN ('primary', 'related', 'prerequisite')),
    confidence REAL NOT NULL DEFAULT 0,
    before_score REAL,
    after_score REAL,
    evidence_json TEXT,
    PRIMARY KEY (mistake_id, kg_node_id),
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_kp_node ON mistake_kp_map(kg_node_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_style_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medium',
    scenario_type TEXT NOT NULL DEFAULT '',
    reasoning_pattern TEXT NOT NULL DEFAULT '',
    distractor_pattern TEXT,
    presentation_features TEXT,
    style_text TEXT NOT NULL DEFAULT '',
    embedding BLOB,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_style_item ON mistake_style_features(mistake_id);
`);

// 全服务器「出题风格技能库」：跨用户沉淀的去重风格技能（按 学科+年级 检索）
db.exec(`
  CREATE TABLE IF NOT EXISTS style_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    grade TEXT NOT NULL,
    kg_node_id INTEGER,
    question_type TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medium',
    skill_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    reinforce_count INTEGER NOT NULL DEFAULT 1,
    distinct_user_count INTEGER NOT NULL DEFAULT 1,
    source_user_ids TEXT,
    quality_weight REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_style_skills_bucket ON style_skills(subject, grade);
  CREATE INDEX IF NOT EXISTS idx_style_skills_node ON style_skills(kg_node_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mistake_proficiency_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mistake_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    before_score REAL,
    after_score REAL,
    before_correct_count REAL,
    before_total_count REAL,
    after_correct_count REAL,
    after_total_count REAL,
    role TEXT NOT NULL DEFAULT 'related',
    confidence REAL NOT NULL DEFAULT 0,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
    reverted_at INTEGER,
    FOREIGN KEY (mistake_id) REFERENCES mistake_items(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_prof_user_node ON mistake_proficiency_events(user_id, kg_node_id, applied_at);
  CREATE INDEX IF NOT EXISTS idx_mistake_prof_item ON mistake_proficiency_events(mistake_id);
`);

// ── 订阅系统 ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    activated_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_chat_usage (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_chat_usage(user_id, date);
`);

// ── 兑换码：消费流水 + 撤销 denylist ─────────────────────────
// 兑换码采用「自描述签名码」：可复用?/面值天数/有效期/批次等条款编码进码内并由 HMAC 签名，
// 服务端离线可验，无需在库中预存码。库里只保留逻辑上不属于码本身的「状态」：
//   1) code_redemptions —— 消费流水：审计 + PK(nonce,user_id) 防同人重复兑换；
//      限次上限来自码内 maxUses，已用次数 = COUNT(*) WHERE nonce=?。
//   2) code_revocations —— 撤销名单：按单码 nonce 或整批 batch 作废（batch 在码内，无需存已发码）。
db.exec(`
  CREATE TABLE IF NOT EXISTS code_redemptions (
    nonce         TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    granted_until INTEGER NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (nonce, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_code_redemptions_nonce ON code_redemptions(nonce);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS code_revocations (
    scope      TEXT NOT NULL CHECK(scope IN ('nonce', 'batch')),
    value      TEXT NOT NULL,
    reason     TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (scope, value)
  );
`);

// ── 星月积分（局内货币）───────────────────────────────────────
// 用户做结构化学习/考试 → 知识点 Elo 熟练度提升 → 按提升量并以学科总熟练度线性倍增
// 结算积分；积分累积可兑换皓月卡/星耀卡会员。三张表：
//   1) user_currency        —— 余额（单行/用户）+ 累计赚/花，便于审计与展示。
//   2) currency_ledger      —— 流水账本（earn/spend/grant/adjust），镜像 code_redemptions 审计模式。
//   3) currency_daily_earn  —— 每日已赚计数，用于日上限封顶（镜像 daily_chat_usage）。
db.exec(`
  CREATE TABLE IF NOT EXISTS user_currency (
    user_id      TEXT PRIMARY KEY,
    balance      INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_spent  INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS currency_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('earn', 'spend', 'grant', 'adjust')),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT,
    ref_id        TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_currency_ledger_user ON currency_ledger(user_id, created_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS currency_daily_earn (
    user_id TEXT NOT NULL,
    date    TEXT NOT NULL,
    earned  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );
`);

// 每日登录领取（按北京时间 date 每天一次，date 为北京时间 YYYY-MM-DD）
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_login_claims (
    user_id    TEXT NOT NULL,
    date       TEXT NOT NULL,
    amount     INTEGER NOT NULL DEFAULT 50,
    claimed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, date)
  );
`);

// ── Waffo Pancake 支付（星月卡现金购卡通道）──────────────────
// 与兑换码/积分并列的第三条发卡路径，最终都收敛到 grantMembershipDays()。
// 三张表各司其职，共同保证「一笔钱只发一次卡」：
//   1) payment_orders        —— 收银台会话流水：站内 user_id ↔ Waffo 订单的唯一关联，
//                               也是 Webhook 反查用户的兜底索引（业务订单号/订单号/邮箱）。
//   2) membership_grants     —— 发卡去重：按「Waffo 订单 × 计费周期」唯一，首期 activated
//                               与 payment_succeeded 同时到达、续费重投都不会重复发卡。
//   3) waffo_webhook_events  —— 投递去重与审计：按投递 ID(event.id) 唯一，status 区分
//                               received/processed/failed，便于排查重投与处理失败。
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_orders (
    session_id   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    plan_key     TEXT NOT NULL,
    product_id   TEXT NOT NULL,
    currency     TEXT NOT NULL,
    amount       TEXT,
    external_id  TEXT NOT NULL,
    order_id     TEXT,
    checkout_url TEXT,
    buyer_email  TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_external ON payment_orders(external_id);
  CREATE INDEX IF NOT EXISTS idx_payment_orders_order_id ON payment_orders(order_id);
  CREATE INDEX IF NOT EXISTS idx_payment_orders_email ON payment_orders(buyer_email);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS membership_grants (
    grant_key  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    days       INTEGER NOT NULL,
    source     TEXT NOT NULL,
    order_id   TEXT,
    until      INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_membership_grants_user ON membership_grants(user_id, created_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS waffo_webhook_events (
    id         TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    event_id   TEXT,
    mode       TEXT,
    order_id   TEXT,
    status     TEXT NOT NULL DEFAULT 'received',
    note       TEXT,
    raw        TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_waffo_events_order ON waffo_webhook_events(order_id);
  CREATE INDEX IF NOT EXISTS idx_waffo_events_type ON waffo_webhook_events(event_type, created_at DESC);
`);

// ── 对话记忆摘要 ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT 'math',
    summary TEXT NOT NULL,
    topics TEXT NOT NULL DEFAULT '',
    proficiency_level TEXT NOT NULL DEFAULT 'unknown',
    unresolved_questions TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    embedding BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_cs_user_subject ON conversation_summaries(user_id, subject);
  CREATE INDEX IF NOT EXISTS idx_cs_created ON conversation_summaries(created_at DESC);
`);

// ── 教育游戏：局记录 ──────────────────────────
// 一局一行。answers 存 JSON 数组 [{questionId, kgNodeId?, correct}]，
// 局末据此回写 user_kp_proficiency（Elo），让游戏结果反哺学习画像。
db.exec(`
  CREATE TABLE IF NOT EXISTS game_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    grade TEXT,
    score INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    max_combo INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    answers TEXT NOT NULL DEFAULT '[]',
    points_awarded INTEGER NOT NULL DEFAULT 0,
    client_kind TEXT NOT NULL DEFAULT 'web',
    mode TEXT NOT NULL DEFAULT 'endless',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_game_user ON game_sessions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_game_board ON game_sessions(subject, created_at, correct_count DESC);
`);

// 出题账本：服务端签发过的题目（含正确答案），结算时据此核对，不信任客户端上报。
// 保留 24 小时后由定期任务清理。
db.exec(`
  CREATE TABLE IF NOT EXISTS game_question_issue (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    subject TEXT NOT NULL,
    grade TEXT,
    mode TEXT NOT NULL DEFAULT 'endless',
    stem TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_key TEXT NOT NULL,
    explain TEXT,
    kg_node_id INTEGER,
    issued_at INTEGER NOT NULL DEFAULT (unixepoch()),
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_gqi_user ON game_question_issue(user_id, issued_at);
  CREATE INDEX IF NOT EXISTS idx_gqi_issued ON game_question_issue(issued_at);
`);

// 题目缓存：LLM 生成过的题落库，重启/多进程都能复用，避免重复烧 token。
db.exec(`
  CREATE TABLE IF NOT EXISTS game_question_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    grade TEXT,
    stem TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_key TEXT NOT NULL,
    explain TEXT,
    kg_node_id INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_gqc_pick ON game_question_cache(subject, grade, used_count);
`);

// 每日挑战：当天的题集固定下来，刷新页面不会换题。
db.exec(`
  CREATE TABLE IF NOT EXISTS game_daily_challenges (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    subject TEXT NOT NULL,
    questions TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, date)
  );
`);

// 关卡进度：每学科一条，关卡制用。
db.exec(`
  CREATE TABLE IF NOT EXISTS game_progress (
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    stage INTEGER NOT NULL DEFAULT 1,
    cleared_stages INTEGER NOT NULL DEFAULT 0,
    best_accuracy INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, subject)
  );
`);

// ── 用量与成本：每次 LLM 调用的记账 ──────────────
// 按 token 计费的生意必须能回答「这个功能/这个用户花了多少钱」，
// 所以把 prompt/completion token 落库，报表由 scripts/usage-report.mjs 汇总。
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    feature TEXT NOT NULL,
    model TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_events(feature, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at DESC);
`);

// ── 监护人同意（14 周岁以下）──────────────────
// PIPL 第 31 条：处理不满十四周岁未成年人个人信息，应取得监护人同意。
db.exec(`
  CREATE TABLE IF NOT EXISTS guardian_consents (
    user_id TEXT PRIMARY KEY,
    guardian_name TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    consent_version TEXT NOT NULL,
    agreed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ip TEXT,
    revoked_at INTEGER
  );
`);

// ── 画像校准样本（逐次口径）──────────────────
// 每次作答前记下「当时的预测概率」，作答后记下实际结果。
// 有了逐次样本，Brier / 可靠性曲线才是上线级证据（聚合口径只是过渡）。
db.exec(`
  CREATE TABLE IF NOT EXISTS calibration_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kg_node_id INTEGER NOT NULL,
    predicted REAL NOT NULL,
    actual INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'game',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_calib_user ON calibration_samples(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_calib_created ON calibration_samples(created_at DESC);
`);

initMembership(db);
export default db;
