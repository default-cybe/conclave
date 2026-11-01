import type { MemoryKind, MemoryScope } from '../types';
import { containsSecret } from '../memory/secrets';
import { asFact, orderIn } from '../memory/facts';
import type { Tool, ToolContext } from './types';
import { fail } from './util';

const KINDS: MemoryKind[] = ['profile', 'fact', 'episode', 'procedure'];
const SCOPES: MemoryScope[] = ['global', 'project', 'agent'];

function scopeKeyFor(scope: MemoryScope, ctx: ToolContext): string | undefined {
  if (scope === 'project') return ctx.cwd;
  if (scope === 'agent') return ctx.agent;
  return undefined;
}

export interface MemorySaveInput {
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  scope?: MemoryScope;
}

export const MemorySaveTool: Tool<MemorySaveInput> = {
  name: 'MemorySave',
  description: `Save something to long-term memory so future conversations (with any model, on any device) can use it.

Save:
- Durable facts about the user: role, projects, machines, accounts they use (not credentials), people they mention by role.
- Preferences: how they like answers, coding style, tools and libraries they prefer or avoid.
- Decisions and their reasons ("chose SQLite over Postgres because personal scale").
- Short how-tos, written as facts ("deploys run with make release on the server"). A method with several steps belongs in a skill (SkillManage).
- Anything the user explicitly asks you to remember.

Write a fact, not an order: "The owner prefers short answers", not "Always answer short"; "The owner uses pnpm", not "Always use pnpm". An order is read back in later sessions as an instruction and can override what the owner asks for then. A save that reads as an order is rewritten as a fact when it is simple, otherwise refused.

Do not save:
- Secrets of any kind: passwords, API keys, tokens, private keys, recovery codes. These are refused.
- Temporary task details, things already in the code or git history, or guesses.
- Duplicates: search first if unsure, and update by forgetting the old entry and saving the new one.

Fields:
- content: one self-contained statement, written so it makes sense with no other context.
- kind: "fact" (default), "profile" (always shown to the agent: identity and standing preferences), "procedure" (how-to), or "episode" (what happened).
- scope: "global" (default), "project" (only for the current working directory), or "agent" (only for this agent).
- tags: a few short keywords.`,
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The memory, as one self-contained statement' },
      kind: { type: 'string', enum: KINDS, description: 'fact (default), profile, procedure or episode' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short keywords' },
      scope: { type: 'string', enum: SCOPES, description: 'global (default), project or agent' },
    },
    required: ['content'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (input) => `Remember: ${String(input.content ?? '').slice(0, 80)}`,
  async run(input, ctx) {
    const given = typeof input.content === 'string' ? input.content.trim() : '';
    if (!given) return fail('content is required.');
    if (given.length > 4000) return fail('content is too long (over 4000 characters). Save one concise, self-contained statement.');
    if (containsSecret(given)) {
      return fail('This looks like it contains a secret (password, key or token). Secrets are never stored in memory. Save the fact without the secret value, e.g. "The API key for X is in the secrets store".');
    }
    // facts, not orders (memory/facts.ts): a simple order becomes a fact, any other is sent back
    const order = orderIn(given);
    const content = order ? asFact(given) : given;
    if (!content) return fail(`This reads as an order ("${order}"), and memories are facts. Save it as a fact about the owner or their setup, for example "The owner prefers short answers" instead of "Always answer short".`);
    const kind = input.kind && KINDS.includes(input.kind) ? input.kind : 'fact';
    const scope = input.scope && SCOPES.includes(input.scope) ? input.scope : 'global';
    const tags = Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toLowerCase().replace(/^#/, '')) : [];
    try {
      const entry = await ctx.host.memory.save({ content, kind, scope, scopeKey: scopeKeyFor(scope, ctx), tags, sourceSessionId: ctx.sessionId });
      const note = content !== given ? ` Saved as a fact: "${entry.content}".` : '';
      return { content: `Saved memory ${entry.id} (${entry.kind}, ${entry.scope}).${note}`, meta: { memoryId: entry.id } };
    } catch (err) {
      return fail(`Could not save memory: ${(err as Error).message}`);
    }
  },
};
