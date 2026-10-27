import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerConfig } from '../config/schema';
import type { ConfigStore } from '../config';
import type { McpStatus } from '../client';
import type { ImageBlock, JsonSchema, TextBlock } from '../types';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpOAuth } from './mcp-oauth';
import { timeoutOutput, type Tool, type ToolOutput } from '../tools/types';
import { logger } from '../util/log';

const log = logger('mcp');

interface ServerTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

type ConnState = 'disabled' | 'connecting' | 'connected' | 'failed' | 'needs-auth';

interface ServerRecord {
  name: string;
  config: McpServerConfig;
  client?: Client;
  state: ConnState;
  tools: ServerTool[];
  error?: string;
  attempts: number;
  nextRetryAt: number;
  connecting?: Promise<void>;
  /** Bumped when the config changes or the server is turned off, so a connect still in flight for the old config is dropped. */
  gen: number;
}

/** Longest an MCP tool call may take unless the server config says otherwise (mcpServers.<name>.timeoutMs). */
export const DEFAULT_MCP_TIMEOUT_MS = 120_000;

/** Backoff schedule for reconnects, in ms. */
const BACKOFF = [1_000, 5_000, 15_000, 30_000, 60_000];

export interface McpManagerOptions {
  /** Servers contributed outside config (e.g. by plugins), merged under config. */
  extraServers?: Record<string, McpServerConfig>;
  /** Token store and sign-in flow for servers with auth "oauth". Default: one on the config's home. */
  oauth?: McpOAuth;
}

/**
 * Manages MCP server connections. Servers connect lazily on first use and
 * reconnect with backoff. Tools are exposed as Conclave Tools named
 * mcp__<server>__<tool>.
 */
export class McpManager {
  private config: ConfigStore;
  private records = new Map<string, ServerRecord>();
  private extra: Record<string, McpServerConfig>;
  readonly oauth: McpOAuth;

  constructor(config: ConfigStore, opts: McpManagerOptions = {}) {
    this.config = config;
    this.extra = opts.extraServers ?? {};
    this.oauth = opts.oauth ?? new McpOAuth(config);
  }

  /** Replace the plugin-contributed server set and drop connections to removed ones. */
  setExtraServers(servers: Record<string, McpServerConfig>): void {
    this.extra = servers;
    this.syncRecords();
  }

  private serverConfigs(): Record<string, McpServerConfig> {
    return { ...this.extra, ...this.config.get().mcpServers };
  }

  private syncRecords(): void {
    const configs = this.serverConfigs();
    // Remove records for servers no longer present.
    for (const name of [...this.records.keys()]) {
      if (!configs[name]) {
        void this.disconnect(name);
        this.records.delete(name);
      }
    }
    for (const [name, cfg] of Object.entries(configs)) {
      const existing = this.records.get(name);
      if (!existing) {
        this.records.set(name, {
          name,
          config: cfg,
          state: cfg.enabled === false ? 'disabled' : 'failed',
          tools: [],
          attempts: 0,
          nextRetryAt: 0,
          gen: 0,
        });
      } else {
        const changed = JSON.stringify({ ...existing.config, enabled: undefined }) !== JSON.stringify({ ...cfg, enabled: undefined });
        existing.config = cfg;
        if (cfg.enabled === false) {
          if (existing.state !== 'disabled') this.dropClient(existing);
          existing.state = 'disabled';
        } else if (existing.state === 'disabled' || changed) {
          // turned back on, or the command, URL or env changed: start over on next use
          this.dropClient(existing);
          existing.gen++;
          existing.connecting = undefined;
          existing.state = 'failed';
          existing.error = undefined;
          existing.attempts = 0;
          existing.nextRetryAt = 0;
        }
      }
    }
  }

  /** Close a record's connection without touching its state (onclose ignores a client that is no longer current). */
  private dropClient(rec: ServerRecord): void {
    if (rec.connecting) {
      rec.gen++;
      rec.connecting = undefined;
    }
    const client = rec.client;
    rec.client = undefined;
    rec.tools = [];
    if (client) void client.close().catch(() => undefined);
  }

  private record(name: string): ServerRecord | undefined {
    this.syncRecords();
    return this.records.get(name);
  }

  /** The server's config, for the OAuth routes. */
  serverConfig(name: string): McpServerConfig | undefined {
    return this.record(name)?.config;
  }

  /** Signed in at the server's current URL. */
  private signedIn(rec: ServerRecord): boolean {
    return !!rec.config.url && this.oauth.hasTokens(rec.name, this.config.expand(rec.config.url));
  }

  /** Forget a server's sign-in and close its live connection, so nothing from before keeps using it. */
  signOut(name: string): void {
    this.oauth.disconnect(name);
    const rec = this.records.get(name);
    if (rec) this.dropClient(rec);
  }

  private makeTransport(name: string, cfg: McpServerConfig, preferSse = false): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    if (cfg.command) {
      return new StdioClientTransport({
        command: cfg.command,
        // placeholders expand in args too, so servers that take a DSN or key as an argument work
        args: (cfg.args ?? []).map((a) => this.config.expand(a)),
        env: stdioEnv(cfg, this.config.expandRecord(cfg.env)),
        cwd: cfg.cwd ? this.config.expand(cfg.cwd) : undefined,
      });
    }
    if (!cfg.url) throw new Error('mcp server needs a command or url');
    const headers = this.config.expandRecord(cfg.headers);
    const raw = this.config.expand(cfg.url);
    const url = new URL(raw);
    const oauth = cfg.auth === 'oauth' ? { authProvider: this.oauth.provider(name, raw), fetch: this.oauth.fetchFor() } : {};
    if (cfg.type === 'sse' || preferSse) {
      return new SSEClientTransport(url, { requestInit: headers ? { headers } : undefined, ...oauth });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: headers ? { headers } : undefined, ...oauth });
  }

  /** Ensure a server is connected. Throws if within a backoff cooldown or disabled. */
  async ensure(name: string): Promise<void> {
    const rec = this.record(name);
    if (!rec) throw new Error(`unknown mcp server: ${name}`);
    if (rec.config.enabled === false) {
      rec.state = 'disabled';
      throw new Error(`mcp server ${name} is disabled`);
    }
    if (rec.state === 'connected' && rec.client) return;
    if (rec.connecting) return rec.connecting;
    // no tokens yet: wait for Connect instead of dialing the server and retrying
    if (rec.config.auth === 'oauth' && !this.signedIn(rec)) {
      rec.state = 'needs-auth';
      rec.error = undefined;
      throw new Error(`mcp server ${name} needs you to connect it`);
    }
    if (rec.state === 'needs-auth') throw new Error(rec.error ?? `mcp server ${name} needs you to connect it`);
    if (rec.nextRetryAt && Date.now() < rec.nextRetryAt) throw new Error(rec.error ?? `mcp server ${name} is in backoff`);

    rec.state = 'connecting';
    const pending: Promise<void> = this.connect(rec).finally(() => {
      if (rec.connecting === pending) rec.connecting = undefined;
    });
    rec.connecting = pending;
    return pending;
  }

  private async connect(rec: ServerRecord): Promise<void> {
    const gen = rec.gen;
    const client = new Client({ name: 'conclave', version: '0.1.0' }, { capabilities: {} });
    const stale = () => {
      if (rec.gen === gen) return false;
      void client.close().catch(() => undefined);
      return true;
    };
    const isHttp = !rec.config.command && !!rec.config.url;
    try {
      await client.connect(this.makeTransport(rec.name, rec.config));
    } catch (err) {
      if (err instanceof UnauthorizedError && rec.config.auth === 'oauth') {
        if (stale()) return;
        return this.onConnectError(rec, err);
      }
      if (isHttp && rec.config.type !== 'sse') {
        // Fall back to SSE for servers that do not speak Streamable HTTP.
        try {
          await client.connect(this.makeTransport(rec.name, rec.config, true));
        } catch (err2) {
          if (stale()) return;
          return this.onConnectError(rec, err2 as Error);
        }
      } else {
        if (stale()) return;
        return this.onConnectError(rec, err as Error);
      }
    }
    if (stale()) return;

    client.onclose = () => {
      if (rec.client === client) {
        rec.state = 'failed';
        rec.client = undefined;
      }
    };

    try {
      const tools: ServerTool[] = [];
      let cursor: string | undefined;
      // a server may page its tool list; 50 pages is far past any real one
      for (let page = 0; page < 50; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(res.tools as ServerTool[]));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      const allow = rec.config.tools;
      rec.tools = tools.filter((t) => !allow || allow.includes(t.name));
    } catch (err) {
      if (stale()) return;
      return this.onConnectError(rec, err as Error);
    }
    if (stale()) return;

    rec.client = client;
    rec.state = 'connected';
    rec.error = undefined;
    rec.attempts = 0;
    rec.nextRetryAt = 0;
    log.info(`connected to mcp server ${rec.name} (${rec.tools.length} tools)`);
  }

  /** Remove expanded secret values from a message (an error may quote the URL or arguments). */
  private redact(cfg: McpServerConfig, msg: string): string {
    const refs = JSON.stringify([cfg.args, cfg.url, cfg.env, cfg.headers, cfg.cwd]).match(/\$\{secret:[A-Za-z0-9_.-]+\}/g) ?? [];
    let out = msg;
    for (const ref of new Set(refs)) {
      const value = this.config.expand(ref);
      if (value.length >= 4) out = out.split(value).join('***');
    }
    return out;
  }

  private onConnectError(rec: ServerRecord, err: Error): never {
    rec.client = undefined;
    err.message = this.redact(rec.config, err.message);
    if (err instanceof UnauthorizedError && rec.config.auth === 'oauth') {
      // the sign-in lapsed or was revoked: retrying cannot fix it, Connect can
      rec.state = 'needs-auth';
      rec.error = 'The sign-in expired or was revoked. Press Connect to sign in again.';
      log.warn(`mcp server ${rec.name} needs a new sign-in`);
      throw err;
    }
    rec.state = 'failed';
    rec.error = err.message;
    const delay = BACKOFF[Math.min(rec.attempts, BACKOFF.length - 1)];
    rec.attempts++;
    rec.nextRetryAt = Date.now() + delay;
    log.warn(`mcp server ${rec.name} connect failed: ${err.message}`);
    throw err;
  }

  private async disconnect(name: string): Promise<void> {
    const rec = this.records.get(name);
    if (rec?.client) {
      try {
        await rec.client.close();
      } catch {
        /* ignore */
      }
      rec.client = undefined;
      rec.state = 'failed';
    }
  }

  /** Connect every enabled server (lazily on first call) and return their tools. */
  async tools(): Promise<Tool[]> {
    this.syncRecords();
    await Promise.all(
      [...this.records.values()]
        .filter((r) => r.config.enabled !== false)
        .map((r) => this.ensure(r.name).catch(() => undefined)),
    );
    const out: Tool[] = [];
    for (const rec of this.records.values()) {
      if (rec.state !== 'connected') continue;
      for (const t of rec.tools) out.push(this.makeTool(rec.name, t, rec.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS));
    }
    return out;
  }

  private makeTool(server: string, t: ServerTool, timeoutMs: number): Tool {
    const readOnly = t.annotations?.readOnlyHint ?? false;
    const fullName = `mcp__${server}__${t.name}`;
    const manager = this;
    return {
      name: fullName,
      description: t.description ?? `${t.name} (via ${server})`,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      readOnly,
      timeoutMs,
      summarize: () => `${server}: ${t.name}`,
      async run(input, ctx): Promise<ToolOutput> {
        return manager.callTool(server, t.name, input as Record<string, unknown>, { signal: ctx.signal, timeoutMs });
      },
    };
  }

  /**
   * Call a tool on a server, connecting if needed. Used by tools and by
   * memory adapters. The call stops on the signal (a user stop) and after
   * the server's timeoutMs; progress from the server resets the timer, up to
   * 5 times the limit in total.
   */
  async callTool(server: string, name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ToolOutput> {
    await this.ensure(server);
    const rec = this.records.get(server);
    if (!rec?.client) return { content: `mcp server ${server} is not connected`, isError: true };
    const timeout = opts.timeoutMs ?? rec.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    try {
      const res = (await rec.client.callTool({ name, arguments: args }, undefined, {
        signal: opts.signal,
        timeout,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: timeout * 5,
        // asking for progress is what lets a slow server reset the timer
        onprogress: () => undefined,
      })) as {
        content?: Array<Record<string, unknown>>;
        isError?: boolean;
      };
      return mapToolResult(res);
    } catch (err) {
      // the SDK reports a stop with the timeout code too, so the signal is checked first
      if (opts.signal?.aborted) return { content: `mcp tool ${name} was stopped`, isError: true };
      if ((err as { code?: unknown }).code === ErrorCode.RequestTimeout) return timeoutOutput(timeout);
      return { content: `mcp tool ${name} failed: ${(err as Error).message}`, isError: true };
    }
  }

  /** Drop the connection and backoff, then connect again. For the "Restart" button. */
  async restart(name: string): Promise<McpStatus | undefined> {
    const rec = this.record(name);
    if (!rec) throw new Error(`unknown mcp server: ${name}`);
    await this.disconnect(name);
    rec.attempts = 0;
    rec.nextRetryAt = 0;
    rec.error = undefined;
    if (rec.state === 'needs-auth') rec.state = 'failed';
    await this.ensure(name).catch(() => undefined);
    return this.status().find((s) => s.name === name);
  }

  /** Tools a server exposes (connecting if needed), with their schemas. */
  async serverTools(name: string): Promise<Array<{ name: string; fullName: string; description?: string; inputSchema?: JsonSchema; readOnly: boolean }>> {
    await this.ensure(name);
    const rec = this.records.get(name);
    return (rec?.tools ?? []).map((t) => ({
      name: t.name,
      fullName: `mcp__${name}__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
      readOnly: t.annotations?.readOnlyHint ?? false,
    }));
  }

  /** Reconnect and report how it went, for the "Test" button. */
  async test(name: string): Promise<{ ok: boolean; ms: number; tools: number; error?: string }> {
    const started = Date.now();
    const st = await this.restart(name);
    return { ok: st?.status === 'connected', ms: Date.now() - started, tools: st?.tools ?? 0, error: st?.error };
  }

  status(): McpStatus[] {
    this.syncRecords();
    return [...this.records.values()].map((rec) => ({
      name: rec.name,
      status:
        rec.state === 'connected'
          ? 'connected'
          : rec.state === 'connecting'
            ? 'connecting'
            : rec.state === 'disabled'
              ? 'disabled'
              : 'failed',
      tools: rec.tools.length,
      error: rec.error,
      source: rec.config.command ? 'stdio' : (rec.config.type ?? 'http'),
      ...(rec.config.auth === 'oauth' ? { auth: rec.state === 'needs-auth' || !this.signedIn(rec) ? ('needs-auth' as const) : ('connected' as const) } : {}),
    }));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.records.keys()].map((n) => this.disconnect(n)));
  }
}

/**
 * Variables a stdio server gets from the hub unless it sets inheritEnv: the
 * basics, plus proxy, CA bundle and cache settings so npx and uvx servers
 * still download behind a proxy. Provider keys and tokens never pass.
 */
export const MCP_ENV_ALLOW = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_cafile',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'PIP_CERT', 'UV_NATIVE_TLS',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
];

/** The environment a stdio server starts with: the allowlist (or everything with inheritEnv), then its own env. */
export function stdioEnv(cfg: Pick<McpServerConfig, 'inheritEnv'>, own: Record<string, string> | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (cfg.inheritEnv) {
    for (const [k, v] of Object.entries(base)) if (typeof v === 'string') out[k] = v;
  } else {
    for (const k of MCP_ENV_ALLOW) if (typeof base[k] === 'string') out[k] = base[k] as string;
  }
  return { ...out, ...(own ?? {}) };
}

function mapToolResult(res: { content?: Array<Record<string, unknown>>; isError?: boolean }): ToolOutput {
  const blocks: Array<TextBlock | ImageBlock> = [];
  for (const c of res.content ?? []) {
    const type = c.type as string;
    if (type === 'text' && typeof c.text === 'string') {
      blocks.push({ type: 'text', text: c.text });
    } else if (type === 'image' && typeof c.data === 'string') {
      blocks.push({ type: 'image', mediaType: (c.mimeType as string) ?? 'image/png', data: c.data });
    } else if (type === 'audio') {
      blocks.push({ type: 'text', text: '[audio content omitted]' });
    } else if (type === 'resource') {
      const r = c.resource as Record<string, unknown> | undefined;
      if (r && typeof r.text === 'string') blocks.push({ type: 'text', text: r.text });
      else if (r && typeof r.uri === 'string') blocks.push({ type: 'text', text: `[resource: ${r.uri}]` });
    } else if (type === 'resource_link' && typeof c.uri === 'string') {
      blocks.push({ type: 'text', text: `[resource link: ${c.uri}]` });
    }
  }
  if (blocks.length === 1 && blocks[0].type === 'text') return { content: blocks[0].text, isError: res.isError };
  if (blocks.length === 0) return { content: '', isError: res.isError };
  return { content: blocks, isError: res.isError };
}
