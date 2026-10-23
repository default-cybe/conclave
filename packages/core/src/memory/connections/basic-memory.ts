/**
 * Basic Memory (github.com/basicmachines-co/basic-memory): markdown notes in
 * a folder, indexed in SQLite, served over MCP. Tools used: search_notes,
 * write_note, read_note, recent_activity, build_context.
 *
 * Server, in order of preference:
 * - options.server: a name from config.mcpServers (agents see the tools too)
 * - options.url: a running `basic-memory mcp --transport streamable-http` (default path /mcp)
 * - options.command/args: any launcher
 * - default: `uvx --prerelease=allow basic-memory mcp` on the hub
 *
 * The owner's hub saves a connection with none of these as one on the
 * hub's basic-memory server (service.ts shared()), so the default is only
 * for a member's own Basic Memory and for testing a form before it is saved.
 */
import type { McpServerConfig } from '../../config/schema';
import { BasicMemoryMcp, noteInFolder, type ExternalMemoryHit, type ExternalNote } from '../external';
import { noteText } from '../text';
import { McpEndpoint, serverSpecFromOptions } from './mcp-client';
import type { AdapterDeps, ConnectionTestResult, MemoryAdapter, PulledNote, ResolvedConnection } from './types';
import { optNum, optStr, optStrArr, TestRun, withTimeout } from './util';

export { noteText };

export const BASIC_MEMORY_DEFAULT_SERVER: McpServerConfig = {
  type: 'stdio',
  command: 'uvx',
  args: ['--prerelease=allow', 'basic-memory', 'mcp'],
};

export const BASIC_MEMORY_TOOLS = ['search_notes', 'write_note', 'read_note', 'recent_activity', 'build_context'];

/** The hub's Basic Memory server in mcpServers: the name routine suggestions look for, and the config Discover installs (catalog/recommended.ts, mcp:basic-memory). */
export const BASIC_MEMORY_SERVER = 'basic-memory';
export const BASIC_MEMORY_MCP_SERVER: McpServerConfig = { command: 'uvx', args: ['basic-memory', 'mcp'] };

/** A Basic Memory connection that would start its own process on the hub: no server, URL or command of its own. */
export function isLocalBasicMemory(c: { type: string; options?: Record<string, unknown> }): boolean {
  const o = c.options ?? {};
  return c.type === 'basic-memory' && !optStr(o, 'server') && !optStr(o, 'url') && !optStr(o, 'command');
}

export class BasicMemoryAdapter implements MemoryAdapter {
  readonly type = 'basic-memory' as const;
  readonly canWrite = true;
  readonly id: string;
  readonly name: string;
  private endpoint: McpEndpoint;
  private bm: BasicMemoryMcp;
  private folder?: string;
  private conn: ResolvedConnection;

  constructor(conn: ResolvedConnection, deps: AdapterDeps) {
    this.conn = conn;
    this.id = conn.id;
    this.name = conn.name;
    const o = conn.options;
    this.endpoint = new McpEndpoint(`memory-${conn.id}`, serverSpecFromOptions(o, BASIC_MEMORY_DEFAULT_SERVER), deps);
    this.folder = optStr(o, 'folder');
    const timeoutMs = Math.max(conn.timeoutMs, 10_000);
    this.bm = new BasicMemoryMcp({
      callTool: (_server, tool, args) => this.endpoint.callTool(tool, args, timeoutMs),
      server: conn.id,
      project: optStr(o, 'project'),
      name: conn.id,
    });
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    return (await this.bm.search(q, limit)).map((h) => ({ ...h, content: noteText(h.content) || h.content }));
  }

  /** The owner's notes only: the folder Conclave writes (its facts, sessions and goals) is left out. Asks for twice the limit, since Conclave's own notes often match first. */
  async searchOwnNotes(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const mine = this.folder ?? 'conclave';
    return (await this.search(q, limit * 2)).filter((h) => !noteInFolder(h, [mine])).slice(0, limit);
  }

  async write(note: ExternalNote): Promise<void> {
    const folder = this.folder && note.folder ? note.folder.replace(/^conclave(?=\/|$)/, this.folder) : (note.folder ?? this.folder);
    await this.bm.write({ ...note, folder });
  }

  /** Delete a note Conclave wrote, by permalink (delete_note). Used when per-fact notes are replaced by grouped ones. */
  async remove(id: string): Promise<void> {
    const local = this.folder ? id.replace(/^conclave(?=\/|$)/, this.folder) : id;
    await this.bm.deleteNote(local);
  }

  /**
   * Folders whose notes are not imported: by default the folder Conclave
   * mirrors into (those facts are already local), and in any mode the goal
   * notes, which are copies of the hub's goals (assistant/goals.ts).
   */
  private skipFolders(): string[] {
    const set = optStrArr(this.conn.options, 'skipFolders');
    if (set) return set;
    return this.conn.mode === 'mirror' ? [this.folder ?? 'conclave'] : [`${this.folder ?? 'conclave'}/goals`];
  }

  async pullAll(opts: { max: number }): Promise<PulledNote[]> {
    const pageSize = 50;
    const max = Math.min(opts.max, optNum(this.conn.options, 'maxImport') ?? opts.max);
    const only = optStrArr(this.conn.options, 'importFolders');
    const skip = this.skipFolders();
    const out: PulledNote[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 200 && out.length < max; page++) {
      const { hits, hasMore } = await this.bm.listPage(page, pageSize);
      for (const h of hits) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        if (noteInFolder(h, skip)) continue;
        if (only && !noteInFolder(h, only)) continue;
        const content = noteText(h.content);
        if (!content) continue;
        out.push({ id: h.id, title: h.title, content, url: h.url });
        if (out.length >= max) break;
      }
      if (!hasMore || !hits.length) break;
    }
    return out;
  }

  async test(): Promise<ConnectionTestResult> {
    const run = new TestRun({ command: this.endpoint.command, url: this.endpoint.url });
    await run.step('connect', () => this.endpoint.connect());
    const tools = await run.step('list tools', async () => (await this.endpoint.listTools().catch(() => undefined)) ?? [], (t) => (t.length ? `${t.length} tools` : 'not available'));
    if (tools?.length) {
      run.tools = tools;
      const missing = ['search_notes', 'write_note'].filter((t) => !tools.includes(t));
      if (missing.length) run.fail('check tools', `The server does not expose ${missing.join(' and ')}.`, 'This does not look like Basic Memory. Check the command or URL.');
    }
    const project = optStr(this.conn.options, 'project');
    const hits = await run.step(
      'search',
      () => withTimeout(this.bm.search('conclave connection test', 3), Math.max(this.conn.timeoutMs, 15_000), 'search'),
      (h) => `${h.length} result(s)${project ? ` in project ${project}` : ''}`,
    );
    if (hits) run.hits = hits.length;
    const res = run.result();
    if (!res.ok && /cloud routing|project/i.test(res.error ?? '')) {
      res.hint = project
        ? `Check that "${project}" is a Basic Memory project on that machine (basic-memory project list), or clear options.project to use the default.`
        : 'Check the Basic Memory projects on that machine (basic-memory project list).';
    }
    return res;
  }

  async close(): Promise<void> {
    await this.endpoint.close();
  }
}
