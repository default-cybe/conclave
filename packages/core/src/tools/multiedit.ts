import type { Tool, ToolOutput } from './types';
import { applyEdit, type EditSpec } from './edit-core';
import { editedSnippet, exactUnread, loadForEdit, saveEdited } from './edit';
import { chatRefusal, extname, fail, lineAt, notReadYet, readMarkOf, resolveAbsolute, splitLines, unifiedDiff, pathRule } from './util';

export interface MultiEditInput {
  file_path: string;
  edits: EditSpec[];
}

const DESCRIPTION = `Make several replacements in one file in a single atomic step. Prefer this over repeated Edit calls on the same file.

Usage:
- Same rules as Edit for every entry: Read the file first, old_string must match the file exactly (without Read's line-number prefixes), and must be unique unless replace_all is true.
- Edits run in order, each on the result of the previous one. Make sure an earlier edit does not change text a later edit needs to find.
- All or nothing: if any edit fails, none are written and the error says which one failed.
- To create a new file, make the first edit's old_string empty and put the full contents in its new_string.`;

export const MultiEditTool: Tool<MultiEditInput> = {
  name: 'MultiEdit',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to modify, absolute or relative to the working directory' },
      edits: {
        type: 'array',
        description: 'Replacements to apply in order',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact text to replace' },
            new_string: { type: 'string', description: 'Text to put in its place' },
            replace_all: { type: 'boolean', description: 'Replace every match (default false)', default: false },
          },
          required: ['old_string', 'new_string'],
          additionalProperties: false,
        },
      },
    },
    required: ['file_path', 'edits'],
    additionalProperties: false,
  },
  readOnly: false,
  editsFiles: true,
  ruleContent: (input, ctx) => pathRule(ctx, input.file_path),
  summarize: (input) => `Edit ${input.file_path} (${Array.isArray(input.edits) ? input.edits.length : 0} changes)`,
  async run(input, ctx): Promise<ToolOutput> {
    const r = resolveAbsolute(ctx, input.file_path);
    if ('error' in r) return fail(r.error);
    const path = r.path;
    const refusal = chatRefusal(ctx, path);
    if (refusal) return fail(refusal, { writeRefused: true });
    if (extname(path) === 'ipynb') return fail('This is a Jupyter notebook. Use NotebookEdit to change its cells.');
    if (!Array.isArray(input.edits) || input.edits.length === 0) return fail('edits must be a non-empty array of {old_string, new_string, replace_all?}.');

    const loaded = await loadForEdit(ctx, path);
    if ('error' in loaded) return fail(loaded.error, loaded.stale ? { writeRefused: true } : undefined);

    let content: string;
    let before: string;
    let eol: '\r\n' | '\n' = '\n';
    let startIdx = 0;
    if (!loaded.exists) {
      const first = input.edits[0];
      if (!first || first.old_string !== '') {
        return fail(`File does not exist: ${path}. To create it, make the first edit's old_string empty, or use Write.`);
      }
      content = first.new_string;
      before = '';
      startIdx = 1;
    } else {
      content = loaded.content;
      before = loaded.content;
      eol = loaded.eol;
    }

    const notes: string[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = startIdx; i < input.edits.length; i++) {
      const outcome = applyEdit(content, input.edits[i], path);
      if (loaded.exists && loaded.unread && !exactUnread(outcome)) return fail(notReadYet(path, 'edit'), { writeRefused: true });
      if (!outcome.ok) {
        return fail(`Edit ${i + 1} of ${input.edits.length} failed: ${outcome.error}\nNo changes were written.`);
      }
      content = outcome.content;
      ranges.push({ start: lineAt(content, outcome.firstStart), end: lineAt(content, Math.max(outcome.firstStart, outcome.firstEnd - 1)) });
      if (outcome.note) notes.push(`Edit ${i + 1}: ${outcome.note}`);
    }

    if (!loaded.exists) {
      await ctx.machine.writeFile(path, content);
      const st = await ctx.machine.stat(path);
      if (st) ctx.readState.set(path, st.mtimeMs);
      return {
        content: `Created ${path} (${splitLines(content).length} lines) with ${input.edits.length} edits applied.${notes.length ? `\nNotes:\n${notes.join('\n')}` : ''}`,
        meta: { path, diff: unifiedDiff(path, '', content), created: true, ...(st ? { readMark: readMarkOf(path, st.mtimeMs, content) } : {}) },
      };
    }

    const { diff, readMark } = await saveEdited(ctx, path, before, content, eol);
    // Line numbers of earlier edits can shift; show one window spanning the edited range.
    const lo = Math.min(...ranges.map((x) => x.start));
    const hi = Math.max(...ranges.map((x) => x.end));
    return {
      content: `Applied ${input.edits.length} edits to ${path}.${notes.length ? `\nNotes:\n${notes.join('\n')}` : ''}\n${editedSnippet(content, lo, hi)}`,
      meta: { path, diff, edits: input.edits.length, ...(readMark ? { readMark } : {}) },
    };
  },
};
