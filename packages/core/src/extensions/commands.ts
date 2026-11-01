import type { Machine } from '../machine/types';
import type { CommandArgStyle, CommandDef } from './types';

const BASH_TIMEOUT_MS = 30_000;
const FILE_CAP_BYTES = 50_000;

export interface ExpandContext {
  machine: Machine;
  cwd: string;
  signal?: AbortSignal;
  /** Asked before each shell line runs; a returned reason refuses it (engine/commands.ts checks it like a Bash call). */
  permit: (command: string) => Promise<string | undefined>;
  /** Asked before an `@file` is inlined; true leaves the reference as written (a Read deny rule matches). */
  readDenied?: (absPath: string) => boolean;
}

/** Split a raw argument line into positional tokens, honoring simple quotes. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Expand a slash command body. Order: run `!`cmd`` snippets and inline `@file`
 * references against the template first (so arguments can never inject either),
 * then substitute the arguments last. Gemini CLI templates use `!{cmd}` and
 * `@{path}` instead and are handled the same way.
 */
export async function expandCommand(def: CommandDef, args: string, ctx: ExpandContext): Promise<string> {
  const style = def.argStyle ?? 'claude';
  // command output and file text wait as markers, so arguments fill only the template: a script's "$1" stays as written
  const held: string[] = [];
  const hold: Hold = (text) => `\u0000${held.push(text) - 1}\u0000`;
  const typed = args.replace(/\u0000/g, '');
  let body = def.body.replace(/\u0000/g, '');
  if (style === 'gemini') {
    body = await expandGeminiFiles(body, ctx, hold);
    body = await expandGeminiShell(body, typed, ctx, hold);
    body = substituteGeminiArgs(body, typed, def.name);
  } else {
    body = await expandBash(body, ctx, /!`([^`]+)`/g, hold);
    body = await expandFiles(body, ctx, hold);
    body = substituteArgsStyled(body, typed, style);
  }
  return body.replace(/\u0000(\d+)\u0000/g, (_, n: string) => held[Number(n)]);
}

type Hold = (text: string) => string;

async function expandBash(body: string, ctx: ExpandContext, re: RegExp, hold: Hold): Promise<string> {
  const matches = [...body.matchAll(re)];
  if (!matches.length) return body;
  const results = await Promise.all(
    matches.map(async (m) => {
      const cmd = m[1];
      try {
        const refused = await ctx.permit(cmd);
        if (refused) return `[command not run: ${refused}]`;
        const res = await ctx.machine.exec(cmd, { cwd: ctx.cwd, timeoutMs: BASH_TIMEOUT_MS, signal: ctx.signal });
        const text = (res.stdout || res.stderr || '').replace(/\n+$/, '');
        return res.timedOut ? `[command timed out: ${cmd}]` : text;
      } catch (err) {
        return `[command failed: ${(err as Error).message}]`;
      }
    }),
  );
  let i = 0;
  return body.replace(re, () => hold(results[i++]));
}

async function readCapped(rel: string, ctx: ExpandContext): Promise<string | undefined> {
  try {
    const abs = ctx.machine.resolve(rel, ctx.cwd);
    if (ctx.readDenied?.(abs)) return undefined;
    const text = await ctx.machine.readText(abs);
    return text.length > FILE_CAP_BYTES ? text.slice(0, FILE_CAP_BYTES) + '\n[... file truncated ...]' : text;
  } catch {
    return undefined;
  }
}

async function expandFiles(body: string, ctx: ExpandContext, hold: Hold): Promise<string> {
  // @path references: @ followed by a non-space path, not preceded by a word char or @.
  const re = /(^|[\s(])@([^\s)]+)/g;
  const matches = [...body.matchAll(re)];
  if (!matches.length) return body;
  const results = await Promise.all(
    matches.map(async (m) => {
      const rel = m[2];
      const text = await readCapped(rel, ctx);
      return text === undefined ? `${m[1]}@${rel}` : `${m[1]}${rel}:\n\n${hold(text)}`;
    }),
  );
  let i = 0;
  return body.replace(re, () => results[i++]);
}

async function expandGeminiFiles(body: string, ctx: ExpandContext, hold: Hold): Promise<string> {
  const re = /@\{([^}]+)\}/g;
  const matches = [...body.matchAll(re)];
  if (!matches.length) return body;
  const results = await Promise.all(
    matches.map(async (m) => {
      const text = await readCapped(m[1].trim(), ctx);
      return text === undefined ? m[0] : `${m[1].trim()}:\n\n${hold(text)}`;
    }),
  );
  let i = 0;
  return body.replace(re, () => results[i++]);
}

/**
 * Claude Code style (the default): $ARGUMENTS is the raw string, and
 * $ARGUMENTS[N] and $N are zero-based, so `/hello Alice Bob` gives $0=Alice and
 * $1=Bob. Verified against Claude Code 2.1.301.
 */
export function substituteArgs(body: string, args: string): string {
  return substituteArgsStyled(body, args, 'claude');
}

export function substituteArgsStyled(body: string, args: string, style: Exclude<CommandArgStyle, 'gemini'> | 'gemini'): string {
  const raw = args.trim();
  const tokens = splitArgs(args);
  if (style === 'gemini') return substituteGeminiArgs(body, args, '');
  if (style === 'claude') {
    let out = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, d) => tokens[Number(d)] ?? '');
    out = out.replace(/\$ARGUMENTS/g, raw);
    return out.replace(/\$(\d)(?!\d)/g, (_, d) => tokens[Number(d)] ?? '');
  }
  if (style === 'numbered') {
    // Codex custom prompts: $1..$9 one-based, $ARGUMENTS raw, $$ is a literal $.
    let out = body.replace(/\$\$/g, '\u0000');
    out = out.replace(/\$ARGUMENTS/g, raw);
    out = out.replace(/\$([1-9])/g, (_, d) => tokens[Number(d) - 1] ?? '');
    return out.replace(/\u0000/g, '$');
  }
  // opencode: one-based; the highest placeholder takes the rest; append args when there is no placeholder.
  const nums = [...body.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const hasArgs = body.includes('$ARGUMENTS');
  if (!nums.length && !hasArgs) return raw ? `${body}\n\n${raw}` : body;
  const last = nums.length ? Math.max(...nums) : 0;
  let out = body.replace(/\$(\d+)/g, (whole, d) => {
    const n = Number(d);
    if (n === 0) return whole;
    if (n === last) return tokens.slice(n - 1).join(' ');
    return tokens[n - 1] ?? '';
  });
  out = out.replace(/\$ARGUMENTS/g, raw);
  return out;
}

/** Find `!{...}` blocks with balanced braces (Gemini allows `{{args}}` inside). */
function geminiShellBlocks(body: string): Array<{ start: number; end: number; inner: string }> {
  const out: Array<{ start: number; end: number; inner: string }> = [];
  let i = 0;
  while ((i = body.indexOf('!{', i)) !== -1) {
    let depth = 1;
    let j = i + 2;
    for (; j < body.length && depth > 0; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') depth--;
    }
    if (depth !== 0) break;
    out.push({ start: i, end: j, inner: body.slice(i + 2, j - 1) });
    i = j;
  }
  return out;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run `!{cmd}` blocks. Inside them {{args}} is shell-quoted, as Gemini CLI does. */
async function expandGeminiShell(body: string, args: string, ctx: ExpandContext, hold: Hold): Promise<string> {
  const blocks = geminiShellBlocks(body);
  if (!blocks.length) return body;
  const results = await Promise.all(
    blocks.map(async (b) => {
      const cmd = b.inner.replace(/\{\{args\}\}/g, shellQuote(args.trim()));
      try {
        const refused = await ctx.permit(cmd);
        if (refused) return `[command not run: ${refused}]`;
        const res = await ctx.machine.exec(cmd, { cwd: ctx.cwd, timeoutMs: BASH_TIMEOUT_MS, signal: ctx.signal });
        const text = [res.stdout, res.stderr].filter(Boolean).join('\n').replace(/\n+$/, '');
        if (res.timedOut) return `[command timed out: ${cmd}]`;
        return res.exitCode ? `${text}\n[Shell command exited with code ${res.exitCode}]` : text;
      } catch (err) {
        return `[command failed: ${(err as Error).message}]`;
      }
    }),
  );
  let out = '';
  let pos = 0;
  blocks.forEach((b, k) => {
    out += body.slice(pos, b.start) + hold(results[k]);
    pos = b.end;
  });
  return out + body.slice(pos);
}

/** Gemini CLI: {{args}} is the raw string; with no {{args}} the whole typed command is appended after a blank line. */
function substituteGeminiArgs(body: string, args: string, name: string): string {
  const raw = args.trim();
  if (body.includes('{{args}}')) return body.replace(/\{\{args\}\}/g, raw);
  if (!raw) return body;
  return `${body}\n\n/${name} ${raw}`.trimEnd();
}
