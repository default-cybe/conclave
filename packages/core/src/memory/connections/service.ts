/**
 * The memory connections API the hub exposes over HTTP: list, add, update,
 * remove, test and sync connections, import Claude Code / Codex memory
 * files, and export memory as markdown.
 *
 * Secrets: option values that look like credentials (apiKey, token,
 * password, Authorization headers) are moved into the secrets store on save
 * and replaced with ${secret:memory.<id>.<key>}. Listing masks any literal
 * credential that is left.
 */
import type { ConfigStore } from '../../config';
import type { ConclaveConfig, McpServerConfig } from '../../config/schema';
import { EngineError } from '../../engine/errors';
import type { Machine } from '../../machine/types';
import { KvRepo } from '../../storage/repos';
import type { Db } from '../../storage/db';
import type { SqliteMemory } from '../store';
import { renderMemoryMarkdown, type MarkdownExport, type MarkdownExportOptions } from '../export';
import { importMemoryFiles, type FileImportOptions, type FileImportResult } from '../import-files';
import { layoutOf, type MemoryConnections } from './manager';
import { BASIC_MEMORY_MCP_SERVER, BASIC_MEMORY_SERVER, isLocalBasicMemory } from './basic-memory';
import { GroupedNoteWriter, perFactPermalink } from './grouped';
import type { EventBus } from '../../util/bus';
import { CONNECTION_PRESETS, LEGACY_CONNECTION_ID, legacyConnection, resolveConnection, slugId, validateConnection, type ConnectionPreset } from './registry';
import type { ConnectionInfo, ConnectionStatus, ConnectionTestResult, MemoryConnectionConfig, SyncResult } from './types';

export const MASK = '********';
/** Most notes one sync imports. */
export const MAX_IMPORT = 2000;

/** Set once the hub's start pointed old local Basic Memory connections at its server (shareLocalBasicMemory). */
const SHARED_KEY = 'memory.basicMemoryShared';

const SECRET_KEY = /^(?:api[_-]?key|apikey|token|access[_-]?token|secret|password|passwd)$/i;
const SECRET_HEADER = /^(?:authorization|x-api-key|api-key|x-auth-token|cookie)$/i;
const REF = /^\$\{(?:env|secret):[^}]+\}$/;

/** What addConnection accepts: id optional (made from the name). */
export type MemoryConnectionInput = Omit<MemoryConnectionConfig, 'id'> & { id?: string };

export interface MemoryConnectionServiceOptions {
  config: ConfigStore;
  connections: MemoryConnections;
  memory: SqliteMemory;
  /** For sync and file import bookkeeping. Pass the engine db. */
  db: Db;
  /** With a bus, grouped notes follow memory changes (grouped.ts). */
  bus?: EventBus;
  /**
   * Adds a server to the hub's mcpServers (engine.addMcpServer). With it, a
   * Basic Memory connection that would start its own uvx process on the hub
   * is saved pointing at the hub's basic-memory server, made when missing:
   * one process serves memory and agents, and agents, routines and routine
   * suggestions get its tools. Left out for a member: the hub's servers are
   * the owner's.
   */
  addMcpServer?: (name: string, config: McpServerConfig) => void;
}

/** What "Group notes" did on one connection. */
export interface GroupNotesResult {
  /** Grouped notes written. */
  notes: number;
  /** Per-fact notes Conclave wrote earlier that can now go (only ones it can name from local rows). */
  perFact: number;
  /** Per-fact notes deleted (with deletePerFact). */
  deleted: number;
  /** False when the server has no delete_note. */
  canDelete: boolean;
  errors: string[];
}

export class MemoryConnectionService {
  private config: ConfigStore;
  readonly connections: MemoryConnections;
  private memory: SqliteMemory;
  private kv: KvRepo;
  private syncing = new Map<string, Promise<SyncResult>>();
  private addMcpServer?: (name: string, config: McpServerConfig) => void;
  /** Rebuilds grouped notes when memories change (Basic Memory with layout grouped). */
  readonly grouped: GroupedNoteWriter;

  constructor(opts: MemoryConnectionServiceOptions) {
    this.config = opts.config;
    this.connections = opts.connections;
    this.memory = opts.memory;
    this.addMcpServer = opts.addMcpServer;
    this.kv = new KvRepo(opts.db);
    this.grouped = new GroupedNoteWriter({
      rows: () => this.memory.list({ limit: 100_000 }),
      get: (id) => this.memory.get(id),
      target: this.connections,
      kv: this.kv,
      bus: opts.bus,
      accountId: opts.memory.accountId,
    });
    this.grouped.start();
  }

  /**
   * Switch a Basic Memory connection to grouped notes: write every grouped
   * note from the local rows, then (with deletePerFact) delete the per-fact
   * notes Conclave wrote before. Only notes it can name from local rows are
   * deleted, never the owner's own notes.
   */
  async groupNotes(id: string, opts: { deletePerFact?: boolean } = {}): Promise<GroupNotesResult> {
    const conn = this.connections.get(id);
    if (!conn) throw new EngineError(404, `unknown memory connection: ${id}`);
    if (conn.type !== 'basic-memory') throw new EngineError(400, 'Grouped notes are for Basic Memory connections.');
    if (conn.mode === 'read') throw new EngineError(400, 'This connection is read only, so Conclave writes nothing to it.');
    if (layoutOf(conn) !== 'grouped') this.updateConnection(id, { options: { ...(conn.options ?? {}), layout: 'grouped' } });
    const notes = await this.grouped.rebuildAll();
    const links = [...new Set(this.memory.list({ limit: 100_000 }).map(perFactPermalink).filter((x): x is string => !!x))];
    const out: GroupNotesResult = { notes, perFact: links.length, deleted: 0, canDelete: this.connections.canRemove(id), errors: [] };
    if (opts.deletePerFact && out.canDelete) {
      for (const link of links) {
        try {
          if (await this.connections.removeNote(id, link)) out.deleted++;
        } catch (err) {
          const msg = (err as Error).message;
          // a note that is not there is fine; a server without delete_note stops the loop
          if (/not found|does not exist|no such/i.test(msg)) continue;
          out.errors.push(msg.slice(0, 200));
          if (/delete_note|unknown tool|not supported/i.test(msg)) {
            out.canDelete = false;
            break;
          }
          if (out.errors.length >= 5) break;
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // config plumbing
  // -------------------------------------------------------------------------

  /** A connection's last sync, under its account's key (the owner keeps the old key). */
  private syncKey(id: string): string {
    const acct = this.memory.accountId ?? 'owner';
    return acct === 'owner' ? `memory.sync.${id}` : `acct:${acct}:memory.sync.${id}`;
  }

  private stored(): MemoryConnectionConfig[] {
    return [...(this.config.get().memory.connections ?? [])];
  }

  /** Write memory.connections, folding the legacy memory.external entry in on the first edit. */
  private save(next: MemoryConnectionConfig[], dropLegacy: boolean): void {
    const user = this.config.getUser();
    const memory = { ...(user.memory ?? {}), connections: next } as ConclaveConfig['memory'];
    if (dropLegacy && memory.external) {
      delete (memory as Partial<ConclaveConfig['memory']>).external;
      this.config.replace({ ...user, memory });
    } else {
      this.config.update({ memory });
    }
    void this.connections.prune();
  }

  /** Stored list with the legacy entry materialized, for edits. */
  private editable(): { list: MemoryConnectionConfig[]; hadLegacy: boolean } {
    const list = this.stored();
    const legacy = legacyConnection(this.config.get().memory);
    if (legacy && !list.some((c) => c.id === legacy.id)) return { list: [legacy, ...list], hadLegacy: true };
    return { list, hadLegacy: !!this.config.get().memory.external };
  }

  /** Move literal credentials into the secrets store. */
  private protectSecrets(c: MemoryConnectionConfig, previous?: MemoryConnectionConfig): MemoryConnectionConfig {
    const options = { ...(c.options ?? {}) };
    const prevOpts = previous?.options ?? {};
    const store = (path: string, value: string): string => {
      const name = `memory.${c.id}.${path}`.replace(/[^A-Za-z0-9_.-]/g, '_');
      this.config.setSecret('values', name, value);
      return `\${secret:${name}}`;
    };
    for (const [k, v] of Object.entries(options)) {
      if (!SECRET_KEY.test(k) || typeof v !== 'string') continue;
      if (v === MASK) options[k] = prevOpts[k];
      else if (v && !REF.test(v)) options[k] = store(k, v);
    }
    if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
      const prevHeaders = (prevOpts.headers && typeof prevOpts.headers === 'object' ? prevOpts.headers : {}) as Record<string, unknown>;
      const headers = { ...(options.headers as Record<string, unknown>) };
      for (const [h, v] of Object.entries(headers)) {
        if (typeof v !== 'string') continue;
        if (v === MASK) headers[h] = prevHeaders[h];
        else if (SECRET_HEADER.test(h) && v && !REF.test(v) && !/\$\{(?:env|secret):/.test(v)) headers[h] = store(`headers.${h}`, v);
      }
      options.headers = headers;
    }
    return { ...c, options };
  }

  /** Copy of a connection with literal credentials masked. References stay visible. */
  private masked(c: MemoryConnectionConfig): MemoryConnectionConfig {
    const options = { ...(c.options ?? {}) };
    for (const [k, v] of Object.entries(options)) if (SECRET_KEY.test(k) && typeof v === 'string' && v && !REF.test(v)) options[k] = MASK;
    if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
      const headers = { ...(options.headers as Record<string, unknown>) };
      for (const [h, v] of Object.entries(headers)) if (SECRET_HEADER.test(h) && typeof v === 'string' && !/\$\{(?:env|secret):/.test(v)) headers[h] = MASK;
      options.headers = headers;
    }
    return { ...c, options };
  }

  private info(id: string): ConnectionInfo {
    const conn = this.connections.get(id);
    if (!conn) throw new EngineError(404, `unknown memory connection: ${id}`);
    const lastSync = this.kv.get<ConnectionStatus['lastSync'] | undefined>(this.syncKey(id), undefined);
    const status: ConnectionStatus = { ...this.connections.statusOf(id), imported: this.memory.importedCount(id), lastSync };
    let pull = false;
    let write = conn.mode !== 'read';
    try {
      const adapter = this.connections.adapter(conn);
      pull = typeof adapter.pullAll === 'function';
      write = write && adapter.canWrite;
    } catch {
      /* invalid config shows up in test() */
    }
    return { ...(this.masked(conn) as typeof conn), status, capabilities: { search: conn.search, write, pull } };
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /** Starting points for the "add connection" form. */
  presets(): ConnectionPreset[] {
    return CONNECTION_PRESETS;
  }

  listConnections(): ConnectionInfo[] {
    return this.connections.list().map((c) => this.info(c.id));
  }

  getConnection(id: string): ConnectionInfo {
    return this.info(id);
  }

  addConnection(input: MemoryConnectionInput): ConnectionInfo {
    if (!input || typeof input !== 'object') throw new EngineError(400, 'connection must be an object');
    const { list, hadLegacy } = this.editable();
    const ids = list.map((c) => c.id);
    let id = input.id?.trim() || slugId(input.name || input.type || 'memory');
    if (!input.id) {
      const base = id;
      for (let n = 2; ids.includes(id); n++) id = `${base}-${n}`;
    }
    // new Basic Memory connections keep a few grouped notes instead of one note per fact
    const options = input.type === 'basic-memory' && (input.options as Record<string, unknown> | undefined)?.layout === undefined ? { ...(input.options ?? {}), layout: 'grouped' } : input.options;
    const conn = this.shared(this.protectSecrets(validateConnection({ ...input, ...(options ? { options } : {}), id } as MemoryConnectionConfig, ids)));
    this.save([...list, conn], hadLegacy);
    return this.info(id);
  }

  updateConnection(id: string, patch: Partial<MemoryConnectionConfig>): ConnectionInfo {
    const { list, hadLegacy } = this.editable();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) throw new EngineError(404, `unknown memory connection: ${id}`);
    if (patch.id !== undefined && patch.id !== id) throw new EngineError(400, 'id cannot be changed; remove and add the connection instead');
    if (patch.type !== undefined && patch.type !== list[i].type) throw new EngineError(400, 'type cannot be changed; remove and add the connection instead');
    const merged = { ...list[i], ...patch, id, options: patch.options !== undefined ? patch.options : list[i].options } as MemoryConnectionConfig;
    const conn = this.protectSecrets(
      validateConnection(merged, list.filter((c) => c.id !== id).map((c) => c.id)),
      list[i],
    );
    const next = [...list];
    next[i] = this.shared(conn);
    this.save(next, hadLegacy);
    return this.info(id);
  }

  /**
   * Once, on hub start: local Basic Memory connections saved before they
   * used the hub's server, on a hub with no basic-memory server, get the
   * server and point at it. Their project, folder and other options stay; a
   * connection with its own URL, command or server is left alone. Returns
   * the ids it changed.
   */
  shareLocalBasicMemory(): string[] {
    if (!this.addMcpServer || this.kv.get<boolean>(SHARED_KEY, false)) return [];
    this.kv.set(SHARED_KEY, true);
    if (this.config.get().mcpServers?.[BASIC_MEMORY_SERVER]) return [];
    const list = this.stored();
    const local = list.filter(isLocalBasicMemory).map((c) => c.id);
    if (!local.length) return [];
    this.save(
      list.map((c) => (isLocalBasicMemory(c) ? this.shared(c) : c)),
      false,
    );
    return local;
  }

  /**
   * A local Basic Memory connection as one on the hub's basic-memory server,
   * which is made (with the connection's env) when missing. Anything else,
   * and anything on a hub that does not share its servers, as it is.
   */
  private shared(c: MemoryConnectionConfig): MemoryConnectionConfig {
    if (!this.addMcpServer || !isLocalBasicMemory(c)) return c;
    if (!this.config.get().mcpServers?.[BASIC_MEMORY_SERVER]) {
      const env = Object.fromEntries(Object.entries((c.options?.env ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
      try {
        this.addMcpServer(BASIC_MEMORY_SERVER, { ...BASIC_MEMORY_MCP_SERVER, ...(Object.keys(env).length ? { env } : {}) });
      } catch (err) {
        // a plugin already brings a basic-memory server: use that one
        if ((err as { status?: number }).status !== 409) throw err;
      }
    }
    return { ...c, options: { ...(c.options ?? {}), server: BASIC_MEMORY_SERVER } };
  }

  /** Remove a connection. Notes it imported are removed too unless keepImported. */
  async removeConnection(id: string, opts: { keepImported?: boolean } = {}): Promise<boolean> {
    const { list, hadLegacy } = this.editable();
    const conn = list.find((c) => c.id === id);
    if (!conn) return false;
    this.save(
      list.filter((c) => c.id !== id),
      hadLegacy,
    );
    if (!opts.keepImported) await this.memory.removeImported(id);
    this.kv.delete(this.syncKey(id));
    await this.connections.prune();
    return true;
  }

  /**
   * Test a saved connection (by id) or an unsaved one (a config object, for
   * the form's Test button). Never throws for connection problems; bad
   * config still throws a 400.
   */
  async testConnection(target: string | MemoryConnectionInput): Promise<ConnectionTestResult> {
    if (typeof target === 'string') {
      const conn = this.connections.get(target);
      if (!conn) throw new EngineError(404, `unknown memory connection: ${target}`);
      return this.connections.test(conn, { saved: true });
    }
    const id = target.id?.trim() || 'test';
    const existing = this.connections.get(id);
    // masked secrets in a form that was loaded from the server: use the saved values
    const unmasked = existing ? this.unmask(target, existing) : target;
    const conn = resolveConnection(validateConnection({ ...unmasked, id } as MemoryConnectionConfig));
    return this.connections.test(conn, { saved: false });
  }

  private unmask(input: MemoryConnectionInput, saved: MemoryConnectionConfig): MemoryConnectionInput {
    const options = { ...(input.options ?? {}) };
    const prev = saved.options ?? {};
    for (const [k, v] of Object.entries(options)) if (v === MASK) options[k] = prev[k];
    if (options.headers && typeof options.headers === 'object') {
      const h = { ...(options.headers as Record<string, unknown>) };
      const ph = (prev.headers ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(h)) if (v === MASK) h[k] = ph[k];
      options.headers = h;
    }
    return { ...input, options };
  }

  /** Pull every note from a connection into the local index (read-only notes). One sync per connection at a time. */
  async syncConnection(id: string): Promise<SyncResult> {
    const running = this.syncing.get(id);
    if (running) return running;
    const p = this.doSync(id).finally(() => this.syncing.delete(id));
    this.syncing.set(id, p);
    return p;
  }

  private async doSync(id: string): Promise<SyncResult> {
    const conn = this.connections.get(id);
    if (!conn) throw new EngineError(404, `unknown memory connection: ${id}`);
    if (!conn.enabled) throw new EngineError(409, `memory connection ${id} is disabled`);
    if (!this.connections.canPull(conn)) throw new EngineError(400, `${conn.name} (${conn.type}) cannot list its notes, so there is nothing to import. Live search still works.`);
    const at = Date.now();
    try {
      const notes = await this.connections.pullAll(conn, MAX_IMPORT + 1);
      const over = Math.max(0, notes.length - MAX_IMPORT);
      const r = await this.memory.upsertImported(
        id,
        notes.slice(0, MAX_IMPORT).map((n) => ({ id: n.id, title: n.title, content: n.content, tags: n.tags })),
        { removeMissing: over === 0 },
      );
      const result: SyncResult = { added: r.added, updated: r.updated, removed: r.removed, unchanged: r.unchanged, skipped: r.skipped + over, total: notes.length };
      this.kv.set(this.syncKey(id), { ...result, at });
      return result;
    } catch (err) {
      const e = err as Error;
      this.kv.set(this.syncKey(id), { added: 0, updated: 0, removed: 0, unchanged: 0, skipped: 0, total: 0, at, error: e.message });
      if (err instanceof EngineError) throw err;
      throw new EngineError(502, `sync of ${id} failed: ${e.message}`);
    }
  }

  /** Remove the notes a connection imported, keep the connection. */
  async clearImported(id: string): Promise<number> {
    this.kv.delete(this.syncKey(id));
    return this.memory.removeImported(id);
  }

  /**
   * Import the memory files of Claude Code, Codex, Gemini CLI and OpenCode
   * from a machine. With no paths: the user files (~/.claude/CLAUDE.md,
   * ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md, ~/.config/opencode/AGENTS.md)
   * and, when opts.cwd is set, that project's CLAUDE.md, .claude/CLAUDE.md,
   * CLAUDE.local.md, AGENTS.md, GEMINI.md and Claude Code auto memory.
   * Unchanged files are skipped unless opts.force.
   */
  async importFromFiles(machine: Machine, paths?: string[], opts: FileImportOptions = {}): Promise<FileImportResult> {
    if (paths !== undefined && (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p.trim()))) throw new EngineError(400, 'paths must be a list of file paths');
    if (paths && paths.length > 50) throw new EngineError(400, 'at most 50 files per import');
    return importMemoryFiles(this.memory, this.kv, machine, paths, opts);
  }

  /** All memory as markdown files (one file, or a Basic Memory style folder). */
  exportMarkdown(opts: MarkdownExportOptions = {}): MarkdownExport {
    if (opts.layout !== undefined && opts.layout !== 'single' && opts.layout !== 'folder') throw new EngineError(400, 'layout must be single or folder');
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const page = this.memory.list({ limit: 1000, offset });
      all.push(...page);
      if (page.length < 1000) break;
    }
    return renderMemoryMarkdown(all, opts);
  }

  /** Write the export onto a machine (a git repo, a Basic Memory project folder). */
  async exportMarkdownTo(machine: Machine, dir: string, opts: MarkdownExportOptions = {}): Promise<{ dir: string; files: string[]; count: number }> {
    if (typeof dir !== 'string' || !dir.trim()) throw new EngineError(400, 'dir is required');
    const root = machine.resolve(dir, machine.resolve('~', '/')).replace(/\/+$/, '');
    const out = this.exportMarkdown(opts);
    const written: string[] = [];
    for (const f of out.files) {
      if (f.path.split('/').some((p) => p === '..')) continue;
      const path = `${root}/${f.path}`;
      await machine.writeFile(path, f.content);
      written.push(path);
    }
    return { dir: root, files: written, count: out.count };
  }
}

export { LEGACY_CONNECTION_ID };
