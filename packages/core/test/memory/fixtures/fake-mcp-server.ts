/**
 * Tiny stdio MCP server for tests. `bun fake-mcp-server.ts basic-memory`
 * acts like Basic Memory (search_notes, write_note, read_note,
 * recent_activity, build_context); `... kg` acts like the official
 * @modelcontextprotocol/server-memory knowledge graph.
 *
 * Env: FAKE_NOTES (JSON seed), FAKE_LOG (file to append calls to as JSON
 * lines), FAKE_DELAY_MS (delay every search), FAKE_NO_JSON (reject output_format).
 */
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const flavor = process.argv[2] ?? 'basic-memory';
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (tool: string, args: unknown) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, args }) + '\n');
};
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], structuredContent: v as Record<string, unknown> });

interface Note {
  title: string;
  folder: string;
  content: string;
  tags: string[];
}
const notes = new Map<string, Note>();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
for (const n of JSON.parse(process.env.FAKE_NOTES ?? '[]') as Note[]) notes.set(`${n.folder}/${slug(n.title)}`, n);

interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}
const entities = new Map<string, Entity>();

const schema = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const tools =
  flavor === 'kg'
    ? [
        { name: 'search_nodes', inputSchema: schema({ query: { type: 'string' } }, ['query']) },
        { name: 'create_entities', inputSchema: schema({ entities: { type: 'array' } }, ['entities']) },
        { name: 'add_observations', inputSchema: schema({ observations: { type: 'array' } }, ['observations']) },
        { name: 'read_graph', inputSchema: schema({}) },
      ]
    : ['search_notes', 'write_note', 'read_note', 'recent_activity', 'build_context', 'list_directory'].map((name) => ({ name, inputSchema: schema({}) }));

const server = new Server({ name: `fake-${flavor}`, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const a = (req.params.arguments ?? {}) as Record<string, any>;
  log(name, a);

  if (flavor === 'kg') {
    if (name === 'search_nodes') {
      if (delay) await sleep(delay);
      const q = String(a.query ?? '').toLowerCase();
      const found = [...entities.values()].filter((e) => e.name.toLowerCase().includes(q) || e.entityType.toLowerCase().includes(q) || e.observations.some((o) => o.toLowerCase().includes(q)));
      return json({ entities: found, relations: [] });
    }
    if (name === 'create_entities') {
      const created: Entity[] = [];
      const skipped: string[] = [];
      for (const e of a.entities as Entity[]) {
        if (entities.has(e.name)) skipped.push(e.name);
        else {
          entities.set(e.name, { ...e, observations: [...e.observations] });
          created.push(e);
        }
      }
      return json(skipped.length ? { entities: created, skipped } : { entities: created });
    }
    if (name === 'add_observations') {
      const results = (a.observations as Array<{ entityName: string; contents: string[] }>).map((o) => {
        const e = entities.get(o.entityName);
        if (!e) throw new Error(`Entity with name ${o.entityName} not found`);
        const added = o.contents.filter((c) => !e.observations.includes(c));
        e.observations.push(...added);
        return { entityName: o.entityName, addedObservations: added };
      });
      return json({ results });
    }
    if (name === 'read_graph') return json({ entities: [...entities.values()], relations: [] });
    return text(`unknown tool ${name}`, true);
  }

  if (process.env.FAKE_NO_JSON && 'output_format' in a) return text(`1 validation error for call[${name}]\noutput_format\n  Unexpected keyword argument`, true);
  if (name === 'search_notes') {
    if (delay) await sleep(delay);
    const page = Number(a.page ?? 1);
    const size = Number(a.page_size ?? 10);
    let rows: Array<[string, Note]>;
    if (a.query === '*' && a.search_type === 'permalink') rows = [...notes.entries()];
    else {
      const terms = String(a.query ?? '')
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2);
      rows = [...notes.entries()].filter(([, n]) => terms.some((t) => `${n.title} ${n.content}`.toLowerCase().includes(t)));
    }
    const slice = rows.slice((page - 1) * size, page * size);
    const results = slice.map(([permalink, n], i) => ({ title: n.title, type: 'entity', score: 1 - i * 0.1, permalink, content: n.content, file_path: `${permalink}.md` }));
    if (a.output_format === 'json') return json({ results, current_page: page, page_size: size, has_more: rows.length > page * size });
    if (!results.length) return text(`No results found for query "${a.query}"`);
    return text(['# Search Results', '', ...results.flatMap((r) => [`### ${r.title}`, `- permalink: ${r.permalink}`, `- score: ${r.score}`, `- match: ${r.content}`, ''])].join('\n'));
  }
  if (name === 'write_note') {
    const folder = String(a.directory ?? a.folder ?? '');
    if (!folder) return text('directory is required', true);
    const permalink = `${folder}/${slug(String(a.title))}`;
    if (notes.has(permalink) && !a.overwrite) return text(`Note already exists at ${permalink}. Pass overwrite=True to replace it.`, true);
    notes.set(permalink, { title: String(a.title), folder, content: String(a.content), tags: Array.isArray(a.tags) ? a.tags : [] });
    return text(`# Created note\npermalink: ${permalink}`);
  }
  if (name === 'read_note') {
    const n = notes.get(String(a.identifier)) ?? [...notes.values()].find((x) => x.title === a.identifier);
    return n ? text(`# ${n.title}\n\n${n.content}`) : text(`Note not found: ${a.identifier}`);
  }
  if (name === 'recent_activity') return json([...notes.entries()].map(([permalink, n]) => ({ type: 'entity', title: n.title, permalink })));
  if (name === 'build_context') return text('# Context');
  return text(`unknown tool ${name}`, true);
});

await server.connect(new StdioServerTransport());
