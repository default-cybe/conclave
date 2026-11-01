import type { Tool } from './types';
import { shellRegistry } from './shells';
import { fail, outputBudget, truncateMiddleOut } from './util';

export interface BashOutputInput {
  bash_id: string;
  filter?: string;
}

const MAX_CHARS = 30_000;

const DESCRIPTION = `Read new output from a background shell started with Bash run_in_background.

Usage:
- Returns only output produced since your last BashOutput call for that shell, plus its status (running, completed, failed, killed) and exit code once it has finished.
- filter is an optional regular expression; only matching lines are shown. Lines that do not match are still marked as read.
- Shell ids look like "bash_3". Use KillShell to stop a shell.`;

export const BashOutputTool: Tool<BashOutputInput> = {
  name: 'BashOutput',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'Id of the background shell' },
      filter: { type: 'string', description: 'Optional regular expression; only matching lines are returned' },
    },
    required: ['bash_id'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `Read output of ${input.bash_id}`,
  async run(input, ctx) {
    const shell = shellRegistry.get(ctx.sessionId, input.bash_id);
    if (!shell) {
      const known = shellRegistry.list(ctx.sessionId).map((s) => `${s.id} (${s.status})`);
      return fail(`No background shell "${input.bash_id}" in this session.${known.length ? ` Known shells: ${known.join(', ')}.` : ' No background shells have been started.'}`);
    }
    let re: RegExp | undefined;
    if (input.filter) {
      try {
        re = new RegExp(input.filter);
      } catch (err) {
        return fail(`Invalid filter regex: ${(err as Error).message}`);
      }
    }
    // Let a just-finished process settle its status first.
    if (!shell.running) await shell.done;
    const out = shell.stdout.takeNew();
    const err = shell.stderr.takeNew();
    const pick = (text: string) => (re ? text.split('\n').filter((l) => re!.test(l)).join('\n') : text);
    const budget = outputBudget(ctx, MAX_CHARS);
    const stdout = truncateMiddleOut(pick(out.text).replace(/\s+$/, ''), Math.floor(budget * 0.7)).text;
    const stderr = truncateMiddleOut(pick(err.text).replace(/\s+$/, ''), Math.floor(budget * 0.25)).text;
    const info = shell.info;
    const parts = [`<status>${info.status}</status>`];
    if (!shell.running) parts.push(`<exit_code>${info.exitCode ?? 'signal'}</exit_code>`);
    if (out.dropped || err.dropped) parts.push(`<note>${out.dropped + err.dropped} characters of older output were dropped before this read.</note>`);
    parts.push(stdout ? `<stdout>\n${stdout}\n</stdout>` : '<stdout>(no new output)</stdout>');
    if (stderr) parts.push(`<stderr>\n${stderr}\n</stderr>`);
    parts.push(`<timestamp>${new Date().toISOString()}</timestamp>`);
    return { content: parts.join('\n'), meta: { shellId: info.id, status: info.status, exitCode: info.exitCode ?? undefined } };
  },
};
