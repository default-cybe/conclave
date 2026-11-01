import type { Tool, ToolContext, ToolOutput } from './types';
import { applyEdit, type EditOutcome } from './edit-core';
import type { ReadMark } from './types';
import { detectLineEnding, extname, fail, fromLf, lineAt, notReadYet, numberLines, readMarkFor, readMarkOf, resolveAbsolute, splitLines, staleCheck, toLf, unifiedDiff, pathRule } from './util';

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const MAX_SNIPPET_LINES = 40;

const DESCRIPTION = `Replace exact text in a file.

- Read the file in this conversation first; if it changed since, the edit is refused and you need to Read it again.
- old_string must match the file exactly, including indentation and line breaks, and match one place only: add surrounding lines until it is unique, or set replace_all to change every match (for a rename). Copy it from the Read output without the line number and tab prefix.
- Keep old_string small, usually 2 to 4 lines around the change. old_string and new_string must differ.
- An empty old_string with the full contents as new_string creates a new file.
- For several changes, send the Edit calls together in one turn. For Jupyter notebooks use NotebookEdit.`;

/** Load a file for editing: LF content plus its original line ending. */
export async function loadForEdit(
  ctx: ToolContext,
  path: string,
): Promise<{ exists: false } | { exists: true; raw: string; content: string; eol: '\r\n' | '\n'; mtimeMs: number; unread?: true } | { error: string; stale?: boolean }> {
  const st = await ctx.machine.stat(path);
  if (!st) return { exists: false };
  if (st.type === 'dir') return { error: `${path} is a directory, not a file.` };
  const raw = await ctx.machine.readText(path);
  // never read, but Read would be allowed: the caller lets the edit through only on an exact match (exactUnread)
  const unread = !readMarkFor(ctx, path) && ctx.readAllowed?.(path) === true;
  const stale = unread ? undefined : staleCheck(ctx, path, st.mtimeMs, 'edit', raw);
  if (stale) return { error: stale, stale: true };
  const eol = detectLineEnding(raw);
  return { exists: true, raw, content: toLf(raw), eol, mtimeMs: st.mtimeMs, ...(unread ? { unread: true as const } : {}) };
}

/**
 * An edit of a file the agent never read with Read goes ahead only when old_string matched the file exactly,
 * with no fuzzy fallback: the agent saw that text some other way, usually a cat in Bash. Else the edit is refused as unread.
 */
export function exactUnread(outcome: EditOutcome): boolean {
  return outcome.ok && !outcome.note;
}

/** Write, refresh readState, and build the result shared by Edit and MultiEdit; the mark records what was written. */
export async function saveEdited(ctx: ToolContext, path: string, before: string, after: string, eol: '\r\n' | '\n'): Promise<{ diff: string; readMark?: ReadMark }> {
  const text = fromLf(after, eol);
  await ctx.machine.writeFile(path, text);
  const st = await ctx.machine.stat(path);
  if (st) ctx.readState.set(path, st.mtimeMs);
  return { diff: unifiedDiff(path, before, after), ...(st ? { readMark: readMarkOf(path, st.mtimeMs, text) } : {}) };
}

/** Numbered lines around [startLine, endLine] of LF content, capped in size. */
export function editedSnippet(content: string, startLine: number, endLine: number): string {
  const lines = splitLines(content);
  const from = Math.max(1, startLine - 4);
  let to = Math.min(lines.length, endLine + 4);
  let tail = '';
  if (to - from + 1 > MAX_SNIPPET_LINES) {
    to = from + MAX_SNIPPET_LINES - 1;
    tail = `\n   ... (${endLine + 4 - to} more changed lines not shown)`;
  }
  if (!lines.length) return '(file is now empty)';
  return numberLines(lines.slice(from - 1, to), from) + tail;
}

export const EditTool: Tool<EditInput> = {
  name: 'Edit',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to modify, absolute or relative to the working directory' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Text to put in its place (must differ from old_string)' },
      replace_all: { type: 'boolean', description: 'Replace every match of old_string (default false)', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  readOnly: false,
  editsFiles: true,
  ruleContent: (input, ctx) => pathRule(ctx, input.file_path),
  summarize: (input) => `Edit ${input.file_path}`,
  async run(input, ctx): Promise<ToolOutput> {
    const r = resolveAbsolute(ctx, input.file_path);
    if ('error' in r) return fail(r.error);
    const path = r.path;
    if (extname(path) === 'ipynb') return fail('This is a Jupyter notebook. Use NotebookEdit to change its cells.');

    const loaded = await loadForEdit(ctx, path);
    if ('error' in loaded) return fail(loaded.error, loaded.stale ? { writeRefused: true } : undefined);
    if (!loaded.exists) {
      if (input.old_string !== '') {
        return fail(`File does not exist: ${path}. To create it, use Write, or Edit with an empty old_string. Current working directory: ${ctx.cwd}.`);
      }
      await ctx.machine.writeFile(path, input.new_string);
      const st = await ctx.machine.stat(path);
      if (st) ctx.readState.set(path, st.mtimeMs);
      return {
        content: `Created ${path} (${splitLines(input.new_string).length} lines).`,
        meta: { path, diff: unifiedDiff(path, '', input.new_string), created: true, ...(st ? { readMark: readMarkOf(path, st.mtimeMs, input.new_string) } : {}) },
      };
    }

    const outcome = applyEdit(loaded.content, input, path);
    if (loaded.unread && !exactUnread(outcome)) return fail(notReadYet(path, 'edit'), { writeRefused: true });
    if (!outcome.ok) return fail(outcome.error);
    const { diff, readMark } = await saveEdited(ctx, path, loaded.content, outcome.content, loaded.eol);
    const startLine = lineAt(outcome.content, outcome.firstStart);
    const endLine = lineAt(outcome.content, Math.max(outcome.firstStart, outcome.firstEnd - 1));
    const head =
      outcome.count > 1
        ? `The file ${path} has been updated. Replaced all ${outcome.count} matches. First edited region:`
        : `The file ${path} has been updated. Edited region:`;
    const note = outcome.note ? `\nNote: ${outcome.note}` : '';
    return {
      content: `${head}${note}\n${editedSnippet(outcome.content, startLine, endLine)}`,
      meta: { path, diff, replacements: outcome.count, ...(readMark ? { readMark } : {}) },
    };
  },
};
