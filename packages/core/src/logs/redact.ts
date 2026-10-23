/**
 * The backstop every log line passes before it is written or exported: the
 * secrets filter from memory/secrets.ts on every string, fields whose names
 * say secret dropped, fields whose names say content (text, prompt, input,
 * output...) dropped, and sizes capped. What to log is decided where the
 * line is made; this catches what slips through.
 */
import { redactSecrets } from '../memory/secrets';

/** A field with this name holds a secret when its value is a string. */
const SECRET_NAME = /^(token|secret|password|passwd|passphrase|pass|pwd|api[_-]?key|apikey|authorization|auth|cookie|set-cookie|credentials?|private[_-]?key|access[_-]?key|client[_-]?secret|bearer|signature|sig|pairing[_-]?code)$|(token|secret|password|passphrase|apikey|api_key|privatekey|credential)$/i;
/** A field with this name holds content (a chat, a file, a tool's input or output). */
const CONTENT_NAME = /^(text|content|contents|prompt|body|input|output|stdout|stderr|diff|messages?|transcript|args|arguments|params|data|result|reply|answer|summary|preview|query|q)$/i;

export const MAX_STRING = 1000;
export const MAX_STACK = 4000;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ITEMS = 20;

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}... [${s.length - max} more chars]` : s;
}

/** One string, secrets replaced and cut to max. */
export function cleanString(s: string, max = MAX_STRING): string {
  return redactSecrets(cap(s, max * 2)).slice(0, max + 40);
}

/**
 * A copy of a fields object that is safe to write: secrets and content out,
 * strings filtered and capped, depth and width limited. `message` and
 * `error` stay (they are error messages), `stack` keeps more room.
 */
export function cleanFields(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return cleanString(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (v instanceof Error) return errorFields(v, false);
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ITEMS).map((x) => cleanFields(x, depth + 1));
    if (v.length > MAX_ITEMS) out.push(`[${v.length - MAX_ITEMS} more]`);
    return out;
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) {
        out['[more]'] = true;
        break;
      }
      if (val === undefined) continue;
      if (SECRET_NAME.test(k) && typeof val === 'string') {
        out[k] = '[redacted]';
        continue;
      }
      if (CONTENT_NAME.test(k) && (typeof val === 'string' || typeof val === 'object') && val !== null) {
        out[k] = '[omitted]';
        continue;
      }
      if (k === 'stack' && typeof val === 'string') {
        out[k] = cleanString(val, MAX_STACK);
        continue;
      }
      out[k] = cleanFields(val, depth + 1);
    }
    return out;
  }
  return cleanString(String(v));
}

/** An error as fields: its message, code and (with stack) where it came from. */
export function errorFields(err: unknown, stack: boolean): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const status = (err as { status?: unknown }).status;
    return {
      error: cleanString(err.message || err.name),
      ...(err.name && err.name !== 'Error' ? { errorName: err.name } : {}),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      ...(typeof status === 'number' ? { status } : {}),
      ...(stack && err.stack ? { stack: cleanString(err.stack, MAX_STACK) } : {}),
    };
  }
  return { error: cleanString(typeof err === 'string' ? err : safeJson(err)) };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * A parsed line from a file, filtered again (export): every string through
 * the secrets filter, secret and content fields out. Keeps the line's shape.
 */
export function recleanLine(line: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(line)) {
    if (k === 'fields' || k === 'client') out[k] = cleanFields(v);
    else if (typeof v === 'string') out[k] = k === 'msg' ? cleanString(v) : redactSecrets(v);
    else out[k] = v;
  }
  return out;
}
