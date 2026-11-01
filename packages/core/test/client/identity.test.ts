import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { Server } from 'bun';
import {
  ApiError,
  ConclaveClient,
  HubIdentityError,
  IDENTITY_PREFIX,
  NETWORK_REFUSED,
  fingerprintOf,
  formatFingerprint,
  isPrivateAddress,
  verifyIdentity,
  type IdentityProof,
} from '../../src/client';

interface Key {
  publicKey: string;
  fingerprint: string;
  prove(nonce: string): IdentityProof;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const id = { publicKey: raw.toString('base64url'), fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 32) };
  return { ...id, prove: (nonce) => ({ ...id, signature: sign(null, Buffer.from(IDENTITY_PREFIX + nonce), privateKey).toString('base64url') }) };
}

interface FakeHub {
  url: string;
  /** Every request: its path and the credential it carried, if any. */
  seen: Array<{ path: string; auth: string | null }>;
  server: Server<undefined>;
}

/** A hub on Bun.serve that proves `key` (or answers /api/identity with `identity`) and records every request. */
function fakeHub(key: Key, identity?: (nonce: string) => Response): FakeHub {
  const seen: FakeHub['seen'] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, auth: req.headers.get('authorization') ?? url.searchParams.get('token') });
      if (url.pathname === '/api/identity') {
        const nonce = url.searchParams.get('nonce') ?? '';
        return identity ? identity(nonce) : Response.json(key.prove(nonce));
      }
      if (url.pathname === '/api/info') return Response.json({ name: 'hub', version: '1' });
      if (url.pathname === '/api/login') return Response.json({ token: 'ccl_new', clientId: 'cli_1', hub: { name: 'hub' } });
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, server };
}

// the check skips loopback, so clients use a public name and this fetch sends it to a fake hub
const PUBLIC = 'https://hub.example.test';
function via(target: () => string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => fetch(String(input).replace(PUBLIC, target()), init)) as typeof fetch;
}

const keyA = makeKey();
const keyB = makeKey();
let real: FakeHub;
let stranger: FakeHub;
const extra: FakeHub[] = [];

beforeAll(() => {
  real = fakeHub(keyA);
  stranger = fakeHub(keyB);
});
afterEach(() => {
  real.seen.length = 0;
  stranger.seen.length = 0;
  setSystemTime();
});
afterAll(() => {
  for (const h of [real, stranger, ...extra]) h.server.stop(true);
});

const identityCalls = (h: FakeHub) => h.seen.filter((s) => s.path === '/api/identity').length;

describe('the identity check before the token', () => {
  test('the token goes out only after the hub proves the pinned key', async () => {
    const client = new ConclaveClient({ baseUrl: PUBLIC, token: 'ccl_secret', hubKey: keyA.publicKey, fetch: via(() => real.url) });
    expect((await client.info()).name).toBe('hub');
    expect(real.seen).toEqual([
      { path: '/api/identity', auth: null },
      { path: '/api/info', auth: 'Bearer ccl_secret' },
    ]);
  });

  test('a hub with another key gets nothing that carries the token or a password', async () => {
    const client = new ConclaveClient({ baseUrl: PUBLIC, token: 'ccl_secret', hubKey: keyA.publicKey, fetch: via(() => stranger.url) });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(HubIdentityError);
    expect(err.address).toBe(PUBLIC);
    expect(err.message).toBe('This address is not your hub. Conclave did not send your sign-in.');
    await expect(client.login('correct horse battery staple', 'Pixel', 'android')).rejects.toBeInstanceOf(HubIdentityError);
    await expect(client.uploadImport('chatgpt', new Uint8Array([1]))).rejects.toBeInstanceOf(HubIdentityError);
    expect(stranger.seen.every((s) => s.path === '/api/identity' && s.auth === null)).toBe(true);
    expect(stranger.seen.length).toBeGreaterThan(0);
  });

  test('the right key with a bad signature is not the hub', async () => {
    // a replayed proof: the right key, signing another nonce
    const forger = fakeHub(keyA, (nonce) => Response.json(keyA.prove(`${nonce}x`)));
    extra.push(forger);
    const client = new ConclaveClient({ baseUrl: PUBLIC, token: 'ccl_secret', hubKey: keyA.publicKey, fetch: via(() => forger.url) });
    await expect(client.info()).rejects.toBeInstanceOf(HubIdentityError);
    expect(forger.seen.map((s) => s.path)).toEqual(['/api/identity']);
  });

  test('an answer that is not a proof is not the hub; a server error is not a stranger', async () => {
    const notHub = fakeHub(keyA, () => new Response('<html>Sign in to the Wi-Fi</html>', { status: 404 }));
    const down = fakeHub(keyA, () => Response.json({ error: 'bad gateway' }, { status: 502 }));
    extra.push(notHub, down);
    const a = new ConclaveClient({ baseUrl: PUBLIC, token: 't', hubKey: keyA.publicKey, fetch: via(() => notHub.url) });
    await expect(a.info()).rejects.toBeInstanceOf(HubIdentityError);
    const b = new ConclaveClient({ baseUrl: PUBLIC, token: 't', hubKey: keyA.publicKey, fetch: via(() => down.url) });
    const err = await b.info().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(HubIdentityError);
    expect(err.status).toBe(502);
    expect(down.seen.map((s) => s.path)).toEqual(['/api/identity']);
  });

  test("the hub's network refusal is an API error in the client's words, and nothing is sent", async () => {
    const gated = fakeHub(keyA, () => Response.json({ error: 'Sign in at evil.example to continue', code: 'network' }, { status: 403 }));
    extra.push(gated);
    const client = new ConclaveClient({ baseUrl: PUBLIC, token: 'ccl_secret', hubKey: keyA.publicKey, fetch: via(() => gated.url) });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(HubIdentityError);
    expect(err.status).toBe(403);
    expect(err.message).toBe(NETWORK_REFUSED);
    expect(gated.seen.map((s) => s.path)).toEqual(['/api/identity']);
  });

  test('a network error is a connection error, not an identity error, and nothing is sent', async () => {
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const url = `http://127.0.0.1:${gone.port}`;
    gone.stop(true);
    const client = new ConclaveClient({ baseUrl: PUBLIC, token: 'ccl_secret', hubKey: keyA.publicKey, fetch: via(() => url) });
    const err = await client.info().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HubIdentityError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  test('a pass counts for ten minutes per address, and calls at once share one check', async () => {
    // both names reach the same hub
    const anyName = ((i: RequestInfo | URL, init?: RequestInit) => fetch(String(i).replace(/^https:\/\/[a-z]+\.example\.test/, real.url), init)) as typeof fetch;
    const client = new ConclaveClient({ baseUrl: PUBLIC, token: 't', hubKey: keyA.publicKey, fetch: anyName });
    await Promise.all([client.info(), client.info(), client.info()]);
    expect(identityCalls(real)).toBe(1);
    await client.info();
    expect(identityCalls(real)).toBe(1);
    setSystemTime(new Date(Date.now() + 9 * 60_000));
    await client.info();
    expect(identityCalls(real)).toBe(1);
    setSystemTime(new Date(Date.now() + 2 * 60_000));
    await client.info();
    expect(identityCalls(real)).toBe(2);
    // another address is checked on its own
    client.baseUrl = 'https://other.example.test';
    await client.info();
    expect(identityCalls(real)).toBe(3);
    client.baseUrl = PUBLIC;
    await client.info();
    expect(identityCalls(real)).toBe(3);
  });

  test('a QR fingerprint is checked the same way', async () => {
    const client = new ConclaveClient({ baseUrl: PUBLIC, fetch: via(() => real.url) });
    expect(await client.checkIdentity({ fingerprint: keyA.fingerprint })).toEqual({ publicKey: keyA.publicKey, fingerprint: keyA.fingerprint });
    await expect(client.checkIdentity({ fingerprint: keyB.fingerprint })).rejects.toBeInstanceOf(HubIdentityError);
    // with nothing to compare, any key that signs is taken
    expect((await client.checkIdentity()).publicKey).toBe(keyA.publicKey);
  });

  test('loopback and clients without a pinned key are not checked', async () => {
    await new ConclaveClient({ baseUrl: real.url, token: 't', hubKey: keyB.publicKey }).info();
    await new ConclaveClient({ baseUrl: PUBLIC, token: 't', fetch: via(() => real.url) }).info();
    expect(identityCalls(real)).toBe(0);
  });
});

/** A socket the test drives: it opens at once. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

test('the socket opens only after the check, and a reconnect checks again', async () => {
  let target = real.url;
  const client = new ConclaveClient({ baseUrl: PUBLIC, token: 'ccl_secret', hubKey: keyA.publicKey, fetch: via(() => target) });
  const errors: HubIdentityError[] = [];
  FakeSocket.all = [];
  const stop = client.connect(() => {}, { WebSocketImpl: FakeSocket as unknown as typeof WebSocket, onIdentityError: (e) => errors.push(e) });
  // nothing is opened before the hub answers
  expect(FakeSocket.all).toHaveLength(0);
  await Bun.sleep(50);
  expect(FakeSocket.all).toHaveLength(1);
  expect(FakeSocket.all[0].url).toBe('wss://hub.example.test/api/ws?token=ccl_secret');
  expect(identityCalls(real)).toBe(1);

  // the socket drops: the next one waits for a new check, within the ten minutes too
  FakeSocket.all[0].drop();
  await Bun.sleep(700);
  expect(identityCalls(real)).toBe(2);
  expect(FakeSocket.all).toHaveLength(2);

  // the address now answers for another machine: no socket, no token
  target = stranger.url;
  FakeSocket.all[1].drop();
  await Bun.sleep(700);
  expect(errors.length).toBe(1);
  expect(errors[0]).toBeInstanceOf(HubIdentityError);
  expect(FakeSocket.all).toHaveLength(2);
  expect(stranger.seen.every((s) => s.path === '/api/identity' && s.auth === null)).toBe(true);
  stop();
});

describe('password login over plain http', () => {
  test('to a public host it is refused before any request', async () => {
    let calls = 0;
    const counting = (() => {
      calls++;
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    const client = new ConclaveClient({ baseUrl: 'http://hub.example.test', fetch: counting });
    await expect(client.login('correct horse battery staple', 'Pixel', 'android')).rejects.toThrow('Use the https address of your hub to log in with a password.');
    expect(calls).toBe(0);
    // https, loopback and private addresses are fine
    for (const baseUrl of ['https://hub.example.test', 'http://127.0.0.1:7717', 'http://192.168.1.20:7717', 'http://hub.tail1234.ts.net']) {
      await new ConclaveClient({ baseUrl, fetch: counting }).login('correct horse battery staple', 'Pixel', 'android');
    }
    expect(calls).toBe(4);
  });

  test('isPrivateAddress', () => {
    const yes = [
      'http://localhost:7717',
      'http://127.0.0.1',
      'http://127.8.9.10:1',
      'http://[::1]:7717',
      'http://10.0.0.5',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.20:7717',
      'http://100.64.0.1',
      'http://100.127.255.254',
      'http://[fd7a:115c:a1e0::1]:7717',
      'http://hub.local',
      'http://hub.local.:7717',
      'https://box.tail1234.ts.net',
      '192.168.0.2:7717',
    ];
    const no = ['http://8.8.8.8', 'http://172.15.0.1', 'http://172.32.0.1', 'http://100.63.0.1', 'http://100.128.0.1', 'http://192.169.0.1', 'http://[2001:db8::1]', 'http://[fc00::1]', 'https://hub.example.com', 'http://local', 'http://evil.ts.net.example.com', 'not a url at all'];
    for (const u of yes) expect([u, isPrivateAddress(u)]).toEqual([u, true]);
    for (const u of no) expect([u, isPrivateAddress(u)]).toEqual([u, false]);
  });
});

describe('verifyIdentity and fingerprints', () => {
  const nonce = 'nonce-nonce-nonce-1234';
  test('a good proof passes; another key, another nonce or a wrong fingerprint does not', async () => {
    const proof = keyA.prove(nonce);
    expect(await verifyIdentity(proof, nonce)).toBe(true);
    expect(await verifyIdentity(proof, nonce, keyA.publicKey)).toBe(true);
    expect(await verifyIdentity(proof, nonce, keyB.publicKey)).toBe(false);
    expect(await verifyIdentity(proof, `${nonce}x`, keyA.publicKey)).toBe(false);
    expect(await verifyIdentity({ ...proof, fingerprint: keyB.fingerprint }, nonce, keyA.publicKey)).toBe(false);
    expect(await verifyIdentity({ ...keyB.prove(nonce), publicKey: keyA.publicKey, fingerprint: keyA.fingerprint }, nonce, keyA.publicKey)).toBe(false);
    expect(await verifyIdentity({ ...proof, signature: 'AAAA' }, nonce)).toBe(false);
    expect(await verifyIdentity({ ...proof, publicKey: 'not+base64url' }, nonce)).toBe(false);
    expect(await verifyIdentity('<html>' as unknown as IdentityProof, nonce)).toBe(false);
  });

  test('fingerprintOf is the first 16 bytes of SHA-256 of the raw key', async () => {
    expect(await fingerprintOf(keyA.publicKey)).toBe(keyA.fingerprint);
    await expect(fingerprintOf('AAAA')).rejects.toThrow('Not an Ed25519 public key.');
    expect(formatFingerprint('0123456789abcdef0123456789abcdef')).toBe('0123 4567 89ab cdef 0123 4567 89ab cdef');
  });
});
