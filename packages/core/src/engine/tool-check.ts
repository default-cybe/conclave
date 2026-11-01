/**
 * A cheap preflight before a subagent or a delegated session starts (GPT ideas
 * run wfr_0mvnmulncxbcgx31tlg, item idea-9): the agent profile's tool list and
 * read-only-ness against keywords in the brief, so a job that needs a shell
 * does not start on a read-only explorer and fail mid-run. Keywords only, and
 * only in a slot where the word tells the agent to act (the start of a
 * sentence or after "then/also/please", or a tool invocation like "git log"):
 * the check never blocks a brief it is unsure about.
 */
import type { AgentDef } from '../extensions/types';

/** Where a verb reads as an instruction: sentence start, after punctuation, or after a connector. */
const SLOT = String.raw`(?:^|[.!?\n;:]\s*|\b(?:then|also|please)\s+)`;

/** A capability a brief can ask for: the tools that give it, and the words that ask. */
const CAPABILITIES: Array<{ tools: string[]; toolWord: string; need: string; words: RegExp }> = [
  {
    tools: ['Bash'],
    toolWord: 'Bash',
    need: 'needs a shell',
    words: new RegExp(
      SLOT + String.raw`(run|execut\w*|invoke|launch|install|uninstall|build|compile|lint|typecheck|type-?check|commit|push|clone|deploy|restart|shell|terminal)\b` +
        String.raw`|\brun tests?\b` +
        String.raw`|\b(npm|yarn|pnpm|bun|cargo|pip|python3?|pytest|vitest|jest|mocha|git|docker|kubectl|systemctl)\s+\S+`,
      'i',
    ),
  },
  {
    tools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
    toolWord: 'file-editing',
    need: 'changes files',
    words: new RegExp(SLOT + String.raw`(edit|modify|patch|refactor|rename|rewrite|delete|implement|fix|change|write|update|add|create|remove|migrat\w+)\b`, 'i'),
  },
];

/** What the run itself takes away: a read-only Delegate job loses the file-editing tools; plan mode loses every non-read-only tool, Bash included (engine.ts toolsFor, permissions.ts). */
export type ToolLimits = 'read-only' | 'plan';

/**
 * The refusal for a brief this agent cannot do, or undefined when it (probably)
 * can. With a tools list (extensions/types.ts: undefined means all default
 * tools), a capability the brief asks for whose tool the list has none of is
 * refused; disallowedTools counts the same way when there is no list. limits
 * covers a run that loses tools whatever the list says: a read-only Delegate
 * job (no file editing) and plan mode (no shell either).
 */
export function missingTools(brief: string, def: Pick<AgentDef, 'name' | 'tools' | 'disallowedTools'>, limits?: ToolLimits): string | undefined {
  for (const cap of CAPABILITIES) {
    if (!cap.words.test(brief)) continue;
    const listed = cap.tools.some((t) => !def.disallowedTools?.includes(t) && (!def.tools?.length || def.tools.includes(t)));
    // the run itself can take the tool away even when the list names it (engine.ts toolsFor, permissions.ts)
    const runTakes = limits === 'plan' ? false : limits === 'read-only' ? !cap.tools.includes('Edit') : true;
    if (limits === 'plan' && listed) {
      // plan mode keeps the refusal about the run, not the agent: no agent has the tool in plan mode
      return `The brief ${cap.need}, but this session is in plan mode, which is read-only: the subagent would start without ${cap.toolWord === 'Bash' ? 'a shell' : 'file-editing tools'} and fail mid-run. Present a plan with ExitPlanMode first, or rewrite the brief as read-only research.`;
    }
    if (!listed || !runTakes) {
      const why = !listed
        ? def.tools?.length
          ? `the brief ${cap.need} and its tools (${def.tools.join(', ')}) have no ${cap.toolWord} tool`
          : `the brief ${cap.need} and ${cap.toolWord === 'Bash' ? 'Bash' : 'file editing'} is turned off for it`
        : `the brief ${cap.need}, and this run gets no ${cap.toolWord} tool`;
      return `Agent "${def.name}" cannot do this job: ${why}. Run it with an agent that has the tool, such as coder or general-purpose, or rewrite the brief as read-only research.`;
    }
  }
  return undefined;
}
