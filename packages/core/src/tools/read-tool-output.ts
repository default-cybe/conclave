import type { Tool } from './types';
import { fail, numberLines, outputBudget, splitLines } from './util';
import { retrieve } from './compress';

export interface ReadToolOutputInput {
  id: string;
  offset?: number;
  limit?: number;
  grep?: string;
  query?: string;
}

const DEFAULT_LIMIT = 400;
const MAX_CHARS = 60_000;

const DESCRIPTION = `Page through a large tool output that was cut short in an earlier result.

Usage:
- When a result says it was truncated and gives an output id, pass that id here.
- offset is the 1-based line to start at; limit is how many lines to return (default ${DEFAULT_LIMIT}).
- grep is an optional regular expression: only matching lines are returned, with their line numbers. Use it to find the relevant part of a long log quickly.
- query is optional words to search for (for example "TypeError cart total"): the best matching blocks of lines come back in file order, ranked like a search engine. Use it when you do not know the exact text for grep.`;

export const ReadToolOutputTool: Tool<ReadToolOutputInput> = {
  name: 'ReadToolOutput',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Output id from a truncated tool result' },
      offset: { type: 'integer', description: '1-based line to start at', minimum: 1 },
      limit: { type: 'integer', description: `Number of lines (default ${DEFAULT_LIMIT})`, minimum: 1 },
      grep: { type: 'string', description: 'Regular expression; return only matching lines' },
      query: { type: 'string', description: 'Words to search for; return the best matching blocks' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `Read output ${input.id}${input.grep ? ` matching ${input.grep}` : input.query ? ` for "${input.query}"` : ''}`,
  async run(input, ctx) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('id is required.');
    const text = ctx.host.readOutput(id);
    if (text === undefined) return fail(`No stored output with id "${id}". It may have expired; run the original tool again.`);
    const lines = splitLines(text);
    const budget = outputBudget(ctx, MAX_CHARS);
    const offset = Math.max(1, Math.floor(input.offset ?? 1));
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));

    if (input.query?.trim()) {
      const blocks = retrieve(lines, input.query);
      if (blocks.length) {
        const parts: string[] = [];
        let end = 0;
        for (const b of blocks) {
          if (end && b.start > end + 1) parts.push('[... non-adjacent ...]');
          parts.push(numberLines(b.lines, b.start));
          end = b.start + b.lines.length - 1;
        }
        let body = parts.join('\n');
        if (body.length > budget) body = body.slice(0, budget) + '\n[... cut, use a narrower query ...]';
        return { content: `${blocks.length} blocks of output ${id} (${lines.length} lines) match "${input.query.trim()}", in file order:\n${body}` };
      }
      // nothing matched: the start of the output, as a plain read gives it
      const slice = lines.slice(0, limit);
      let body = numberLines(slice, 1);
      if (body.length > budget) body = body.slice(0, budget) + '\n[... cut, use offset and limit ...]';
      return { content: `No block of output ${id} matches "${input.query.trim()}". Its first lines:\n${body}${slice.length < lines.length ? `\n(Lines 1-${slice.length} of ${lines.length}.)` : ''}` };
    }

    if (input.grep) {
      let re: RegExp;
      try {
        re = new RegExp(input.grep);
      } catch (err) {
        return fail(`Invalid grep regex: ${(err as Error).message}`);
      }
      const hits: string[] = [];
      let total = 0;
      for (let i = offset - 1; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        if (hits.length < limit) hits.push(numberLines([lines[i]], i + 1));
      }
      if (!total) return { content: `No lines match /${input.grep}/ in output ${id} (${lines.length} lines).` };
      let body = hits.join('\n');
      if (body.length > budget) body = body.slice(0, budget) + '\n[... cut, use offset or a narrower grep ...]';
      return { content: `${total} matching lines in output ${id}${total > hits.length ? ` (showing ${hits.length})` : ''}:\n${body}` };
    }

    if (offset > lines.length) return { content: `Output ${id} has ${lines.length} lines; offset ${offset} is past the end.` };
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let body = numberLines(slice, offset);
    if (body.length > budget) body = body.slice(0, budget) + '\n[... cut, use a smaller limit ...]';
    const last = offset + slice.length - 1;
    const more = last < lines.length ? `\n(Lines ${offset}-${last} of ${lines.length}. Continue with offset=${last + 1}.)` : `\n(End of output, ${lines.length} lines.)`;
    return { content: body + more };
  },
};
