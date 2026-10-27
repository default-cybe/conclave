import type { ConfigStore } from '../../config';
import type { ConclaveConfig, McpServerConfig } from '../../config/schema';
import type { CallTool, ExternalMemoryHit, ExternalNote } from '../external';

/** One entry of config memory.connections. */
export type MemoryConnectionConfig = NonNullable<ConclaveConfig['memory']['connections']>[number];
export type MemoryConnectionType = MemoryConnectionConfig['type'];
export type MemoryConnectionMode = NonNullable<MemoryConnectionConfig['mode']>;

export const CONNECTION_TYPES: readonly MemoryConnectionType[] = ['basic-memory', 'mcp', 'http', 'mem0', 'cognee'];
export const CONNECTION_MODES: readonly MemoryConnectionMode[] = ['mirror', 'read', 'external'];

/** A connection with defaults filled in. */
export interface ResolvedConnection extends MemoryConnectionConfig {
  name: string;
  enabled: boolean;
  mode: MemoryConnectionMode;
  search: boolean;
  timeoutMs: number;
  options: Record<string, unknown>;
  /** True when this entry comes from the old memory.external setting. */
  legacy?: boolean;
}

/** A note pulled from a connection for the local index. */
export interface PulledNote {
  /** Stable id on the remote side (permalink, entity name, memory id). */
  id: string;
  title?: string;
  content: string;
  tags?: string[];
  url?: string;
}

export interface TestStep {
  step: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Total time for the whole test. */
  latencyMs: number;
  steps: TestStep[];
  /** First failure, in plain words. */
  error?: string;
  /** What to try next. */
  hint?: string;
  /** Results returned by the test search. */
  hits?: number;
  /** Tool names the MCP server exposes (MCP based types). */
  tools?: string[];
}

export interface MemoryAdapter {
  readonly id: string;
  readonly type: MemoryConnectionType;
  readonly name: string;
  /** Can this adapter write at all (independent of mode). */
  readonly canWrite: boolean;
  /** Connectivity plus a harmless search. Never throws. */
  test(): Promise<ConnectionTestResult>;
  search(q: string, limit: number): Promise<ExternalMemoryHit[]>;
  /** search() over the owner's own notes, without the folder Conclave writes. Missing when the backend keeps no notes of the owner's. */
  searchOwnNotes?(q: string, limit: number): Promise<ExternalMemoryHit[]>;
  write(note: ExternalNote): Promise<void>;
  /** Everything worth importing into the local index. Missing when the backend has no list call. */
  pullAll?(opts: { max: number }): Promise<PulledNote[]>;
  /** Delete one note or memory by its id on the remote side (a Basic Memory permalink). Missing when the backend cannot. */
  remove?(id: string): Promise<void>;
  /** Notes and their links for the memory map (Basic Memory). Missing when the backend has no note graph. */
  graph?(): Promise<import('../graph').BmGraphData>;
  close?(): Promise<void>;
}

/** A started MCP client, or a view onto one the engine already manages. */
export interface McpClientHandle {
  callTool(tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
  listTools?(): Promise<string[]>;
  close?(): Promise<void>;
}

/** Start an MCP client for a server config. The engine may pass its own. */
export type McpClientFactory = (name: string, server: McpServerConfig) => Promise<McpClientHandle>;

export interface AdapterDeps {
  config: ConfigStore;
  /** Calls a tool on a server from config.mcpServers (the engine's McpManager). */
  callTool?: CallTool;
  /** Tool names of a server from config.mcpServers. Optional, improves test() output. */
  listTools?: (server: string) => Promise<string[]>;
  /** Starts clients for servers defined inline in a connection. Default: built-in SDK client. */
  mcpClientFactory?: McpClientFactory;
  fetch?: typeof fetch;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Notes the remote returned. */
  total: number;
  /** Notes skipped (empty, secrets, over the cap). */
  skipped: number;
}

export interface ConnectionStatus {
  state: 'ok' | 'error' | 'backoff' | 'disabled' | 'unknown';
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** Last measured search or test latency. */
  latencyMs?: number;
  /** Consecutive failures. */
  failures: number;
  /** Live search skips this connection until then. */
  retryAt?: number;
  lastSync?: SyncResult & { at: number; error?: string };
  /** Notes from this connection in the local index. */
  imported: number;
}

export interface ConnectionInfo extends ResolvedConnection {
  status: ConnectionStatus;
  capabilities: { search: boolean; write: boolean; pull: boolean };
}
