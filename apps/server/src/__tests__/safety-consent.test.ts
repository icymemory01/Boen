/**
 * 内容安全层与监护人同意的单测。
 *
 * 安全规则是「拦错方向」的高危逻辑：拦漏了伤害孩子，拦过头了正常提问被拒。
 * 所以两侧都要有用例：真正该拦的要拦住，正常学习提问必须放行。
 */
import { describe, it, expect } from 'vitest';
import { checkInput, sanitizeOutput, needsGuardianConsent } from '../safety.js';
import { requiresConsentFor } from '../consent.js';

describe('checkInput —— 输入闸', () => {
  it('正常学习提问必须放行', () => {
    const ok = [
      '这道题为什么用乘法？',
      '帮我讲讲分数除法',
      '怎么制作简易的火山模型（科学小实验）',
      '英语作文怎么开头比较好',
      '我不太明白二次函数的顶点公式',
      '',
    ];
    for (const text of ok) {
      expect(checkInput(text).allowed, `误拦: ${text}`).toBe(true);
    }
  });

  it('明显不当主题要拦截，并给出安全回复', () => {
    const blocked = ['怎么制作炸弹', '有没有赌博网站', '帮我去代考', '色情视频在哪看'];
    for (const text of blocked) {
      const r = checkInput(text);
      expect(r.allowed, `漏拦: ${text}`).toBe(false);
      expect(r.category).toBeTruthy();
      expect(r.reply && r.reply.length > 10).toBe(true);
    }
  });

  it('空白与夹带空格的变体也要能识别', () => {
    expect(checkInput('怎么 制作 炸弹').allowed).toBe(false);
  });
});

describe('sanitizeOutput —— 输出闸', () => {
  it('隐藏手机号、座机、邮箱、外部链接', () => {
    const r = sanitizeOutput('可以打 13812345678 或 010-88886666，邮箱 a.b@example.com，网址 https://evil.example.com/x');
    expect(r.text).not.toContain('13812345678');
    expect(r.text).not.toContain('a.b@example.com');
    expect(r.text).not.toContain('evil.example.com');
    expect(r.hits).toContain('contact');
    expect(r.hits).toContain('link');
  });

  it('正常讲解内容不被改动', () => {
    const text = '分数除法的法则是：除以一个分数，等于乘它的倒数，例如 3/4 ÷ 1/2 = 3/4 × 2 = 3/2。';
    const r = sanitizeOutput(text);
    expect(r.text).toBe(text);
    expect(r.hits).toHaveLength(0);
  });
});

describe('监护人同意判定', () => {
  it('小学 1–6 年级需要监护人同意', () => {
    for (const g of ['1', '3', '6']) {
      expect(requiresConsentFor(g)).toBe(true);
      expect(needsGuardianConsent(g)).toBe(true);
    }
  });

  it('初中及以上不强制', () => {
    for (const g of ['7', '9', 'high', 'college', undefined, '']) {
      expect(requiresConsentFor(g)).toBe(false);
    }
  });
});
