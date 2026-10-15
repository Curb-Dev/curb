// JSON lines to stdout (Docker's log driver rotates them), one object per
// event: {t, level, msg, ...fields}. Every line goes through the redactor, so
// a secret that reached a message or a field by accident never reaches the
// log. bigints are written as decimal strings.

import { redact } from './secrets.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serialise(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return x.toString();
    if (x instanceof Error) return { name: x.name, message: x.message };
    if (x instanceof Map) return Object.fromEntries(x);
    if (x instanceof Uint8Array) return `<${x.length} bytes>`;
    return x;
  });
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function jsonLogger(opts: { level?: Level; write?: (line: string) => void; base?: Record<string, unknown>; now?: () => number } = {}): Logger {
  const min = ORDER[opts.level ?? ((process.env.CURB_SHARER_LOG_LEVEL as Level) || 'info')] ?? ORDER.info;
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? Date.now;
  const make = (base: Record<string, unknown>): Logger => {
    const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
      if (ORDER[level] < min) return;
      const obj = { t: new Date(now()).toISOString(), level, msg, ...base, ...(fields ?? {}) };
      write(redact(serialise(obj)));
    };
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (f) => make({ ...base, ...f }),
    };
  };
  return make(opts.base ?? {});
}

/** A logger that keeps its lines (tests). */
export function memoryLogger(): Logger & { lines: string[]; records(): any[] } {
  const lines: string[] = [];
  const l = jsonLogger({ level: 'debug', write: (x) => lines.push(x) });
  return Object.assign(l, { lines, records: () => lines.map((x) => JSON.parse(x)) });
}
