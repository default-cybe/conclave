/**
 * ToolSearch: deferred MCP schemas (HARNESS-REVIEW item 18). When a session
 * has more MCP tools than mcp.deferAbove, their schemas stay out of the
 * request; this tool finds them by words or by name and returns their exact
 * schemas. A tool named in a ToolSearch result that is still in context is
 * offered in the requests after it (engine.toolsFor), so a compaction that
 * drops the result unloads the tool again and no table is needed.
 */
import type { Tool } from './types';
import { fail } from './util';

export interface ToolSearchInput {
  query: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
/** Field weights (dsh-mcp-lens): the tool name counts most, then its server, its parameters, its description. */
const WEIGHTS = { name: 3, server: 2, params: 1.5, description: 1 };

/** Words of a name or text: snake_case and camelCase split, lower case, a plural s dropped. */
export function words(text: string): string[] {
  return (text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** "mcp__github__create_issue" -> server "github", tool "create_issue". */
export function splitMcpName(name: string): { server: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : { server: '', tool: name };
}

function fields(t: Tool): Record<keyof typeof WEIGHTS, Set<string>> {
  const { server, tool } = splitMcpName(t.name);
  const props = Object.keys(t.inputSchema?.properties ?? {});
  return { name: new Set(words(tool)), server: new Set(words(server)), params: new Set(props.flatMap(words)), description: new Set(words(t.description ?? '')) };
}

/** Tools ranked for a query by IDF-weighted word matches over name, server, parameters and description. */
export function rankTools(tools: Tool[], query: string, limit = DEFAULT_LIMIT): Tool[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const all = tools.map((t) => ({ t, f: fields(t) }));
  const df = new Map<string, number>();
  for (const { f } of all) {
    const seen = new Set([...f.name, ...f.server, ...f.params, ...f.description]);
    for (const term of terms) if (seen.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const scored = all.map(({ t, f }, i) => {
    let score = 0;
    for (const term of terms) {
      const d = df.get(term);
      if (!d) continue;
      const idf = Math.log(1 + (all.length - d + 0.5) / (d + 0.5));
      let w = 0;
      for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) if (f[k].has(term)) w = Math.max(w, WEIGHTS[k]);
      score += idf * w;
    }
    return { t, i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.t);
}

/** The schema block a result carries for one tool, in the shape a tool list uses. */
function schemaOf(t: Tool): string {
  return `<function>${JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema })}</function>`;
}

const DESCRIPTION = `Load the schemas of MCP tools that are not in your tool list yet. This session has more MCP tools than fit in every request, so they are loaded on demand.

- query is words that describe what you need (for example "create github issue" or "notion database query"); the best matches come back with their exact schemas.
- Or pass "select:<name>,<name>" to load tools by their exact names.
- The tools in the result can be called from your next step on, by the names it gives. Calling a deferred tool before it is loaded fails with a note to search first.`;

/** The ToolSearch tool for a session's MCP tools; its description lists their servers, and their names while they fit. */
export function toolSearchFor(deferred: Tool[]): Tool<ToolSearchInput> {
  const servers = new Map<string, number>();
  for (const t of deferred) {
    const s = splitMcpName(t.name).server || 'other';
    servers.set(s, (servers.get(s) ?? 0) + 1);
  }
  const names = deferred.map((t) => t.name).join(', ');
  const list = `\n\nMCP tools loaded on demand: ${deferred.length}, from ${[...servers.entries()].map(([s, c]) => `${s} (${c})`).join(', ')}.${names.length <= 3_000 ? `\nNames: ${names}` : ''}`;
  return { ...ToolSearchTool, description: DESCRIPTION + list };
}

export const ToolSearchTool: Tool<ToolSearchInput> = {
  name: 'ToolSearch',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words that describe the tool you need, or "select:<name>,<name>"' },
      limit: { type: 'integer', description: `Most tools to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`, minimum: 1 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `ToolSearch ${input.query}`,
  async run(input, ctx) {
    const catalog = ctx.host.deferredTools?.() ?? [];
    if (!catalog.length) return fail('No deferred tools in this session: every tool is already in your tool list.');
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return fail('query is required.');
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));
    let hits: Tool[];
    if (query.startsWith('select:')) {
      const wanted = query.slice('select:'.length).split(',').map((s) => s.trim()).filter(Boolean);
      hits = wanted.map((w) => catalog.find((t) => t.name === w) ?? catalog.find((t) => splitMcpName(t.name).tool === w)).filter((t): t is Tool => !!t);
      const missing = wanted.filter((w) => !hits.some((t) => t.name === w || splitMcpName(t.name).tool === w));
      if (!hits.length) return fail(`No deferred tool is named ${missing.join(', ')}. Search by words instead.`);
    } else {
      hits = rankTools(catalog, query, limit);
      if (!hits.length) return { content: `No deferred tool matches "${query}". Try other words, or select:<name> with a name from the ToolSearch description.` };
    }
    return {
      content: `${hits.length} tools loaded. Call them by these names from your next step:\n${hits.map(schemaOf).join('\n')}`,
      meta: { promoted: hits.map((t) => t.name) },
    };
  },
};
