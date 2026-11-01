import type { Tool } from './types';
import { fail } from './util';
import { helpDocs, type DocsIndex } from '../platform/docs';

export interface ConclaveHelpInput {
  query?: string;
  section?: string;
  limit?: number;
}

/** Longest section ConclaveHelp returns whole. */
const SECTION_CHARS = 14_000;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 6;

/** Tests swap the shipped docs for their own. */
let docsFor: () => Promise<DocsIndex> = helpDocs;
export function setHelpDocs(fn: (() => Promise<DocsIndex>) | undefined): void {
  docsFor = fn ?? helpDocs;
}

/**
 * Searches the Conclave docs that ship with the hub (platform/docs.ts):
 * the install guide, extensions, memory, assistant and workflow guides, the
 * design log and the round specs. Read-only, and it reads nothing of the
 * owner's: only the shipped text.
 */
export const ConclaveHelpTool: Tool<ConclaveHelpInput> = {
  name: 'ConclaveHelp',
  description: `Search the Conclave docs that ship with this hub: setup, features, settings pages, limits and how each part works. Use it before you answer a question about Conclave itself ("how do I add a second Claude account", "where do I set up the browser proxy", "can a routine run on my laptop") instead of guessing.

- query: a few plain words about the feature ("second claude account order", "browser proxy country"). The best sections come back with the paragraphs that match, each with an id.
- section: an id from an earlier result ("INSTALL.md#accounts-and-their-order") to read that whole section.
- limit: how many sections to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).
The docs describe the current release; the owner's own settings may differ, so check the live state (your tools, the platform card) before you say what is set up.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to search for' },
      section: { type: 'string', description: 'A section id from an earlier result, to read it whole' },
      limit: { type: 'integer', description: `Sections to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`, minimum: 1, maximum: MAX_LIMIT },
    },
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => (input.section ? `Read Conclave docs: ${input.section}` : `Search Conclave docs: ${input.query ?? ''}`),
  async run(input) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const ref = typeof input.section === 'string' ? input.section.trim() : '';
    if (!query && !ref) return fail('Pass a query (a few words), or a section id from an earlier result.');
    const docs = await docsFor();
    if (!docs.sections.length) return fail('The Conclave docs are not bundled with this hub, so there is nothing to search. Answer from the platform card, or point the owner to docs/ in the Conclave repository.');

    const s = ref ? docs.get(ref) : undefined;
    if (ref && !s && !query) {
      const near = docs.search(ref.replace(/[#/.-]+/g, ' '), 3);
      const also = near.length ? ` Close matches: ${near.map((h) => h.section.id).join(', ')}.` : '';
      return { content: `No section has the id "${ref}".${also}`, meta: { hits: 0, sections: [] } };
    }
    if (s) {
      const cut = s.text.length > SECTION_CHARS;
      const text = cut ? `${s.text.slice(0, SECTION_CHARS).replace(/\s+\S*$/, '')}\n\n[The rest of this section was cut; search with a narrower query to find it.]` : s.text;
      return { content: `${s.path}\nid: ${s.id}\n\n${text}`, meta: { hits: 1, sections: [s.id] } };
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(input.limit) || DEFAULT_LIMIT)));
    const hits = docs.search(query, limit + 3);
    if (!hits.length) return { content: `Nothing in the Conclave docs matches "${query}". Try other words, or the name of the page or feature.`, meta: { hits: 0, sections: [] } };
    const shown = hits.slice(0, limit);
    const more = hits.slice(limit);
    const parts = shown.map((h) => `## ${h.section.path}\nid: ${h.section.id}\n\n${h.snippet}${h.partial ? `\n\n[Part of the section. Read it whole with section "${h.section.id}".]` : ''}`);
    const note = docs.missing.length ? `\n\n(Not bundled with this hub: ${docs.missing.join(', ')}.)` : '';
    const tail = more.length ? `\n\nAlso matching: ${more.map((h) => `${h.section.path} (${h.section.id})`).join('; ')}.` : '';
    return {
      content: `Conclave docs, ${shown.length} ${shown.length === 1 ? 'section' : 'sections'} for "${query}":\n\n${parts.join('\n\n---\n\n')}${tail}${note}`,
      meta: { hits: shown.length, sections: shown.map((h) => h.section.id) },
    };
  },
};
