/**
 * Conclave as an MCP server for other tools:
 *
 *   /mcp                       streamable HTTP (POST), stateless. Bearer token:
 *                              owner token, a paired client token or a gateway
 *                              key (everything), or an OAuth access token from
 *                              a connected app (what its scopes allow).
 *   GET /api/mcp-server/snippets  ready-to-paste config for Claude Code, Codex,
 *                              OpenCode and Gemini CLI (HTTP and stdio).
 *
 * The tools live in core (engine/hub-mcp.ts) so `conclave mcp` (stdio) can
 * proxy to this endpoint and serve the same set. OAuth scopes are checked
 * here, before the MCP SDK runs, because only an HTTP 401 or 403 makes
 * claude.ai and ChatGPT ask the owner to sign in again.
 */
import type { Hono } from 'hono';
import type { McpConnectStepDto, McpServerSnippets, OAuthScope } from '@conclave/core/client/index.ts';
import { HUB_MCP_TOOLS, MEMORY_CONTEXT_PROMPT, MEMORY_CONTEXT_URI, handleHubMcpRequest, hubMcpApiFor } from '@conclave/core/engine/hub-mcp.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import { mcpConnectPlan } from '@conclave/core/extensions/cli-sync.ts';
import type { HonoEnv, ServerContext } from './context';
import { bearerToken } from './auth';
import { publicUrl } from './routes';
import { bearerChallenge, isHubResource } from './oauth';
import { ACCESS_PREFIX, type AccessInfo } from './oauth/store';
import { SCOPES } from './oauth/scopes';

export const MCP_TOKEN_ENV = 'CONCLAVE_TOKEN';

/**
 * The scope an OAuth token needs for each tool. Add a row for every new
 * tool. A tool without a row is hidden from OAuth tokens and refused, so it
 * stays closed until someone gives it a scope. The hub token, paired app
 * tokens and gateway keys are not checked against this table.
 */
export const MCP_TOOL_SCOPES: Record<string, OAuthScope> = {
  memory_context: 'memory:read',
  memory_search: 'memory:read',
  memory_recent: 'memory:read',
  tasks_list: 'memory:read',
  routines_list: 'memory:read',
  memory_save: 'memory:write',
  memory_forget: 'memory:write',
  sessions_search: 'chats:read',
  chat_search: 'chats:read',
};

/** Prompts and resources, the same way. */
export const MCP_PROMPT_SCOPES: Record<string, OAuthScope> = { [MEMORY_CONTEXT_PROMPT]: 'memory:read' };
export const MCP_RESOURCE_SCOPES: Record<string, OAuthScope> = { [MEMORY_CONTEXT_URI]: 'memory:read' };

/**
 * Who called /mcp: someone with a hub credential (every tool), or a connected
 * app with its scopes. Either way the tools see one account: the token's
 * (gateway keys are the owner's), or the account that allowed the app.
 */
type McpCaller = { kind: 'full'; accountId: string } | { kind: 'oauth'; access: AccessInfo };

function mcpCaller(ctx: ServerContext, req: Request): McpCaller | undefined {
  // headers only: a token in the query string ends up in logs and browser history
  const token = bearerToken(req, new URL(req.url), false) ?? req.headers.get('x-api-key') ?? undefined;
  if (!token) return undefined;
  if (token.startsWith(ACCESS_PREFIX)) {
    const access = ctx.oauth.store.access(token);
    // a token is only good for the resource it was issued for: this hub's /mcp (RFC 8707)
    return access && isHubResource(ctx, req, access.resource) ? { kind: 'oauth', access } : undefined;
  }
  const who = ctx.auth.check(token);
  if (who) return { kind: 'full', accountId: who.accountId };
  return ctx.auth.checkGatewayKey(token) ? { kind: 'full', accountId: OWNER_ID } : undefined;
}

/** The scope a JSON-RPC message needs, null when it needs none, undefined when nothing may give it. */
function scopeFor(msg: unknown): OAuthScope | null | undefined {
  if (!msg || typeof msg !== 'object') return null;
  const { method, params } = msg as { method?: unknown; params?: Record<string, unknown> };
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    if (name in MCP_TOOL_SCOPES) return MCP_TOOL_SCOPES[name];
    // a hub tool without a row is closed; an unknown name gets the SDK's own error
    return HUB_MCP_TOOLS.some((t) => t.name === name) ? undefined : null;
  }
  if (method === 'prompts/get') {
    const name = typeof params?.name === 'string' ? params.name : '';
    return name in MCP_PROMPT_SCOPES ? MCP_PROMPT_SCOPES[name] : null;
  }
  if (method === 'resources/read') {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    return uri in MCP_RESOURCE_SCOPES ? MCP_RESOURCE_SCOPES[uri] : null;
  }
  return null;
}

/** What the request's messages need that the token does not hold, or 'closed' for a tool no scope opens. */
async function missingScopes(req: Request, held: readonly OAuthScope[]): Promise<OAuthScope[] | 'closed'> {
  if (req.method !== 'POST') return [];
  let body: unknown;
  try {
    body = JSON.parse(await req.clone().text());
  } catch {
    return []; // the SDK answers a parse error
  }
  const missing = new Set<OAuthScope>();
  for (const msg of Array.isArray(body) ? body : [body]) {
    const need = scopeFor(msg);
    if (need === undefined) return 'closed';
    if (need && !held.includes(need)) missing.add(need);
  }
  return [...missing];
}

function allowFor(held: readonly OAuthScope[]) {
  return (kind: 'tool' | 'prompt' | 'resource', name: string): boolean => {
    const table = kind === 'tool' ? MCP_TOOL_SCOPES : kind === 'prompt' ? MCP_PROMPT_SCOPES : MCP_RESOURCE_SCOPES;
    const need = table[name];
    return !!need && held.includes(need);
  };
}

export function mcpSnippets(url: string): McpServerSnippets {
  const http = mcpConnectPlan('conclave', { type: 'http', url, headers: { Authorization: `Bearer \${env:${MCP_TOKEN_ENV}}` } }) as McpConnectStepDto[];
  const stdio = mcpConnectPlan('conclave', { type: 'stdio', command: 'conclave', args: ['mcp'] }) as McpConnectStepDto[];
  return {
    url,
    tokenEnv: MCP_TOKEN_ENV,
    tools: HUB_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    http,
    stdio,
    notes: [
      `Set ${MCP_TOKEN_ENV} to a gateway key (Settings, Gateway keys: one per tool so you can revoke it) or the hub token. Keep it out of files you commit.`,
      'The stdio form needs the Conclave CLI on that machine, logged in to this hub (conclave login). It forwards to the same endpoint.',
      'claude.ai and ChatGPT sign in with OAuth instead: add the same URL as a custom connector and allow it on the Conclave page that opens. Settings, Connected apps lists them.',
      'Search covers local memory and every memory connection. Saves go through the same secret filter and dedupe as Conclave itself.',
      "To make an agent use it, add a line to that tool's instruction file (CLAUDE.md, AGENTS.md, GEMINI.md), for example: \"At the start of every chat, call Conclave's memory_context. Search the conclave memory tools before answering questions about my setup, and save durable facts there.\"",
    ],
  };
}

export function registerMcpEndpoint(app: Hono<HonoEnv>, ctx: ServerContext): void {
  app.all('/mcp', async (c) => {
    const req = c.req.raw;
    const caller = mcpCaller(ctx, req);
    if (!caller) {
      const sent = !!(req.headers.get('authorization') || req.headers.get('x-api-key'));
      // the 401 and its resource_metadata start the sign in in claude.ai and ChatGPT
      return c.json(
        { error: sent ? 'invalid_token' : 'unauthorized', error_description: sent ? 'The token is wrong, expired or revoked.' : 'Sign in to use this server.' },
        401,
        { 'www-authenticate': bearerChallenge(req, sent ? { error: 'invalid_token', description: 'The token is wrong, expired or revoked.' } : {}) },
      );
    }
    if (caller.kind === 'full') return handleHubMcpRequest(hubMcpApiFor(ctx.engine, caller.accountId), req);
    const held = caller.access.scope;
    const missing = await missingScopes(req, held);
    if (missing === 'closed') {
      return c.json({ jsonrpc: '2.0', error: { code: -32601, message: 'This tool is not open to connected apps.' }, id: null }, 403);
    }
    if (missing.length) {
      // step up (MCP 2025-11-25): name everything the app needs, the scopes it holds and the new ones
      const want = SCOPES.filter((s) => held.includes(s) || missing.includes(s));
      const description = `This needs ${missing.join(' and ')}, which the owner did not allow.`;
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: description }, id: null }, 403, {
        'www-authenticate': bearerChallenge(req, { error: 'insufficient_scope', description, scope: want }),
      });
    }
    return handleHubMcpRequest(hubMcpApiFor(ctx.engine, caller.access.grant.accountId), req, { allow: allowFor(held) });
  });

  app.get('/api/mcp-server/snippets', (c) => c.json(mcpSnippets(`${publicUrl(ctx, c.req.raw)}/mcp`)));
}
