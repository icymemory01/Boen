# 更新日志

## 未发布 · 知识跑酷改版

### 正确性修复（P0，会直接影响学生看到什么题）
- **不再用占位符补选项**：旧实现在 LLM 只返回 2~3 个选项时补「此选项无效」凑满 4 个，
  学生必然看到假选项。现在选项数 ≠ 4 一律丢弃该题、走兜底题库。
- **不再猜测正确答案**：旧实现把非法 `correctKey` 强制改成 `A`，等于随机指定答案。
  现在解析不出答案就丢弃该题。
- **按索引而非文本定位正确答案**：旧实现用 `options.find(o => o.text === correctText)` 重排答案，
  选项文本重复时（例如上面那三个「此选项无效」）答案门会指错位置。
- **修复题目拉取的竞态**：`fetchQueue` 的状态收尾原先无条件把 `fetching` 置 false，
  切换学科时旧请求的收尾会覆盖新请求状态，可能并发拉题。现在用单调 `fetchId` 仲裁。

### 教学价值（P1）
- **答错即讲解**：作答后画面冻结 2 秒，正确门高亮变绿并显示 ✓（不只靠颜色，色盲可辨），
  错门标 ✗，其余干扰项压暗，同时顶部弹出「正确答案 + 一句话解析」。
- **出题接入课程数据**：按 `subject × grade` 分池，并通过 `curriculum_kg_map` 从知识图谱里挑知识点注入
  prompt；高中/大学走对应学段提示词。
- **薄弱点优先**：已登录用户出题时优先命中其 Elo 薄弱知识点（`getWeakPoints`）。
- **兜底题库按学段分层**：小学 / 初中各一套（原来全学段共用 20 道题）。
- **回归测试**：新增 `apps/server/src/__tests__/game.test.ts`（14 例）覆盖上述解析与洗牌的不变量。
- 纯逻辑拆到 `game-core.ts`，不依赖 better-sqlite3，可在无数据库环境下单测。

### 闭环与留存（P2）
- 新增 `game_sessions` 表，一局一行，逐题记录 `{questionId, kgNodeId, correct}`。
- 新增 `POST /api/game/finish`：单事务完成「写局记录 → 回写知识点 Elo（`mode='game'`）→ 发放积分」。
- 积分按「答对 3 分/题 + 满分 8 分 + 连击奖励」计算，单局上限 60，并沿用每日 100 分总上限。
- 新增 `GET /api/game/leaderboard`（近 7 天 / 全部，按正确题数排名，昵称匿名化）与
  `GET /api/game/stats`（个人最佳、总正确率、最近 10 局）。
- 前端：结算弹窗展示获得积分 / 新纪录 / 已记录知识点数；选科页展示个人最佳与近 7 天榜。

### 二轮：防刷分、玩法与工程

#### 安全与正确性
- **结算不再采信客户端**：出题时把 `{questionId → correctKey, 选项, 解析, 知识点}` 写进 `game_question_issue`
  （出题账本，24 小时 TTL）；结算只上报「撞了哪个选项」，分数 / 对错 / 连击全部由服务端重算，
  账本里查不到的题一律不计分。
- 排行榜周榜改为**北京时间自然周（周一 00:00）**，不再是滚动 168 小时；昵称词表从 6×6 扩到
  24×24 + 两位哈希后缀，避免「勤学少年」满屏重名。

#### 新玩法
- **每日挑战**：每人每天一套固定 10 题（落库后刷新不换题），完成额外 +15 积分。
- **关卡制**：每科独立关卡，每关 5 题、答对 4 题过关并解锁下一关，进度落在 `game_progress`。
- **错题本闭环**：局末把答错的题（题干 / 正确选项 / 解析）自动写入 `mistake_items`
  （`error_type='game'`、直接 `analyzed`，并置 `proficiency_applied_at` 避免与游戏结算的 Elo 重复计），
  每局最多回流 5 题。
- 答对时不再全屏揭示答案（减少信息噪音）；反馈冻结期间锁定换道。
- 题干 TTS 朗读（可开关，本地记忆）+ WebAudio 现场合成音效（答对 / 答错 / 换道），不引入音频资源文件。
- 画布按容器实际尺寸决定逻辑分辨率，桌面端不再因固定 480×720 留白。

#### 工程
- 学科表、跑道数、计分常量、关卡规则统一到 `@boen/shared`（原本 GamesView / RunnerScene / 服务端各写一遍）。
- 题目三级供给：`game_question_cache` 缓存 → 离线题库 / 内置题库 → LLM 后台预热；
  LLM 生成的题落库复用，重启与多进程共享。
- 新增 `scripts/build-game-bank.mjs`：按 curriculum 教材离线批量生成题库（幂等、合并去重、严格校验）。
- **删除 46 个过时的 `.js` 副本**（全部存在 `.ts` 孪生；`tsx` 本就把 `./x.js` 解析到 `x.ts`，这些文件纯属技术债）。
- 新增 GitHub Actions CI：`npm run test` + 服务端 `tsc --noEmit` + 前端 `vue-tsc --noEmit`。
- 补 `LICENSE`（MIT）；删除根目录 `expected` 空文件与一次性诊断脚本 `test-memory-match.ts`，
  `mascot-demo.html` 移入 `docs/`；README 配置段按真实 `.env.example` 重写。
- 新增单测：出题解析 / 洗牌 14 例、计分与北京时间边界 9 例。

---

## v0.5.0

### 重大功能

#### 多模态输入（图片 → 聊天）
- 前端图片选择 → Canvas 压缩 → base64 → multi-content HumanMessage
- DeepSeek V4 Flash 原生支持图片理解，学生可拍照上传数学题/试卷截图
- 图片预览缩略图 + 移除按钮，图片与文字同一条消息发送
- 消息持久化兼容：JSON 编码图文消息，历史对话可恢复显示

#### 高级 RAG（查询改写 + 混合检索）
- **查询改写**：LLM 自动将口语化提问改写为更适合检索的形式（如"这一步为什么这么算？" → "分数除法计算方法的原理"）
- **FTS5 全文搜索**：SQLite FTS5 + BM25 关键词精确匹配，与向量语义检索互补
- **RRF 融合排序**：向量结果 + BM25 结果按倒数排名融合，取双方优势
- **自适应模式**：`lookup_knowledge_point` 工具支持 `auto/semantic/keyword/hybrid` 四种模式

#### 条件化检索
- `needRetrieval` 规则引擎：问候、短确认、纯追随便跳过知识库查询
- 减少不必要的 LLM 调用延迟 + API 消耗

#### 长期对话记忆
- 会话结束时 LLM 自动生成结构化摘要（知识点、学生水平、未解决问题）
- 摘要经 bge-small-zh 向量化后存储，跨会话检索
- `loadCurriculum` 节点自动注入相关历史记忆，实现个性化连贯教学
- 每个用户保留最近 50 条摘要，自动清理过期数据

#### 服务条款合规
- 登录页添加勾选复选框「我已阅读并同意服务条款」，未勾选时登录按钮置灰
- 完整的《服务条款》二级弹窗，覆盖《个人信息保护法》《网络安全法》《未成年人保护法》等中国法律法规要求

### 错误修复（P0）
- **用量在 SSE 流开始前扣除**：`checkAndIncrementUsage` 拆分为 `checkUsage`（只读）+ `incrementUsage`（流成功后执行），失败请求不消耗免费额度
- **`[object Object]` 崩溃**：multi-content `HumanMessage` 的 `content` 为数组时 `String(content)` 产生 `[object Object]`，新增 `getMessageText()` 正确提取文本
- **对话创建失败 → threadId=null**：`apiCreateConversation` 失败时 `busy=false; return`，不再发送消息
- **catch 块中 send() 再次异常**：6 处 `send({type:'error'})` 全部加 `try {} catch {}` 保护，防止 unhandled rejection
- **令牌撤销绕过**：`userIdCache` 新增反向索引 `userIdTokens` 用于 O(1) 失效，撤销后立即删除缓存
- **4 处 Map 内存泄漏**：`userIdCache`（上限 5000）/ `PROFICIENCY_CACHE`（上限 5000）/ `redeemAttempts`（上限 10000）/ tikz 限流（上限 10000）全部加清理逻辑

### 工程
- 全部 workspace 升级至 v0.5.0
- 服务启动时自动从已有课程数据重建 FTS5 索引（幂等）
- 公司信息统一：寒霜科技（Frost Tech），联系邮箱 phy55015@hotmail.com

---

## v0.4.0

### 五大架构升级

#### 多模态输入
- 前端图片选择 → Canvas 压缩 → base64 → multi-content HumanMessage，DeepSeek V4 原生支持

#### 高级 RAG
- LLM 查询改写 + FTS5 BM25 全文搜索 + RRF 融合排序
- 新建 `query-rewriter.ts`、`fts.ts` 模块

#### 条件化检索
- `loadCurriculum` 节点前加 `needRetrieval()` 规则判断

#### 长期对话记忆
- 新建 `conversation-memory.ts`：会话结束 LLM 摘要 → 向量化 → 跨会话检索注入

#### 自适应检索
- `lookup_knowledge_point` 支持 `mode: auto/semantic/keyword/hybrid` 参数

---

## v0.3.5

### 熟练度系统重写
- Elo 参数全面校准：`ELO_RATING_INIT=0`、`ELO_K_BASE=8`、`ELO_SCALING=15`
- 结构化学习模式 `modeMult=2.0`（review/weakness/exam），qa=1.0、preview=0.7、explore=0.4
- 逐题增量追踪：缓存模式用 running `expectedRating` 而非 DB 静态值，每题展示该题带来的增量变化
- 前驱反向传播：缓存模式下答对知识点时，前驱节点同步获得小幅 boost，前端一并展示
- `flushProficiencyCache` 直接以 `expectedRating` 写入，不再经过 `updateProficiency` 的累计单次 Elo
- StarDisplay 统一线性映射 `Math.round(v/10)/2`，`starDiffers` 与之对齐
- 结算弹窗显示详细熟练度变化，箭头从裸文字改为绿色/粉色 badge 样式
- 移除「新」徽章，首次答题即显示 0 星

### 错误修复
- 出题卡片消失：`awaitQuestion` 恢复后为非出题工具 `tool_call` 注入空 ToolMessage
- 提交答案中断：`shouldContinue` 保持原始路由，stub 消息直接操作 `state.messages` 
- 专项练习规划卡死：`BoenMode` 补 `practice`，`mode` 设为 `practice` 而非 `qa`
- 选择题选项重复：prompt + schema + `cleanMultipleChoiceStem` 三重防护
- 课堂空章节：`seed-kp.ts` 补全 3 年级数学知识点（33+39 KPs）
- 年级重置初二：`checkAuth` 补扫 scoped profile key
- 登录崩溃：修复 `as any[]` 链式 filter 的 esbuild 编译错误
- SSE 流中断：`process.on('uncaughtException')` 兜底 + `for await` try-catch + keepalive ping
- nginx `send_timeout` 设 86400s，覆盖默认 60s
- 前驱箭头反向：去掉 `before` 的 `Math.round`，前后都用原始 float 比较
- 结算重复覆盖：`handleSessionExit` 在 cache 为空时不发 settlement
- 错题本映射始终为空：`listMistakes` 批量加载 mappings/assets/styleFeature
- 填空题 LLM 评分：逐空调 N 次改为整题一次调用 + 考试模式统一接口
- 填空题证据改为中文、错因诊断改进、缓存模式用预期熟练度、分数改为星星

### 测试
- 新增 105 项测试：33 纯函数验证 + 14 缓存机制 + 41 场景精算 + 17 压力测试
- vitest 配置 + 4 个测试文件覆盖全部 7 种模式

### 工程
- PM2 `watch` 自动重启，git push 后无需手动部署
- 全部 workspace manifest 升级至 v0.3.5

---

## v0.3.2

### 工具系统重构
- 改用 LangGraph 标准 `ToolNode` + `agent → tools → agent` 循环，移除手写节点路由和条件边
- `plan_steps → advance_step → exit_session` 三工具驱动所有结构化教学模式
- `plan_steps` 每次会话仅可执行一次（`updateTodo` 跳过已有 TODO 的二次调用）
- `switch_subject` 工具：模型可主动切换学科，自动播放渐变动画
- 所有结构化 prompt 接入 `switch_subject` 强制令

### 工具 UI 卡片
- 工具调用三态统一：pending（橙色 + 动画点）→ done（绿色 + CheckCircle）/ error（红色 + XCircle）
- pending/done/error 合并为单一模板，动态 `:class` 切换，不重建 DOM
- CSS transition 0.35s 平滑变色
- 卡片插入 `items` 数组，`todo_done` 时原地替换（同一 `v-for` key）
- 移除入场动画重播，dots 始终存在于 DOM（done/error 时 `opacity: 0` 渐隐）
- 知识图谱查询（`lookup_knowledge_point`）纳入同一卡片管理

### 学科切换
- 手动（SubjectSwitcher 标签栏）+ 模型自适应（`switch_subject` tool）混合模式
- 模型切换保留现有对话；手动切换仍创建新会话
- `subject_changed` 从 `on_chat_model_end` 的完整 args 发送（流式分片不触发）
- `todo_done(switch)` 延迟 800ms，等 CSS transition 播完再结束 pending
- `await nextTick()` 分离 DOM 更新与 subject 变更，确保 transition 不被合并跳过

### 侧边栏
- 品牌区域（logo + 版本 + 收起按钮）始终显示，不再随 `currentView` 隐藏
- 恢复原始 `transition-[width]` + Tailwind `w-64`/`w-0` 方案
- `borderRadius`/`boxShadow` 改为 `:style` 绑定 + `transitionProperty` 精确控制
- 双层渐变文字：`brand-text-bg`（固定色）+ `brand-text-overlay`（随 subject 变化，opacity 交叉淡变）

### 递归修复
- 过滤 `agent` 循环中重复追加的 system message
- `plan_steps` 指令从静态 prompt 移到动态 `todoAppend`（仅 TODO 为空时显示）
- `recursionLimit` 提升至 50

### 年级适配
- 高中：科学学科不可选（仅语数英）
- 大学：隐藏学科切换器 + 隐藏学习模式按钮 + 隐藏知识画像页面
- 知识图谱 `grade` 从 `authStore` 读取，变更时自动刷新

### 其他修复
- 专项练习二级菜单改用 Teleport + `position: fixed` 避免 `overflow:hidden` 裁剪
- `overflow-x:auto` 隐式设置 `overflow-y:auto` 修复（加 `overflow-y:visible`）
- 专项练习在通用模式下展示所有学科类型
- 发送消息即时向下滚动（force 模式跳过 `nextTick`+`rAF`）
- `finalizeAssistants` 自动过滤无正文的空 assistant 消息
- 删除对话先确认再退 session
- 探索课创建后加载到 chatStore
- `reviewTools` 重复展开导致 tool name 冲突 400 修复
- TikZ 模板加 `\usepackage{amsmath}` 支持 `\text{}`
- `$` 定界符自动闭合 + 正则 `\$(.+?)\$\$` 修复跨边界吞 `$`

---

## v0.3.1

- 画像树过滤教材导航章节节点
- 底部安全区域适配

## v0.3.0 — 移动端全面适配 + 知识图谱全量覆盖

### 移动端
- 响应式布局全面适配
- 侧栏会员标签 + 年级选择两步按钮
- 移除 QA 页右上角 UserMenu

### 课程知识图谱（G1-G9 全学科）
- 数学 1-9 全年级、语文 1-9 全年级、英语 3-9 主干 + 小学补充
- 浙教版初中科学 7-9 全部入库
- 知识点权重体系（核心/重要/标准/了解/拓展）
- 知识点 → 主题/素养/布鲁姆分类/前置依赖语义映射
- 数据库驱动的 question taxonomy（`knowledgePointId` 直连图谱节点）

### 考试系统全面优化
- 4 阶段并发流水线（蓝图→出题→审核→完成）
- 总分约束全链路嵌入（蓝图→出题→审核三级校验）
- 学科特定审核规则（数理 TikZ 校验 + 语文英语阅读量审核）
- `response_format` 替代 `bindTools`/`tool_choice`
- 大题导航 + 同组小题同页展示
- 题号轨道固定窗口 + 居中滚动动画
- 题号三态着色（未答/当前/已答）
- 选择题多选支持 + TiKZ 预渲染
- 填空题 `\boxed` → `\underline` 渲染优化
- 竖式（xlop）除法渲染 + 审核
- 出题/判卷标题 `brand-text` 渐变动画
- 答案端限额 + 每日用量环

### 用户设置
- 独立路由 `/setup`，彻底解决弹窗 backdrop 问题
- 字体大小三档调节（sm/md/lg）
- 模型提供商切换（DeepSeek V4 Flash / Pro）
- 所有卡片迁移 `.clay-glass` 毛玻璃效果
- 设置页双色球背景透过毛玻璃显示

### 熟练度系统
- Elo 评分 + 遗忘感知不确定性
- 指数移动平均替代简单累进
- 自适应 alpha（进步加速/退步减速）
- 非线性星映射（半星粒度）
- 星级变化动画过渡
- 各模式不同权重（预习 0.5 / 复习 1.0 / 突破 1.5 / 考试 2.0）
- 数据丰富度加权（无数据显示 0 星激励练习）

### 错题本
- 完整 CRUD + OCR 分析 + 风格特征 + 知识点映射
- 多题识别 + 学科自检测
- 按答案匹配度过滤
- 对话模式错题自动归集
- 双栏布局 + 富文本渲染
- LLM 标题生成
- 手动录入表单按题型自适应

### 知识画像
- 课程大纲可视化（按教材单元/章节/知识点）
- 综合熟练度大五星显示
- 学习诊断报告
- 章节小测 + 卷册测试按钮
- 非传统教学节点分类过滤（纯噪声过滤）
- 探索课 prompt 库 + 结构化 TODO prompt

### 探索课
- 20+ 探索主题（数学文化/科学探究/语文思辨）
- 结构化 TODO prompt + 评分解析
- API 端点 + 前端二次确认弹窗

---

## v0.2.2

- 滚动条轨道透明，不破坏背景沉浸感
- 考试页隐藏侧栏品牌 logo + 题号导航无边
- 清除 package.json BOM + SidebarLayout TS 类型断言
- 模型显示名 DeepSeek V4 Flash / Pro，去 emoji
- 用户 profile 按 userId 隔离
- 蓝图总分 <5% 偏差时微调题型数量精确命中目标分
- 英语阅读 passage 与 stem 重复显示自动去重
- 字体大小三档调节 + 滚动条 `scrollbar-gutter: stable`

## v0.2.1

- 初中年级标签初七→初一
- OAuth 回调 `router.replace` 修复双重渲染
- `authChecked` 前不展示主界面
- ChatView 多余 Transition 修复
- 考试页学科切换联动主题色（`:data-subject` 驱动 CSS 变量）
- `.clay-glass` 毛玻璃卡片体系
- 用户设置改为独立路由 `/setup`

## v0.2.0 — 结构化教学模式 + 考试系统

### 结构化学习模式
- 复习巩固模式（`complete_review` 工具）
- 预习模式 + 薄弱点突破模式
- 专项练习菜单（6 种工作流）
- 学习周期感知 + 模式切换工具（用户二次确认）
- 复习+快速巩固深度融合
- 各模式不同熟练度权重

### Todo 状态机
- `advance_step` 工具驱动步骤推进
- `exit_session` 工具退出类课堂
- 隐藏未完成步骤内容，强制 LLM 调 `advance_step` 解锁
- 每步耗时统计 + `todo_step` SSE 事件
- 步骤日志改用累积文本匹配，防 token 拆分漏检
- 跑马灯边框特效（`session-beam`）+ Teleport 修复裁切

### 类课堂冷色氛围
- `.boen-session` class 绑定 + CSS 变量覆盖（冷色 paper/ink/line）
- 广谱 `* { transition }` 全覆盖（0.7s）
- 光斑 opacity 补过渡
- 冷色覆盖层硬编码，根治跳变

### 出题系统
- 4 题型并行出题（选择/填空/判断/简答）
- 固定题分制（选择 3 分/填空 3 分/判断 2 分/简答 8 分）
- LLM 简答题评分 + 审核维度
- 年级段试卷结构知识库
- 多考点 `;` 分隔拆分匹配

### System Prompt 重写
- 吸收 Hermes Edu Skills 教学思想
- 通用学习方法嵌入各学科指引
- 强调必须用出题工具（否则数据不入库）
- 用户消息前显示模式标记

### 考试系统（初版）
- AI 自动生成试卷 + 在线作答 + 自动批改
- 成绩圆环显示百分比 + 揭晓动画
- 熟练度变化追踪 + 结果页展示
- 考试历史回顾页 + 侧栏三分区

### 其他
- 错题本初版（CRUD + OCR）
- 语音输入
- 吉祥物移至输入框右上角
- DeepSeek 默认模型
- ICP 备案号

---

## v0.1.1

- 修复吉祥物与消息重叠
- 修复题干 `<br>` 标签处理
- 知识点/素养标签标准化
- TikZ 根据提示词生成几何示意图
- 答题卡公式编辑器 MathLive

## v0.1.0

- 初始版本
- QA 模式流式对话
- Frost ID OAuth 登录
- 基本出题工具（选择题/填空/判断/简答）
- TikZ 图形渲染
- 年级感知适配（小学/初中/本科）
- 课程知识库基础设施（LangGraph RAG 集成）
