import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { constants, createHash, createHmac, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { startHub, type TestHub } from './helpers';
import { CLOCK_SKEW_S, JWT_BEARER, MAX_ASSERTION_LIFETIME_S, parseJwks, verifyClientAssertion, type PublicJwk } from '../src/oauth/assertion';
import { JWKS_REFETCH_MS, JWKS_TTL_MS, JwksCache } from '../src/oauth/cimd';

/**
 * private_key_jwt for clients known by a client ID metadata document, the
 * way ChatGPT signs in (docs/design/MCP-OAUTH.md, threat 10). The keys are
 * made here; the documents and key sets are served by the fetch the hub is
 * given, so nothing reaches the network.
 */

let clock = Date.now();
const served = new Map<string, { status?: number; body?: unknown; headers?: Record<string, string> }>();
const fetched: string[] = [];
let hub: TestHub;

beforeAll(() => {
  hub = startHub({
    oauth: {
      now: () => clock,
      cimd: {
        resolve: async (host) => (host === 'keys.internal.example' ? ['10.0.0.9'] : ['93.184.216.34']),
        fetch: async (url) => {
          fetched.push(url);
          const d = served.get(url);
          if (!d) return new Response('not found', { status: 404 });
          return new Response(typeof d.body === 'string' ? d.body : JSON.stringify(d.body), { status: d.status ?? 200, headers: d.headers });
        },
      },
    },
  });
});
afterAll(() => hub.stop());

// ---------------------------------------------------------------------------
// keys and clients

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });

const pub = (k: KeyObject, kid?: string, extra: Record<string, unknown> = {}) => ({ ...k.export({ format: 'jwk' }), ...(kid ? { kid } : {}), use: 'sig', ...extra });

/** Shaped like ChatGPT's document: private_key_jwt, RS256, keys at a jwks_uri. */
const GPT = 'https://chatgpt.example/oauth/abc/client.json';
const GPT_JWKS = 'https://chatgpt.example/oauth/jwks.json';
const GPT_REDIRECT = 'https://chatgpt.com/connector/oauth/abc';
/** Inline keys, no fixed algorithm: ES256 and PS256. */
const INLINE = 'https://app.example/inline/client.json';
const INLINE_REDIRECT = 'https://app.example/cb';

function doc(id: string, extra: Record<string, unknown>, redirect = INLINE_REDIRECT) {
  return { client_id: id, client_name: 'Test app', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra };
}

served.set(GPT, {
  body: doc(GPT, { client_name: 'ChatGPT', client_uri: 'https://chatgpt.com/', token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'RS256', jwks_uri: GPT_JWKS }, GPT_REDIRECT),
});
served.set(GPT_JWKS, { body: { keys: [pub(rsa.publicKey, 'rsa-1'), pub(ec.publicKey, 'ec-1')] } });
served.set(INLINE, { body: doc(INLINE, { token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [pub(ec.publicKey, 'ec-1'), pub(rsa.publicKey, 'rsa-1')] } }) });

// ---------------------------------------------------------------------------
// the client side

const nowS = () => Math.floor(clock / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signJwt(alg: string, key: KeyObject | Buffer | null, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const input = `${b64({ alg, typ: 'JWT', ...header })}.${b64(claims)}`;
  const data = Buffer.from(input);
  let sig = Buffer.alloc(0);
  if (alg === 'RS256') sig = cryptoSign('sha256', data, key as KeyObject);
  else if (alg === 'PS256') sig = cryptoSign('sha256', data, { key: key as KeyObject, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  else if (alg === 'ES256') sig = cryptoSign('sha256', data, { key: key as KeyObject, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'HS256') sig = createHmac('sha256', key as Buffer).update(data).digest();
  return `${input}.${sig.toString('base64url')}`;
}

interface AssertOpts {
  alg?: string;
  key?: KeyObject | Buffer | null;
  /** null leaves kid out. */
  kid?: string | null;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
}

/** A client assertion as a client makes it; claims set to undefined are left out. */
function assertion(clientId: string, o: AssertOpts = {}): string {
  const header = { ...(o.kid === null ? {} : { kid: o.kid ?? 'rsa-1' }), ...o.header };
  const claims = { iss: clientId, sub: clientId, aud: `${hub.url}/oauth/token`, iat: nowS(), exp: nowS() + 300, jti: randomBytes(12).toString('hex'), ...o.claims };
  return signJwt(o.alg ?? 'RS256', o.key === undefined ? rsa.privateKey : o.key, header, claims);
}

const signed = (jwt: string) => ({ client_assertion_type: JWT_BEARER, client_assertion: jwt });

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function authorize(clientId: string, redirectUri: string) {
  const { verifier, challenge } = pkce();
  const u = new URL(`${hub.url}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'memory:read memory:write chats:read offline_access', resource: `${hub.url}/mcp` })) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: 'manual' });
  return { res, verifier };
}

/** Authorize, read the consent request, allow: a code for this client. */
async function getCode(clientId: string, redirectUri: string) {
  const { res, verifier } = await authorize(clientId, redirectUri);
  expect(res.status).toBe(302);
  const id = new URL(res.headers.get('location')!).searchParams.get('request')!;
  const req = (await (await hub.api(`/api/oauth/requests/${id}`)).json()) as any;
  const answer = (await (await hub.api(`/api/oauth/requests/${id}`, { method: 'POST', json: { decision: 'allow', consent: req.consent } })).json()) as any;
  return { code: new URL(answer.redirect).searchParams.get('code')!, verifier, redirectUri, request: req };
}

async function post(path: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params).toString() });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as any };
}

const token = (params: Record<string, string>, headers: Record<string, string> = {}) => post('/oauth/token', params, headers);

function exchange(clientId: string, g: { code: string; verifier: string; redirectUri: string }, extra: Record<string, string> = {}) {
  return token({ grant_type: 'authorization_code', code: g.code, code_verifier: g.verifier, redirect_uri: g.redirectUri, client_id: clientId, resource: `${hub.url}/mcp`, ...extra });
}

/** Sign in all the way with a fresh assertion: access and refresh tokens. */
async function connect(clientId: string, redirectUri: string, o: AssertOpts = {}) {
  const g = await getCode(clientId, redirectUri);
  const t = await exchange(clientId, g, signed(assertion(clientId, o)));
  expect(t.status).toBe(200);
  return { access: t.body.access_token as string, refresh: t.body.refresh_token as string };
}

function mcp(access: string) {
  return fetch(`${hub.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_recent', arguments: {} } }),
  });
}

const count = (url: string) => fetched.filter((u) => u === url).length;

async function errorPageFor(id: string) {
  const { res } = await authorize(id, INLINE_REDIRECT);
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

// ---------------------------------------------------------------------------

describe('10. private_key_jwt', () => {
  test('metadata: private_key_jwt and its algorithms are listed, none still first', async () => {
    const as = (await (await fetch(`${hub.url}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.token_endpoint_auth_methods_supported[0]).toBe('none');
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt']);
    expect(as.revocation_endpoint_auth_methods_supported).toContain('private_key_jwt');
    expect(as.token_endpoint_auth_signing_alg_values_supported).toEqual(['RS256', 'PS256', 'ES256']);
    expect(as.revocation_endpoint_auth_signing_alg_values_supported).toEqual(['RS256', 'PS256', 'ES256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  test('jwt: RS256 with keys at a jwks_uri, through the code, refreshes and revoke', async () => {
    const before = count(GPT_JWKS);
    const g = await getCode(GPT, GPT_REDIRECT);
    expect(g.request.app).toMatchObject({ name: 'ChatGPT', host: 'chatgpt.com', identity: 'chatgpt.example', kind: 'cimd' });
    expect(g.request.app.warning).toBeUndefined();
    // aud: the token endpoint
    const t = await exchange(GPT, g, signed(assertion(GPT)));
    expect(t.status).toBe(200);
    expect(t.body.scope).toBe('memory:read memory:write chats:read');
    expect((await mcp(t.body.access_token)).status).toBe(200);
    // aud: the issuer, and no client_id: the assertion's sub names the client
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, ...signed(assertion(GPT, { claims: { aud: hub.url } })) });
    expect(r1.status).toBe(200);
    // aud as a list
    const r2 = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: GPT, ...signed(assertion(GPT, { claims: { aud: ['https://other.example', `${hub.url}/oauth/token`] } })) });
    expect(r2.status).toBe(200);
    // the keys were fetched once and kept
    expect(count(GPT_JWKS) - before).toBe(1);
    // revocation authenticates the same way
    const bare = await post('/oauth/revoke', { token: r2.body.refresh_token, client_id: GPT });
    expect(bare.status).toBe(401);
    expect(bare.body.error).toBe('invalid_client');
    expect((await mcp(r2.body.access_token)).status).toBe(200);
    const rv = await post('/oauth/revoke', { token: r2.body.refresh_token, client_id: GPT, ...signed(assertion(GPT, { claims: { aud: `${hub.url}/oauth/revoke` } })) });
    expect(rv.status).toBe(200);
    expect((await mcp(r2.body.access_token)).status).toBe(401);
  });

  test('jwt: ES256 and PS256 with keys inline in the document', async () => {
    const g = await getCode(INLINE, INLINE_REDIRECT);
    const t = await exchange(INLINE, g, signed(assertion(INLINE, { alg: 'ES256', key: ec.privateKey, kid: 'ec-1' })));
    expect(t.status).toBe(200);
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: INLINE, ...signed(assertion(INLINE, { alg: 'PS256', kid: 'rsa-1' })) });
    expect(r1.status).toBe(200);
    // no kid: each key that fits the algorithm is tried
    const r2 = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: INLINE, ...signed(assertion(INLINE, { alg: 'ES256', key: ec.privateKey, kid: null })) });
    expect(r2.status).toBe(200);
    expect((await mcp(r2.body.access_token)).status).toBe(200);
  });

  test('jwt: a missing or bad assertion is invalid_client, and the code is not spent', async () => {
    const g = await getCode(GPT, GPT_REDIRECT);
    // each case, and the words that show the right check refused it
    const bad: Array<[string, Record<string, string>, string]> = [
      ['no assertion', {}, 'signs in with private_key_jwt'],
      ['a client secret instead', { client_secret: 'ccs_guess' }, 'signs in with private_key_jwt'],
      ['wrong assertion type', { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:saml2-bearer', client_assertion: assertion(GPT) }, 'client_assertion_type must be'],
      ['type without assertion', { client_assertion_type: JWT_BEARER }, 'client_assertion is missing'],
      ['not a JWT', signed('not-a-jwt'), 'not a signed JWT'],
      ['wrong iss', signed(assertion(GPT, { claims: { iss: 'https://evil.example/client.json' } })), 'iss and sub'],
      ['wrong sub', signed(assertion(GPT, { claims: { sub: 'https://evil.example/client.json' } })), 'iss and sub'],
      ['wrong aud', signed(assertion(GPT, { claims: { aud: 'https://other.example/oauth/token' } })), 'aud must be'],
      ['aud is /mcp', signed(assertion(GPT, { claims: { aud: `${hub.url}/mcp` } })), 'aud must be'],
      ['no aud', signed(assertion(GPT, { claims: { aud: undefined } })), 'aud must be'],
      ['expired', signed(assertion(GPT, { claims: { iat: nowS() - 400, exp: nowS() - CLOCK_SKEW_S - 1 } })), 'has expired'],
      ['no exp', signed(assertion(GPT, { claims: { exp: undefined } })), 'needs exp'],
      ['exp too far ahead', signed(assertion(GPT, { claims: { exp: nowS() + MAX_ASSERTION_LIFETIME_S + CLOCK_SKEW_S + 5 } })), 'lives too long'],
      ['iat in the future', signed(assertion(GPT, { claims: { iat: nowS() + 600 } })), 'issued in the future'],
      ['iat too old', signed(assertion(GPT, { claims: { iat: nowS() - MAX_ASSERTION_LIFETIME_S - CLOCK_SKEW_S - 5 } })), 'more than an hour old'],
      ['nbf in the future', signed(assertion(GPT, { claims: { nbf: nowS() + 600 } })), 'not valid yet'],
      ['no jti', signed(assertion(GPT, { claims: { jti: undefined } })), 'needs a jti'],
      ['alg none', signed(signJwt('none', null, { kid: 'rsa-1' }, { iss: GPT, sub: GPT, aud: `${hub.url}/oauth/token`, exp: nowS() + 300, jti: 'none-1' })), 'alg none'],
      // the classic confusion: HMAC keyed with the public key
      ['HS256', signed(assertion(GPT, { alg: 'HS256', key: Buffer.from(rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string) })), 'not a shared secret'],
      ['another key, right kid', signed(assertion(GPT, { key: attacker.privateKey })), 'signature does not verify'],
      ['own key in the header', signed(assertion(GPT, { key: attacker.privateKey, kid: 'evil', header: { jwk: pub(attacker.publicKey) } })), 'kid names no key'],
      ['unknown kid', signed(assertion(GPT, { kid: 'nope' })), 'kid names no key'],
      ['PS256 when the app said RS256', signed(assertion(GPT, { alg: 'PS256' })), 'said it signs with RS256'],
      ['crit header', signed(assertion(GPT, { header: { crit: ['exp'] } })), 'critical header'],
      ['secret and assertion both', { client_secret: 'x', ...signed(assertion(GPT)) }, 'not both'],
      ['client_id of another app', { ...signed(assertion(GPT)), client_id: INLINE }, 'iss and sub'],
    ];
    for (const [name, params, words] of bad) {
      const params2 = { grant_type: 'authorization_code', code: g.code, code_verifier: g.verifier, redirect_uri: g.redirectUri, client_id: GPT, ...params };
      const res = await token(params2);
      expect([name, res.status, res.body.error]).toEqual([name, 401, 'invalid_client']);
      expect([name, String(res.body.error_description).includes(words)]).toEqual([name, true]);
    }
    // Basic credentials next to an assertion
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(GPT)}:x`).toString('base64')}`;
    const both = await token({ grant_type: 'authorization_code', code: g.code, code_verifier: g.verifier, redirect_uri: g.redirectUri, ...signed(assertion(GPT)) }, { authorization: basic });
    expect(both.status).toBe(401);
    // the sentences say what is wrong
    const none = await exchange(GPT, g);
    expect(none.body.error_description).toContain('private_key_jwt');
    expect((await exchange(GPT, g, signed(assertion(GPT, { claims: { exp: nowS() - 200 } })))).body.error_description).toContain('expired');
    expect((await exchange(GPT, g, signed(assertion(GPT, { claims: { aud: 'https://x.example' } })))).body.error_description).toContain('aud');
    expect((await exchange(GPT, g, signed(signJwt('none', null, {}, { iss: GPT, sub: GPT })))).body.error_description).toContain('alg none');
    // none of that touched the code: a good assertion still gets the tokens
    const ok = await exchange(GPT, g, signed(assertion(GPT)));
    expect(ok.status).toBe(200);
  });

  test('jwt: an assertion works once', async () => {
    const t = await connect(GPT, GPT_REDIRECT);
    const once = assertion(GPT);
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GPT, ...signed(once) });
    expect(r1.status).toBe(200);
    const again = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: GPT, ...signed(once) });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('invalid_client');
    expect(again.body.error_description).toContain('already used');
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'oauth.replay' && a.detail.includes('client assertion'))).toBe(true);
    // the refused replay did not spend the refresh token
    const r2 = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: GPT, ...signed(assertion(GPT)) });
    expect(r2.status).toBe(200);
    // the hub keeps a hash, never the jti itself
    const jti = JSON.parse(Buffer.from(once.split('.')[1], 'base64url').toString()).jti as string;
    const rows = JSON.stringify(hub.engine.repos.db.query('SELECT * FROM oauth_assertions').all());
    expect(rows).not.toContain(jti);
    // and lets it go once the assertion is past its exp
    const before = (hub.engine.repos.db.query('SELECT COUNT(*) AS n FROM oauth_assertions').get() as { n: number }).n;
    clock += (300 + CLOCK_SKEW_S + 1) * 1000;
    hub.running.conclave.ctx.oauth.store.prune(true);
    expect((hub.engine.repos.db.query('SELECT COUNT(*) AS n FROM oauth_assertions').get() as { n: number }).n).toBeLessThan(before);
  });

  test('jwt: an unknown kid fetches the keys again, at most once a minute', async () => {
    const t = await connect(GPT, GPT_REDIRECT);
    const start = count(GPT_JWKS);
    const fresh = () => assertion(GPT, { kid: 'rsa-2', key: rotated.privateKey });
    const first = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GPT, ...signed(fresh()) });
    expect(first.status).toBe(401);
    expect(first.body.error_description).toContain('kid');
    expect(count(GPT_JWKS) - start).toBe(1);
    // made up kids cannot make the hub fetch again right away
    for (let i = 0; i < 5; i++) expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GPT, ...signed(assertion(GPT, { kid: `made-up-${i}` })) })).status).toBe(401);
    expect(count(GPT_JWKS) - start).toBe(1);
    // the app rotates its keys; a minute later the new kid is fetched and works
    served.set(GPT_JWKS, { body: { keys: [pub(rsa.publicKey, 'rsa-1'), pub(rotated.publicKey, 'rsa-2'), pub(ec.publicKey, 'ec-1')] } });
    clock += 61_000;
    const ok = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GPT, ...signed(fresh()) });
    expect(ok.status).toBe(200);
    expect(count(GPT_JWKS) - start).toBe(2);
  });

  test('jwt: keys on a private address, behind a redirect or with a private key are never used', async () => {
    // a name that resolves to a private address: the document is fine, the keys are never fetched
    const PRIV = 'https://app.example/priv/client.json';
    const PRIV_JWKS = 'https://keys.internal.example/jwks.json';
    served.set(PRIV, { body: doc(PRIV, { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: PRIV_JWKS }) });
    served.set(PRIV_JWKS, { body: { keys: [pub(rsa.publicKey, 'rsa-1')] } });
    const g = await getCode(PRIV, INLINE_REDIRECT);
    const res = await exchange(PRIV, g, signed(assertion(PRIV)));
    expect(res.status).toBe(401);
    expect(res.body.error_description).toContain('not a public internet address');
    expect(count(PRIV_JWKS)).toBe(0);
    // a literal private address, plain http or another port: the document is refused at authorize
    for (const [n, uri] of [['ip', 'https://10.1.2.3/jwks.json'], ['v6', 'https://[::1]/jwks.json'], ['http', 'http://app.example/jwks.json'], ['port', 'https://app.example:8443/jwks.json'], ['userinfo', 'https://u:p@app.example/jwks.json']]) {
      const id = `https://app.example/bad-uri-${n}/client.json`;
      served.set(id, { body: doc(id, { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: uri }) });
      const page = await errorPageFor(id);
      expect([n, page.status, page.location]).toEqual([n, 400, null]);
      expect(count(uri)).toBe(0);
    }
    // a key set that redirects, or that holds a private key
    const keySets: Array<[string, { status?: number; body?: unknown; headers?: Record<string, string> }, string]> = [
      ['redirect', { status: 302, headers: { location: 'https://10.0.0.1/jwks.json' } }, 'answered with a redirect'],
      ['private', { body: { keys: [{ ...rsa.privateKey.export({ format: 'jwk' }), kid: 'rsa-1' }] } }, 'private or shared key'],
      ['weak', { body: { keys: [pub(weak.publicKey, 'rsa-1')] } }, 'no usable signing key'],
    ];
    for (const [n, served1, words] of keySets) {
      const id = `https://app.example/keys-${n}/client.json`;
      const uri = `https://app.example/keys-${n}/jwks.json`;
      served.set(id, { body: doc(id, { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: uri }) });
      served.set(uri, served1);
      const gk = await getCode(id, INLINE_REDIRECT);
      const r = await exchange(id, gk, signed(assertion(id)));
      expect([n, r.status, r.body.error, String(r.body.error_description).includes(words)]).toEqual([n, 401, 'invalid_client', true]);
    }
  });

  test('cimd: a document that asks for a client secret, or gives no usable keys, is still refused', async () => {
    const before = fetched.length;
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['basic', { token_endpoint_auth_method: 'client_secret_basic' }, 'never with a client secret'],
      ['post', { token_endpoint_auth_method: 'client_secret_post' }, 'never with a client secret'],
      ['jwt-secret', { token_endpoint_auth_method: 'client_secret_jwt' }, 'never with a client secret'],
      ['tls', { token_endpoint_auth_method: 'tls_client_auth' }, 'never with a client secret'],
      ['secret', { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: GPT_JWKS, client_secret: 'shh' }, 'client secret'],
      ['no-keys', { token_endpoint_auth_method: 'private_key_jwt' }, 'no public keys'],
      ['both', { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: GPT_JWKS, jwks: { keys: [pub(rsa.publicKey)] } }, 'not both'],
      ['private-inline', { token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [rsa.privateKey.export({ format: 'jwk' })] } }, 'private or shared key'],
      ['oct-inline', { token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [{ kty: 'oct', k: 'c2VjcmV0' }] } }, 'private or shared key'],
      ['weak-inline', { token_endpoint_auth_method: 'private_key_jwt', jwks: { keys: [pub(weak.publicKey)] } }, 'no usable signing key'],
      ['eddsa', { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: GPT_JWKS, token_endpoint_auth_signing_alg: 'EdDSA' }, 'signing algorithm'],
      ['hs256', { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: GPT_JWKS, token_endpoint_auth_signing_alg: 'HS256' }, 'signing algorithm'],
    ];
    for (const [n, extra, words] of cases) {
      const id = `https://app.example/refused-${n}/client.json`;
      served.set(id, { body: doc(id, extra) });
      const page = await errorPageFor(id);
      expect([n, page.status, page.location]).toEqual([n, 400, null]);
      expect([n, page.text.includes(words)]).toEqual([n, true]);
    }
    // only the documents were fetched, never a key set
    expect(fetched.slice(before).every((u) => u.endsWith('/client.json'))).toBe(true);
  });

  test('none: a public client known by a document URL works as before, and an assertion from it is refused', async () => {
    const id = 'https://claude.example/oauth/claude-code-client-metadata';
    served.set(id, { body: { client_id: id, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' } });
    const g = await getCode(id, 'http://localhost:51234/callback');
    expect(g.request.app).toMatchObject({ name: 'Claude Code', kind: 'cimd', loopback: true });
    const t = await exchange(id, g);
    expect(t.status).toBe(200);
    const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: id });
    expect(r.status).toBe(200);
    // the safer reading: an app the hub knows as public that sends an assertion is refused, not waved through
    const withJwt = await token({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token, client_id: id, ...signed(assertion(id)) });
    expect(withJwt.status).toBe(401);
    expect(withJwt.body.error).toBe('invalid_client');
    expect(withJwt.body.error_description).toContain('not registered for private_key_jwt');
    // and that did not spend the refresh token
    expect((await token({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token, client_id: id })).status).toBe(200);
    // the same for a registered public client
    const reg = (await (await fetch(`${hub.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) })).json()) as any;
    const gr = await getCode(reg.client_id, 'https://claude.ai/api/mcp/auth_callback');
    expect((await exchange(reg.client_id, gr, signed(assertion(reg.client_id)))).status).toBe(401);
    expect((await exchange(reg.client_id, gr)).status).toBe(200);
  });

  test('dcr: an app can register for private_key_jwt with its jwks_uri', async () => {
    const res = await fetch(`${hub.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [GPT_REDIRECT], token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'RS256', jwks_uri: GPT_JWKS }),
    });
    expect(res.status).toBe(201);
    const reg = (await res.json()) as any;
    expect(reg.client_secret).toBeUndefined();
    expect(reg).toMatchObject({ token_endpoint_auth_method: 'private_key_jwt', jwks_uri: GPT_JWKS, token_endpoint_auth_signing_alg: 'RS256' });
    const g = await getCode(reg.client_id, GPT_REDIRECT);
    expect((await exchange(reg.client_id, g)).status).toBe(401);
    expect((await exchange(reg.client_id, g, signed(assertion(reg.client_id)))).status).toBe(200);
    // no keys, or a private one: refused
    for (const extra of [{}, { jwks: { keys: [rsa.privateKey.export({ format: 'jwk' })] } }, { jwks_uri: 'http://app.example/jwks.json' }]) {
      const bad = await fetch(`${hub.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [GPT_REDIRECT], token_endpoint_auth_method: 'private_key_jwt', ...extra }) });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).error).toBe('invalid_client_metadata');
    }
  });

  // last here: it gives the hub an https address of its own
  test('jwt: aud must be one of the hub’s own addresses, not one a request header names', async () => {
    const t = await connect(GPT, GPT_REDIRECT);
    const own = 'https://conclave.example.com';
    hub.engine.config.update({ server: { publicUrl: own } } as never);
    // through the tunnel, as the internet sees it
    const via = (host: string) => ({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' });
    try {
      // a server ChatGPT also talks to holds assertions made for it; naming itself in a header does not make them good here
      const other = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GPT, ...signed(assertion(GPT, { claims: { aud: 'https://evil.example/oauth/token' } })) }, via('evil.example'));
      expect(other.status).toBe(401);
      expect(other.body.error_description).toContain('aud must be');
      // the hub's own address works through the same tunnel
      const ok = await token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: GPT, ...signed(assertion(GPT, { claims: { aud: own } })) }, via('conclave.example.com'));
      expect(ok.status).toBe(200);
    } finally {
      hub.engine.config.update({ server: { publicUrl: undefined } } as never);
    }
  });
});

// ---------------------------------------------------------------------------
// the pure parts

describe('assertion checks', () => {
  const keys = parseJwks({ keys: [pub(rsa.publicKey, 'rsa-1'), pub(ec.publicKey, 'ec-1')] }, 'Keys') as PublicJwk[];
  const ID = 'https://app.example/c.json';
  const AUD = 'https://hub.example';
  const at = 1_800_000_000;
  const claims = (extra: Record<string, unknown> = {}) => ({ iss: ID, sub: ID, aud: AUD, iat: at, exp: at + 300, jti: randomBytes(8).toString('hex'), ...extra });
  const check = (jwt: string, extra: Partial<Parameters<typeof verifyClientAssertion>[1]> = {}) => verifyClientAssertion(jwt, { clientId: ID, audiences: [AUD], nowMs: at * 1000, keys: async () => keys, ...extra });

  test('jwks: private and shared keys refuse the set; encryption, weak and unknown keys are left out', () => {
    expect(keys.length).toBe(2);
    expect(Object.keys(keys[0]).sort()).toEqual(['e', 'kid', 'kty', 'n']);
    expect(parseJwks({ keys: [{ ...pub(rsa.publicKey), d: 'x' }] }, 'Keys')).toContain('private or shared key');
    expect(parseJwks({ keys: [{ kty: 'oct', k: 'abc' }] }, 'Keys')).toContain('private or shared key');
    expect(parseJwks({ keys: [pub(weak.publicKey)] }, 'Keys')).toContain('no usable signing key');
    expect(parseJwks({ keys: [{ kty: 'RSA', n: 'abc', e: 'AQAB' }] }, 'Keys')).toContain('no usable signing key');
    expect(parseJwks([], 'Keys')).toContain('not a JWK set');
    expect(parseJwks({ keys: Array.from({ length: 21 }, () => pub(ec.publicKey)) }, 'Keys')).toContain('more than 20');
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
    const mixed = parseJwks({ keys: [pub(rsa.publicKey, 'enc', { use: 'enc' }), ed, pub(ec.publicKey, 'ok')] }, 'Keys') as PublicJwk[];
    expect(mixed.map((k) => k.kid)).toEqual(['ok']);
  });

  test('jwt: the lifetime bounds and the clock skew', async () => {
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims()))).ok).toBe(true);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ exp: at - CLOCK_SKEW_S + 1 })))).ok).toBe(true);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ exp: at - CLOCK_SKEW_S })))).ok).toBe(false);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ exp: at + MAX_ASSERTION_LIFETIME_S })))).ok).toBe(true);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ exp: at + MAX_ASSERTION_LIFETIME_S + CLOCK_SKEW_S + 1 })))).ok).toBe(false);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ iat: at + CLOCK_SKEW_S })))).ok).toBe(true);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ iat: at + CLOCK_SKEW_S + 1 })))).ok).toBe(false);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ iat: undefined })))).ok).toBe(true);
    expect((await check(signJwt('RS256', rsa.privateKey, { kid: 'rsa-1' }, claims({ exp: String(at + 300) })))).ok).toBe(false);
  });

  test('jwt: an unknown kid asks for the keys once more, and a tampered token fails', async () => {
    const asked: boolean[] = [];
    const res = await check(signJwt('ES256', ec.privateKey, { kid: 'other' }, claims()), { keys: async (force) => (asked.push(force), keys) });
    expect(res.ok).toBe(false);
    expect(asked).toEqual([false, true]);
    const good = signJwt('ES256', ec.privateKey, { kid: 'ec-1' }, claims());
    expect((await check(good)).ok).toBe(true);
    const [h, , s] = good.split('.');
    expect((await check(`${h}.${b64(claims({ sub: ID, iss: ID, exp: at + 3000 }))}.${s}`)).ok).toBe(false);
    // an ES256 signature in DER form, or of the wrong length, does not pass
    const der = cryptoSign('sha256', Buffer.from(good.split('.').slice(0, 2).join('.')), ec.privateKey).toString('base64url');
    expect((await check(`${good.split('.').slice(0, 2).join('.')}.${der}`)).ok).toBe(false);
    // a key that failed to load becomes the reason, not an exception
    const down = await check(good, { keys: async () => { throw new Error('The hub could not fetch the app\'s keys from keys.example.'); } });
    expect(down).toEqual({ ok: false, reason: "The hub could not fetch the app's keys from keys.example." });
  });

  test('jwks cache: kept 5 minutes, fetched again once on demand, never from a private address, not retried at once', async () => {
    let t = 1_000_000;
    let calls = 0;
    const opts = {
      resolve: async (host: string) => (host === 'lan.example' ? ['192.168.1.2'] : ['93.184.216.34']),
      fetch: async () => (calls++, new Response(JSON.stringify({ keys: [pub(rsa.publicKey, 'a')] }))),
    };
    const cache = new JwksCache(() => t);
    await cache.get('https://keys.example/jwks.json', opts);
    await cache.get('https://keys.example/jwks.json', opts);
    expect(calls).toBe(1);
    await cache.get('https://keys.example/jwks.json', opts, true);
    expect(calls).toBe(2);
    await cache.get('https://keys.example/jwks.json', opts, true);
    expect(calls).toBe(2);
    t += JWKS_TTL_MS;
    await cache.get('https://keys.example/jwks.json', opts);
    expect(calls).toBe(3);
    await expect(cache.get('https://lan.example/jwks.json', opts)).rejects.toThrow('not a public internet address');
    await expect(cache.get('https://127.0.0.1/jwks.json', opts)).rejects.toThrow('not a public internet address');
    expect(calls).toBe(3);
    // a fetch that failed is not tried again for a minute, forced or not
    let up = false;
    const flaky = { resolve: opts.resolve, fetch: async () => (calls++, up ? new Response(JSON.stringify({ keys: [pub(rsa.publicKey, 'a')] })) : new Response('down', { status: 503 })) };
    await expect(cache.get('https://flaky.example/jwks.json', flaky)).rejects.toThrow('answered 503');
    await expect(cache.get('https://flaky.example/jwks.json', flaky, true)).rejects.toThrow('answered 503');
    expect(calls).toBe(4);
    up = true;
    t += JWKS_REFETCH_MS;
    expect((await cache.get('https://flaky.example/jwks.json', flaky)).length).toBe(1);
    expect(calls).toBe(5);
  });
});
