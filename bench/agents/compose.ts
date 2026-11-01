// Print the system prompt Conclave sends for a built-in agent: BASE.md, the
// environment block, the mode note, the role, and a two-line owner profile.
// usage: bun bench/agents/compose.ts <agent-name> <cwd> [git]
import { BUILTIN_AGENTS } from '../../packages/core/src/extensions/builtin-agents';
import { buildSystemPrompt } from '../../packages/core/src/session/prompt';
import type { Session } from '../../packages/core/src/types';

const [name, cwd, git] = process.argv.slice(2);
const agent = BUILTIN_AGENTS.find((a) => a.name === name);
if (!agent || !cwd) {
  console.error('usage: compose.ts <agent-name> <cwd> [git]');
  process.exit(2);
}
const mode = agent.mode ?? 'agent';
// a workflow step gets the step note, as workflows/agents.ts sets meta.workflow
const meta = name === 'workflow' ? { workflow: { runId: 'bench', seq: 1, label: 'bench' } } : {};
const session = { id: 'bench', cwd, agent: name, mode, meta } as unknown as Session;
const toolNames = agent.tools ?? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'];
const blocks = buildSystemPrompt({
  session, agent, mode, toolNames,
  modelRef: 'anthropic/claude-sonnet-5-5',
  platform: 'linux', hostname: 'arch-desktop', isGitRepo: git === 'git', deviceName: 'arch-desktop',
  projectInstructions: [],
  profile: [
    { content: 'The owner is a security student who runs a Proxmox homelab (hub host madx, LXC containers), an Arch desktop and a MacBook.' },
    { content: 'Prefers short, direct answers with one recommended method, plain words and no em dashes.' },
  ] as never,
  skills: [], subagents: [], date: '2026-10-18',
});
process.stdout.write(blocks.map((b) => b.text).join('\n\n') + '\n');
