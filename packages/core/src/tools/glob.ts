import type { Tool } from './types';
import { fail, resolveLoose } from './util';

export interface GlobInput {
  pattern: string;
  path?: string;
}

const MAX_RESULTS = 200;

const DESCRIPTION = `Find files by name pattern. Fast on any codebase size.

Usage:
- Supports glob patterns such as "**/*.ts", "src/**/*.{ts,tsx}" or "*.md". A pattern without a slash matches at any depth.
- Returns absolute file paths, most recently modified first, at most ${MAX_RESULTS}.
- Files ignored by .gitignore are skipped. Hidden files are included only when the pattern names them (e.g. ".github/**/*.yml").
- path is the directory to search in; leave it out to search the current working directory. Do not pass "undefined" or "null".
- Use Grep to search file contents. For open-ended searches that may take several rounds, consider the Task tool.
- Several Glob calls can run in parallel when you need different patterns.`;

export const GlobTool: Tool<GlobInput> = {
  name: 'Glob',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match files against' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the current working directory.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input, ctx) => resolveLoose(ctx, input.path),
  summarize: (input) => `Glob ${input.pattern}${input.path ? ` in ${input.path}` : ''}`,
  async run(input, ctx) {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) return fail('pattern is required.');
    const path = input.path === 'undefined' || input.path === 'null' ? undefined : input.path;
    const cwd = resolveLoose(ctx, path);
    let files: string[];
    try {
      files = await ctx.machine.glob(input.pattern, { cwd, limit: MAX_RESULTS + 1 });
    } catch (err) {
      return fail(`Glob failed: ${(err as Error).message}`);
    }
    if (!files.length) return { content: `No files found matching "${input.pattern}" in ${cwd}.` };
    const truncated = files.length > MAX_RESULTS;
    const shown = files.slice(0, MAX_RESULTS);
    let text = shown.join('\n');
    if (truncated) text += `\n(Results are truncated at ${MAX_RESULTS} files. Use a more specific pattern or path.)`;
    return { content: text, meta: { truncated: truncated || undefined, count: shown.length } };
  },
};
