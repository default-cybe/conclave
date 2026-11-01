import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { PathMap, ReadMark, ToolContext, ToolOutput } from './types';
import { defuseFrameworkTags } from '../session/untrusted';
import { insideFolder } from '../files/share';

/** Error result the model can act on. */
export function fail(message: string, meta?: ToolOutput['meta']): ToolOutput {
  return { content: message, isError: true, meta };
}

export function ok(content: ToolOutput['content'], meta?: ToolOutput['meta']): ToolOutput {
  return { content, meta };
}

type PathCtx = Pick<ToolContext, 'machine' | 'cwd'> & { pathMap?: PathMap };

/**
 * A session that moved to another device or folder keeps its old paths in
 * earlier messages. An absolute path under an old root that is not on this
 * device maps to the same place under the new root
 * (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.7). The old root goes into
 * pathMap.hits, so the result can say so once.
 */
export function mapOldPath(ctx: { pathMap?: PathMap }, path: string): string {
  const roots = ctx.pathMap?.roots;
  if (!roots?.length) return path;
  for (const r of roots) {
    // a root of / (or empty) would map every path on the device
    if (!r.from || r.from === '/') continue;
    if (path !== r.from && !path.startsWith(r.from.endsWith('/') ? r.from : `${r.from}/`)) continue;
    ctx.pathMap!.hits.push(r.from);
    return r.to + path.slice(r.from.length);
  }
  return path;
}

/**
 * Resolve a required model-supplied path to an absolute one: absolute, "~",
 * or relative to the session folder (models slip less with short relative
 * paths, bench run 3). Returns an error string when it is missing.
 */
export function resolveAbsolute(ctx: PathCtx, p: unknown, param = 'file_path'): { path: string } | { error: string } {
  if (typeof p !== 'string' || !p.trim()) return { error: `${param} is required and must be a non-empty string.` };
  return { path: resolveLoose(ctx, p) };
}

/**
 * A chat's file tools reach only its outputs folder on the hub (files/share.ts):
 * a chat reads web pages, so a page must not steer it to the owner's files.
 * Returns the refusal, or undefined when the path may be used (or the session is not a chat).
 */
export function chatRefusal(ctx: Pick<ToolContext, 'session' | 'host'>, path: string): string | undefined {
  if (ctx.session?.kind !== 'chat') return undefined;
  const dir = ctx.host.outputsDir?.();
  if (!dir) return 'Refused: this chat has no outputs folder to keep files in.';
  return insideFolder(dir, path) ? undefined : `Refused: a chat reads and writes files only in its outputs folder (${dir}). Use a plain file name such as report.md.`;
}

/** What permission rules judge for a path parameter: the very path resolveAbsolute gives the tool. */
export function pathRule(ctx: PathCtx, p: unknown): string | undefined {
  const r = resolveAbsolute(ctx, p);
  return 'path' in r ? r.path : undefined;
}

/** Resolve an optional path relative to cwd (for search tools). */
export function resolveLoose(ctx: PathCtx, p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) return ctx.cwd;
  return mapOldPath(ctx, ctx.machine.resolve(p.trim(), ctx.cwd));
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  if (idx <= 0) return sep;
  return p.slice(0, idx);
}

/** Join using the separator the base path already uses. */
export function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** Show a path relative to cwd when it sits inside it. */
export function displayPath(p: string, cwd: string): string {
  if (cwd && p.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) return p.slice(cwd.length + (cwd.endsWith('/') ? 0 : 1));
  return p;
}

export const MAX_LINE_CHARS = 2000;

/** cat -n style: right-aligned line number, a tab, then the line. */
export function numberLines(lines: string[], firstLine: number, maxLineChars = MAX_LINE_CHARS): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > maxLineChars) line = `${line.slice(0, maxLineChars)}... [line truncated, ${line.length} chars total]`;
    out.push(`${String(firstLine + i).padStart(6)}\t${line}`);
  }
  return out.join('\n');
}

/** Split file text into display lines (without trailing \r). */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A numbered window of `content` around 1-based lines [from, to]. */
export function snippet(content: string, from: number, to: number, context = 4): string {
  const lines = splitLines(content);
  const start = Math.max(1, from - context);
  const end = Math.min(lines.length, to + context);
  return numberLines(lines.slice(start - 1, end), start);
}

/** 1-based line number of a character offset. */
export function lineAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(path, path, before, after, undefined, undefined, { context: 3 });
}

/** Count of added and removed lines in a unified diff. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  // lines the current hunk still holds, from its @@ counts: a removed "-- note" reads "--- note" but is no header
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    } else if (line.startsWith('+') && newLeft > 0) {
      added++;
      newLeft--;
    } else if (line.startsWith('-') && oldLeft > 0) {
      removed++;
      oldLeft--;
    } else if (line.startsWith(' ')) {
      oldLeft--;
      newLeft--;
    }
  }
  return { added, removed };
}

export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Mark fetched text as data, not instructions. Other framework tags in it are defused (session/untrusted.ts). */
export function wrapUntrusted(source: string, text: string): string {
  const safeSource = source.replace(/"/g, '%22');
  const body = defuseFrameworkTags(text.replace(/<\/untrusted_web_content>/gi, '</untrusted_web_content_>'));
  return `<untrusted_web_content source="${safeSource}">\n${body}\n</untrusted_web_content>`;
}

/** Files larger than this are marked by mtime only. */
export const HASH_MAX_CHARS = 4 * 1024 * 1024;

/** sha256 of a file's text as machine.readText returns it (UTF-8, BOM kept). */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The read mark a file tool's result carries: the path, its mtime and a hash of the text read or written. */
export function readMarkOf(path: string, mtimeMs: number, text?: string): ReadMark {
  return { path, mtimeMs, ...(text !== undefined && text.length <= HASH_MAX_CHARS ? { sha256: textHash(text) } : {}) };
}

/** The newest read mark for a path: from context when the runner gives one, else from readState. */
export function readMarkFor(ctx: Pick<ToolContext, 'readState' | 'readMark'>, path: string): ReadMark | undefined {
  const seen = ctx.readState.get(path);
  return ctx.readMark ? ctx.readMark(path) : seen !== undefined ? { path, mtimeMs: seen } : undefined;
}

export function notReadYet(path: string, verb: string): string {
  return `File has not been read yet. Use the Read tool on ${path} first, then ${verb} it. Output of cat in Bash does not count.`;
}

/**
 * Check that a file was read, and has not changed since, before changing
 * it. The read mark comes from the newest Read, Edit or Write result for the
 * path in context (ctx.readMark, HARNESS-REVIEW item 17), else from the
 * readState map. With the file's current text, a hash decides: an mtime that
 * moved without a change passes, and a change that kept the mtime does not.
 * Returns an error message, or undefined to go on.
 */
export function staleCheck(ctx: Pick<ToolContext, 'readState' | 'readMark'>, path: string, mtimeMs: number, verb: string, current?: string): string | undefined {
  const mark = readMarkFor(ctx, path);
  if (!mark) return notReadYet(path, verb);
  const modified = `File ${path} was modified after you last read it (by the user, a formatter, or another process). Read it again before you ${verb} it.`;
  if (mark.sha256 && current !== undefined && current.length <= HASH_MAX_CHARS) return textHash(current) === mark.sha256 ? undefined : modified;
  if (mtimeMs > mark.mtimeMs) return modified;
  return undefined;
}

/** Detect CRLF files so edits keep their line endings. */
export function detectLineEnding(text: string): '\r\n' | '\n' {
  const crlf = text.indexOf('\r\n');
  if (crlf === -1) return '\n';
  const lf = text.indexOf('\n');
  return lf === crlf + 1 ? '\r\n' : '\n';
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function fromLf(text: string, eol: '\r\n' | '\n'): string {
  return eol === '\n' ? text : text.replace(/\r?\n/g, '\r\n');
}

/** Combine the tool signal with a timeout. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

/** Middle-out truncation for command output. */
export function truncateMiddleOut(text: string, max: number): { text: string; truncated: boolean; dropped: number } {
  if (text.length <= max) return { text, truncated: false, dropped: 0 };
  const head = Math.floor(max / 2);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n... [${dropped} characters truncated] ...\n\n${text.slice(text.length - tail)}`,
    truncated: true,
    dropped,
  };
}

/**
 * Character budget for a tool result. The engine offloads results longer
 * than context.maxToolResultChars, so tools that page their own output stay
 * a little under it to avoid being cut twice.
 */
export function outputBudget(ctx: Pick<ToolContext, 'host'>, preferred: number): number {
  let limit: number | undefined;
  try {
    limit = ctx.host.config()?.context?.maxToolResultChars;
  } catch {
    limit = undefined;
  }
  if (!limit || limit <= 0) return preferred;
  return Math.max(4_000, Math.min(preferred, limit - 1_000));
}
