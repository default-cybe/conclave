/** `conclave` / `conclave chat`: the interactive TUI. */
import type { PermissionMode, SessionMode } from '@conclave/core/types.ts';
import { bool, str, type ParsedArgs } from '../args';
import { runCommand } from './run';
import { CliError, getClient } from './shared';

export async function chatCommand(args: ParsedArgs, promptFrom: number): Promise<number> {
  const prompt = args._.slice(promptFrom).join(' ').trim() || undefined;
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Pipes and scripts get the headless runner.
    if (prompt || !process.stdin.isTTY) return runCommand(args, promptFrom);
    throw new CliError('The chat UI needs a terminal. Use `conclave run <prompt>` in scripts.');
  }
  const { client, target } = await getClient(args);
  const { startTui } = await import('../tui/main');
  return startTui({
    client,
    target,
    agent: str(args, 'agent'),
    model: str(args, 'model'),
    mode: str(args, 'mode') as SessionMode | undefined,
    permissionMode: str(args, 'permission-mode') as PermissionMode | undefined,
    device: str(args, 'device'),
    cwd: str(args, 'cwd'),
    resume: str(args, 'resume'),
    continueLast: bool(args, 'continue'),
    prompt,
  });
}
