import type { Tool } from './types';
import { fail } from './util';

export interface MemorySearchInput {
  query: string;
  limit?: number;
}

export const MemorySearchTool: Tool<MemorySearchInput> = {
  name: 'MemorySearch',
  description: `Search long-term memory: facts, preferences, decisions and procedures saved from earlier conversations with this user, across every model and device.

Usage:
- Search when knowing the user's preferences, setup or earlier decisions would change your answer ("my usual setup", "the server we set up"). For what happened in past chats ("like last time", "what did we decide last week"), use SessionSearch.
- A few relevant memories may already be included in the conversation automatically; search when you need more.
- query is plain words describing what you need; limit defaults to 8.
- Each result has an id (for MemoryForget), its kind and scope, and the stored text. Memories can be outdated; prefer what the user says now.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for' },
      limit: { type: 'integer', description: 'Maximum results (default 8)', minimum: 1, maximum: 50 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `Search memory: ${input.query}`,
  async run(input, ctx) {
    if (typeof input.query !== 'string' || !input.query.trim()) return fail('query is required.');
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 8)));
    let hits;
    try {
      hits = await ctx.host.memory.search(input.query.trim(), { limit });
    } catch (err) {
      return fail(`Memory search failed: ${(err as Error).message}`);
    }
    if (!hits.length) return { content: `No memories match "${input.query.trim()}".` };
    const lines = hits.map((h) => {
      const date = new Date(h.updatedAt).toISOString().slice(0, 10);
      const tags = h.tags.length ? ` #${h.tags.join(' #')}` : '';
      const scope = h.scope === 'global' ? 'global' : `${h.scope}:${h.scopeKey ?? ''}`;
      return `[${h.id}] (${h.kind}, ${scope}, ${date}${tags})\n${h.content}`;
    });
    return { content: `${hits.length} memories:\n\n${lines.join('\n\n')}`, meta: { count: hits.length } };
  },
};
