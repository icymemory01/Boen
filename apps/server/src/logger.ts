/**
 * logger.ts —— 结构化日志（JSON 一行一条）
 *
 * 原来的日志是 `console.log('xxx', err)`，线上只能靠 pm2 文本翻找，
 * 既不能按字段过滤，也做不了统计。这里统一成 JSON lines：
 * 直接 `pm2 logs` 可读，接 Loki / ELK / CloudWatch 也能直接按 level、event 筛。
 *
 * 约定：
 * - `event` 是稳定的机器可读标识（如 'chat.done'、'game.finish'），日志检索全靠它
 * - 只放可枚举的标量，不塞整段学生原文（隐私）
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as LogLevel[]).includes(raw as LogLevel)
    ? (raw as LogLevel)
    : 'info';
}

function emit(level: LogLevel, event: string, fields: LogFields = {}, error?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  if (error !== undefined) {
    payload.error = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack) payload.stack = error.stack.split('\n').slice(0, 4).join(' | ');
  }
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields, error?: unknown) => emit('warn', event, fields, error),
  error: (event: string, fields?: LogFields, error?: unknown) => emit('error', event, fields, error),
};
