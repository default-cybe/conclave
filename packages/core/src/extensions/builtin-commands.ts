/**
 * The built-in "/" commands the hub runs itself (engine/commands.ts
 * runCommand), as a list a client can show. GET /api/commands?builtins=1
 * puts them first, so a client without its own copy (Android) lists and
 * routes them; the web and the TUI keep their own lists with their sheets.
 * No imports: the web may read INIT_PROMPT from here.
 */
import type { CommandDef } from './types';

/** One built-in: `chat` is true when it also fits a chat (no tools). */
type Builtin = { name: string; description: string; argumentHint?: string; chat?: boolean };

const LIST: Builtin[] = [
  { name: 'clear', description: 'Clear the conversation and start fresh', chat: true },
  { name: 'compact', description: 'Summarize older messages to free context', argumentHint: '[instructions]', chat: true },
  { name: 'cost', description: 'Tokens and cost of this session', chat: true },
  { name: 'cwd', description: 'Change the working folder', argumentHint: '<path>' },
  { name: 'debate', description: 'Let two models argue it out', argumentHint: '[a] [b] [rounds]' },
  { name: 'device', description: 'Run tools on another device', argumentHint: '[device]' },
  { name: 'export', description: 'Share this session as Markdown', chat: true },
  { name: 'fork', description: 'Fork this session', chat: true },
  { name: 'handoff', description: 'Switch this session to another model', argumentHint: '<provider/model> [brief]', chat: true },
  { name: 'init', description: 'Write an AGENTS.md that explains this project' },
  { name: 'jury', description: 'Ask a jury of models', argumentHint: '[models]' },
  { name: 'mode', description: 'Agent, chat, plan, jury, debate or loop', argumentHint: '[mode]', chat: true },
  { name: 'model', description: 'Show or set the model', argumentHint: '[provider/model]', chat: true },
  { name: 'move', description: 'Copy this folder to the hub and run there', argumentHint: 'hub --copy' },
  { name: 'review', description: 'Second opinion on the last reply', argumentHint: '[model]' },
];

/** The built-ins as command rows (source builtin, no body), in name order. */
export function builtinCommands(): Array<CommandDef & { chat?: boolean }> {
  return LIST.map((b) => ({ name: b.name, description: b.description, ...(b.argumentHint ? { argumentHint: b.argumentHint } : {}), ...(b.chat ? { chat: true } : {}), body: '', source: 'builtin' as const }));
}

/** The prompt /init sends: Claude Code's /init, for AGENTS.md (Conclave, Codex and OpenCode read it; Claude Code reads CLAUDE.md). */
export const INIT_PROMPT = `Look through this project and write an AGENTS.md at its root for coding agents that work here later. Keep it short and factual:

- what the project is, in two sentences
- how to install, build, run and test it (the exact commands)
- the layout: the main folders and what lives in each
- conventions the code follows that are not obvious from one file
- anything that breaks easily

If an AGENTS.md or CLAUDE.md is already there, improve it instead of starting over. Do not invent commands; run them to check.`;
