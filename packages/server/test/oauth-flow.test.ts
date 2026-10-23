import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OWNER, startHub, type TestHub } from './helpers';

/**
 * The whole sign in, played by the official MCP SDK client (the one Claude
 * Code and many connectors use): discovery from the 401, dynamic
 * registration, authorize with PKCE, the owner's consent, the code
 * exchange, a memory_context call, a refresh, a revoke, and then a 401.
 */

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

class TestProvider implements OAuthClientProvider {
  readonly redirectUrl = 'http://127.0.0.1:43123/callback';
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authUrl?: URL;
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'SDK test client', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() {
    return 'sdk-state-1';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') this.saved = undefined;
    if (scope === 'all' || scope === 'client') this.info = undefined;
  }
}

/** What the owner's browser does: open the authorize URL, land on the consent page, press Allow. */
async function ownerAllows(authUrl: URL): Promise<URL> {
  const res = await fetch(authUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const consentPage = new URL(res.headers.get('location')!);
  expect(consentPage.pathname).toBe('/oauth/consent');
  const id = consentPage.searchParams.get('request')!;
  const req = (await (await hub.api(`/api/oauth/requests/${id}`)).json()) as any;
  expect(req.app.name).toBe('SDK test client');
  expect(req.app.loopback).toBe(true);
  const answer = (await (await hub.api(`/api/oauth/requests/${id}`, { method: 'POST', json: { decision: 'allow', consent: req.consent } })).json()) as any;
  return new URL(answer.redirect);
}

test('the MCP SDK client signs in, calls memory_context, refreshes, and is shut out after revoke', async () => {
  await hub.engine.memory.save({ content: 'The owner studies networks at TU Delft.', kind: 'fact', importance: 0.9 });
  const url = new URL(`${hub.url}/mcp`);
  const provider = new TestProvider();

  // 1. the first connection gets the 401, finds the metadata, registers and asks for the browser
  const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await expect(new Client({ name: 'sdk', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.info?.client_id).toStartWith('ccid_');
  const authUrl = provider.authUrl!;
  expect(authUrl.origin + authUrl.pathname).toBe(`${hub.url}/oauth/authorize`);
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.get('resource')).toBe(`${hub.url}/mcp`);
  expect(authUrl.searchParams.get('scope')).toBe('memory:read memory:write chats:read');

  // 2. consent, then the code comes back to the loopback redirect with state and iss
  const back = await ownerAllows(authUrl);
  expect(back.origin + back.pathname).toBe(provider.redirectUrl);
  expect(back.searchParams.get('state')).toBe('sdk-state-1');
  expect(back.searchParams.get('iss')).toBe(hub.url);

  // 3. code exchange
  await first.finishAuth(back.searchParams.get('code')!);
  const firstTokens = provider.saved!;
  expect(firstTokens.access_token).toStartWith('cat_');
  expect(firstTokens.refresh_token).toStartWith('crt_');

  // 4. a real session and the memory_context call
  const client = new Client({ name: 'sdk', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toContain('memory_context');
  const ctx = await client.callTool({ name: 'memory_context', arguments: {} });
  expect((ctx.content as Array<{ text: string }>)[0].text).toContain('The owner studies networks at TU Delft.');
  await client.close();

  // 5. refresh: new pair, the old access token stops
  expect(await auth(provider, { serverUrl: url })).toBe('AUTHORIZED');
  expect(provider.saved!.refresh_token).not.toBe(firstTokens.refresh_token);
  const old = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${firstTokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect(old.status).toBe(401);
  const again = new Client({ name: 'sdk', version: '1' });
  await again.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  expect((await again.listTools()).tools.length).toBeGreaterThan(0);
  await again.close();

  // Settings shows it
  const apps = (await (await hub.api('/api/oauth/apps')).json()) as Array<{ name: string; host: string }>;
  expect(apps).toContainEqual(expect.objectContaining({ name: 'SDK test client', host: '127.0.0.1' }));

  // 6. revoke (RFC 7009) with the refresh token
  const live = provider.saved!;
  const rv = await fetch(`${hub.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: live.refresh_token!, token_type_hint: 'refresh_token', client_id: provider.info!.client_id }) });
  expect(rv.status).toBe(200);

  // 7. then a 401, and the client is sent back to sign in
  const after = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${live.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect(after.status).toBe(401);
  expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"');
  provider.authUrl = undefined;
  await expect(new Client({ name: 'sdk', version: '1' }).connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.authUrl).toBeDefined();

  // the hub token still works the old way
  const owner = new Client({ name: 'owner', version: '1' });
  await owner.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${OWNER}` } } }));
  expect((await owner.listTools()).tools.length).toBe(9);
  await owner.close();
});
