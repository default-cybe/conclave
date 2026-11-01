import type { GrepOptions } from '../machine/types';
import type { Tool } from './types';
import { fail, outputBudget, resolveLoose } from './util';

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-i'?: boolean;
  '-n'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  multiline?: boolean;
  head_limit?: number;
  offset?: number;
}

const DEFAULT_HEAD_LIMIT = 250;
const MAX_OUTPUT_CHARS = 60_000;

const DESCRIPTION = `Search file contents with ripgrep.

Usage:
- Always use Grep for content search. Do not run grep or rg through Bash; this tool handles permissions, ignores and output limits for you.
- pattern is a Rust regular expression (ripgrep syntax), e.g. "log.*Error" or "function\\s+\\w+". Escape literal braces and other metacharacters: use "interface\\{\\}" to find "interface{}".
- Filter files with glob (e.g. "*.js", "*.{ts,tsx}") or type (e.g. "js", "py", "rust"; faster than glob for standard languages).
- output_mode: "files_with_matches" (default for a directory) lists matching files, newest first; "content" shows matching lines; "count" shows match counts per file. When path is a single file, the default is "content".
- In content mode you can add context lines with -A (after), -B (before) or -C (both), and -n shows line numbers (on by default).
- -i makes the search case-insensitive.
- Patterns match within a single line by default. Set multiline to true for patterns that span lines (e.g. "struct \\{[\\s\\S]*?field").
- head_limit caps how many lines or files are returned (default ${DEFAULT_HEAD_LIMIT}; 0 means no limit, use sparingly). offset skips that many entries first, for paging.
- Files ignored by .gitignore are skipped; hidden files are searched.
- For open-ended searches that need several rounds of searching, consider the Task tool.`;

export const GrepTool: Tool<GrepInput> = {
  name: 'Grep',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the current working directory.' },
      glob: { type: 'string', description: 'Glob filter for file names, e.g. "*.ts" or "*.{ts,tsx}"' },
      type: { type: 'string', description: 'ripgrep file type, e.g. js, py, rust, go, java' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'content: matching lines (default when path is a file); files_with_matches: file paths (default for a directory); count: matches per file',
      },
      '-i': { type: 'boolean', description: 'Case-insensitive search' },
      '-n': { type: 'boolean', description: 'Show line numbers (content mode, default true)' },
      '-A': { type: 'number', description: 'Lines of context after each match (content mode)' },
      '-B': { type: 'number', description: 'Lines of context before each match (content mode)' },
      '-C': { type: 'number', description: 'Lines of context before and after each match (content mode)' },
      multiline: { type: 'boolean', description: 'Let patterns span lines; . also matches newlines' },
      head_limit: { type: 'number', description: `Return at most this many lines or files (default ${DEFAULT_HEAD_LIMIT}, 0 for no limit)` },
      offset: { type: 'number', description: 'Skip this many lines or files before applying head_limit' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input, ctx) => resolveLoose(ctx, input.path),
  summarize: (input) => `Grep "${input.pattern}"${input.path ? ` in ${input.path}` : ''}`,
  async run(input, ctx) {
    if (typeof input.pattern !== 'string' || !input.pattern) return fail('pattern is required.');
    const path = resolveLoose(ctx, input.path === 'undefined' || input.path === 'null' ? undefined : input.path);
    // listing the one file the caller already named says nothing, so show its lines
    const mode = input.output_mode ?? (input.path && (await ctx.machine.stat(path).then((s) => s?.type === 'file', () => false)) ? 'content' : 'files_with_matches');
    const context = input['-C'];
    const limit = input.head_limit === undefined ? DEFAULT_HEAD_LIMIT : Math.max(0, Math.floor(input.head_limit));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const opts: GrepOptions = {
      pattern: input.pattern,
      path,
      glob: input.glob || undefined,
      type: input.type || undefined,
      caseInsensitive: !!input['-i'],
      multiline: !!input.multiline,
      outputMode: mode === 'files_with_matches' ? 'files' : mode,
      before: mode === 'content' ? (input['-B'] ?? context) : undefined,
      after: mode === 'content' ? (input['-A'] ?? context) : undefined,
      lineNumbers: mode === 'content' ? input['-n'] !== false : undefined,
      limit: limit || undefined,
      offset,
    };
    let res;
    try {
      res = await ctx.machine.grep(opts);
    } catch (err) {
      return fail(`Grep failed: ${(err as Error).message}`);
    }
    if (!res.output.trim()) {
      if (res.total > 0 && offset >= res.total) return { content: `No results at offset ${offset}; there are only ${res.total}.` };
      return { content: mode === 'count' ? 'No matches found.' : mode === 'content' ? 'No matches found.' : 'No files found.' };
    }

    let body = res.output;
    let cut = false;
    const budget = outputBudget(ctx, MAX_OUTPUT_CHARS);
    if (body.length > budget) {
      body = body.slice(0, budget);
      body = body.slice(0, body.lastIndexOf('\n') > 0 ? body.lastIndexOf('\n') : body.length);
      cut = true;
    }
    const shown = body.split('\n').length;
    let header = '';
    if (mode === 'files_with_matches') header = `Found ${res.total} file${res.total === 1 ? '' : 's'}\n`;
    else if (mode === 'count') {
      let occurrences = 0;
      for (const line of res.output.split('\n')) {
        const m = line.match(/:(\d+)$/);
        if (m) occurrences += Number(m[1]);
      }
      header = `${occurrences} matches in ${res.total} file${res.total === 1 ? '' : 's'}${res.truncated ? ' (in the files shown)' : ''}\n`;
    }
    let footer = '';
    if (res.truncated || cut) {
      const next = offset + shown;
      footer = `\n(Showing ${offset + 1}-${next} of ${res.total}. Pass offset=${next} for more, or narrow the search.)`;
    } else if (offset) footer = `\n(Showing ${offset + 1}-${offset + shown} of ${res.total}.)`;
    return { content: header + body + footer, meta: { truncated: res.truncated || cut || undefined, total: res.total } };
  },
};
