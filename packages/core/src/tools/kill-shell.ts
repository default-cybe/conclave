import type { Tool } from './types';
import { shellRegistry } from './shells';
import { fail } from './util';

export interface KillShellInput {
  shell_id: string;
}

export const KillShellTool: Tool<KillShellInput> = {
  name: 'KillShell',
  description: `Stop a background shell started with Bash run_in_background, along with any processes it started. Takes the shell id (e.g. "bash_2").`,
  inputSchema: {
    type: 'object',
    properties: {
      shell_id: { type: 'string', description: 'Id of the background shell to stop' },
    },
    required: ['shell_id'],
    additionalProperties: false,
  },
  // Only touches processes this session started itself.
  readOnly: true,
  summarize: (input) => `Kill ${input.shell_id}`,
  async run(input, ctx) {
    const shell = shellRegistry.get(ctx.sessionId, input.shell_id);
    if (!shell) {
      const known = shellRegistry.list(ctx.sessionId).map((s) => `${s.id} (${s.status})`);
      return fail(`No background shell "${input.shell_id}" in this session.${known.length ? ` Known shells: ${known.join(', ')}.` : ''}`);
    }
    if (!shell.running) {
      return { content: `Shell ${shell.info.id} already ${shell.info.status} (exit code ${shell.info.exitCode ?? 'n/a'}).`, meta: { shellId: shell.info.id } };
    }
    await shell.kill();
    return { content: `Killed shell ${shell.info.id} (${shell.info.command.slice(0, 120)}).`, meta: { shellId: shell.info.id } };
  },
};
