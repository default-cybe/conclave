/**
 * External memory servers. Basic Memory (markdown notes + SQLite index over
 * MCP) is the main target; HttpMemory covers simple REST memory services.
 */
import { basename } from 'node:path';
import type { ConfigStore } from '../config';
import { logger } from '../util/log';
import { redactSecrets } from './secrets';
import { str, tryJson } from './connections/util';

const log = logger('memory.external');

export interface ExternalMemoryHit {
  id: string;
  title?: string;
  content: string;
  score?: number;
  url?: string;
  /** Connection id the hit came from, when several are searched together. */
  source?: string;
  /** File path inside the store (Basic Memory file_path), for folder filters. */
  path?: string;
}

export interface ExternalNote {
  title: string;
  /** Markdown body (Basic Memory observations and relations). */
  content: string;
  folder?: string;
  tags?: string[];
  project?: string;
  /** Memory kind (fact, procedure, episode) for stores that are not markdown based. */
  kind?: string;
  /** Plain text of the memory, without markdown, for mem0, Cognee and knowledge graphs. */
  text?: string;
  /** A grouped note (connections/grouped.ts): only connections with layout "grouped" get it. */
  grouped?: boolean;
  /** Write to every writable connection whatever its layout (an episode note the owner asked for per session). */
  always?: boolean;
}

export interface ExternalMemory {
  name: string;
  search(q: string, limit: number): Promise<ExternalMemoryHit[]>;
  write(note: ExternalNote): Promise<void>;
  /**
   * How saves use this memory. mirror: write here and locally. external: write
   * here instead of locally. undefined: never write (read only). When the
   * method is missing, config memory.external.mode decides.
   */
  writeMode?(): 'mirror' | 'external' | undefined;
  /** Overall timeout the store should allow for search(). Default MEMORY_TUNING.externalTimeoutMs. */
  readonly searchTimeoutMs?: number;
  /**
   * The owner's own notes: search() without the folder Conclave writes
   * (conclave/ and below). Learned facts are checked against it before they
   * are saved (store.ts inOwnNotes). Missing when the store keeps no notes
   * of the owner's (mem0, Cognee, plain HTTP). Throws when nothing answered.
   */
  searchOwnNotes?(q: string, limit: number): Promise<ExternalMemoryHit[]>;
}

/**
 * The hit is a note in one of these folders. Basic Memory's file_path is
 * relative to the project; a permalink may start with the project name.
 */
export function noteInFolder(h: Pick<ExternalMemoryHit, 'id' | 'path'>, folders: string[]): boolean {
  const path = (h.path ?? h.id).toLowerCase();
  return folders.some((raw) => {
    const f = raw.replace(/\/+$/, '').toLowerCase() + '/';
    return path.startsWith(f) || (!h.path && path.split('/').slice(1).join('/').startsWith(f));
  });
}

export type CallTool = (server: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// MCP result parsing
// ---------------------------------------------------------------------------

/** Pull text and structured data out of whatever the MCP client returned. */
export function unwrapToolResult(res: unknown): { text: string; data?: unknown; isError: boolean } {
  if (typeof res === 'string') return { text: res, data: tryJson(res), isError: false };
  if (!res || typeof res !== 'object') return { text: String(res ?? ''), isError: false };
  const r = res as Record<string, unknown>;
  const isError = r.isError === true;
  let text = '';
  if (Array.isArray(r.content)) {
    text = r.content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  } else if (typeof r.content === 'string') text = r.content; // McpManager ToolOutput
  else if (typeof r.text === 'string') text = r.text;
  let data: unknown = r.structuredContent;
  // FastMCP wraps non-object returns as {"result": ...}
  if (data && typeof data === 'object' && !Array.isArray(data) && 'result' in (data as object) && Object.keys(data as object).length === 1) {
    data = (data as { result: unknown }).result;
  }
  if (typeof data === 'string') data = tryJson(data) ?? undefined;
  if (data === undefined && text) data = tryJson(text);
  if (data === undefined && !Array.isArray(r.content) && typeof r.content !== 'string' && !('text' in r)) data = res;
  return { text, data, isError };
}

/** Normalize Basic Memory search_notes output (JSON of any recent version, or its markdown text). */
export function parseBasicMemorySearch(data: unknown, text: string): ExternalMemoryHit[] {
  let rows: unknown[] | undefined;
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    rows = (Array.isArray(d.results) ? d.results : Array.isArray(d.items) ? d.items : Array.isArray(d.notes) ? d.notes : undefined) as unknown[] | undefined;
  }
  if (rows) {
    const out: ExternalMemoryHit[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const permalink = str(r.permalink);
      const title = str(r.title);
      const content = str(r.content) ?? str(r.matched_chunk) ?? str(r.match) ?? str(r.text) ?? str(r.summary) ?? title ?? '';
      const id = permalink ?? str(r.file_path) ?? str(r.id) ?? title;
      if (!id || !content) continue;
      const filePath = str(r.file_path);
      out.push({
        id,
        title,
        content,
        score: typeof r.score === 'number' ? r.score : undefined,
        url: permalink ? `memory://${permalink}` : undefined,
        ...(filePath ? { path: filePath } : {}),
      });
    }
    return out;
  }
  return parseBasicMemoryText(text);
}

/** Text format: "### Title" blocks with "- permalink: x", "- score: 0.8", "- match: ..." lines. */
function parseBasicMemoryText(text: string): ExternalMemoryHit[] {
  if (!text || /^\s*(?:No results|# Search Failed|# No Search Criteria)/i.test(text)) return [];
  const out: ExternalMemoryHit[] = [];
  const blocks = text.split(/^#{2,3}\s+/m).slice(1);
  for (const block of blocks) {
    const [titleLine, ...rest] = block.split('\n');
    const title = titleLine.trim();
    if (!title || /^(?:search results|results|next steps)/i.test(title)) continue;
    const field = (name: string) => rest.find((l) => new RegExp(`^\\s*[-*]\\s*${name}\\s*:`, 'i').test(l))?.replace(/^[^:]+:\s*/, '').trim();
    const permalink = field('permalink');
    const score = Number(field('score'));
    const body = field('match') ?? field('content') ?? rest.filter((l) => l.trim() && !/^\s*[-*]\s*\w+\s*:/.test(l)).join(' ').trim();
    out.push({
      id: permalink ?? title,
      title,
      content: body || title,
      score: Number.isFinite(score) ? score : undefined,
      url: permalink ? `memory://${permalink}` : undefined,
    });
  }
  return out;
}

function looksLikeArgError(msg: string, arg: string): boolean {
  return new RegExp(`${arg}|unexpected keyword|extra (?:fields|inputs)|unexpected argument|validation error`, 'i').test(msg);
}

// ---------------------------------------------------------------------------
// Basic Memory over MCP
// ---------------------------------------------------------------------------

export interface BasicMemoryOptions {
  callTool: CallTool;
  /** Name of the Basic Memory entry in config.mcpServers. */
  server: string;
  /** Basic Memory project to search and write (personal, infra...). Default: the server's default project. */
  project?: string;
  name?: string;
}

export class BasicMemoryMcp implements ExternalMemory {
  readonly name: string;
  private callTool: CallTool;
  private server: string;
  private project?: string;
  /** Older Basic Memory versions reject output_format; remember after the first failure. */
  private jsonOutput = true;

  constructor(opts: BasicMemoryOptions);
  constructor(callTool: CallTool, server: string, project?: string);
  constructor(a: BasicMemoryOptions | CallTool, server?: string, project?: string) {
    const o: BasicMemoryOptions = typeof a === 'function' ? { callTool: a, server: server ?? 'basic-memory', project } : a;
    this.callTool = o.callTool;
    this.server = o.server;
    this.project = o.project;
    this.name = o.name ?? 'basic-memory';
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<{ text: string; data?: unknown }> {
    const res = unwrapToolResult(await this.callTool(this.server, tool, args));
    if (res.isError) throw new Error(`${tool}: ${res.text || 'tool error'}`);
    return res;
  }

  /** Call with output_format=json, retry without it on servers that do not know the argument. */
  private async callJson(tool: string, args: Record<string, unknown>): Promise<{ text: string; data?: unknown }> {
    if (this.jsonOutput) {
      try {
        return await this.call(tool, { ...args, output_format: 'json' });
      } catch (err) {
        if (!looksLikeArgError((err as Error).message, 'output_format')) throw err;
        this.jsonOutput = false;
      }
    }
    return this.call(tool, args);
  }

  private withProject(args: Record<string, unknown>, project?: string): Record<string, unknown> {
    const p = project ?? this.project;
    return p ? { ...args, project: p } : args;
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const { text, data } = await this.callJson('search_notes', this.withProject({ query: q, page_size: limit }));
    return parseBasicMemorySearch(data, text).slice(0, limit);
  }

  /** The owner's notes only, without the conclave folder this class writes into. */
  async searchOwnNotes(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    return (await this.search(q, limit * 2)).filter((h) => !noteInFolder(h, ['conclave'])).slice(0, limit);
  }

  async write(note: ExternalNote): Promise<void> {
    const args = this.withProject(
      { title: note.title, content: note.content, folder: note.folder ?? 'conclave', tags: note.tags ?? [] },
      note.project,
    );
    try {
      await this.call('write_note', args);
    } catch (err) {
      // newer versions refuse to replace an existing note unless overwrite is set
      if (!/overwrite|already exists|exists/i.test((err as Error).message)) throw err;
      await this.call('write_note', { ...args, overwrite: true });
    }
  }

  /** Delete one note by permalink or title. Older servers have no delete_note; the error says so. */
  async deleteNote(identifier: string): Promise<void> {
    await this.call('delete_note', this.withProject({ identifier }));
  }

  /** Notes changed recently (timeframe like "1d", "24h", "7d"). */
  async recent(timeframe = '1d', limit = 50): Promise<Array<{ title: string; permalink?: string; type?: string }>> {
    const { text, data } = await this.callJson('recent_activity', this.withProject({ timeframe, page_size: limit }));
    const rows = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : undefined;
    if (rows) {
      return rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ title: str(r.title) ?? str(r.permalink) ?? '', permalink: str(r.permalink), type: str(r.type) }))
        .filter((r) => r.title);
    }
    return parseBasicMemoryText(text).map((h) => ({ title: h.title ?? h.id, permalink: h.url?.replace(/^memory:\/\//, '') }));
  }

  /**
   * One page of every note in the project, via a permalink glob search
   * (query "*", search_type "permalink"). Used to import notes.
   */
  async listPage(page: number, pageSize: number): Promise<{ hits: ExternalMemoryHit[]; hasMore: boolean }> {
    const { text, data } = await this.callJson('search_notes', this.withProject({ query: '*', search_type: 'permalink', page, page_size: pageSize }));
    const hits = parseBasicMemorySearch(data, text);
    const d = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
    const hasMore = typeof d?.has_more === 'boolean' ? d.has_more : hits.length >= pageSize;
    return { hits, hasMore };
  }

  /** Full markdown of one note by title, permalink or memory:// url. */
  async read(identifier: string): Promise<string> {
    const { text } = await this.call('read_note', this.withProject({ identifier }));
    return text;
  }
}

// ---------------------------------------------------------------------------
// Plain HTTP memory service
// ---------------------------------------------------------------------------

export interface HttpMemoryOptions {
  url: string;
  headers?: Record<string, string>;
  name?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpMemory implements ExternalMemory {
  readonly name: string;
  private base: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(opts: HttpMemoryOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.headers = opts.headers ?? {};
    this.name = opts.name ?? 'http';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.name} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return tryJson(text) ?? text;
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const data = await this.post('/search', { query: q, limit });
    const d = data as Record<string, unknown> | unknown[];
    const rows = Array.isArray(d) ? d : ((d?.results ?? d?.memories ?? d?.items ?? []) as unknown[]);
    const out: ExternalMemoryHit[] = [];
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      const r = row as Record<string, unknown>;
      const content = str(r.content) ?? str(r.text) ?? str(r.memory) ?? str(r.body);
      if (!content) return;
      out.push({
        id: String(r.id ?? r.permalink ?? i),
        title: str(r.title),
        content,
        score: typeof r.score === 'number' ? r.score : undefined,
        url: str(r.url),
      });
    });
    return out.slice(0, limit);
  }

  async write(note: ExternalNote): Promise<void> {
    await this.post('/add', { title: note.title, content: note.content, tags: note.tags ?? [], folder: note.folder });
  }
}

// ---------------------------------------------------------------------------
// Note formatting and factory
// ---------------------------------------------------------------------------

function slugTitle(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Project path to a Basic Memory link target ("/home/me/code/conclave" -> "conclave"). */
export function projectName(project?: string): string | undefined {
  if (!project) return undefined;
  const b = basename(project.replace(/[\\/]+$/, ''));
  return b || undefined;
}

/** Episode summary as a Basic Memory note: observations plus [[relations]]. */
export function episodeNote(opts: {
  sessionId: string;
  summary: string;
  title?: string;
  project?: string;
  agent?: string;
  date?: Date;
  tags?: string[];
}): ExternalNote {
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const proj = projectName(opts.project);
  // a title is often the first prompt, so it can hold a token
  const topic = slugTitle(redactSecrets(opts.title ?? opts.summary.split('\n')[0] ?? 'session')).slice(0, 60);
  const tags = [...new Set(['conclave', 'session', ...(opts.tags ?? []), ...(proj ? [proj.toLowerCase()] : [])])];
  const relations = [proj ? `- part_of [[${proj}]]` : '', opts.agent ? `- handled_by [[${opts.agent}]]` : ''].filter(Boolean);
  const body = [
    `# ${topic}`,
    '',
    `Date: ${date}`,
    `Session: ${opts.sessionId}`,
    opts.agent ? `Agent: ${opts.agent}` : '',
    '',
    '## Summary',
    '',
    opts.summary.trim(),
    '',
    '## Observations',
    '',
    ...opts.summary
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `- [episode] ${l}`),
    ...(relations.length ? ['', '## Relations', '', ...relations] : []),
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
  return {
    title: slugTitle(`${date} ${topic} (${opts.sessionId.slice(-6)})`),
    content: body,
    folder: 'conclave/sessions',
    tags,
    kind: 'episode',
    text: opts.summary.trim(),
  };
}

/** A single fact or procedure as a small note in conclave/memories. */
export function factNote(opts: { content: string; kind: string; tags?: string[]; project?: string }): ExternalNote {
  const proj = projectName(opts.project);
  const title = slugTitle(opts.content.replace(/^the user\s+/i, '').split(/\s+/).slice(0, 8).join(' '));
  const tagStr = (opts.tags ?? []).map((t) => `#${t.replace(/\s+/g, '-')}`).join(' ');
  const lines = [`- [${opts.kind}] ${opts.content}${tagStr ? ' ' + tagStr : ''}`];
  if (proj) lines.push('', '## Relations', '', `- relates_to [[${proj}]]`);
  return { title, content: lines.join('\n'), folder: 'conclave/memories', tags: ['conclave', opts.kind, ...(opts.tags ?? [])], kind: opts.kind, text: opts.content };
}

/** Build the configured external memory, if any. */
export function createExternalMemory(config: ConfigStore, callTool?: CallTool, opts: { project?: string } = {}): ExternalMemory | undefined {
  const ext = config.get().memory.external;
  if (!ext) return undefined;
  if (ext.type === 'mcp') {
    if (!ext.mcpServer || !callTool) {
      log.warn('memory.external.type is mcp but no mcpServer or MCP client is available');
      return undefined;
    }
    return new BasicMemoryMcp({ callTool, server: ext.mcpServer, project: opts.project, name: ext.mcpServer });
  }
  if (ext.type === 'http' && ext.url) {
    return new HttpMemory({ url: config.expand(ext.url), headers: config.expandRecord(ext.headers) });
  }
  return undefined;
}
