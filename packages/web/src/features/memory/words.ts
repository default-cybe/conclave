/**
 * Words for memory connections: types, modes, states, option fields and
 * the small helpers the Connections, Import and Share tabs share.
 */
import type { MemoryConnectionInfo, MemoryConnectionMode, MemoryConnectionStatus, MemoryConnectionType, MemorySyncResult } from '@conclave/core/client';
import { hhmm, relTime } from '@/lib/format';

export const TYPE_NAME: Record<MemoryConnectionType, string> = {
  'basic-memory': 'Basic Memory',
  mcp: 'MCP',
  http: 'HTTP',
  mem0: 'mem0',
  cognee: 'Cognee',
};

/** What each mode does, in the owner's words (UI-HANDOFF.md). */
export const MODE: Record<MemoryConnectionMode, { label: string; words: string; help: string }> = {
  mirror: { label: 'Mirror', words: 'Saves here and in Conclave', help: 'New facts and session summaries go to this store and stay in Conclave too.' },
  read: { label: 'Read', words: 'Search and import only', help: 'Conclave searches it and can import its notes, but never writes to it.' },
  external: { label: 'External', words: 'Saves here instead of Conclave', help: 'Facts and summaries go only to this store. Your profile stays in Conclave. If the store fails, the note is kept in Conclave.' },
};
export const MODES: MemoryConnectionMode[] = ['mirror', 'read', 'external'];

export const CREDENTIAL = '********';

/** Option keys that hold a credential. The hub moves these to its secrets store. */
function isSecretKey(key: string): boolean {
  return /^(?:api[_-]?key|apikey|token|access[_-]?token|secret|password|passwd)$/i.test(key);
}
function isSecretHeader(name: string): boolean {
  return /^(?:authorization|x-api-key|api-key|x-auth-token|cookie)$/i.test(name);
}
/** A saved credential the list does not show: the mask or a ${secret:...} reference. */
export function isHidden(v: unknown): boolean {
  return typeof v === 'string' && (v === CREDENTIAL || /^\$\{secret:[^}]+\}$/.test(v));
}

/** Where the store is, as one short string (a URL, a server name, a command). */
export function whereOf(c: Pick<MemoryConnectionInfo, 'type' | 'options'>): string {
  const o = c.options ?? {};
  const str = (k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : undefined);
  if (str('url')) return str('url')!;
  if (str('server')) return `mcpServers.${str('server')}`;
  if (str('command')) return [str('command'), ...(Array.isArray(o.args) ? o.args.map(String) : [])].join(' ');
  if (c.type === 'basic-memory') return 'uvx basic-memory mcp';
  if (c.type === 'mcp' && o.preset !== 'custom') return 'npx @modelcontextprotocol/server-memory';
  if (c.type === 'mem0') return 'api.mem0.ai';
  return '';
}

/** The project or dataset inside the store, when it has one. */
export function placeOf(c: Pick<MemoryConnectionInfo, 'type' | 'options'>): string | undefined {
  const o = c.options ?? {};
  if (typeof o.project === 'string' && o.project) return `project ${o.project}`;
  if (typeof o.dataset === 'string' && o.dataset) return `dataset ${o.dataset}`;
  if (typeof o.userId === 'string' && o.userId) return `user ${o.userId}`;
  return undefined;
}

/** MCP based stores can be added to other CLIs as they are. */
export function isMcpBased(c: Pick<MemoryConnectionInfo, 'type'>): boolean {
  return c.type === 'basic-memory' || c.type === 'mcp';
}

export interface StateWords {
  word: string;
  tone: 'ok' | 'fault' | 'warn' | 'dim';
  /** A second sentence: what went wrong and what to do. */
  detail?: string;
}

/** ok, error with the message and a fix, backoff with the retry time, off. */
export function stateWords(s: MemoryConnectionStatus, now = Date.now()): StateWords {
  // a rest that ended since the list loaded reads as the error it was resting from
  const state = s.state === 'backoff' && s.retryAt && s.retryAt <= now ? 'error' : s.state;
  switch (state) {
    case 'ok':
      return { word: 'ok', tone: 'ok' };
    case 'disabled':
      return { word: 'off', tone: 'dim' };
    case 'backoff':
      return {
        word: s.retryAt ? `resting until ${hhmm(s.retryAt)}` : 'resting',
        tone: 'warn',
        detail: s.lastError ? `${sentence(s.lastError)} ${hintFor(s.lastError) ?? ''} Live search skips it until then.`.replace(/\s+/g, ' ').trim() : `Failed ${s.failures} times in a row. Live search skips it for now.`,
      };
    case 'error':
      return { word: 'failed', tone: 'fault', detail: s.lastError ? `${sentence(s.lastError)} ${hintFor(s.lastError) ?? ''}`.trim() : undefined };
    default:
      return { word: 'not checked yet', tone: 'dim' };
  }
}

/** A sync error without the hub's "sync of <id> failed: " prefix, as a sentence. */
export function syncError(msg: string): string {
  return sentence(msg.replace(/^sync of \S+ failed:\s*/i, ''));
}

/**
 * Where notes go, in one line: "Kept in Conclave, mirrored to Basic Memory
 * (project main) and searched in mem0." plus what is failing. Empty until the
 * list is in, so the line never claims a store it has not seen.
 */
export function storeWords(list: MemoryConnectionInfo[] | undefined): { text: string; problem?: string } {
  if (!list) return { text: '' };
  const on = list.filter((c) => c.enabled);
  if (!on.length) return { text: list.length ? "Kept in Conclave's own store. Every connection is off." : "Kept in Conclave's own store." };
  // the place (a project, a dataset) when only one store takes the writes
  const writers = on.filter((c) => c.mode !== 'read');
  const label = (c: MemoryConnectionInfo) => (writers.length === 1 && c === writers[0] && placeOf(c) ? `${c.name} (${placeOf(c)})` : c.name);
  const names = (mode: string) => on.filter((c) => c.mode === mode).map(label);
  const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const parts: string[] = [];
  const ext = names('external');
  const mirror = names('mirror');
  const read = names('read');
  if (ext.length) parts.push(`Saved to ${and(ext)} instead of Conclave`);
  else parts.push('Kept in Conclave');
  if (mirror.length) parts.push(`mirrored to ${and(mirror)}`);
  if (read.length) parts.push(`searched in ${and(read)}`);
  const text = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ');
  const failing = on.filter((c) => c.status.state === 'error' || c.status.state === 'backoff');
  return { text: `${text}.`, problem: failing.length ? `${and(failing.map((c) => c.name))} ${failing.length === 1 ? 'is' : 'are'} failing.` : undefined };
}

/** End a hub message with a period so it reads as a sentence. */
export function sentence(msg: string): string {
  const m = msg.trim();
  return /[.!?:]$/.test(m) ? m : `${m}.`;
}

/**
 * The fix for a stored error, from the same patterns the hub uses for test
 * hints (memory/connections/util.ts explainError).
 */
export function hintFor(error: string): string | undefined {
  if (/Not authorized|HTTP 40[13]\b/i.test(error)) return 'Check the API key or token in this connection.';
  if (/HTTP 404|Endpoint not found/i.test(error)) return 'Check the base URL. Use the server root, without /api or /v1 on the end.';
  if (/timed out|timeout/i.test(error)) return 'The server is slow or unreachable. Raise the timeout, or check the host is up.';
  if (/Connection refused|ECONNREFUSED/i.test(error)) return 'Nothing is listening there. Is the server running, and is the port right?';
  if (/Host not found|ENOTFOUND|getaddrinfo/i.test(error)) return 'Check the host name, and that the hub can reach that machine (same network, VPN or tailnet).';
  if (/No MCP server named/i.test(error)) return 'Add it under MCP servers first, or give this connection its own command or URL.';
  if (/Command not found|ENOENT/i.test(error)) return 'Install it on the hub, or give the full path.';
  if (/HTTP 5\d\d|Server error/i.test(error)) return 'Look at the memory server logs.';
  return undefined;
}

/** "2m ago", "3h ago", "16 Oct" */
export function agoWords(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const r = relTime(ts, now);
  if (r === 'now') return 'just now';
  return /^\d+[smhd]$/.test(r) ? `${r} ago` : `on ${r}`;
}

export function msWords(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** "3 added, 1 updated, 0 removed, 138 unchanged" */
export function syncWords(r: MemorySyncResult): string {
  const parts = [`${r.added} added`, `${r.updated} updated`, `${r.removed} removed`, `${r.unchanged} unchanged`];
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  return parts.join(', ');
}

export function capabilityWords(c: MemoryConnectionInfo['capabilities']): string {
  const can = [c.search && 'search', c.write && 'save', c.pull && 'import'].filter(Boolean) as string[];
  if (!can.length) return 'Nothing yet';
  return can.join(', ');
}

// ---------------------------------------------------------------------------
// Option fields for the add and edit form
// ---------------------------------------------------------------------------

export type FieldKind = 'text' | 'secret' | 'headers' | 'env' | 'json';

export interface FieldInfo {
  label: string;
  help: string;
  kind: FieldKind;
  placeholder?: string;
  mono?: boolean;
}

export const FIELD: Record<string, FieldInfo> = {
  project: { label: 'Project', kind: 'text', mono: true, placeholder: 'main', help: 'A Basic Memory project. Empty uses its default project.' },
  folder: { label: 'Folder', kind: 'text', mono: true, placeholder: 'conclave', help: 'Folder in the project for notes Conclave writes.' },
  server: { label: 'MCP server', kind: 'text', mono: true, placeholder: 'basic-memory', help: 'The name of a server in MCP servers. Agents keep its tools too.' },
  url: { label: 'URL', kind: 'text', mono: true, placeholder: 'http://notes-box:8000/mcp', help: 'Where the store listens. A Tailscale name works.' },
  headers: { label: 'Headers', kind: 'headers', mono: true, placeholder: 'Authorization: Bearer …', help: 'One per line, Name: value. Authorization and X-API-Key values move to the secrets store.' },
  env: { label: 'Environment', kind: 'env', mono: true, placeholder: 'MEMORY_FILE_PATH=/srv/memory-graph.jsonl', help: 'One per line, NAME=value. Set MEMORY_FILE_PATH, or the graph lands in the npx cache and is lost on update.' },
  entity: { label: 'Entity', kind: 'text', mono: true, placeholder: 'user', help: 'The entity new facts are added to as observations.' },
  searchTool: { label: 'Search tool', kind: 'text', mono: true, placeholder: 'search', help: 'The tool that takes a query and returns notes.' },
  searchArgs: { label: 'Search arguments', kind: 'json', mono: true, help: 'JSON. Placeholders: {{query}} and {{limit}}.' },
  writeTool: { label: 'Write tool', kind: 'text', mono: true, placeholder: 'add_memory', help: 'Leave empty for a store you only read. Then the mode must be Read.' },
  writeArgs: { label: 'Write arguments', kind: 'json', mono: true, help: 'JSON. Placeholders: {{title}}, {{content}}, {{text}}, {{kind}}, {{tags}}.' },
  resultPath: { label: 'Result path', kind: 'text', mono: true, placeholder: 'results', help: 'Where the rows are in the tool result. Empty finds them on its own.' },
  apiKey: { label: 'API key', kind: 'secret', mono: true, placeholder: 'm0-…', help: 'Moved to the secrets store when you save. It is never shown again.' },
  userId: { label: 'User id', kind: 'text', mono: true, placeholder: 'conclave', help: 'Every note is filed under this user.' },
  dataset: { label: 'Dataset', kind: 'text', mono: true, placeholder: 'conclave', help: 'The Cognee dataset notes go into.' },
  searchType: { label: 'Search type', kind: 'text', mono: true, placeholder: 'CHUNKS', help: 'CHUNKS returns stored text without an LLM call. GRAPH_COMPLETION costs an LLM call per turn.' },
  listPath: { label: 'List path', kind: 'text', mono: true, placeholder: '/all', help: 'A GET route that lists every note. Needed to import.' },
};

export function fieldInfo(key: string): FieldInfo {
  return FIELD[key] ?? { label: key, kind: isSecretKey(key) ? 'secret' : 'text', mono: true, help: '' };
}

/** "project?" -> { key: "project", optional: true } */
export function parseField(f: string): { key: string; optional: boolean } {
  return f.endsWith('?') ? { key: f.slice(0, -1), optional: true } : { key: f, optional: false };
}

/** Record to editable lines: "Name: value" for headers, "NAME=value" for env. Hidden credentials show as the mask. */
export function recordToText(r: unknown, kind: 'headers' | 'env'): string {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return '';
  return Object.entries(r as Record<string, unknown>)
    .map(([k, v]) => {
      // the hub restores masked headers on save; env values are never masked, so they show as stored
      const val = kind === 'headers' && isHidden(v) && isSecretHeader(k) ? CREDENTIAL : String(v ?? '');
      return kind === 'headers' ? `${k}: ${val}` : `${k}=${val}`;
    })
    .join('\n');
}

/** Lines back to a record. Returns an error sentence for a line it cannot read. */
export function textToRecord(text: string, kind: 'headers' | 'env'): { value?: Record<string, string>; error?: string } {
  const out: Record<string, string> = {};
  const lines = text.split('\n').map((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    const m = kind === 'headers' ? /^([^:\s]+)\s*:\s*(.*)$/.exec(line) : /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return { error: `Line ${i + 1} should look like ${kind === 'headers' ? 'Name: value' : 'NAME=value'}.` };
    out[m[1]] = m[2];
  }
  return { value: Object.keys(out).length ? out : undefined };
}
