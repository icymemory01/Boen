# 博文 Boen · 学习辅助智能体

面向 **小学 / 中学 / 本科** 三个年龄段的通用 AI 学习助手，基于 **LangGraph.js（全 TypeScript 栈）**。

支持日常问答、结构化预习/复习/练习、AI 出题批改、考试生成与评测、多模态输入（图片）。

> 线上体验：[boen.frostrain.tech](https://boen.frostrain.tech)

当前版本：**v0.5.0**

---

## 功能概览

### 日常问答（QA Mode）
- 任意学科自由提问，模型按年龄段调整语气与深度
- 苏格拉底式引导，优先帮用户自己推导而非直接给答案
- 流式输出 + LaTeX 公式 / TikZ 示意图实时渲染
- **多模态输入**：支持上传图片，DeepSeek V4 原生理解图像内容（数学题截图、试卷照片等）

### 结构化教学模式

所有结构化模式由统一的工具链驱动：

```
plan_steps → advance_step → exit_session
```

| 模式 | 说明 |
|------|------|
| 预习 | 建立知识框架、标记疑问点、准备课堂关注点 |
| 复习巩固 | 让学生自己讲、暴露盲区、针对性补充 |
| 薄弱点突破 | 诊断→基础重建→中等难度→综合巩固 |
| 专项练习 | 口算速练 / 字词听写 / 课文背诵 / 阅读理解 / 作文指导 / 单词学习 |
| 探索课 | 跨学科主题探索，教师引导式对话 |

### 出题与测评
- 四种题型：选择题（含多选）、填空、判断、简答
- 模型以 `tool_call` 结构化出题 → 前端渲染交互卡片
- 服务端判分（填空逐空给分，简答交 LLM 定性评分）
- 标准答案只留服务端，不下发前端

### 智能检索（高级 RAG）
- **查询改写**：LLM 将口语化提问改写为更适合检索的形式
- **混合检索**：向量语义（bge-small-zh） + BM25 全文搜索（FTS5）RRF 融合排序
- **自适应模式**：`lookup_knowledge_point` 工具支持 `auto/semantic/keyword/hybrid` 四种检索模式
- **条件化检索**：问候/追随便跳过知识库查询，减少延迟

### 长期对话记忆
- 会话结束后 LLM 自动生成结构化摘要（知识点、学生水平、未解决问题）
- 摘要向量化后跨会话检索，实现越用越懂你的个性化教学

### 学科自适应切换
- 手动切换（右上角标签栏）+ 模型自动切换（`switch_subject` 工具）
- 模型检测到跨学科问题时自动切换学科 + 更新知识库
- 切换时 CSS transition 平滑变色（光斑 + UI 元素）

### 年级适配
| 年级 | 可选学科 | 结构化模式 | 知识画像 |
|------|---------|-----------|---------|
| 小学 1-6 | 语数英科 | ✅ | ✅ |
| 初中 7-9 | 语数英科 | ✅ | ✅ |
| 高中 | 语数英（无科学） | ✅ | ✅ |
| 大学 | 通用对话（无学科绑定） | ❌ | ❌ |

### 考试系统
- AI 自动生成试卷（按知识点/题型/难度）
- 在线作答 + 自动批改 + 成绩分析
- 错题本 + 薄弱点推荐练习

### 知识画像
- 知识点熟练度追踪（Elo 评分 + 遗忘感知）
- 课程大纲可视化（按教材单元/章节/知识点）
- 掌握度星级展示

### 知识跑酷（教育游戏）
- Phaser 4 四跑道跑酷：4 个选项就是 4 扇门，撞对加分、撞错扣命（共 3 条）
- 三种玩法：**无尽跑酷** / **每日挑战**（当天固定 10 题）/ **关卡**（每关 5 题，答对 4 题过）
- 题目按 **学科 × 年级** 分池，并优先考查该学生的**薄弱知识点**（题目携带知识图谱节点）
- 每次作答立即反馈：答错时高亮正确答案 + ✓/✗ 标记 + 一句话解析
- **成绩不可伪造**：出题时服务端把正确答案写进出题账本（保留 24h），结算时按 `questionId` 逐题核验，
  客户端上报的分数一律不采信
- 局末结算：成绩入库 → 知识点熟练度（Elo）回写 → **答错的题自动进错题本** → 按每日上限发星月积分
- 排行榜（北京时间自然周，匿名昵称）、个人最佳、总正确率、各科关卡进度
- 题干可朗读（TTS），对错有合成音效，移动端左右半屏操作

---

## 技术栈

| 层 | 选型 |
|---|---|
| 智能体编排 | LangGraph.js（`@langchain/langgraph`） |
| 模型适配 | `@langchain/openai`（OpenAI 兼容）/ `@langchain/anthropic`（Claude） |
| 后端 | Hono + `@hono/node-server`，SSE 流式 |
| 前端 | Vue 3 + Vite + Tailwind v4 + markdown-it + KaTeX |
| 图形渲染 | PGF/TiKZ → xelatex → dvisvgm 服务端编译 |
| 向量嵌入 | bge-small-zh-v1.5（本地 ONNX，`@huggingface/transformers`） |
| 全文搜索 | SQLite FTS5（BM25） |
| 知识库 | SQLite（`better-sqlite3`）+ 自定义课程知识图谱；语数英 G1-G9、科学 G1-G9 |
| 公式编辑 | MathLive（所见即所得） |
| 教育游戏 | Phaser 4（Canvas 跑酷）+ WebAudio 现场合成音效 + 浏览器 TTS 朗读题干 |
| 包管理 | npm workspaces（monorepo） |

## 目录结构

```
boen/
├── packages/
│   ├── shared/          # 前后端共享类型（SseEvent / GradeBand / ChatRequest …）
│   └── agent-core/      # 模型工厂 + LangGraph 主图 + 工具定义 + 出题批分模块
├── apps/
│   ├── server/          # Hono SSE 后端（聊天/考试/画像/探索/记忆 API）
│   └── web/             # Vue 3 前端
├── scripts/             # 数据分析、课程导入、离线题库生成（build-game-bank.mjs）
└── docs/                # 合规记录与静态演示页
```

## LangGraph 图结构

```
router → checkNeedRetrieval → loadCurriculum (条件) → agent
agent → ToolNode(有 tool_calls) → agent
agent → awaitQuestion(出题) → agent(答题后)
agent → __end__(无 tool_calls)
```

- **router**: 用户意图检测 → 设置 `mode`（qa / review / preview / weakness / practice / explore）
- **checkNeedRetrieval**: 问候/短确认/纯追随便跳过知识库检索（方向二）
- **loadCurriculum**: 按学科+年级加载课程知识库 + 长期记忆 + 薄弱点数据
- **agent**: 构建 system prompt + 绑定工具 → 调用 LLM
- **tools**: `ToolNode` 自动执行所有工具调用

## 工具清单

| 工具 | 说明 |
|------|------|
| `plan_steps` | 模型根据学习内容自定 TODO 步骤（≥3 步），每次会话仅可调用一次 |
| `advance_step` | 推进到下一步（需学生确认） |
| `exit_session` | 结束类课堂学习，提交总结和评分 |
| `switch_subject` | 切换当前教学学科（模型自适应） |
| `ask_multiple_choice` | 出选择题（含多选） |
| `ask_fill_blank` | 出填空题 |
| `ask_true_false` | 出判断题 |
| `ask_short_answer` | 出简答题 |
| `complete_review` | 复习完成提交评分 |
| `lookup_knowledge_point` | 查询课程知识图谱（支持 `auto/semantic/keyword/hybrid` 模式） |
| `switch_to_*` | 学习周期感知主动建议切换模式 |

## 配置

复制 `.env.example` 为 `.env` 并填写。当前唯一必填的是模型密钥：

```env
# 必填：DeepSeek（免费 Flash 档 / 会员 Pro 档由服务端按订阅切换）
DEEPSEEK_API_KEY=你的key
PORT=8787

# 登录（Frost ID OAuth）—— 缺 FROST_ID_CLIENT_SECRET 时服务端拒绝启动
VITE_FROST_ID_URL=https://frostrain.tech
VITE_FROST_ID_CLIENT_ID=boen-client
FROST_ID_INTERNAL_URL=http://127.0.0.1:4000
FROST_ID_CLIENT_ID=boen-client
FROST_ID_CLIENT_SECRET=你的secret

# 会员支付（Waffo）—— 生产 KYB 通过前保持 WAFFO_ALLOW_TEST_CHECKOUT=false
WAFFO_ENVIRONMENT=test
WAFFO_ALLOW_TEST_CHECKOUT=false
WAFFO_MERCHANT_ID=
WAFFO_PRIVATE_KEY=
WAFFO_STORE_ID=
WAFFO_PRODUCT_MONTHLY=
WAFFO_PRODUCT_YEARLY=
WAFFO_WEB_ORIGIN=https://boen.frostrain.tech
WAFFO_PORTAL_URL=https://pancake.waffo.ai/consumer/portal/login

# 错题本 OCR（二选一或都配）：阿里云结构化识别 / 百炼多模态 VLM
ALIYUN_ACCESS_KEY_ID=
ALIYUN_ACCESS_KEY_SECRET=
ALIYUN_OCR_ENDPOINT=ocr-api.cn-hangzhou.aliyuncs.com
BAILIAN_API_KEY=
BAILIAN_BASE_URL=
BAILIAN_VL_MODEL=qwen3-vl-plus
```

模型全部走 DeepSeek（讯飞 provider 已下线），**不再有 `BOEN_PROVIDER` / `BOEN_MODEL` 这类开关**；
免费档与会员 Pro 档由订阅状态决定。完整字段与注释以 `.env.example` 为准。

### 离线题库（可选）

知识跑酷的题目默认由「LLM 实时生成 + 内置题库」供给。想让题库更厚、更贴合教材，
可以用脚本按 curriculum 教材离线批量生成，服务端启动时会自动加载：

```bash
node scripts/build-game-bank.mjs --dry-run          # 先看有多少知识点可出题
DEEPSEEK_API_KEY=... node scripts/build-game-bank.mjs --subject=math --grade=3 --limit=40
```

产物落在 `apps/server/curriculum/game-bank/<subject>-g<grade>.json`，重复执行会合并去重。

## 运行

```bash
npm install                    # 根目录，一次装齐所有 workspace 依赖

npm run dev:server             # 启动后端 → http://localhost:8787
npm run dev:web                # 启动前端 → http://localhost:5173
```

健康检查：`curl http://localhost:8787/api/health`

## API

主要端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 流式对话（SSE，支持图片） |
| `/api/answer` | POST | 提交题目作答 |
| `/api/explore` | POST | 启动探索课 |
| `/api/exam/generate` | POST | 生成考试 |
| `/api/exam/submit` | POST | 提交考试答案 |
| `/api/profile/report` | GET | 学习画像报告 |
| `/api/profile/outline` | GET | 课程大纲 |
| `/api/render-tikz` | POST | TikZ → SVG 渲染 |
| `/api/model/status` | GET | 当前模型状态 |
| `/api/game/question` | GET | 单题出题（学科 + 年级 + 薄弱点） |
| `/api/game/questions` | GET | 批量出题（跑酷一次拉 5 道） |
| `/api/game/daily` | GET | 每日挑战：当天固定题集（刷新不换题） |
| `/api/game/stage` | GET | 关卡进度 + 本关题目（5 题，答对 4 题过关） |
| `/api/game/finish` | POST | 局末结算：**服务端按出题账本核验**，再入库/回写画像/发积分 |
| `/api/game/leaderboard` | GET | 排行榜（北京时间自然周 / 全部，匿名昵称） |
| `/api/game/stats` | GET | 个人战绩 + 最近 10 局 + 各科关卡进度 |

详细接口定义见 `packages/shared/src/index.ts` 中的 `SseEvent` 类型。

## 年级系统

```typescript
type Grade = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'high' | 'college';
type GradeBand = 'primary' | 'middle' | 'undergrad';
```

`gradeToBand` 映射：1-6 → primary，7-9 → middle，high → middle，college → undergrad。

## 部署

### 云端结构（阿里云）

- 代码 `/var/www/boen`，git 检出自 `github.com:Frostrain5015/Boen.git`
- nginx 站点 `/etc/nginx/sites-available/boen`：静态托管 `/apps/web/dist`，`/api` 反代到 `127.0.0.1:8787`
- 后端 pm2 进程 `boen-server`

### 部署步骤

```bash
cd /var/www/boen
git fetch origin main && git reset --hard origin/main
npm install
cd apps/web && npm run build
pm2 restart boen-server
```

## License

MIT

© 2026 寒霜科技（Frost Tech）
