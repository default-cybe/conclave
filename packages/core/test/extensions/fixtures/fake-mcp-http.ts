/**
 * In-process fakes for the MCP OAuth tests: an authorization server with
 * discovery, dynamic registration, PKCE and rotating refresh tokens next to
 * an MCP server that wants its bearer tokens (fakeOAuthMcp), and a fake
 * AFFiNE MCP server with a static bearer token and Markdown tools
 * (fakeAffineMcp). Stateless Streamable HTTP, one SDK server per request.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
type Handler = (name: string, args: Record<string, unknown>) => string;

async function mcpResponse(req: Request, tools: ToolDef[], handle: Handler): Promise<Response> {
  const server = new Server({ name: 'fake', version: '0.0.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: 'text', text: handle(r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>) }] }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

const b64url = (b: Buffer) => b.toString('base64url');
const tok = (p: string) => `${p}_${b64url(randomBytes(12))}`;

export interface FakeOAuthMcp {
  url: string;
  origin: string;
  /** Hits on /mcp, any answer. */
  mcpHits: number;
  /** Requests of any kind that carried an Authorization header. */
  authHeaders: number;
  registrations: number;
  refreshCalls: number;
  /** Every token the server issued, to check none reaches a log or secrets.json in the clear. */
  issued: string[];
  /** Access tokens stop working; the refresh token still does. */
  expireAccess(): void;
  /** Everything stops working, as when the owner removes the app at the provider. */
  revokeAll(): void;
  currentRefresh(): string | undefined;
  /** Hold refresh answers until the returned function runs. */
  holdRefresh(): () => void;
  stop(): void;
}

export function fakeOAuthMcp(opts: { authServers?: string[] } = {}): FakeOAuthMcp {
  let hold: Promise<void> | undefined;
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { client: string; challenge: string; redirect: string }>();
  let access = new Set<string>();
  let refresh: string | undefined;
  const tools: ToolDef[] = [{ name: 'whoami', description: 'Who the token belongs to.', inputSchema: { type: 'object', properties: {} } }];

  const issue = () => {
    const a = tok('at');
    const r = tok('rt');
    access.add(a);
    refresh = r;
    state.issued.push(a, r);
    return Response.json({ access_token: a, token_type: 'Bearer', expires_in: 3600, refresh_token: r });
  };
  const bad = (error: string) => Response.json({ error }, { status: 400 });

  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      const origin = u.origin;
      if (req.headers.get('authorization')) state.authHeaders++;
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: opts.authServers ?? [origin] });
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (u.pathname === '/register' && req.method === 'POST') {
        const meta = (await req.json()) as { redirect_uris: string[] };
        const id = tok('client');
        clients.set(id, { redirect_uris: meta.redirect_uris });
        state.registrations++;
        return Response.json({ ...meta, client_id: id }, { status: 201 });
      }
      if (u.pathname === '/authorize') {
        // the owner pressing Allow
        const q = u.searchParams;
        const c = clients.get(q.get('client_id') ?? '');
        if (!c || !c.redirect_uris.includes(q.get('redirect_uri') ?? '')) return bad('invalid_client');
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return bad('invalid_request');
        const code = tok('code');
        codes.set(code, { client: q.get('client_id')!, challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')! });
        const back = new URL(q.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state') ?? '');
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      if (u.pathname === '/token' && req.method === 'POST') {
        const p = new URLSearchParams(await req.text());
        if (p.get('grant_type') === 'authorization_code') {
          const c = codes.get(p.get('code') ?? '');
          codes.delete(p.get('code') ?? '');
          if (!c || c.client !== p.get('client_id') || c.redirect !== p.get('redirect_uri')) return bad('invalid_grant');
          if (b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) !== c.challenge) return bad('invalid_grant');
          return issue();
        }
        if (p.get('grant_type') === 'refresh_token') {
          state.refreshCalls++;
          await hold;
          if (!refresh || p.get('refresh_token') !== refresh) {
            // like Notion: an old refresh token used again ends the whole connection
            refresh = undefined;
            access = new Set();
            return bad('invalid_grant');
          }
          return issue();
        }
        return bad('unsupported_grant_type');
      }
      if (u.pathname === '/mcp') {
        state.mcpHits++;
        const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
        if (!bearer || !access.has(bearer)) {
          return new Response(JSON.stringify({ error: 'invalid_token' }), {
            status: 401,
            headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
          });
        }
        return mcpResponse(req, tools, () => 'owner@example.com');
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${srv.port}`;
  const state: FakeOAuthMcp = {
    url: `${origin}/mcp`,
    origin,
    mcpHits: 0,
    authHeaders: 0,
    registrations: 0,
    refreshCalls: 0,
    issued: [],
    expireAccess: () => (access = new Set()),
    revokeAll: () => {
      access = new Set();
      refresh = undefined;
    },
    currentRefresh: () => refresh,
    holdRefresh: () => {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = undefined;
        release();
      };
    },
    stop: () => srv.stop(true),
  };
  return state;
}

export interface FakeAffine {
  url: string;
  docs: Map<string, { title: string; markdown: string }>;
  unauthorized: number;
  stop(): void;
}

/** The community AFFiNE server in HTTP mode with AFFINE_MCP_AUTH_MODE=bearer, backed by an in-memory "AFFiNE". */
export function fakeAffineMcp(token: string): FakeAffine {
  const docs = new Map<string, { title: string; markdown: string }>();
  const tools: ToolDef[] = [
    { name: 'create_doc_from_markdown', description: 'Create a doc from Markdown.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } }, required: ['markdown'] } },
    { name: 'append_markdown', description: 'Append Markdown to a doc.', inputSchema: { type: 'object', properties: { docId: { type: 'string' }, markdown: { type: 'string' } }, required: ['docId', 'markdown'] } },
  ];
  const handle: Handler = (name, args) => {
    if (name === 'create_doc_from_markdown') {
      const id = `doc${docs.size + 1}`;
      docs.set(id, { title: String(args.title ?? 'Untitled'), markdown: String(args.markdown) });
      return JSON.stringify({ docId: id });
    }
    const d = docs.get(String(args.docId));
    if (!d) return 'no such doc';
    d.markdown += `\n${String(args.markdown)}`;
    return JSON.stringify({ docId: args.docId, ok: true });
  };
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname !== '/mcp') return new Response('not found', { status: 404 });
      if (req.headers.get('authorization') !== `Bearer ${token}`) {
        out.unauthorized++;
        return new Response('unauthorized', { status: 401 });
      }
      return mcpResponse(req, tools, handle);
    },
  });
  const out: FakeAffine = { url: `http://127.0.0.1:${srv.port}/mcp`, docs, unauthorized: 0, stop: () => srv.stop(true) };
  return out;
}
