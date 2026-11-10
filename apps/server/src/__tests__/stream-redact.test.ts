/**
 * 流式脱敏的单元测试。
 *
 * 这是「安全逻辑 + 流式」的交叉点，两类 bug 都很隐蔽：
 * - 跨 chunk 的手机号漏过（安全漏洞）
 * - 正常文本被缓冲区吞掉或重复（体验问题）
 */
import { describe, it, expect } from 'vitest';
import { TokenRedactor } from '../stream-redact.js';

/** 把分片依次喂进去，收集所有下发内容 */
function feed(chunks: string[], tail?: number): string {
  const r = tail === undefined ? new TokenRedactor() : new TokenRedactor(tail);
  const out: string[] = [];
  for (const c of chunks) out.push(...r.push(c));
  out.push(...r.flush());
  return out.join('');
}

describe('TokenRedactor', () => {
  it('跨 chunk 的手机号也能被完整脱敏', () => {
    const got = feed(['请拨打 138', '1234', '5678 联系']);
    expect(got).not.toContain('13812345678');
    expect(got).toContain('联系方式已隐藏');
  });

  it('整段到达的手机号同样被脱敏', () => {
    const got = feed(['我的号码是13900001111']);
    expect(got).not.toContain('13900001111');
  });

  it('正常讲解内容逐字保留，不丢不重', () => {
    const chunks = ['分数除法的', '法则是：除以', '一个分数，', '等于乘它的倒数。'];
    const got = feed(chunks);
    expect(got).toBe(chunks.join(''));
  });

  it('空输入不产生空片段', () => {
    const r = new TokenRedactor();
    expect(r.push('')).toEqual([]);
    expect(r.flush()).toEqual([]);
  });

  it('flush 后缓冲区清空，重复 flush 不再下发', () => {
    const r = new TokenRedactor();
    r.push('尾巴内容');
    expect(r.flush().join('')).toBe('尾巴内容');
    expect(r.flush()).toEqual([]);
  });

  it('长文本会分多次下发，总长度与原文一致（无敏感串时）', () => {
    const text = '这是一段用于验证分片行为的中文讲解文本，'.repeat(6);
    const r = new TokenRedactor(12);
    const out: string[] = [];
    for (const ch of text) out.push(...r.push(ch));
    out.push(...r.flush());
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('')).toBe(text);
  });
});
