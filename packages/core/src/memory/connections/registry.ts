/**
 * Connection config: defaults, the legacy memory.external mapping,
 * validation, adapter construction and the presets the UI offers.
 */
import type { ConclaveConfig } from '../../config/schema';
import { EngineError } from '../../engine/errors';
import { BasicMemoryAdapter } from './basic-memory';
import { CogneeAdapter } from './cognee';
import { HttpMemoryAdapter } from './http';
import { McpMemoryAdapter } from './mcp';
import { Mem0Adapter } from './mem0';
import {
  CONNECTION_MODES,
  CONNECTION_TYPES,
  type AdapterDeps,
  type MemoryAdapter,
  type MemoryConnectionConfig,
  type MemoryConnectionType,
  type ResolvedConnection,
} from './types';
import { optObject, optStr } from './util';

export const DEFAULT_CONNECTION_TIMEOUT_MS = 2500;
export const LEGACY_CONNECTION_ID = 'external';

const TYPE_NAMES: Record<MemoryConnectionType, string> = {
  'basic-memory': 'Basic Memory',
  mcp: 'MCP memory',
  http: 'HTTP memory',
  mem0: 'mem0',
  cognee: 'Cognee',
};

/** Fill defaults. */
export function resolveConnection(c: MemoryConnectionConfig, legacy = false): ResolvedConnection {
  return {
    ...c,
    name: c.name?.trim() || TYPE_NAMES[c.type] || c.id,
    enabled: c.enabled !== false,
    mode: c.mode ?? 'mirror',
    search: c.search !== false,
    timeoutMs: c.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    options: { ...(c.options ?? {}) },
    ...(legacy ? { legacy: true } : {}),
  };
}

/** The old memory.external setting as a connection, or undefined. */
export function legacyConnection(memory: ConclaveConfig['memory']): MemoryConnectionConfig | undefined {
  const ext = memory.external;
  if (!ext) return undefined;
  const mode = ext.mode === 'external' ? 'external' : 'mirror';
  if (ext.type === 'mcp') {
    if (!ext.mcpServer) return undefined;
    return { id: LEGACY_CONNECTION_ID, type: 'basic-memory', name: 'Basic Memory', mode, options: { server: ext.mcpServer, ...(ext.project ? { project: ext.project } : {}) } };
  }
  if (ext.type === 'http' && ext.url) {
    return { id: LEGACY_CONNECTION_ID, type: 'http', name: 'HTTP memory', mode, options: { url: ext.url, ...(ext.headers ? { headers: ext.headers } : {}) } };
  }
  return undefined;
}

/** Every configured connection, legacy first, with defaults filled in. Explicit entries win over the legacy one. */
export function listConfigured(memory: ConclaveConfig['memory']): ResolvedConnection[] {
  const explicit = (memory.connections ?? []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
  const out: ResolvedConnection[] = [];
  const legacy = legacyConnection(memory);
  if (legacy && !explicit.some((c) => c.id === legacy.id)) out.push(resolveConnection(legacy, true));
  const seen = new Set(out.map((c) => c.id));
  for (const c of explicit) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(resolveConnection(c));
  }
  return out;
}

export function createAdapter(conn: ResolvedConnection, deps: AdapterDeps): MemoryAdapter {
  switch (conn.type) {
    case 'basic-memory':
      return new BasicMemoryAdapter(conn, deps);
    case 'mcp':
      return new McpMemoryAdapter(conn, deps);
    case 'http':
      return new HttpMemoryAdapter(conn, deps);
    case 'mem0':
      return new Mem0Adapter(conn, deps);
    case 'cognee':
      return new CogneeAdapter(conn, deps);
    default:
      throw new EngineError(400, `Unknown memory connection type: ${String((conn as { type?: unknown }).type)}`);
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function slugId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'memory'
  );
}

function bad(msg: string): never {
  throw new EngineError(400, msg);
}

function checkUrl(v: unknown, field: string): void {
  if (typeof v !== 'string' || !v.trim()) bad(`${field} is required`);
  const s = v.trim();
  if (/^\$\{(?:env|secret):[^}]+\}/.test(s)) return; // resolved at run time
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    bad(`${field} is not a valid URL: ${s}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`${field} must be http or https`);
}

function checkStringArray(v: unknown, field: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`${field} must be a list of strings`);
}

function checkStringRecord(v: unknown, field: string): void {
  if (v === undefined) return;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string')) bad(`${field} must be an object of strings`);
}

function checkMcpServer(o: Record<string, unknown>, required: boolean): void {
  const has = ['server', 'command', 'url'].filter((k) => o[k] !== undefined && o[k] !== '');
  if (has.length > 1) bad(`set only one of options.server, options.command or options.url (got ${has.join(', ')})`);
  if (!has.length && required) bad('set options.server (a name from mcpServers), options.command, or options.url');
  if (o.server !== undefined && (typeof o.server !== 'string' || !o.server.trim())) bad('options.server must be a server name');
  if (o.command !== undefined && (typeof o.command !== 'string' || !o.command.trim())) bad('options.command must be a string');
  if (o.url !== undefined) checkUrl(o.url, 'options.url');
  if (o.transport !== undefined && !['http', 'sse'].includes(String(o.transport))) bad('options.transport must be http or sse');
  checkStringArray(o.args, 'options.args');
  checkStringRecord(o.env, 'options.env');
  checkStringRecord(o.headers, 'options.headers');
}

/** Throw a 400 EngineError when the connection is not usable. Returns it normalized. */
export function validateConnection(c: MemoryConnectionConfig, existingIds: string[] = []): MemoryConnectionConfig {
  if (!c || typeof c !== 'object') bad('connection must be an object');
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) bad('id must be 1 to 40 lowercase letters, digits, dash or underscore');
  if (existingIds.includes(c.id)) bad(`a memory connection with id "${c.id}" already exists`);
  if (!CONNECTION_TYPES.includes(c.type)) bad(`type must be one of ${CONNECTION_TYPES.join(', ')}`);
  if (c.mode !== undefined && !CONNECTION_MODES.includes(c.mode)) bad(`mode must be one of ${CONNECTION_MODES.join(', ')}`);
  if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 80)) bad('name must be a string up to 80 characters');
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') bad('enabled must be true or false');
  if (c.search !== undefined && typeof c.search !== 'boolean') bad('search must be true or false');
  if (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || c.timeoutMs < 200 || c.timeoutMs > 60_000)) bad('timeoutMs must be between 200 and 60000');
  if (c.options !== undefined && (!c.options || typeof c.options !== 'object' || Array.isArray(c.options))) bad('options must be an object');
  const o = c.options ?? {};
  for (const k of ['project', 'folder', 'dataset', 'userId', 'agentId', 'entity', 'entityType', 'searchType', 'apiKey', 'token', 'resultPath']) {
    if (o[k] !== undefined && typeof o[k] !== 'string') bad(`options.${k} must be a string`);
  }
  switch (c.type) {
    case 'basic-memory':
      checkMcpServer(o, false);
      if (o.layout !== undefined && o.layout !== 'grouped' && o.layout !== 'per-fact') bad('options.layout must be grouped or per-fact');
      checkStringArray(o.importFolders, 'options.importFolders');
      checkStringArray(o.skipFolders, 'options.skipFolders');
      break;
    case 'mcp': {
      const preset = o.preset === undefined ? (o.searchTool ? 'custom' : 'knowledge-graph') : o.preset;
      if (preset !== 'knowledge-graph' && preset !== 'custom') bad('options.preset must be knowledge-graph or custom');
      checkMcpServer(o, preset === 'custom');
      if (preset === 'custom') {
        if (!optStr(o, 'searchTool')) bad('options.searchTool is required for a custom MCP memory');
        // preset is the inferred one too: a searchTool alone makes it custom
        if (c.mode !== 'read' && !optStr(o, 'writeTool')) bad('a custom MCP memory without options.writeTool can only use mode "read"');
        for (const k of ['searchArgs', 'writeArgs', 'listArgs', 'fields']) if (o[k] !== undefined && !optObject(o, k)) bad(`options.${k} must be an object`);
        for (const k of ['writeTool', 'listTool']) if (o[k] !== undefined && typeof o[k] !== 'string') bad(`options.${k} must be a string`);
      }
      break;
    }
    case 'http':
      checkUrl(o.url, 'options.url');
      checkStringRecord(o.headers, 'options.headers');
      break;
    case 'mem0': {
      if (o.url !== undefined) checkUrl(o.url, 'options.url');
      if (o.variant !== undefined && o.variant !== 'platform' && o.variant !== 'self-hosted') bad('options.variant must be platform or self-hosted');
      const platform = o.variant === 'platform' || (o.variant === undefined && (o.url === undefined || /mem0\.ai/i.test(String(o.url))));
      if (platform && !optStr(o, 'apiKey')) bad('options.apiKey is required for the mem0 platform');
      if (o.infer !== undefined && typeof o.infer !== 'boolean') bad('options.infer must be true or false');
      break;
    }
    case 'cognee':
      checkUrl(o.url, 'options.url');
      checkStringArray(o.nodeSet, 'options.nodeSet');
      break;
  }
  return c;
}

// ---------------------------------------------------------------------------
// presets for the "add connection" form
// ---------------------------------------------------------------------------

export interface ConnectionPreset {
  key: string;
  type: MemoryConnectionType;
  label: string;
  description: string;
  /** Starting config; the user fills the blanks. */
  template: Omit<MemoryConnectionConfig, 'id'>;
  /** Option keys the form should show, in order. Keys ending in ? are optional. */
  fields: string[];
  docs: string;
}

export const CONNECTION_PRESETS: ConnectionPreset[] = [
  {
    key: 'basic-memory-local',
    type: 'basic-memory',
    label: 'Basic Memory on the hub',
    description: "Markdown notes on the hub disk, started with uvx as the hub's basic-memory MCP server, so agents get its tools too. Needs uv installed on the hub.",
    template: { type: 'basic-memory', name: 'Basic Memory', mode: 'mirror', options: { project: '' } },
    fields: ['project?', 'folder?'],
    docs: 'docs/MEMORY.md#basic-memory',
  },
  {
    key: 'basic-memory-server',
    type: 'basic-memory',
    label: 'Basic Memory from mcpServers',
    description: 'Reuse a Basic Memory server already in mcpServers. Agents keep its tools too.',
    template: { type: 'basic-memory', name: 'Basic Memory', mode: 'mirror', options: { server: 'basic-memory' } },
    fields: ['server', 'project?'],
    docs: 'docs/MEMORY.md#basic-memory',
  },
  {
    key: 'basic-memory-http',
    type: 'basic-memory',
    label: 'Basic Memory over HTTP',
    description: 'A Basic Memory server on another box: basic-memory mcp --transport streamable-http.',
    template: { type: 'basic-memory', name: 'Basic Memory', mode: 'mirror', options: { url: 'http://notes-box:8000/mcp' } },
    fields: ['url', 'project?', 'headers?'],
    docs: 'docs/MEMORY.md#basic-memory',
  },
  {
    key: 'mcp-knowledge-graph',
    type: 'mcp',
    label: 'MCP knowledge graph',
    description: 'The official @modelcontextprotocol/server-memory, started with npx.',
    template: { type: 'mcp', name: 'Knowledge graph', mode: 'mirror', options: { preset: 'knowledge-graph', env: { MEMORY_FILE_PATH: '' } } },
    fields: ['env?', 'entity?'],
    docs: 'docs/MEMORY.md#any-mcp-memory-server',
  },
  {
    key: 'mcp-custom',
    type: 'mcp',
    label: 'Other MCP memory server',
    description: 'Any MCP server with a search tool. Map the tool names and arguments.',
    template: { type: 'mcp', name: 'MCP memory', mode: 'read', options: { preset: 'custom', server: '', searchTool: 'search', searchArgs: { query: '{{query}}', limit: '{{limit}}' } } },
    fields: ['server', 'searchTool', 'searchArgs?', 'writeTool?', 'writeArgs?', 'resultPath?'],
    docs: 'docs/MEMORY.md#any-mcp-memory-server',
  },
  {
    key: 'mem0-platform',
    type: 'mem0',
    label: 'mem0 platform',
    description: 'Hosted mem0 at api.mem0.ai.',
    template: { type: 'mem0', name: 'mem0', mode: 'mirror', options: { apiKey: '', userId: 'conclave' } },
    fields: ['apiKey', 'userId?'],
    docs: 'docs/MEMORY.md#mem0',
  },
  {
    key: 'mem0-self-hosted',
    type: 'mem0',
    label: 'mem0 self-hosted',
    description: 'The mem0 server from the mem0 repo (docker compose, port 8888).',
    template: { type: 'mem0', name: 'mem0', mode: 'mirror', options: { variant: 'self-hosted', url: 'http://mem0:8888', apiKey: '', userId: 'conclave' } },
    fields: ['url', 'apiKey?', 'userId?'],
    docs: 'docs/MEMORY.md#mem0',
  },
  {
    key: 'cognee',
    type: 'cognee',
    label: 'Cognee',
    description: 'Cognee REST API. Writes go into a dataset and build its graph in the background.',
    template: { type: 'cognee', name: 'Cognee', mode: 'mirror', timeoutMs: 5000, options: { url: 'http://cognee:8000', dataset: 'conclave' } },
    fields: ['url', 'apiKey?', 'dataset?', 'searchType?'],
    docs: 'docs/MEMORY.md#cognee',
  },
  {
    key: 'http',
    type: 'http',
    label: 'Plain HTTP',
    description: 'Any service with POST /search and POST /add.',
    template: { type: 'http', name: 'HTTP memory', mode: 'mirror', options: { url: '' } },
    fields: ['url', 'headers?', 'listPath?'],
    docs: 'docs/MEMORY.md#plain-http',
  },
];
