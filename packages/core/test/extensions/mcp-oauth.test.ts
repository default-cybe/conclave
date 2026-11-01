import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGINS_KEY_FILE } from '../../src/browser/logins';
import { isHubPrivatePath } from '../../src/machine/private';
import { ConfigStore } from '../../src/config';
import { McpManager } from '../../src/extensions/mcp';
import { McpOAuth, oauthSecretName } from '../../src/extensions/mcp-oauth';
import { RECOMMENDED, type McpInstall } from '../../src/catalog/recommended';
import { setLogTap } from '../../src/util/log';
import { cleanup, tempDir } from './_helpers';
import { fakeAffineMcp, fakeOAuthMcp, type FakeOAuthMcp } from './fixtures/fake-mcp-http';

const dirs: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  cleanup(...dirs.splice(0));
});

const REDIRECT = 'https://hub.example/api/mcp/oauth/callback';

function setup(fake: FakeOAuthMcp, opts: { now?: () => number; also?: FakeOAuthMcp[]; fetch?: typeof fetch } = {}) {
  const home = tempDir();
  dirs.push(home);
  const cfg = new ConfigStore(home);
  cfg.update({ mcpServers: { notion: { type: 'http', url: fake.url, auth: 'oauth' } } as never });
  // the fixtures run on http://127.0.0.1, which only an explicit allowance reaches
  const allowOrigins = [fake, ...(opts.also ?? [])].map((f) => f.origin);
  const mgr = new McpManager(cfg, { oauth: new McpOAuth(cfg, { now: opts.now, fetch: opts.fetch, allowOrigins }) });
  stops.push(() => mgr.shutdown());
  return { cfg, mgr, home };
}

/** The owner presses Allow: the fake authorization server redirects back with a code. */
async function allow(authorizeUrl: string): Promise<{ code: string; state: string }> {
  const res = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
}

async function connect(mgr: McpManager, fake: FakeOAuthMcp) {
  const { authorizeUrl } = await mgr.oauth.start('notion', fake.url, REDIRECT);
  const { code, state } = await allow(authorizeUrl);
  expect(mgr.oauth.serverOf(state)).toBe('notion');
  await mgr.oauth.finish(state, code);
  return mgr.restart('notion');
}

describe('MCP OAuth', () => {
  test('a server with no sign-in waits for Connect and is never dialed', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const { mgr } = setup(fake);
    expect(await mgr.tools()).toEqual([]);
    await mgr.tools();
    expect(fake.mcpHits).toBe(0);
    expect(mgr.status()[0]).toMatchObject({ name: 'notion', status: 'failed', auth: 'needs-auth' });
  });

  test('discovery, registration, PKCE, code exchange, then tools; tokens sealed in secrets.json', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const lines: string[] = [];
    const prev = setLogTap((_l, scope, msg, extra) => lines.push(`${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
    stops.push(() => void setLogTap(prev));
    const { mgr, cfg } = setup(fake);

    const { authorizeUrl } = await mgr.oauth.start('notion', fake.url, REDIRECT);
    const q = new URL(authorizeUrl).searchParams;
    expect(authorizeUrl.startsWith(`${fake.origin}/authorize`)).toBe(true);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('state')!.length).toBeGreaterThan(20);
    expect(fake.registrations).toBe(1);

    const { code, state } = await allow(authorizeUrl);
    await mgr.oauth.finish(state, code);
    const st = await mgr.restart('notion');
    expect(st).toMatchObject({ status: 'connected', tools: 1, auth: 'connected' });
    expect((await mgr.callTool('notion', 'whoami', {})).content).toBe('owner@example.com');

    const raw = readFileSync(cfg.paths.secrets, 'utf8');
    expect(raw).toContain(oauthSecretName('notion'));
    expect(raw).toContain('enc:v1:');
    for (const t of fake.issued) expect(raw.includes(t)).toBe(false);
    expect(raw.includes('access_token')).toBe(false);
    // the hub can read it back
    expect(mgr.oauth.read('notion').tokens?.refresh_token).toBe(fake.currentRefresh());
    for (const t of fake.issued) expect(lines.some((l) => l.includes(t))).toBe(false);
    expect(lines.some((l) => l.includes(code))).toBe(false);

    // the state works once
    await expect(mgr.oauth.finish(state, code)).rejects.toThrow('unknown or already finished');
  });

  test('an expired access token refreshes once for concurrent calls, and the rotated refresh token is saved', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const { mgr } = setup(fake);
    await connect(mgr, fake);
    const first = mgr.oauth.read('notion').tokens!.refresh_token;

    fake.expireAccess();
    // two transports hit 401 at once: each runs auth(), but only one refresh reaches the server
    const a = new McpManager(mgr['config'], { oauth: mgr.oauth });
    stops.push(() => a.shutdown());
    const [r1, r2] = await Promise.all([mgr.callTool('notion', 'whoami', {}), a.callTool('notion', 'whoami', {})]);
    expect(r1.content).toBe('owner@example.com');
    expect(r2.content).toBe('owner@example.com');
    expect(fake.refreshCalls).toBe(1);
    const saved = mgr.oauth.read('notion').tokens!.refresh_token;
    expect(saved).not.toBe(first);
    expect(saved).toBe(fake.currentRefresh());
  });

  test('a revoked connection becomes needs-auth with no backoff retries', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const { mgr } = setup(fake);
    await connect(mgr, fake);
    fake.revokeAll();
    const st = await mgr.restart('notion');
    expect(st).toMatchObject({ status: 'failed', auth: 'needs-auth' });
    expect(st?.error).toContain('Press Connect');
    const hits = fake.mcpHits;
    await mgr.tools();
    await mgr.tools();
    expect(fake.mcpHits).toBe(hits);
    // Connect again works
    expect((await connect(mgr, fake))?.status).toBe('connected');
  });

  test('disconnect forgets tokens and registration', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const { mgr, cfg } = setup(fake);
    await connect(mgr, fake);
    mgr.oauth.disconnect('notion');
    expect(cfg.secretValue(oauthSecretName('notion'))).toBeUndefined();
    expect((await mgr.restart('notion'))?.auth).toBe('needs-auth');
  });

  test('after the URL changes, no token reaches the new host', async () => {
    const fake = fakeOAuthMcp();
    const other = fakeOAuthMcp();
    stops.push(fake.stop, other.stop);
    const { mgr, cfg } = setup(fake, { also: [other] });
    await connect(mgr, fake);
    cfg.update({ mcpServers: { notion: { type: 'http', url: other.url, auth: 'oauth' } } as never });
    expect(await mgr.tools()).toEqual([]);
    expect(mgr.status()[0]).toMatchObject({ auth: 'needs-auth' });
    await mgr.restart('notion');
    await mgr.callTool('notion', 'whoami', {}).catch(() => undefined);
    expect(other.authHeaders).toBe(0);
    expect(other.mcpHits).toBe(0);
    expect(mgr.oauth.hasTokens('notion', other.url)).toBe(false);
    // and back at the old URL the sign-in still holds
    expect(mgr.oauth.hasTokens('notion', fake.url)).toBe(true);
  });

  test('discovery that points at the hub network or a metadata service is refused before any request', async () => {
    for (const target of ['https://127.0.0.1:9', 'https://192.168.1.10', 'http://169.254.169.254', 'https://169.254.169.254', 'https://metadata.google.internal', 'https://printer.local']) {
      const fake = fakeOAuthMcp({ authServers: [target] });
      stops.push(fake.stop);
      const seen: string[] = [];
      const counting = ((url: string | URL | Request, init?: RequestInit) => {
        seen.push(String(url));
        return fetch(url, init);
      }) as typeof fetch;
      const { mgr } = setup(fake, { fetch: counting });
      const err = await mgr.oauth.start('notion', fake.url, REDIRECT).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toContain('Refused');
      expect(seen.length).toBeGreaterThan(0);
      for (const u of seen) expect(new URL(u).origin).toBe(fake.origin);
      expect(fake.registrations).toBe(0);
    }
  });

  test('a failed sign-in shows no response body', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const { mgr } = setup(fake);
    const { authorizeUrl } = await mgr.oauth.start('notion', fake.url, REDIRECT);
    const { state } = await allow(authorizeUrl);
    const err = await mgr.oauth.finish(state, 'not-a-real-code').then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toBe('The sign-in could not finish: the server answered invalid_grant.');
    const again = await mgr.oauth.start('notion', fake.url, REDIRECT);
    const s2 = new URL(again.authorizeUrl).searchParams.get('state')!;
    await expect(mgr.oauth.finish(s2, undefined, '<b>Internal details</b>')).rejects.toThrow('The server refused the sign-in.');
  });

  test('a disconnect during a refresh leaves no tokens behind', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    const { mgr, cfg } = setup(fake);
    await connect(mgr, fake);
    fake.expireAccess();
    const release = fake.holdRefresh();
    const call = mgr.callTool('notion', 'whoami', {}).catch(() => undefined);
    for (let i = 0; i < 200 && fake.refreshCalls === 0; i++) await Bun.sleep(10);
    expect(fake.refreshCalls).toBe(1);
    mgr.signOut('notion');
    release();
    await call;
    await Bun.sleep(50);
    expect(cfg.secretValue(oauthSecretName('notion'))).toBeUndefined();
    expect(mgr.oauth.read('notion')).toEqual({});
    expect(mgr.status()[0]).toMatchObject({ auth: 'needs-auth' });
  });

  test('the sealing key is a private hub file from the first McpOAuth', () => {
    const home = tempDir();
    dirs.push(home);
    new McpOAuth(new ConfigStore(home));
    expect(isHubPrivatePath(join(home, LOGINS_KEY_FILE))).toBe(true);
  });

  test('an unknown, expired or cancelled sign-in is refused', async () => {
    const fake = fakeOAuthMcp();
    stops.push(fake.stop);
    let now = 1_000_000;
    const { mgr } = setup(fake, { now: () => now });
    await expect(mgr.oauth.finish('guess', 'code')).rejects.toThrow('unknown');
    const late = await mgr.oauth.start('notion', fake.url, REDIRECT);
    const { code, state } = await allow(late.authorizeUrl);
    now += 16 * 60_000;
    expect(mgr.oauth.serverOf(state)).toBeUndefined();
    await expect(mgr.oauth.finish(state, code)).rejects.toThrow('too long');
    const denied = await mgr.oauth.start('notion', fake.url, REDIRECT);
    const s2 = new URL(denied.authorizeUrl).searchParams.get('state')!;
    await expect(mgr.oauth.finish(s2, undefined, 'access_denied')).rejects.toThrow('cancelled');
    expect(mgr.oauth.hasTokens('notion', fake.url)).toBe(false);
  });
});

describe('AFFiNE catalog entry', () => {
  test('writes a page from Markdown and appends to it through the community server', async () => {
    const token = 'affine-test-token-0123456789';
    const fake = fakeAffineMcp(token);
    stops.push(fake.stop);
    const item = RECOMMENDED.find((i) => i.id === 'mcp:affine')!;
    const spec = item.install as McpInstall;
    expect(spec.config.headers?.Authorization).toBe('Bearer {{AFFINE_MCP_TOKEN}}');
    expect(item.inputs?.find((i) => i.name === 'AFFINE_MCP_TOKEN')).toMatchObject({ secret: true, secretKey: 'affine-mcp-token' });

    const home = tempDir();
    dirs.push(home);
    const cfg = new ConfigStore(home);
    cfg.setSecret('values', 'affine-mcp-token', token);
    // what the catalog install saves: the URL typed in, the token as a secret reference
    cfg.update({ mcpServers: { affine: { ...spec.config, url: fake.url, headers: { Authorization: 'Bearer ${secret:affine-mcp-token}' } } } as never });
    const mgr = new McpManager(cfg);
    stops.push(() => mgr.shutdown());

    const made = await mgr.callTool('affine', 'create_doc_from_markdown', { title: 'Week 9', markdown: '# Week 9\n\n- integers' });
    const { docId } = JSON.parse(made.content as string) as { docId: string };
    await mgr.callTool('affine', 'append_markdown', { docId, markdown: '- overflow' });
    expect(fake.docs.get(docId)).toEqual({ title: 'Week 9', markdown: '# Week 9\n\n- integers\n- overflow' });
    expect(fake.unauthorized).toBe(0);
  });

  test('Notion and Linear sign in with OAuth', () => {
    for (const id of ['mcp:notion', 'mcp:linear']) expect((RECOMMENDED.find((i) => i.id === id)!.install as McpInstall).config.auth).toBe('oauth');
  });
});
