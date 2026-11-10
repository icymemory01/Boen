/**
 * safety.ts —— 面向未成年人的内容安全层（纯函数，可单测）
 *
 * 两道闸：
 * 1. **输入闸**：学生发来的内容若含明显不当/成人向主题，直接拦下，不进模型、不烧 token；
 * 2. **输出闸**：模型输出再做一次规则清洗（联系方式、外部链接、自伤相关表述），
 *    命中时替换为温和提示，而不是把原文透传给孩子。
 *
 * 说明：规则法只是第一层，覆盖不了语义级违规；真正的兜底应再加一层审核模型
 * （见 docs 里的后续计划）。这里刻意做成纯函数，方便在网关、SSE 流、离线评测里复用。
 */

export type SafetyVerdict = {
  /** 是否放行 */
  allowed: boolean;
  /** 命中的规则类别（便于统计与调参，不含学生原文） */
  category?: string;
  /** 面向学生的替换文案 */
  reply?: string;
};

/** 明显不适合 K12 场景的主题词（可在不改代码的前提下扩充） */
const BLOCKED_INPUT = [
  { category: 'adult', words: ['色情', '黄色视频', '裸聊', '约炮', '成人小说'] },
  { category: 'violence', words: ['怎么制作炸弹', '自制枪支', '投毒', '杀人方法', '自残方法', '自杀方法'] },
  { category: 'gambling', words: ['赌博网站', '网络赌博', '博彩平台', '代下注'] },
  { category: 'cheating', words: ['代考', '替考', '作弊器', '考试答案买卖'] },
];

/** 输出里不宜直接给到孩子的内容形态 */
const OUTPUT_RULES: Array<{ category: string; pattern: RegExp; replace: string }> = [
  // 手机号 / 座机
  { category: 'contact', pattern: /1[3-9]\d{9}/g, replace: '（联系方式已隐藏）' },
  { category: 'contact', pattern: /0\d{2,3}-?\d{7,8}/g, replace: '（联系方式已隐藏）' },
  // 邮箱
  { category: 'contact', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g, replace: '（邮箱已隐藏）' },
  // 站外链接（避免把学生引到未经审核的站点）
  { category: 'link', pattern: /https?:\/\/[^\s，。；）)]+/g, replace: '（外部链接已移除）' },
];

/** 输入闸：命中即拦截 */
export function checkInput(text: string): SafetyVerdict {
  if (!text) return { allowed: true };
  const normalized = text.replace(/\s+/g, '');
  for (const group of BLOCKED_INPUT) {
    for (const word of group.words) {
      if (normalized.includes(word)) {
        return {
          allowed: false,
          category: group.category,
          reply: '这个话题我不能聊哦。如果你有学习上的问题，或者遇到了让你不安的事情，请告诉身边信任的大人，也可以直接问我功课上的问题。',
        };
      }
    }
  }
  return { allowed: true };
}

/** 输出闸：清洗而非拦截，保证正常讲解不受影响 */
export function sanitizeOutput(text: string): { text: string; hits: string[] } {
  if (!text) return { text, hits: [] };
  let out = text;
  const hits: string[] = [];
  for (const rule of OUTPUT_RULES) {
    if (rule.pattern.test(out)) {
      hits.push(rule.category);
      out = out.replace(rule.pattern, rule.replace);
    }
    rule.pattern.lastIndex = 0;
  }
  return { text: out, hits: [...new Set(hits)] };
}

/** 判断某个年级是否属于「不满 14 周岁」区间（小学 1–6 年级按未满 14 岁处理） */
export function needsGuardianConsent(grade?: string): boolean {
  const n = Number(grade);
  if (!Number.isFinite(n)) return false;
  return n >= 1 && n <= 6;
}
