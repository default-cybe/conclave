import type { Tool, ToolOutput } from './types';
import { detectLineEnding, diffStats, fail, fromLf, readMarkOf, resolveAbsolute, splitLines, staleCheck, unifiedDiff, pathRule } from './util';

export interface WriteInput {
  file_path: string;
  content: string;
}

const DESCRIPTION = `Write a file, creating it or replacing everything in it.

Usage:
- file_path is absolute or relative to the working directory. Missing parent directories are created.
- If the file already exists you must Read it first in this conversation, and it must not have changed since; otherwise the write is refused.
- To change part of an existing file, use Edit instead. It sends only the changed text and is safer.
- Do not create documentation files (*.md, README) unless the user asked for them.
- Do not add emojis to files unless the user asks for them.`;

export const WriteTool: Tool<WriteInput> = {
  name: 'Write',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write, absolute or relative to the working directory' },
      content: { type: 'string', description: 'Full contents of the file' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  readOnly: false,
  editsFiles: true,
  ruleContent: (input, ctx) => pathRule(ctx, input.file_path),
  summarize: (input) => `Write ${input.file_path}`,
  async run(input, ctx): Promise<ToolOutput> {
    const r = resolveAbsolute(ctx, input.file_path);
    if ('error' in r) return fail(r.error);
    const path = r.path;
    if (typeof input.content !== 'string') return fail('content must be a string.');

    const st = await ctx.machine.stat(path);
    if (st?.type === 'dir') return fail(`${path} is a directory. Give a file path.`);
    let before = '';
    let content = input.content;
    if (st) {
      before = await ctx.machine.readText(path);
      const stale = staleCheck(ctx, path, st.mtimeMs, 'overwrite', before);
      if (stale) return fail(stale, { writeRefused: true });
      // Keep Windows line endings when the file already used them.
      if (detectLineEnding(before) === '\r\n' && !content.includes('\r\n')) content = fromLf(content, '\r\n');
    }

    await ctx.machine.writeFile(path, content);
    const after = await ctx.machine.stat(path);
    if (after) ctx.readState.set(path, after.mtimeMs);
    const mark = after ? { readMark: readMarkOf(path, after.mtimeMs, content) } : {};

    const diff = unifiedDiff(path, before.replace(/\r\n/g, '\n'), content.replace(/\r\n/g, '\n'));
    const lines = splitLines(content).length;
    if (!st) {
      return { content: `Created ${path} (${lines} lines).`, meta: { path, diff, created: true, ...mark } };
    }
    const { added, removed } = diffStats(diff);
    const summary = added || removed ? `+${added} -${removed} lines` : 'no changes';
    return { content: `Updated ${path} (${lines} lines, ${summary}).`, meta: { path, diff, ...mark } };
  },
};
