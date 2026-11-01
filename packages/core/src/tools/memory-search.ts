import type { MemoryKind } from '../types';
import { INSPIRATION_PREFIX } from './save-inspiration';
import type { Tool } from './types';
import { fail, wrapUntrusted } from './util';

export interface MemorySearchInput {
  query: string;
  limit?: number;
  kind?: MemoryKind;
}

const KINDS: MemoryKind[] = ['profile', 'fact', 'episode', 'procedure', 'inspiration'];
/** A search without a kind leaves the inspiration board out: its items are outside text, asked for by name. */
const DEFAULT_KINDS: MemoryKind[] = ['profile', 'fact', 'episode', 'procedure'];

export const MemorySearchTool: Tool<MemorySearchInput> = {
  name: 'MemorySearch',
  description: `Search long-term memory: facts, preferences, decisions and procedures saved from earlier conversations with this user, across every model and device.

Usage:
- Search when knowing the user's preferences, setup or earlier decisions would change your answer ("my usual setup", "the server we set up"). For what happened in past chats ("like last time", "what did we decide last week"), use SessionSearch.
- A few relevant memories may already be included in the conversation automatically; search when you need more.
- query is plain words describing what you need; limit defaults to 8.
- kind narrows to one kind. kind "inspiration" searches the owner's inspiration board (design references saved with SaveInspiration): put the brief's words and tags in query (e.g. "hero scroll typography dark"), then Read the files of the top 2 to 3 items. Without kind, the board is left out.
- Each result has an id (for MemoryForget), its kind and scope, and the stored text. Memories can be outdated; prefer what the user says now.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for' },
      limit: { type: 'integer', description: 'Maximum results (default 8)', minimum: 1, maximum: 50 },
      kind: { type: 'string', enum: KINDS, description: 'Only this kind; "inspiration" for the inspiration board' },
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
      const kinds = input.kind && KINDS.includes(input.kind) ? [input.kind] : DEFAULT_KINDS;
      hits = await ctx.host.memory.search(input.query.trim(), { limit, kinds });
    } catch (err) {
      return fail(`Memory search failed: ${(err as Error).message}`);
    }
    if (!hits.length) return { content: `No memories match "${input.query.trim()}".` };
    const lines = hits.map((h) => {
      const date = new Date(h.updatedAt).toISOString().slice(0, 10);
      const tags = h.tags.length ? ` #${h.tags.join(' #')}` : '';
      const scope = h.scope === 'global' ? 'global' : `${h.scope}:${h.scopeKey ?? ''}`;
      // an inspiration item carries a post's or page's own words: fenced like WebFetch output
      const body = h.kind === 'inspiration' ? wrapUntrusted(h.content.split('\n', 1)[0].replace(INSPIRATION_PREFIX, ''), h.content) : h.content;
      return `[${h.id}] (${h.kind}, ${scope}, ${date}${tags})\n${body}`;
    });
    return { content: `${hits.length} memories:\n\n${lines.join('\n\n')}`, meta: { count: hits.length } };
  },
};
