/**
 * stream-redact.ts —— SSE 输出流的实时脱敏
 *
 * 问题：`sanitizeOutput()` 是整段匹配，但流式输出是逐 token 下发的，
 * 一个手机号会被切成 `138` `1234` `5678` 三段，任何一段单独看都合法，
 * 于是「输出脱敏」在最需要它的场景里失效。
 *
 * 做法：发送前留一个固定长度的尾巴（tail）不立即发出，等后续内容到达再一起匹配。
 * 这样跨 chunk 的敏感串一定能在缓冲区内被完整看到，代价是首字延迟 tail 个字符。
 */
import { sanitizeOutput } from './safety.js';

export class TokenRedactor {
  private buffer = '';

  /**
   * @param tail 保留在缓冲区、暂不下发的字符数。应大于最长待匹配串
   *             （手机号 11 位 + 少量缓冲，取 24 足够）。
   */
  constructor(private readonly tail = 24) {}

  /** 放入一段增量文本，返回可以立即下发的部分（可能为空） */
  push(text: string): string[] {
    if (!text) return [];
    this.buffer += text;
    if (this.buffer.length <= this.tail) return [];
    const cut = this.buffer.length - this.tail;
    const head = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    const clean = sanitizeOutput(head).text;
    return clean ? [clean] : [];
  }

  /** 流结束时把缓冲冲干净 */
  flush(): string[] {
    if (!this.buffer) return [];
    const clean = sanitizeOutput(this.buffer).text;
    this.buffer = '';
    return clean ? [clean] : [];
  }

  /** 当前缓冲区内容（仅用于测试与调试） */
  peek(): string {
    return this.buffer;
  }
}
