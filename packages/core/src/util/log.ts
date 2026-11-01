import { redactSecrets } from '../memory/secrets';
import { cleanFields } from '../logs/redact';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.CONCLAVE_LOG as Level) || 'info'] ?? 20;

/**
 * Where lines go besides the console. The hub's log files (logs/sink.ts)
 * install one; it gets every line, debug included, and decides itself what
 * to keep. `extra` is an Error, an object of fields, or anything else.
 */
export type LogTap = (level: Level, scope: string, msg: string, extra?: unknown) => void;
let tap: LogTap | undefined;

/** Install the tap (undefined removes it). Returns the one it replaced. */
export function setLogTap(next: LogTap | undefined): LogTap | undefined {
  const prev = tap;
  tap = next;
  return prev;
}

export function currentLogTap(): LogTap | undefined {
  return tap;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Fields as key=value for the console; strings with spaces are quoted. */
function kv(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const t = v instanceof Error ? v.message : v;
    const s = typeof t === 'string' ? (/[\s"]/.test(t) ? JSON.stringify(t) : t) : typeof t === 'object' && t !== null ? JSON.stringify(t) : String(t);
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

function out(level: Level, scope: string, msg: string, extra?: unknown) {
  if (tap) {
    try {
      tap(level, scope, msg, extra);
    } catch {
      /* the files must never break the caller */
    }
  }
  if (order[level] < min) return;
  // stdout (docker logs, journald) gets the same secrets filter as the files
  const line = redactSecrets(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`);
  const write = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) write(line);
  else if (isPlainObject(extra)) {
    const rest = kv(cleanFields(extra) as Record<string, unknown>);
    write(rest ? `${line} ${rest}` : line);
  } else if (extra instanceof Error) write(`${line}\n${redactSecrets(extra.stack ?? `${extra.name}: ${extra.message}`)}`);
  // anything else (a string, an array, a class instance) goes through the same filter, never as it came
  else write(`${line} ${consoleText(extra)}`);
}

/** A value that is not a plain object or an Error, as filtered text for the console. */
function consoleText(v: unknown): string {
  try {
    if (typeof v === 'string') return redactSecrets(v);
    return redactSecrets(JSON.stringify(cleanFields(v)) ?? String(v));
  } catch {
    return '[unprintable]';
  }
}

/** A line for the log files only, not the console: busy events such as tool calls. */
export function logEvent(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (!tap) return;
  try {
    tap(level, scope, msg, fields);
  } catch {
    /* the files must never break the caller */
  }
}

/**
 * A logger for one component. The second argument is an Error (its message
 * and, for errors, its stack go to the files) or an object of fields:
 * ids, counts, durations, statuses. Never message text, file contents, tool
 * input or output, tokens or keys.
 */
export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => out('debug', scope, m, e),
    info: (m: string, e?: unknown) => out('info', scope, m, e),
    warn: (m: string, e?: unknown) => out('warn', scope, m, e),
    error: (m: string, e?: unknown) => out('error', scope, m, e),
  };
}
