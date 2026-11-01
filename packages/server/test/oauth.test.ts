import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { OWNER, startHub, type TestHub } from './helpers';
import { HUB_MCP_TOOLS } from '@conclave/core/engine/hub-mcp.ts';
import { MCP_TOOL_SCOPES } from '../src/mcp-endpoint';
import { cleanName, matchRedirect, nameWarning } from '../src/oauth/checks';
import { isPublicAddress } from '../src/oauth/cimd';
import { MAX_UNUSED_CLIENTS, OAuthStore } from '../src/oauth/store';
import { openDb } from '@conclave/core/storage/db.ts';

/**
 * The hub as the OAuth server for /mcp (docs/design/MCP-OAUTH.md). Each
 * describe block is one threat from that page, by name. The client side is
 * played with plain fetch calls, the way claude.ai and ChatGPT talk to it.
 */

let clock = Date.now();
const docs = new Map<string, { status?: number; body?: unknown; headers?: Record<string, string> }>();
const fetched: string[] = [];
let hub: TestHub;

beforeAll(() => {
  hub = startHub({
    oauth: {
      now: () => clock,
      cimd: {
        resolve: async (host) => (host === 'internal.example' ? ['10.0.0.5'] : host === 'rebind.example' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34']),
        fetch: async (url) => {
          fetched.push(url);
          const d = docs.get(url);
          if (!d) return new Response('not found', { status: 404 });
          return new Response(typeof d.body === 'string' ? d.body : JSON.stringify(d.body), { status: d.status ?? 200, headers: d.headers });
        },
      },
    },
  });
});
afterAll(() => hub.stop());

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${hub.url}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...body }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function authorizeUrl(p: Record<string, string | undefined>) {
  const u = new URL(`${hub.url}/oauth/authorize`);
  for (const [k, v] of Object.entries(p)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

async function authorize(p: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  return fetch(authorizeUrl(p), { redirect: 'manual', headers });
}

const requestId = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('request')!;

async function readRequest(id: string, token: string | null = OWNER) {
  const res = await hub.api(`/api/oauth/requests/${id}`, { token });
  return { status: res.status, body: (await res.json()) as any };
}

async function decide(id: string, body: Record<string, unknown>, token: string | null = OWNER) {
  const res = await hub.api(`/api/oauth/requests/${id}`, { method: 'POST', json: body, token });
  return { status: res.status, body: (await res.json()) as any };
}

/** Register (or reuse) a client and walk to a code: authorize, read the request, allow. */
async function getCode(opts: { client?: any; scope?: string; redirectUri?: string; allow?: string[]; state?: string } = {}) {
  const client = opts.client ?? (await register()).body;
  const { verifier, challenge } = pkce();
  const redirectUri = opts.redirectUri ?? client.redirect_uris[0];
  const state = opts.state ?? randomBytes(8).toString('hex');
  const res = await authorize({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: opts.scope ?? 'memory:read memory:write chats:read offline_access',
    resource: `${hub.url}/mcp`,
  });
  expect(res.status).toBe(302);
  const id = requestId(res);
  const req = await readRequest(id);
  const answer = await decide(id, { decision: 'allow', consent: req.body.consent, ...(opts.allow ? { scopes: opts.allow } : {}) });
  expect(answer.status).toBe(200);
  const back = new URL(answer.body.redirect);
  return { client, verifier, challenge, redirectUri, state, code: back.searchParams.get('code')!, back, request: req.body };
}

async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${hub.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params).toString() });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

async function exchange(g: Awaited<ReturnType<typeof getCode>>, extra: Record<string, string> = {}) {
  return token({ grant_type: 'authorization_code', code: g.code, code_verifier: g.verifier, redirect_uri: g.redirectUri, client_id: g.client.client_id, resource: `${hub.url}/mcp`, ...extra });
}

async function connect(opts: Parameters<typeof getCode>[0] = {}) {
  const g = await getCode(opts);
  const t = await exchange(g);
  expect(t.status).toBe(200);
  return { ...g, access: t.body.access_token as string, refresh: t.body.refresh_token as string, scope: t.body.scope as string };
}

function rpc(tokenValue: string | null, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${hub.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

const call = (t: string, name: string, args: Record<string, unknown> = {}) => rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

// ---------------------------------------------------------------------------

describe('discovery', () => {
  test('401 from /mcp points at the metadata and names the scopes', async () => {
    const res = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate')!;
    expect(h).toStartWith('Bearer ');
    expect(h).toContain(`resource_metadata="${hub.url}/.well-known/oauth-protected-resource/mcp"`);
    expect(h).toContain('scope="memory:read memory:write chats:read"');
    expect(h).not.toContain('error=');
    const bad = await rpc('cat_not-a-real-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  test('protected resource metadata (RFC 9728) at both paths, and server metadata (RFC 8414)', async () => {
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = (await (await fetch(hub.url + p)).json()) as any;
      expect(prm.resource).toBe(`${hub.url}/mcp`);
      expect(prm.authorization_servers).toEqual([hub.url]);
      expect(prm.scopes_supported).toEqual(['memory:read', 'memory:write', 'chats:read']);
      expect(prm.bearer_methods_supported).toEqual(['header']);
    }
    const res = await fetch(`${hub.url}/.well-known/oauth-authorization-server`, { headers: { origin: 'https://inspector.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const as = (await res.json()) as any;
    expect(as.issuer).toBe(hub.url);
    expect(as.authorization_endpoint).toBe(`${hub.url}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${hub.url}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${hub.url}/oauth/register`);
    expect(as.revocation_endpoint).toBe(`${hub.url}/oauth/revoke`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.token_endpoint_auth_methods_supported).toContain('none');
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(as.scopes_supported).toContain('offline_access');
  });

  test('the hub token, paired apps and gateway keys keep full access, unchanged', async () => {
    const key = (await (await hub.api('/api/gateway/keys', { method: 'POST', json: { name: 'codex' } })).json()) as any;
    for (const t of [OWNER, key.key]) {
      const list = (await (await rpc(t, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as any;
      expect(list.result.tools.map((x: { name: string }) => x.name)).toContain('memory_save');
      expect((await call(t, 'memory_save', { content: 'Full access still works' })).status).toBe(200);
    }
  });

  test('every hub tool has a row in the scope table', () => {
    for (const t of HUB_MCP_TOOLS) expect(MCP_TOOL_SCOPES[t.name]).toBeDefined();
  });
});

describe('the whole flow, by hand', () => {
  test('register, authorize, consent, code, memory_context, refresh, revoke, then 401', async () => {
    await hub.engine.memory.save({ content: 'The Proxmox host is called madx.', kind: 'fact', importance: 0.9 });
    const reg = await register();
    expect(reg.status).toBe(201);
    expect(reg.body.client_id).toStartWith('ccid_');
    expect(reg.body.client_secret).toBeUndefined();
    const g = await getCode({ client: reg.body, state: 'xyz-state' });
    expect(g.request.app).toMatchObject({ name: 'Claude', host: 'claude.ai', loopback: false });
    expect(g.request.app.warning).toBeUndefined();
    expect(g.request.scopes.map((s: { id: string }) => s.id)).toEqual(['memory:read', 'memory:write', 'chats:read']);
    expect(g.back.origin + g.back.pathname).toBe(CLAUDE);
    expect(g.back.searchParams.get('state')).toBe('xyz-state');
    expect(g.back.searchParams.get('iss')).toBe(hub.url);
    expect(g.code).toStartWith('cac_');

    const t = await exchange(g);
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'memory:read memory:write chats:read' });
    const ctxRes = (await (await call(t.body.access_token, 'memory_context')).json()) as any;
    expect(ctxRes.result.content[0].text).toContain('The Proxmox host is called madx.');

    const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: reg.body.client_id });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).not.toBe(t.body.refresh_token);
    expect((await call(t.body.access_token, 'memory_context')).status).toBe(401);
    expect((await call(r.body.access_token, 'memory_context')).status).toBe(200);

    const apps = (await (await hub.api('/api/oauth/apps')).json()) as any[];
    const mine = apps.find((a) => a.name === 'Claude' && a.host === 'claude.ai');
    expect(mine).toBeDefined();
    expect(mine.scopes.map((s: { id: string }) => s.id)).toEqual(['memory:read', 'memory:write', 'chats:read']);
    expect(mine.lastUsedAt).toBeGreaterThan(0);

    const rv = await fetch(`${hub.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: r.body.refresh_token, client_id: reg.body.client_id }) });
    expect(rv.status).toBe(200);
    expect((await call(r.body.access_token, 'memory_context')).status).toBe(401);

    const actions = hub.engine.repos.audit.list({ limit: 200 }).map((a) => a.action);
    for (const a of ['oauth.register', 'oauth.consent', 'oauth.token', 'oauth.revoke']) expect(actions).toContain(a);
  });

  test('a confidential client (client_secret_basic) needs its secret at the token endpoint', async () => {
    const reg = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_basic' });
    expect(reg.body.client_secret).toStartWith('ccs_');
    const g = await getCode({ client: reg.body });
    expect(g.request.app.warning).toBeUndefined();
    const noSecret = await exchange(g);
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe('invalid_client');
    const g2 = await getCode({ client: reg.body });
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(reg.body.client_id)}:${encodeURIComponent(reg.body.client_secret)}`).toString('base64')}`;
    const ok = await token({ grant_type: 'authorization_code', code: g2.code, code_verifier: g2.verifier, redirect_uri: g2.redirectUri }, { authorization: basic });
    expect(ok.status).toBe(200);
  });

  test('a client known by its metadata document URL (CIMD)', async () => {
    const id = 'https://claude.ai/oauth/claude-code-client-metadata';
    docs.set(id, { body: { client_id: id, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' } });
    const g = await getCode({ client: { client_id: id, redirect_uris: ['http://localhost:51234/callback'] } });
    expect(g.request.app).toMatchObject({ name: 'Claude Code', host: 'localhost', identity: 'claude.ai', kind: 'cimd', loopback: true });
    expect(g.request.app.warning).toContain('Any program there can use this name');
    expect(g.back.toString()).toStartWith('http://localhost:51234/callback?code=');
    const t = await exchange(g);
    expect(t.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 1. stolen codes

describe('1. a stolen authorization code', () => {
  test('code: plain PKCE and a missing challenge are refused', async () => {
    const client = (await register()).body;
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, state: 's1', resource: `${hub.url}/mcp` };
    for (const extra of [{}, { code_challenge: pkce().challenge }, { code_challenge: pkce().challenge, code_challenge_method: 'plain' }, { code_challenge: 'short', code_challenge_method: 'S256' }]) {
      const res = await authorize({ ...base, ...extra });
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get('location')!);
      expect(back.origin + back.pathname).toBe(CLAUDE);
      expect(back.searchParams.get('error')).toBe('invalid_request');
      expect(back.searchParams.get('state')).toBe('s1');
    }
  });

  test('code: wrong verifier, other client and other redirect fail', async () => {
    const g = await getCode();
    expect((await exchange(g, { code_verifier: pkce().verifier })).body.error).toBe('invalid_grant');
    const g2 = await getCode();
    const other = (await register()).body;
    expect((await exchange(g2, { client_id: other.client_id })).body.error).toBe('invalid_grant');
    const g3 = await getCode();
    expect((await exchange(g3, { redirect_uri: 'https://claude.ai/api/mcp/auth_callback2' })).body.error).toBe('invalid_grant');
    const g4 = await getCode();
    expect((await exchange(g4, { code_verifier: '' })).body.error).toBe('invalid_request');
  });

  test('code: works once, and a replay revokes what it made', async () => {
    const g = await getCode();
    const first = await exchange(g);
    expect(first.status).toBe(200);
    expect((await call(first.body.access_token, 'memory_recent')).status).toBe(200);
    const again = await exchange(g);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
    expect((await call(first.body.access_token, 'memory_recent')).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: g.client.client_id })).body.error).toBe('invalid_grant');
    expect(hub.engine.repos.audit.list({ limit: 50 }).some((a) => a.action === 'oauth.replay')).toBe(true);
  });

  test('code: expires after 10 minutes', async () => {
    const g = await getCode();
    clock += 10 * 60_000 + 1;
    try {
      expect((await exchange(g)).body.error).toBe('invalid_grant');
    } finally {
      clock -= 10 * 60_000 + 1;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. redirects

describe('2. redirect tricks and open redirects', () => {
  test('redirect: registration refuses http, javascript, fragments and user info', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,hi', 'https://claude.ai/cb#frag', 'https://user:pw@claude.ai/cb', 'com.example.app:/cb', 'https:///nohost', 'https:\\\\evil.example\\cb', '/relative/cb', 'http://192.168.1.5/cb', 'http://localhost.evil.example/cb']) {
      const r = await register({ redirect_uris: [uri] });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_redirect_uri');
    }
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: ['http://localhost:3000/cb', 'http://[::1]/cb', 'http://127.0.0.1/cb'] })).status).toBe(201);
  });

  test('redirect: near misses are refused without a redirect', async () => {
    const client = (await register()).body;
    const { challenge } = pkce();
    for (const uri of [
      'https://claude.ai/api/mcp/auth_callback/',
      'https://claude.ai/api/mcp/auth_callback.evil.example',
      'https://claude.ai.evil.example/api/mcp/auth_callback',
      'https://claude.ai/api/mcp/auth_callback?next=https://evil.example',
      'https://claude.ai/api/mcp/auth_callback/../../evil',
      'https://CLAUDE.ai/api/mcp/auth_callback',
      'https://claude.ai:443/api/mcp/auth_callback',
      'https://evil.example/',
    ]) {
      const res = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: uri, code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('Conclave stopped here and sent nothing');
    }
    // an unknown client is the same: no redirect at all
    const unknown = await authorize({ response_type: 'code', client_id: 'ccid_nope', redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
  });

  test('redirect: loopback ignores the port and nothing else', () => {
    const reg = ['http://localhost/callback', 'http://127.0.0.1/callback'];
    expect(matchRedirect(reg, 'http://localhost:51234/callback')).toBe('http://localhost:51234/callback');
    expect(matchRedirect(reg, 'http://127.0.0.1:9/callback')).toBe('http://127.0.0.1:9/callback');
    expect(matchRedirect(['http://localhost:3000/callback'], 'http://localhost:4000/callback')).toBe('http://localhost:4000/callback');
    expect(matchRedirect(reg, 'http://localhost:51234/callback/x')).toBeUndefined();
    expect(matchRedirect(reg, 'http://localhost:51234/callback?x=1')).toBeUndefined();
    expect(matchRedirect(reg, 'https://localhost:51234/callback')).toBeUndefined();
    expect(matchRedirect(['http://localhost/callback'], 'http://127.0.0.1:5/callback')).toBeUndefined();
    expect(matchRedirect(reg, 'http://localhost:51234/x/../callback')).toBeUndefined();
    expect(matchRedirect(['https://claude.ai/cb'], 'https://claude.ai:8443/cb')).toBeUndefined();
  });

  test('redirect: errors after the check carry state and iss', async () => {
    const client = (await register()).body;
    const res = await authorize({ response_type: 'token', client_id: client.client_id, redirect_uri: CLAUDE, state: 'abc', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('unsupported_response_type');
    expect(back.searchParams.get('state')).toBe('abc');
    expect(back.searchParams.get('iss')).toBe(hub.url);
    // deny carries them too
    const { challenge } = pkce();
    const ok = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, state: 'st2', code_challenge: challenge, code_challenge_method: 'S256' });
    const id = requestId(ok);
    const denied = await decide(id, { decision: 'deny', consent: (await readRequest(id)).body.consent });
    const d = new URL(denied.body.redirect);
    expect(d.searchParams.get('error')).toBe('access_denied');
    expect(d.searchParams.get('state')).toBe('st2');
    expect(d.searchParams.get('iss')).toBe(hub.url);
    expect(d.searchParams.get('code')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. consent

async function openRequest(scope = 'memory:read memory:write') {
  const client = (await register()).body;
  const res = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', scope });
  expect(res.headers.get('location')).toStartWith(`${hub.url}/oauth/consent?request=oar_`);
  return requestId(res);
}

describe('3. CSRF and clickjacking on the consent screen', () => {
  test('consent: needs a signed in owner', async () => {
    const id = await openRequest();
    expect((await readRequest(id, null)).status).toBe(401);
    expect((await readRequest(id, 'wrong-token')).status).toBe(401);
    const consent = (await readRequest(id)).body.consent;
    expect((await decide(id, { decision: 'allow', consent }, null)).status).toBe(401);
    // a form post from another site carries no Authorization header and no JSON
    const form = await fetch(`${hub.url}/api/oauth/requests/${id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: `decision=allow&consent=${consent}` });
    expect(form.status).toBe(401);
    // the page cannot be framed
    const page = await fetch(`${hub.url}/oauth/consent?request=${id}`);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    // CORS on /api does not answer other sites
    const pre = await fetch(`${hub.url}/api/oauth/requests/${id}`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('consent: needs the consent value from this request', async () => {
    const id = await openRequest();
    const other = await openRequest();
    const first = (await readRequest(id)).body.consent;
    const otherValue = (await readRequest(other)).body.consent;
    expect((await decide(id, { decision: 'allow' })).status).toBe(403);
    expect((await decide(id, { decision: 'allow', consent: 'guess' })).status).toBe(403);
    expect((await decide(id, { decision: 'allow', consent: otherValue })).status).toBe(403);
    // a new read makes a new value; the old one stops working
    const second = (await readRequest(id)).body.consent;
    expect(second).not.toBe(first);
    expect((await decide(id, { decision: 'allow', consent: first })).status).toBe(403);
    expect((await decide(id, { decision: 'allow', consent: second })).status).toBe(200);
  });

  test('consent: decides once', async () => {
    const id = await openRequest();
    const consent = (await readRequest(id)).body.consent;
    expect((await decide(id, { decision: 'allow', consent })).status).toBe(200);
    expect((await decide(id, { decision: 'allow', consent })).status).toBe(404);
    expect((await decide(id, { decision: 'deny', consent })).status).toBe(404);
    expect((await readRequest(id)).status).toBe(404);
  });

  test('consent: expires', async () => {
    const id = await openRequest();
    const consent = (await readRequest(id)).body.consent;
    clock += 10 * 60_000 + 1;
    try {
      expect((await readRequest(id)).status).toBe(404);
      expect((await decide(id, { decision: 'allow', consent })).status).toBe(404);
    } finally {
      clock -= 10 * 60_000 + 1;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. leaks

describe('4. tokens and codes in logs', () => {
  test('leaks: no token, code or secret in logs, audit or tables', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const grab = (...a: unknown[]) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    console.log = console.error = console.warn = console.info = grab;
    const secrets: string[] = [];
    try {
      const reg = await register({ token_endpoint_auth_method: 'client_secret_post' });
      secrets.push(reg.body.client_secret);
      const g = await getCode({ client: reg.body });
      secrets.push(g.code, g.verifier);
      const t = await exchange(g, { client_secret: reg.body.client_secret });
      expect(t.status).toBe(200);
      secrets.push(t.body.access_token, t.body.refresh_token);
      await call(t.body.access_token, 'memory_context');
      const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: reg.body.client_id, client_secret: reg.body.client_secret });
      secrets.push(r.body.access_token, r.body.refresh_token);
      // the noisy paths too: a replay and a wrong token
      await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: reg.body.client_id, client_secret: reg.body.client_secret });
      await exchange(g, { client_secret: reg.body.client_secret });
      await call(`${t.body.access_token}x`, 'memory_context');
    } finally {
      Object.assign(console, orig);
    }
    const audit = JSON.stringify(hub.engine.repos.audit.list({ limit: 500 }));
    const db = hub.engine.repos.db;
    const tables = ['oauth_clients', 'oauth_requests', 'oauth_codes', 'oauth_grants', 'oauth_tokens'].map((t) => JSON.stringify(db.query(`SELECT * FROM ${t}`).all())).join('\n');
    const logs = lines.join('\n');
    for (const s of secrets) {
      expect(s.length).toBeGreaterThan(20);
      expect(logs).not.toContain(s);
      expect(audit).not.toContain(s);
      expect(tables).not.toContain(s);
    }
    expect(audit).toContain('oauth.replay');
  });

  test('leaks: query string tokens are refused', async () => {
    const t = await connect();
    const res = await fetch(`${hub.url}/mcp?access_token=${t.access}&token=${t.access}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

// ---------------------------------------------------------------------------
// 5. replay

describe('5. replay', () => {
  test('refresh: rotates, and reuse revokes the grant', async () => {
    const t = await connect();
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client.client_id });
    expect(r1.status).toBe(200);
    const r2 = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: t.client.client_id });
    expect(r2.status).toBe(200);
    // the first refresh token again: someone holds a copy, so everything ends
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client.client_id });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await call(r2.body.access_token, 'memory_recent')).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: r2.body.refresh_token, client_id: t.client.client_id })).body.error).toBe('invalid_grant');
  });

  test('access: expires after an hour', async () => {
    const t = await connect();
    expect((await call(t.access, 'memory_recent')).status).toBe(200);
    clock += 60 * 60_000 + 1;
    try {
      expect((await call(t.access, 'memory_recent')).status).toBe(401);
      // the refresh token still works and gives a fresh one
      const r = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client.client_id });
      expect(r.status).toBe(200);
      expect((await call(r.body.access_token, 'memory_recent')).status).toBe(200);
    } finally {
      clock -= 60 * 60_000 + 1;
    }
  });

  test('revoke: the endpoint and Settings both end access', async () => {
    // RFC 7009 with an access token: that token only
    const a = await connect();
    await fetch(`${hub.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.access, client_id: a.client.client_id }) });
    expect((await call(a.access, 'memory_recent')).status).toBe(401);
    // another client cannot revoke it
    const b = await connect();
    const c = await connect();
    await fetch(`${hub.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: b.refresh, client_id: c.client.client_id }) });
    expect((await call(b.access, 'memory_recent')).status).toBe(200);
    // Settings > Connected apps: Revoke ends everything the app holds and forgets it
    const apps = (await (await hub.api('/api/oauth/apps')).json()) as Array<{ id: string; name: string }>;
    const row = (await hub.engine.repos.db.query('SELECT id FROM oauth_clients WHERE client_id = ?').get(b.client.client_id)) as { id: string };
    expect(apps.some((x) => x.id === row.id)).toBe(true);
    expect((await hub.api(`/api/oauth/apps/${row.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(b.access, 'memory_recent')).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: b.refresh, client_id: b.client.client_id })).body.error).toBe('invalid_client');
    expect(((await (await hub.api('/api/oauth/apps')).json()) as Array<{ id: string }>).some((x) => x.id === row.id)).toBe(false);
    expect((await hub.api(`/api/oauth/apps/${row.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((x) => x.action === 'oauth.revoke' && x.actor === 'owner')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. scope escalation

describe('6. scope escalation', () => {
  test('scope: a read token cannot save', async () => {
    const t = await connect({ scope: 'memory:read' });
    expect(t.scope).toBe('memory:read');
    const list = (await (await rpc(t.access, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as any;
    expect(list.result.tools.map((x: { name: string }) => x.name)).toEqual(['memory_context', 'memory_search', 'memory_recent', 'tasks_list', 'routines_list']);
    const save = await call(t.access, 'memory_save', { content: 'should not land' });
    expect(save.status).toBe(403);
    const h = save.headers.get('www-authenticate')!;
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="memory:read memory:write"');
    expect(h).toContain('resource_metadata=');
    expect((await call(t.access, 'sessions_search', { query: 'x' })).status).toBe(403);
    // a batch that hides a write behind a read is refused whole
    const batch = await rpc(t.access, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_forget', arguments: { id: 'mem_1' } } },
    ]);
    expect(batch.status).toBe(403);
    expect(hub.engine.memory.list().some((m) => m.content === 'should not land')).toBe(false);
    // prompts and resources need memory:read; a write-only token has neither
    const w = await connect({ scope: 'memory:write' });
    expect((await rpc(w.access, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'conclave://memory/context' } })).status).toBe(403);
    expect((await rpc(w.access, { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'memory_context' } })).status).toBe(403);
    expect((await call(w.access, 'memory_context')).status).toBe(403);
    expect((await call(w.access, 'memory_save', { content: 'Writes work with memory:write' })).status).toBe(200);
  });

  test('scope: consent cannot add scopes', async () => {
    const id = await openRequest('memory:read');
    const consent = (await readRequest(id)).body.consent;
    expect((await decide(id, { decision: 'allow', consent, scopes: ['memory:read', 'memory:write'] })).status).toBe(400);
    expect((await decide(id, { decision: 'allow', consent, scopes: [] })).status).toBe(400);
    expect((await decide(id, { decision: 'allow', consent, scopes: 'memory:read' })).status).toBe(400);
    // leaving one out is fine
    const t = await connect({ scope: 'memory:read memory:write', allow: ['memory:read'] });
    expect(t.scope).toBe('memory:read');
  });

  test('scope: refresh cannot widen', async () => {
    const t = await connect({ scope: 'memory:read memory:write', allow: ['memory:read'] });
    const wide = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client.client_id, scope: 'memory:read memory:write' });
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe('invalid_scope');
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client.client_id, scope: 'memory:read admin' })).body.error).toBe('invalid_scope');
    // the refused attempt did not spend the token
    const same = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client.client_id, scope: 'memory:read' });
    expect(same.status).toBe(200);
    expect(same.body.scope).toBe('memory:read');
    // offline_access alone keeps what the grant has
    const keep = await token({ grant_type: 'refresh_token', refresh_token: same.body.refresh_token, client_id: t.client.client_id, scope: 'offline_access' });
    expect(keep.status).toBe(200);
    expect(keep.body.scope).toBe('memory:read');
  });

  test('scope: registration caps the request', async () => {
    const client = (await register({ scope: 'memory:read' })).body;
    expect(client.scope).toBe('memory:read');
    const res = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', scope: 'memory:read memory:write' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
    // with no scope asked, it gets what it registered for
    const g = await getCode({ client, scope: '' });
    expect(g.request.scopes.map((s: { id: string }) => s.id)).toEqual(['memory:read']);
  });

  test('scope: tokens only work on /mcp', async () => {
    const t = await connect();
    expect((await hub.api('/api/sessions', { token: t.access })).status).toBe(401);
    expect((await hub.api('/api/memory', { token: t.access })).status).toBe(401);
    expect((await fetch(`${hub.url}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${t.access}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    // a refresh token is not an access token
    expect((await call(t.refresh, 'memory_recent')).status).toBe(401);
  });

  test('scope: resource must be this hub', async () => {
    const client = (await register()).body;
    for (const resource of ['https://other.example/mcp', `${hub.url}/api`, `${hub.url}/mcp/`, `${hub.url}/mcp?x=1`]) {
      const res = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource });
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    }
    const g = await getCode({ client });
    expect((await exchange(g, { resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
  });
});

// ---------------------------------------------------------------------------
// 7. lookalike names

describe('7. a client with a lookalike name', () => {
  test('names: a brand name on another host is flagged', async () => {
    const fake = (await register({ client_name: 'Claude', redirect_uris: ['https://claude-ai.evil.example/cb'] })).body;
    const g = await getCode({ client: fake });
    expect(g.request.app.host).toBe('claude-ai.evil.example');
    expect(g.request.app.warning).toContain('does not send you back to claude-ai.evil.example');
    expect(nameWarning('ChatGPT', 'https://chatgpt.com.evil.example/cb', ['https://chatgpt.com.evil.example/cb'])).toContain('ChatGPT does not send you back');
    expect(nameWarning('OpenAI connector', 'https://chatgpt.com/connector_platform_oauth_redirect', ['https://chatgpt.com/connector_platform_oauth_redirect'])).toBeUndefined();
    expect(nameWarning('Claude', 'https://claude.ai/api/mcp/auth_callback', [CLAUDE])).toBeUndefined();
    // a Cyrillic lookalike host shows as punycode
    const idn = (await register({ client_name: 'Claude', redirect_uris: ['https://сlaude.ai/api/mcp/auth_callback'] })).body;
    const gi = await getCode({ client: idn });
    expect(gi.request.app.host).toStartWith('xn--');
    expect(gi.request.app.warning).toBeDefined();
  });

  test('names: hidden characters are removed', async () => {
    expect(cleanName('Cla‮ude​  Code\u0007')).toBe('Claude Code');
    expect(cleanName('x'.repeat(200)).length).toBeLessThanOrEqual(62);
    expect(cleanName(42)).toBe('');
    const r = await register({ client_name: '‮edualc' });
    expect(r.body.client_name).toBe('edualc');
    expect((await register({ client_name: '' })).body.client_name).toBe('Unnamed app');
  });

  test('names: loopback clients are flagged', async () => {
    const local = (await register({ client_name: 'Some tool', redirect_uris: ['http://127.0.0.1:8123/cb'] })).body;
    const g = await getCode({ client: local });
    expect(g.request.app.loopback).toBe(true);
    expect(g.request.app.warning).toContain('finishes signing in on your own computer');
  });
});

// ---------------------------------------------------------------------------
// 8. more ways in

describe('8. more ways in', () => {
  test('register: rate limit and cleanup', async () => {
    const from = { 'x-forwarded-for': '198.51.100.20' };
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await register({}, from)).status;
    expect(last).toBe(429);
    // registrations that never got consent go after a day
    const unused = (await register()).body;
    const db = hub.engine.repos.db;
    expect(db.query('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(unused.client_id)).not.toBeNull();
    clock += 25 * 3_600_000;
    try {
      hub.running.conclave.ctx.oauth.store.prune(true);
      expect(db.query('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(unused.client_id)).toBeNull();
    } finally {
      clock -= 25 * 3_600_000;
    }
  });

  test('cimd: clients known by a document URL that never got consent are capped like registrations', () => {
    // each one costs an attacker only a URL on a domain of theirs and an authorize request
    let t = 1;
    const db = openDb(':memory:');
    const store = new OAuthStore(db, () => t++);
    for (let i = 0; i < MAX_UNUSED_CLIENTS + 5; i++) store.upsertDocumentClient({ url: `https://app.example/c/${i}`, name: 'x', redirectUris: ['https://app.example/cb'], applicationType: 'web' });
    expect((db.query('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n).toBe(MAX_UNUSED_CLIENTS);
    expect(store.byClientId('https://app.example/c/0')).toBeUndefined();
    expect(store.byClientId(`https://app.example/c/${MAX_UNUSED_CLIENTS + 4}`)).toBeDefined();
  });

  test('cimd: refuses private addresses, redirects and a wrong client_id', async () => {
    const tryId = async (id: string) => {
      const res = await authorize({ response_type: 'code', client_id: id, redirect_uri: 'https://app.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    };
    const before = fetched.length;
    for (const id of ['https://127.0.0.1/app.json', 'https://[::1]/app.json', 'https://169.254.169.254/latest/meta-data', 'https://10.1.2.3/app.json', 'https://internal.example/app.json', 'https://rebind.example/app.json', 'https://app.example:8443/app.json']) {
      const r = await tryId(id);
      expect(r.status).toBe(400);
      expect(r.location).toBeNull();
    }
    expect(fetched.length).toBe(before);
    docs.set('https://app.example/moved.json', { status: 302, headers: { location: 'http://127.0.0.1/x' } });
    expect((await tryId('https://app.example/moved.json')).text).toContain('redirect');
    docs.set('https://app.example/wrong.json', { body: { client_id: 'https://other.example/app.json', redirect_uris: ['https://app.example/cb'] } });
    expect((await tryId('https://app.example/wrong.json')).text).toContain('different client_id');
    docs.set('https://app.example/secret.json', { body: { client_id: 'https://app.example/secret.json', redirect_uris: ['https://app.example/cb'], client_secret: 'x' } });
    expect((await tryId('https://app.example/secret.json')).status).toBe(400);
    docs.set('https://app.example/big.json', { body: 'x'.repeat(70 * 1024) });
    expect((await tryId('https://app.example/big.json')).text).toContain('larger than');
    docs.set('https://app.example/badredirect.json', { body: { client_id: 'https://app.example/badredirect.json', redirect_uris: ['http://evil.example/cb'] } });
    expect((await tryId('https://app.example/badredirect.json')).status).toBe(400);
    for (const ip of ['8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(ip)).toBe(true);
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '224.0.0.1']) expect(isPublicAddress(ip)).toBe(false);
  });

  test('guard: wrong tokens and codes block the address', async () => {
    const from = { 'x-forwarded-for': '203.0.113.77' };
    for (let i = 0; i < 19; i++) expect((await rpc(`cat_wrong${i}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, from)).status).toBe(401);
    // the same wrong value again counts once
    expect((await rpc('cat_wrong0', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, from)).status).toBe(401);
    expect((await rpc('cat_wrong-last', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, from)).status).toBe(401);
    expect((await rpc(OWNER, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, from)).status).toBe(429);
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'crt_x', client_id: 'x' }, from)).status).toBe(429);
    // wrong codes count too
    const other = { 'x-forwarded-for': '203.0.113.78' };
    const client = (await register()).body;
    for (let i = 0; i < 20; i++) await token({ grant_type: 'authorization_code', code: `cac_guess${i}`, code_verifier: pkce().verifier, client_id: client.client_id, redirect_uri: CLAUDE }, other);
    expect((await token({ grant_type: 'authorization_code', code: 'cac_one-more', code_verifier: pkce().verifier, client_id: client.client_id }, other)).status).toBe(429);
    expect(hub.engine.repos.audit.list({ limit: 50 }).some((a) => a.action === 'auth.blocked')).toBe(true);
  });

  test('http: refused on a network address', async () => {
    const lan = { 'x-forwarded-host': '192.168.1.5:7717' };
    const client = (await register()).body;
    const res = await authorize({ response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE, code_challenge: pkce().challenge, code_challenge_method: 'S256' }, lan);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('https address');
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'crt_x', client_id: client.client_id }, lan)).body.error).toBe('invalid_request');
    expect((await register({}, lan)).status).toBe(400);
    // behind a tunnel the forwarded proto says https, and that is fine
    const tunnel = { 'x-forwarded-host': 'conclave.example.com', 'x-forwarded-proto': 'https' };
    const prm = (await (await fetch(`${hub.url}/.well-known/oauth-protected-resource/mcp`, { headers: tunnel })).json()) as any;
    expect(prm.resource).toBe('https://conclave.example.com/mcp');
  });
});
