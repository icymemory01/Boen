#!/usr/bin/env node
/**
 * build-game-bank.mjs —— 离线批量生成「知识跑酷」题库
 *
 * 背景：跑酷小游戏的服务端兜底题库每学科/学段只有 6 道题，一局就会重复。
 * 本脚本在**离线**阶段用 DeepSeek 基于 curriculum 教材数据批量生成四选一单选题，
 * 写成 apps/server/curriculum/game-bank/<subject>-g<grade>.json；
 * 服务端启动时再加载这些 JSON 扩充题库（加载逻辑不在这里实现）。
 *
 * 用法（纯 Node ESM，零新增依赖，只用内置 fetch —— 需 Node 18+）：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/build-game-bank.mjs
 *   node scripts/build-game-bank.mjs --subject=math --grade=3 --limit=20
 *   node scripts/build-game-bank.mjs --dry-run          # 只统计知识点，不调模型、不写文件
 *
 * 参数：
 *   --subject=<math|chinese|english|science>  只处理指定学科（可逗号分隔）
 *   --grade=<1..9>                            只处理指定年级（可逗号分隔）
 *   --limit=<n>                               每个 subject/grade **目标题目总数**，默认 20
 *   --dry-run                                 只统计并打印，不调模型、不写任何文件
 *   --help                                    打印帮助
 *
 * 设计要点：
 *   - 幂等：--limit 是「目标总数」而不是「本次新增数」，已有文件按 stem 去重合并，
 *     重复执行只会补齐缺口，不会让题库无限膨胀；已达标的分组直接跳过。
 *   - 单请求失败重试 2 次（指数退避 1s / 2s）；某个分组整体失败不中断其它分组。
 *   - 校验规则与服务端 apps/server/src/game-core.ts 的 parseLLMQuestion 保持一致，
 *     不合格的条目直接丢弃并计入统计，绝不补占位符、绝不把无效答案猜成 A。
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRICULUM_DIR = path.join(ROOT, 'apps', 'server', 'curriculum');
const BANK_DIR = path.join(CURRICULUM_DIR, 'game-bank');

/* ── 模型与接口配置 ─────────────────────────────────────────── */

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2; // 失败后重试 2 次，退避 1s / 2s
const RETRY_BASE_DELAY_MS = 1000;

/* ── 业务常量（与服务端 game-core.ts 对齐） ─────────────────── */

const DEFAULT_LIMIT = 20;
/** 跑酷固定 4 条跑道 → 题目必须 4 选 1（对应 game-core.ts 的 LANE_COUNT） */
const LANE_COUNT = 4;
/** 题干最短长度（对应 game-core.ts：stem.trim().length < 2 丢弃） */
const MIN_STEM_LENGTH = 2;
/** 题干 / 解析落盘时的截断长度，与 game-core.ts 保持一致 */
const MAX_STEM_LENGTH = 200;
const MAX_EXPLAIN_LENGTH = 160;
/** 单次请求提示词里最多列出多少个知识点，避免上下文过长 */
const MAX_POINTS_IN_PROMPT = 80;

const SUBJECT_ORDER = ['chinese', 'math', 'english', 'science'];
const SUBJECT_LABEL = { chinese: '语文', math: '数学', english: '英语', science: '科学' };

/**
 * 年级 → 中文标签。
 * 注意：这里是 game-core.ts 中 GRADE_LABEL 的副本 —— .mjs 脚本无法 import .ts，
 * 两边改动时请同步。
 */
const GRADE_LABEL = {
  1: '小学一年级',
  2: '小学二年级',
  3: '小学三年级',
  4: '小学四年级',
  5: '小学五年级',
  6: '小学六年级',
  7: '初中一年级',
  8: '初中二年级',
  9: '初中三年级',
};

/**
 * 哪些 kind 的节点算「一节课」。
 * ⚠️ 任务描述里写的是 kind === 'lesson'，但实测 curriculum 数据里：
 *   - 语文/数学：children 用 kind: 'lesson'
 *   - 英语：children 用 kind: 'section'（Unit 下的 Part A/B/C）
 *   - 科学：children 用 kind: 'section'（章下的第 N 节）
 * 若只收 'lesson'，英语和科学会只剩「本章复习与测试」这种标题，几乎出不了题，
 * 因此这里把 'section' 也当作课级知识点一起收集。
 */
const LESSON_KINDS = new Set(['lesson', 'section']);

/* ══════════════════════════════════════════════════════════════
 * 参数解析
 * ══════════════════════════════════════════════════════════════ */

const HELP = `离线题库生成脚本（知识跑酷）

用法:
  node scripts/build-game-bank.mjs [选项]

选项:
  --subject=<学科>   只处理指定学科，可逗号分隔；取值 chinese/math/english/science
  --grade=<年级>     只处理指定年级，可逗号分隔；取值 1-9
  --limit=<n>        每个 subject/grade 的目标题目总数（默认 ${DEFAULT_LIMIT}）
  --dry-run          只统计知识点数量并打印，不调模型、不写文件
  --help             显示本帮助

环境变量:
  DEEPSEEK_API_KEY   调用 DeepSeek 的 API key（--dry-run 时可缺省）

示例:
  node scripts/build-game-bank.mjs --dry-run
  DEEPSEEK_API_KEY=sk-xxx node scripts/build-game-bank.mjs --subject=math --grade=3 --limit=20
`;

/** 把 "a,b" / "a" 拆成去重后的字符串数组 */
function splitList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const opts = { subjects: null, grades: null, limit: DEFAULT_LIMIT, dryRun: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--dryRun') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    const match = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`无法识别的参数：${arg}（用 --help 查看用法）`);
    const [, key, inline] = match;
    // 兼容 `--grade=3` 与 `--grade 3` 两种写法
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`参数 --${key} 缺少取值（用 --help 查看用法）`);
      }
      value = next;
      i += 1; // 跳过被消费的取值
    }
    if (key === 'subject') {
      const list = splitList(value);
      if (!list.length) throw new Error('--subject 不能为空');
      opts.subjects = list;
    } else if (key === 'grade') {
      const list = splitList(value);
      if (!list.length) throw new Error('--grade 不能为空');
      opts.grades = list;
    } else if (key === 'limit') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit 必须是正整数，收到：${value}`);
      opts.limit = n;
    } else throw new Error(`无法识别的参数：--${key}（用 --help 查看用法）`);
  }

  return opts;
}

/* ══════════════════════════════════════════════════════════════
 * 读取 curriculum，收集知识点
 * ══════════════════════════════════════════════════════════════ */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 把 knowledgePoints 元素（可能是字符串，也可能是 {title, description}）压成一行文本 */
function knowledgePointText(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const desc = typeof item.description === 'string' ? item.description.trim() : '';
    if (title && desc) return `${title}：${desc}`;
    return title || desc;
  }
  return '';
}

/**
 * 递归收集「知识点」：lesson/section 标题 + knowledgePoints。
 *
 * 课级标题会带上祖先路径（面包屑），因为实际数据里英语的叶子标题就是
 * 「Part A」「Part B」「Part C Project」这种通用词 —— 不带父级 Unit 标题的话，
 * 跨单元去重后只剩 2-3 个知识点，模型根本不知道要考什么。
 * chapter/unit 自身不作为知识点（太粗），只作为面包屑前缀。
 */
function collectKnowledgePoints(units) {
  const points = [];
  const seen = new Set();

  const push = (text) => {
    const t = String(text ?? '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    points.push(t);
  };

  const walk = (nodes, trail) => {
    for (const node of asArray(nodes)) {
      if (!node || typeof node !== 'object') continue;
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      // 节点自带的 knowledgePoints（math 等学科的显式知识点）
      for (const kp of asArray(node.knowledgePoints)) push(knowledgePointText(kp));
      // 课级节点：把「祖先标题 · … · 本节标题」整体作为知识点
      if (LESSON_KINDS.has(node.kind) && title) {
        push([...trail, title].join(' · '));
      }
      // children 可能多层嵌套，防御性递归
      if (node.children) {
        walk(node.children, title ? [...trail, title] : trail);
      }
    }
  };

  walk(units, []);
  return points;
}

/** 科目排序权重：先按预设学科序，未知学科排后面 */
function subjectRank(subject) {
  const i = SUBJECT_ORDER.indexOf(subject);
  return i < 0 ? SUBJECT_ORDER.length : i;
}

function gradeLabel(grade) {
  return GRADE_LABEL[grade] ?? `${grade} 年级`;
}

/**
 * 扫描 curriculum 目录，按 subject+grade 归组。
 * @returns {Promise<Map<string, {subject:string, grade:string, points:string[], books:string[]}>>}
 */
async function loadCurriculumGroups(opts) {
  const entries = (await readdir(CURRICULUM_DIR)).filter((f) => f.toLowerCase().endsWith('.json'));
  const groups = new Map();

  const subjectFilter = opts.subjects ? new Set(opts.subjects) : null;
  const gradeFilter = opts.grades ? new Set(opts.grades) : null;

  for (const file of entries) {
    const full = path.join(CURRICULUM_DIR, file);
    let data;
    try {
      data = JSON.parse(await readFile(full, 'utf8'));
    } catch (error) {
      console.warn(`⚠️  跳过无法解析的教材文件 ${file}：${error.message}`);
      continue;
    }

    const subject = typeof data.subject === 'string' ? data.subject.trim() : '';
    const grade = typeof data.grade === 'string' || typeof data.grade === 'number'
      ? String(data.grade).trim()
      : '';
    if (!subject || !grade) {
      console.warn(`⚠️  跳过缺少 subject/grade 的教材文件 ${file}`);
      continue;
    }
    if (subjectFilter && !subjectFilter.has(subject)) continue;
    if (gradeFilter && !gradeFilter.has(grade)) continue;

    const key = `${subject}|${grade}`;
    if (!groups.has(key)) groups.set(key, { subject, grade, points: [], books: [] });
    const group = groups.get(key);

    // 同一 subject/grade 有上册/下册多个文件，知识点合并去重
    for (const p of collectKnowledgePoints(data.units)) {
      if (!group.points.includes(p)) group.points.push(p);
    }
    // 顶层 knowledgePoints（math 等学科目前为空数组，仍防御性收集）
    for (const kp of asArray(data.knowledgePoints)) {
      const text = knowledgePointText(kp);
      if (text && !group.points.includes(text)) group.points.push(text);
    }

    const publisher = typeof data.publisher === 'string' ? data.publisher : '';
    const volume = typeof data.volume === 'string' ? data.volume : '';
    const book = `${publisher}${volume}`.trim();
    if (book && !group.books.includes(book)) group.books.push(book);
  }

  return new Map(
    [...groups.entries()].sort(([, a], [, b]) => (
      subjectRank(a.subject) - subjectRank(b.subject) || Number(a.grade) - Number(b.grade)
    )),
  );
}

/* ══════════════════════════════════════════════════════════════
 * 题库文件读写
 * ══════════════════════════════════════════════════════════════ */

function bankPath(subject, grade) {
  return path.join(BANK_DIR, `${subject}-g${grade}.json`);
}

/** 题干去重键：压掉首尾与内部多余空白，避免「同题不同空格」重复入库 */
function stemKey(stem) {
  return String(stem ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * 读取已存在的题库；文件不存在返回空数组。
 * 文件损坏或没有 items 数组时抛错 —— 宁可让这个分组失败，
 * 也不要用空数组把已有题目覆盖没了。
 */
async function readExistingItems(subject, grade) {
  const file = bankPath(subject, grade);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`已有题库 JSON 解析失败，未覆盖：${file}（${error.message}）`);
  }
  if (!Array.isArray(data?.items)) {
    throw new Error(`已有题库缺少 items 数组，未覆盖：${file}`);
  }
  return data.items;
}

async function writeBank(subject, grade, items) {
  await mkdir(BANK_DIR, { recursive: true });
  const payload = { subject, grade, items };
  await writeFile(bankPath(subject, grade), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/* ══════════════════════════════════════════════════════════════
 * 调模型
 * ══════════════════════════════════════════════════════════════ */

const SYSTEM_PROMPT = [
  '你是一位资深的中小学命题老师，擅长把教材知识点改写成干净、无歧义的四选一单选题。',
  '',
  '输出格式（必须严格遵守）：',
  '- 只输出一个**纯 JSON 数组**，第一个字符是 [，最后一个字符是 ]。',
  '- 不要输出任何解释性文字，不要使用 Markdown 代码围栏（```）。',
  '- 数组每一项都是这样的对象：',
  '  {"stem": "题干", "options": ["选项A", "选项B", "选项C", "选项D"], "correctIndex": 0, "explain": "一句话解析"}',
  '',
  '硬性要求：',
  '1. options 必须恰好 4 个字符串，且四个选项互不相同；禁止「以上都对」「以上都不对」「A 和 B」这类模糊选项。',
  '2. 有且只有一个选项正确；correctIndex 是正确选项在 options 中的下标，只能是 0、1、2、3 的整数。',
  '3. stem 是能独立作答的完整题干（不是填空占位符），不要出现「下列哪项」而后面没有选项内容的情况。',
  '4. explain 用一句话说明正确答案的依据，60 字以内。',
  '5. 题目必须直接对应给定的知识点，难度贴合指定年级，不得超纲；计算题的数字要能口算或笔算验证，答案必须正确。',
].join('\n');

function buildUserPrompt(group, count) {
  const label = SUBJECT_LABEL[group.subject] ?? group.subject;
  const books = group.books.length ? group.books.join('、') : '通用教材';
  const points = group.points.slice(0, MAX_POINTS_IN_PROMPT)
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  return [
    `学科：${label}（${group.subject}）`,
    `年级：${gradeLabel(group.grade)}（第 ${group.grade} 年级）`,
    `教材：${books}`,
    '',
    '本学段已梳理出的知识点：',
    points,
    '',
    `请围绕上面这些知识点出 ${count} 道四选一单选题，尽量覆盖不同知识点，不要重复同一个知识点。`,
    `只输出长度为 ${count} 的 JSON 数组，不要输出其它内容。`,
  ].join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 单次请求：返回模型原始文本。
 * 失败重试 MAX_RETRIES 次，退避 1s / 2s；2xx 之外与网络错误都算失败。
 */
async function requestCompletion(apiKey, body) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1); // 1s → 2s
      console.warn(`   请求失败（${lastError?.message ?? '未知错误'}），${delay / 1000}s 后第 ${attempt} 次重试…`);
      await sleep(delay);
    }
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText} ${text.slice(0, 200)}`.trim());
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('模型返回内容为空');
      }
      return content;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`重试 ${MAX_RETRIES} 次后仍失败：${lastError?.message ?? '未知错误'}`);
}

/* ══════════════════════════════════════════════════════════════
 * 解析与严格校验（复刻 game-core.ts 的规则）
 * ══════════════════════════════════════════════════════════════ */

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 从模型输出中尽力抠出题目数组：容忍代码围栏、前后废话、{items:[...]} 包裹 */
function extractQuestionArray(content) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const body = (fenced ? fenced[1] : content).trim();

  const direct = tryParseJson(body);
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === 'object') {
    for (const key of ['items', 'questions', 'data', 'list', 'result']) {
      if (Array.isArray(direct[key])) return direct[key];
    }
  }

  // 去掉模型可能加的前后缀：先试 [ ... ]，再试 { ... }
  const arrayStart = body.indexOf('[');
  const arrayEnd = body.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const arr = tryParseJson(body.slice(arrayStart, arrayEnd + 1));
    if (Array.isArray(arr)) return arr;
  }
  const objStart = body.indexOf('{');
  const objEnd = body.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    const obj = tryParseJson(body.slice(objStart, objEnd + 1));
    if (obj && typeof obj === 'object') {
      for (const key of ['items', 'questions', 'data', 'list', 'result']) {
        if (Array.isArray(obj[key])) return obj[key];
      }
    }
  }
  return null;
}

/** 选项文本抽取：兼容字符串与 {text|label|content|value} 对象（同 game-core.ts） */
function optionText(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    for (const key of ['text', 'label', 'content', 'value']) {
      if (typeof item[key] === 'string') return item[key].trim();
    }
  }
  return '';
}

/**
 * 严格校验单条题目。不合格返回 null（由调用方丢弃并计数）。
 *
 * 规则与服务端 parseLLMQuestion 一致：
 *   - 题干 trim 后非空且长度 ≥ 2
 *   - options 恰好 4 个、每项文本非空、去重后仍是 4 个
 *   - correctIndex 是 0-3 的整数
 * 不合格时**不补占位符、不猜答案**。
 */
function validateQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const stem = typeof raw.stem === 'string' ? raw.stem.trim() : '';
  if (stem.length < MIN_STEM_LENGTH) return null;

  if (!Array.isArray(raw.options) || raw.options.length !== LANE_COUNT) return null;

  const options = raw.options.map(optionText);
  if (options.some((text) => !text)) return null; // 有空选项
  if (new Set(options).size !== LANE_COUNT) return null; // 去重后不足 4 个

  const { correctIndex } = raw;
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= LANE_COUNT) return null;

  const explain = typeof raw.explain === 'string' ? raw.explain.trim() : '';

  return {
    stem: stem.slice(0, MAX_STEM_LENGTH),
    options,
    correctIndex,
    explain: explain.slice(0, MAX_EXPLAIN_LENGTH),
  };
}

/* ══════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════ */

function groupTag(group) {
  return `${group.subject}-g${group.grade}`;
}

/**
 * 校验 --subject / --grade 过滤值是否真的存在，避免手误静默跑空。
 * 过滤后为空时会重新读一遍**不过滤**的分组，报出真实的可用组合。
 */
async function assertFiltersExist(opts, groups) {
  if (opts.subjects) {
    const unknown = opts.subjects.filter((s) => !SUBJECT_ORDER.includes(s));
    if (unknown.length) {
      throw new Error(`未知学科：${unknown.join(', ')}（可选 ${SUBJECT_ORDER.join('/')}）`);
    }
  }

  if (groups.size) return;

  const all = await loadCurriculumGroups({ ...opts, subjects: null, grades: null });
  if (!all.size) {
    throw new Error(`教材目录为空或无法解析：${path.relative(ROOT, CURRICULUM_DIR)}`);
  }
  const subjects = [...new Set([...all.keys()].map((k) => k.split('|')[0]))];
  const combos = [...new Set([...all.keys()].map((k) => k.replace('|', '-g')))].join('、');
  throw new Error(
    `没有匹配的教材文件。可用学科：${subjects.join(', ')}；可用分组：${combos}。请检查 --subject / --grade。`,
  );
}

async function runDryRun(groups, limit) {
  console.log('🔍 dry-run：只统计知识点，不调模型、不写文件\n');
  let totalPoints = 0;
  let totalExisting = 0;

  for (const group of groups.values()) {
    let existing = 0;
    try {
      existing = (await readExistingItems(group.subject, group.grade)).length;
    } catch (error) {
      console.warn(`⚠️  ${groupTag(group)} 已有题库读取失败：${error.message}`);
    }
    totalPoints += group.points.length;
    totalExisting += existing;
    const need = Math.max(0, limit - existing);
    console.log(
      `${groupTag(group)} | ${SUBJECT_LABEL[group.subject] ?? group.subject}${gradeLabel(group.grade)}`
      + ` | 知识点 ${String(group.points.length).padStart(3)} 个`
      + ` | 教材 ${group.books.length} 册`
      + ` | 已有 ${String(existing).padStart(3)} 题`
      + ` | 需补 ${String(need).padStart(3)} 题`,
    );
  }

  console.log(
    `\n汇总：${groups.size} 个 subject/grade，知识点合计 ${totalPoints} 个，`
    + `已有题库合计 ${totalExisting} 题，目标上限每组的 --limit=${limit}。`,
  );
  console.log('dry-run 结束：未调用模型，未写入任何文件。');
}

/**
 * 处理单个分组：读旧题 → 计算缺口 → 调模型 → 校验 → 合并去重 → 落盘。
 * @returns {{generated:number, discarded:number, total:number, skipped:boolean}}
 */
async function processGroup(group, { apiKey, limit }) {
  const existing = await readExistingItems(group.subject, group.grade);
  const knownStems = new Set(existing.map((item) => stemKey(item?.stem)));
  const needed = limit - existing.length;

  if (needed <= 0) {
    console.log(`${groupTag(group)} | 生成 0 题 / 丢弃 0 题 / 落盘总数 ${existing.length}（已达 --limit=${limit}，跳过）`);
    return { generated: 0, discarded: 0, total: existing.length, skipped: true };
  }
  if (!group.points.length) {
    console.log(`${groupTag(group)} | 生成 0 题 / 丢弃 0 题 / 落盘总数 ${existing.length}（无知识点，跳过）`);
    return { generated: 0, discarded: 0, total: existing.length, skipped: true };
  }

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(group, needed) },
    ],
    temperature: 0.7,
    stream: false,
  };

  const content = await requestCompletion(apiKey, body);
  const rawItems = extractQuestionArray(content);

  let generated = 0;
  let discarded = 0;
  const fresh = [];

  if (!rawItems) {
    console.warn(`   ${groupTag(group)} 模型输出不含可解析的 JSON 数组，本组丢弃`);
  } else {
    for (const raw of rawItems) {
      const question = validateQuestion(raw);
      if (!question) {
        discarded += 1;
        continue;
      }
      const key = stemKey(question.stem);
      if (knownStems.has(key)) {
        // 与已有题库（或本批前面）题干重复：合并去重，不算丢弃也不算新增
        continue;
      }
      knownStems.add(key);
      fresh.push(question);
      generated += 1;
    }
  }

  const merged = [...existing, ...fresh];
  if (fresh.length) await writeBank(group.subject, group.grade, merged);

  console.log(`${groupTag(group)} | 生成 ${generated} 题 / 丢弃 ${discarded} 题 / 落盘总数 ${merged.length}`);
  return { generated, discarded, total: merged.length, skipped: false };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    return 1;
  }

  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  if (!opts.dryRun) {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      console.error('❌ 缺少环境变量 DEEPSEEK_API_KEY，无法调用 DeepSeek。');
      console.error('   请先设置，例如：');
      console.error('     PowerShell: $env:DEEPSEEK_API_KEY="sk-xxxx"; node scripts/build-game-bank.mjs');
      console.error('     bash/zsh:   DEEPSEEK_API_KEY=sk-xxxx node scripts/build-game-bank.mjs');
      console.error('   只想看知识点统计可以加 --dry-run（无需 API key）。');
      return 1;
    }
    opts.apiKey = apiKey;
  }

  let groups;
  try {
    groups = await loadCurriculumGroups(opts);
    await assertFiltersExist(opts, groups);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    return 1;
  }

  if (opts.dryRun) {
    await runDryRun(groups, opts.limit);
    return 0;
  }

  console.log(
    `🚀 开始生成题库：${groups.size} 个 subject/grade 分组，每组目标总数 --limit=${opts.limit}，模型 ${MODEL}\n`,
  );

  let totalGenerated = 0;
  let totalDiscarded = 0;
  let totalItems = 0;
  const failures = [];

  for (const group of groups.values()) {
    try {
      const result = await processGroup(group, opts);
      totalGenerated += result.generated;
      totalDiscarded += result.discarded;
      totalItems += result.total;
    } catch (error) {
      // 单个分组失败不影响其它分组
      failures.push({ tag: groupTag(group), message: error.message });
      console.error(`${groupTag(group)} | ❌ 失败：${error.message}`);
    }
  }

  console.log('\n──── 汇总 ────');
  console.log(`分组：${groups.size} 个（成功 ${groups.size - failures.length} / 失败 ${failures.length}）`);
  console.log(`本次生成：${totalGenerated} 题`);
  console.log(`校验丢弃：${totalDiscarded} 题`);
  console.log(`落盘题目合计（含已有）：${totalItems} 题`);
  if (totalItems) console.log(`题库目录：${path.relative(ROOT, BANK_DIR)}`);
  if (failures.length) {
    console.log('\n失败分组：');
    for (const f of failures) console.log(`  - ${f.tag}：${f.message}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`❌ 脚本异常退出：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
