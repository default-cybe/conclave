/**
 * MCP plumbing for memory connections. A connection either names a server
 * from config.mcpServers (then the engine's McpManager runs it and its tools
 * are also visible to agents) or defines one inline (then Conclave starts a
 * private client just for memory).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ConfigStore } from '../../config';
import type { McpServerConfig } from '../../config/schema';
import { EngineError } from '../../engine/errors';
import type { AdapterDeps, McpClientFactory, McpClientHandle } from './types';
import { optRecord, optStr, optStrArr, withTimeout } from './util';

/** How long the first connect may take. uvx and npx download on first run. */
export const MCP_CONNECT_TIMEOUT_MS = 90_000;

export interface McpServerSpec {
  /** Name of an entry in config.mcpServers. */
  ref?: string;
  /** Inline server started by the connection itself. */
  inline?: McpServerConfig;
}

/** Read server, command/args/env or url/headers/transport from connection options. */
export function serverSpecFromOptions(o: Record<string, unknown>, fallback?: McpServerConfig): McpServerSpec {
  const ref = optStr(o, 'server');
  if (ref) return { ref };
  const command = optStr(o, 'command');
  const url = optStr(o, 'url');
  if (command) return { inline: { type: 'stdio', command, args: optStrArr(o, 'args') ?? [], env: optRecord(o, 'env') } };
  if (url) {
    const t = optStr(o, 'transport');
    return { inline: { type: t === 'sse' ? 'sse' : 'http', url, headers: optRecord(o, 'headers') } };
  }
  if (!fallback) return {};
  // the default server (uvx basic-memory, npx server-memory) still takes options.env, e.g. MEMORY_FILE_PATH
  const env = Object.fromEntries(Object.entries(optRecord(o, 'env') ?? {}).filter(([, v]) => v !== ''));
  return { inline: Object.keys(env).length ? { ...fallback, env: { ...(fallback.env ?? {}), ...env } } : fallback };
}

export function describeSpec(spec: McpServerSpec): string {
  if (spec.ref) return `mcpServers.${spec.ref}`;
  const s = spec.inline;
  if (!s) return '(no server)';
  if (s.command) return [s.command, ...(s.args ?? [])].join(' ');
  return s.url ?? '(no url)';
}

/**
 * Default factory: a plain SDK client. stdio servers get their stderr kept
 * (not printed) so a failed start can say why.
 */
export function defaultMcpClientFactory(config: ConfigStore, opts: { baseEnv?: Record<string, string> } = {}): McpClientFactory {
  return async (name, cfg) => {
    const client = new Client({ name: `conclave-${name}`, version: '0.1.0' }, { capabilities: {} });
    let stderrTail = '';
    if (cfg.command) {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        // a member's Basic Memory gets a bare environment instead of the hub's (people/memory.ts)
        env: { ...(opts.baseEnv ?? (process.env as Record<string, string>)), ...(config.expandRecord(cfg.env) ?? {}) },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      try {
        await client.connect(transport);
      } catch (err) {
        const tail = stderrTail.trim().split('\n').slice(-3).join(' | ');
        const e = new Error(`${(err as Error).message}${tail ? ` (stderr: ${tail})` : ''}`) as Error & { code?: string };
        e.code = (err as { code?: string }).code;
        throw e;
      }
    } else if (cfg.url) {
      const headers = config.expandRecord(cfg.headers);
      const url = new URL(config.expand(cfg.url));
      const init = headers ? { requestInit: { headers } } : undefined;
      if (cfg.type === 'sse') await client.connect(new SSEClientTransport(url, init));
      else {
        try {
          await client.connect(new StreamableHTTPClientTransport(url, init));
        } catch (err) {
          // older servers only speak SSE
          try {
            await client.connect(new SSEClientTransport(url, init));
          } catch {
            throw err;
          }
        }
      }
    } else throw new Error('MCP server needs a command or a url');

    return {
      async callTool(tool, args, opts) {
        return client.callTool({ name: tool, arguments: args }, undefined, opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
      },
      async listTools() {
        const res = await client.listTools();
        return res.tools.map((t) => t.name);
      },
      async close() {
        await client.close().catch(() => {});
      },
    };
  };
}

/**
 * One MCP server as a memory connection sees it. Connects lazily, keeps the
 * client, and drops it after a transport failure so the next call reconnects.
 */
export class McpEndpoint {
  private handle?: McpClientHandle;
  private connecting?: Promise<McpClientHandle>;

  constructor(
    private name: string,
    readonly spec: McpServerSpec,
    private deps: AdapterDeps,
  ) {}

  get command(): string | undefined {
    return this.spec.inline?.command;
  }

  get url(): string | undefined {
    return this.spec.inline?.url;
  }

  private async client(): Promise<McpClientHandle> {
    if (this.spec.ref) {
      // plugin servers are not in config.mcpServers, so unknown names are left to the MCP manager to report
      const ref = this.spec.ref;
      if (!this.deps.callTool) throw new EngineError(500, 'The hub MCP manager is not wired to memory connections.');
      const callTool = this.deps.callTool;
      const listTools = this.deps.listTools;
      return {
        callTool: (tool, args) => callTool(ref, tool, args),
        listTools: listTools ? () => listTools(ref) : undefined,
      };
    }
    if (!this.spec.inline) throw new EngineError(400, 'Set options.server (a name from mcpServers), options.command, or options.url.');
    if (this.handle) return this.handle;
    if (!this.connecting) {
      const factory = this.deps.mcpClientFactory ?? defaultMcpClientFactory(this.deps.config);
      const inline = this.spec.inline;
      const started = factory(this.name, inline);
      this.connecting = withTimeout(started, MCP_CONNECT_TIMEOUT_MS, 'MCP connect')
        .then((h) => {
          this.handle = h;
          return h;
        })
        .catch((err) => {
          // a client that connects after the timeout is nobody's: close it so no stdio process lingers
          started.then((h) => h.close?.()).catch(() => {});
          throw err;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return this.connecting;
  }

  /** Connect (if needed) without calling anything. */
  async connect(): Promise<void> {
    await this.client();
  }

  async callTool(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const c = await this.client();
    try {
      return await c.callTool(tool, args, { timeoutMs });
    } catch (err) {
      // transport errors: drop the client so the next call starts fresh
      if (!this.spec.ref && /closed|not connected|EPIPE|ECONNRESET|terminated|Connection/i.test((err as Error).message)) await this.reset();
      throw err;
    }
  }

  async listTools(): Promise<string[] | undefined> {
    const c = await this.client();
    return c.listTools ? c.listTools() : undefined;
  }

  async reset(): Promise<void> {
    const h = this.handle;
    this.handle = undefined;
    await h?.close?.().catch(() => {});
  }

  async close(): Promise<void> {
    if (this.connecting) await this.connecting.catch(() => {});
    await this.reset();
  }
}
