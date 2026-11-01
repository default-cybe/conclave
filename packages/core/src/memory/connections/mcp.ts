/**
 * Any MCP memory server. Two flavors:
 *
 * - preset "knowledge-graph": the official @modelcontextprotocol/server-memory
 *   (tools search_nodes, create_entities, add_observations, read_graph).
 * - preset "custom" (default when searchTool is set): name the search and
 *   write tools and map arguments with {{placeholders}}.
 *
 * Custom options:
 *   searchTool   "search"                      (required)
 *   searchArgs   {"query": "{{query}}", "limit": "{{limit}}"}   (default)
 *   writeTool    "add_memory"                  (optional; no writes without it)
 *   writeArgs    {"content": "{{text}}"}       (default)
 *   listTool     "list_memories"               (optional, enables import)
 *   listArgs     {}                            (default)
 *   resultPath   "results"                     (where the rows are; auto when unset)
 *   fields       {"id": "id", "title": "name", "content": "text", "score": "score"}
 * Placeholders: query, limit, title, content (markdown), text (plain), kind,
 * tags (array), folder, project.
 */
import type { McpServerConfig } from '../../config/schema';
import { unwrapToolResult, type ExternalMemoryHit, type ExternalNote } from '../external';
import { words } from '../text';
import { McpEndpoint, serverSpecFromOptions } from './mcp-client';
import type { AdapterDeps, ConnectionTestResult, MemoryAdapter, PulledNote, ResolvedConnection } from './types';
import { clip, fillTemplate, findRows, optObject, optStr, rowToHit, TestRun, withTimeout, type RowFields } from './util';

export const KNOWLEDGE_GRAPH_DEFAULT_SERVER: McpServerConfig = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
};

interface KgEntity {
  name: string;
  entityType?: string;
  observations?: string[];
}

function kgEntities(data: unknown): KgEntity[] {
  const d = data as { entities?: unknown } | undefined;
  const list = Array.isArray(d?.entities) ? d.entities : Array.isArray(data) ? data : [];
  return list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string')
    .map((e) => ({
      name: e.name as string,
      entityType: typeof e.entityType === 'string' ? e.entityType : undefined,
      observations: Array.isArray(e.observations) ? e.observations.filter((o): o is string => typeof o === 'string') : [],
    }));
}

function entityText(e: KgEntity): string {
  return (e.observations ?? []).join('; ') || e.name;
}

export class McpMemoryAdapter implements MemoryAdapter {
  readonly type = 'mcp' as const;
  readonly id: string;
  readonly name: string;
  readonly canWrite: boolean;
  private endpoint: McpEndpoint;
  private preset: 'knowledge-graph' | 'custom';
  private o: Record<string, unknown>;
  private conn: ResolvedConnection;

  constructor(conn: ResolvedConnection, deps: AdapterDeps) {
    this.conn = conn;
    this.id = conn.id;
    this.name = conn.name;
    this.o = conn.options;
    this.preset = optStr(this.o, 'preset') === 'knowledge-graph' || (!optStr(this.o, 'searchTool') && optStr(this.o, 'preset') !== 'custom') ? 'knowledge-graph' : 'custom';
    const fallback = this.preset === 'knowledge-graph' ? KNOWLEDGE_GRAPH_DEFAULT_SERVER : undefined;
    this.endpoint = new McpEndpoint(`memory-${conn.id}`, serverSpecFromOptions(this.o, fallback), deps);
    this.canWrite = this.preset === 'knowledge-graph' || !!optStr(this.o, 'writeTool');
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; data?: unknown }> {
    const res = unwrapToolResult(await this.endpoint.callTool(tool, args, Math.max(this.conn.timeoutMs, 10_000)));
    if (res.isError) throw new Error(`${tool}: ${res.text || 'tool error'}`);
    return res;
  }

  private fields(): RowFields {
    const f = optObject(this.o, 'fields') ?? {};
    const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
    return { id: s('id'), title: s('title'), content: s('content'), score: s('score'), url: s('url') };
  }

  private parseRows(text: string, data: unknown): ExternalMemoryHit[] {
    const rows = findRows(data, optStr(this.o, 'resultPath'));
    if (rows) return rows.map((r, i) => rowToHit(r, i, this.fields())).filter((h): h is ExternalMemoryHit => !!h);
    const t = text.trim();
    if (!t || /^(?:no (?:results|memories|matches)|nothing found|\[\]|\{\})/i.test(t)) return [];
    return [{ id: '0', content: clip(t, 2000) }];
  }

  // -------------------------------------------------------------------------
  // knowledge graph preset
  // -------------------------------------------------------------------------

  private async kgSearch(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    // search_nodes is a plain substring match on the whole query, so a
    // sentence finds nothing. Try the query, then its strongest words.
    const found = new Map<string, { e: KgEntity; hits: number; order: number }>();
    const add = (list: KgEntity[]) =>
      list.forEach((e) => {
        const cur = found.get(e.name);
        if (cur) cur.hits++;
        else found.set(e.name, { e, hits: 1, order: found.size });
      });
    const whole = q.trim().slice(0, 200);
    add(kgEntities((await this.call('search_nodes', { query: whole })).data));
    if (found.size < limit) {
      const terms = [...new Set(words(q))].filter((w) => w.length >= 3 && w !== whole.toLowerCase()).sort((a, b) => b.length - a.length).slice(0, 4);
      const lists = await Promise.all(terms.map((t) => this.call('search_nodes', { query: t }).then((r) => kgEntities(r.data)).catch(() => [] as KgEntity[])));
      lists.forEach(add);
    }
    const ranked = [...found.values()].sort((a, b) => b.hits - a.hits || a.order - b.order).slice(0, limit);
    const max = Math.max(1, ...ranked.map((r) => r.hits));
    return ranked.map(({ e, hits }) => ({ id: e.name, title: e.name, content: clip(entityText(e), 800), score: hits / max }));
  }

  private kgEntityFor(note: ExternalNote): { name: string; entityType: string } {
    if (note.kind === 'episode') return { name: note.title, entityType: 'session' };
    return { name: optStr(this.o, 'entity') ?? 'user', entityType: optStr(this.o, 'entityType') ?? 'person' };
  }

  private async kgWrite(note: ExternalNote): Promise<void> {
    const { name, entityType } = this.kgEntityFor(note);
    const observation = (note.text ?? note.content).trim();
    const created = await this.call('create_entities', { entities: [{ name, entityType, observations: [observation] }] });
    const d = created.data as { skipped?: unknown; entities?: unknown } | unknown[] | undefined;
    // newer servers list skipped names; older ones return only the created entities
    const skipped = !Array.isArray(d) && Array.isArray(d?.skipped) ? (d.skipped as unknown[]).includes(name) : !kgEntities(d).some((e) => e.name === name);
    if (skipped) await this.call('add_observations', { observations: [{ entityName: name, contents: [observation] }] });
  }

  // -------------------------------------------------------------------------
  // MemoryAdapter
  // -------------------------------------------------------------------------

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    if (this.preset === 'knowledge-graph') return this.kgSearch(q, limit);
    const tool = optStr(this.o, 'searchTool')!;
    const tpl = optObject(this.o, 'searchArgs') ?? { query: '{{query}}', limit: '{{limit}}' };
    const { text, data } = await this.call(tool, fillTemplate(tpl, { query: q, limit }) as Record<string, unknown>);
    return this.parseRows(text, data).slice(0, limit);
  }

  async write(note: ExternalNote): Promise<void> {
    if (this.preset === 'knowledge-graph') return this.kgWrite(note);
    const tool = optStr(this.o, 'writeTool');
    if (!tool) throw new Error(`connection ${this.id} has no writeTool`);
    const tpl = optObject(this.o, 'writeArgs') ?? { content: '{{text}}' };
    const vars = { title: note.title, content: note.content, text: note.text ?? note.content, kind: note.kind ?? 'fact', tags: note.tags ?? [], folder: note.folder, project: note.project };
    await this.call(tool, fillTemplate(tpl, vars) as Record<string, unknown>);
  }

  get pullAll(): ((opts: { max: number }) => Promise<PulledNote[]>) | undefined {
    if (this.preset === 'knowledge-graph') {
      return async ({ max }) => {
        const { data } = await this.call('read_graph', {});
        return kgEntities(data)
          .slice(0, max)
          .map((e) => ({ id: e.name, title: e.name, content: `${e.name}${e.entityType ? ` (${e.entityType})` : ''}: ${entityText(e)}` }));
      };
    }
    const tool = optStr(this.o, 'listTool');
    if (!tool) return undefined;
    return async ({ max }) => {
      const { text, data } = await this.call(tool, (fillTemplate(optObject(this.o, 'listArgs') ?? {}, { limit: max }) as Record<string, unknown>) ?? {});
      return this.parseRows(text, data)
        .slice(0, max)
        .map((h) => ({ id: h.id, title: h.title, content: h.content, url: h.url }));
    };
  }

  async test(): Promise<ConnectionTestResult> {
    const run = new TestRun({ command: this.endpoint.command, url: this.endpoint.url });
    await run.step('connect', () => this.endpoint.connect());
    const tools = await run.step('list tools', async () => (await this.endpoint.listTools().catch(() => undefined)) ?? [], (t) => (t.length ? `${t.length} tools` : 'not available'));
    if (tools?.length) {
      run.tools = tools;
      const need =
        this.preset === 'knowledge-graph'
          ? ['search_nodes', 'create_entities', 'add_observations']
          : [optStr(this.o, 'searchTool'), optStr(this.o, 'writeTool'), optStr(this.o, 'listTool')].filter((t): t is string => !!t);
      const missing = need.filter((t) => !tools.includes(t));
      if (missing.length) {
        run.fail(
          'check tools',
          `The server does not expose ${missing.join(', ')}.`,
          this.preset === 'knowledge-graph' ? 'This does not look like @modelcontextprotocol/server-memory. Use preset "custom" with your tool names.' : `Available tools: ${tools.slice(0, 15).join(', ')}`,
        );
      }
    }
    const hits = await run.step('search', () => withTimeout(this.search('conclave connection test', 3), Math.max(this.conn.timeoutMs, 15_000), 'search'), (h) => `${h.length} result(s)`);
    if (hits) run.hits = hits.length;
    return run.result();
  }

  async close(): Promise<void> {
    await this.endpoint.close();
  }
}
