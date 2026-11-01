/**
 * Reaching the saved hub and its identity (lib/identity.ts, lib/reach.ts,
 * lib/remote.ts): the fingerprint in groups of four, which addresses the app
 * tries and in what order, the retry backoff, the offline banner's words,
 * and the password check in Settings.
 *
 *   bun test packages/web/test/hub-reach.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { ApiError, fingerprintOf, HubIdentityError, IDENTITY_PREFIX } from '@conclave/core/client';
import { cannotCheckWords, fingerprintGroups, isCannotCheckError, isHubIdentityError, onHubIdentityError, reportHubError } from '../src/lib/identity';
import { addressOrder, keepAddresses } from '../src/lib/remote';
import { reachHub, retryDelay } from '../src/lib/reach';
import { nextTryWords } from '../src/features/connect/OfflineBanner';
import { passwordProblem } from '../src/features/settings/identity';

describe('fingerprintGroups', () => {
  test('32 hex characters become eight groups of four', () => {
    expect(fingerprintGroups('3f2a9c1b07e45d8a6b2c91f03e7d4a58')).toEqual(['3f2a', '9c1b', '07e4', '5d8a', '6b2c', '91f0', '3e7d', '4a58']);
  });
  test('upper case, spaces and colons from a pasted copy are read the same', () => {
    expect(fingerprintGroups('3F2A 9C1B:07E4')).toEqual(['3f2a', '9c1b', '07e4']);
  });
  test('a short tail stays as it is, and nothing gives no groups', () => {
    expect(fingerprintGroups('abcdef')).toEqual(['abcd', 'ef']);
    expect(fingerprintGroups(undefined)).toEqual([]);
    expect(fingerprintGroups('')).toEqual([]);
  });
});

describe('HubIdentityError', () => {
  test('is known by class and by name', () => {
    expect(isHubIdentityError(new HubIdentityError('https://old.example.com'))).toBe(true);
    const copy = new Error('This address is not your hub.');
    copy.name = 'HubIdentityError';
    expect(isHubIdentityError(copy)).toBe(true);
    expect(isHubIdentityError(new ApiError(401, 'unauthorized'))).toBe(false);
    expect(isHubIdentityError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isHubIdentityError('HubIdentityError')).toBe(false);
  });
  test('the default message says nothing was sent', () => {
    expect(new HubIdentityError('https://x').message).toBe('This address is not your hub. Conclave did not send your sign-in.');
  });
  test('reportHubError passes on identity errors only, until the listener stops', () => {
    const seen: string[] = [];
    const stop = onHubIdentityError((e) => seen.push(e.address));
    expect(reportHubError(new TypeError('Failed to fetch'))).toBe(false);
    expect(reportHubError(new HubIdentityError('https://a.example.com'))).toBe(true);
    stop();
    reportHubError(new HubIdentityError('https://b.example.com'));
    expect(seen).toEqual(['https://a.example.com']);
  });
  test("the client's error for a platform without Ed25519 is known, and an iPhone says what it needs", () => {
    const e = new Error("This browser cannot check the hub's key (no Ed25519 in WebCrypto). Update it, or open the hub's own address.");
    expect(isCannotCheckError(e)).toBe(true);
    expect(isCannotCheckError(new Error("This page cannot check the hub's key (no WebCrypto here). Open it over https."))).toBe(true);
    expect(isCannotCheckError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isCannotCheckError(new HubIdentityError('https://x'))).toBe(false);
    const g = globalThis as { navigator?: unknown };
    const before = g.navigator;
    try {
      g.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X)' };
      expect(cannotCheckWords(e)).toBe('This iPhone needs iOS 17 or later to check the hub. Conclave did not send your sign-in.');
      g.navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' };
      expect(cannotCheckWords(e)).toBe(e.message);
    } finally {
      g.navigator = before;
    }
  });
});

describe('addressOrder', () => {
  const app = { origin: 'capacitor://localhost', protocol: 'capacitor:' };
  test('the address in use first, then the others once each, without trailing slashes', () => {
    expect(addressOrder('https://quiet-river-lamp.trycloudflare.com/', ['https://quiet-river-lamp.trycloudflare.com', 'https://madx.tail4e2a.ts.net:7420/', 'http://192.168.1.20:7717', 'http://192.168.1.20:7717'], app)).toEqual([
      'https://quiet-river-lamp.trycloudflare.com',
      'https://madx.tail4e2a.ts.net:7420',
      'http://192.168.1.20:7717',
    ]);
  });
  test('an https page skips plain http addresses', () => {
    expect(addressOrder('https://hub.example.com', ['http://192.168.1.20:7717', 'https://madx.tail4e2a.ts.net'], { origin: 'https://app.example.com', protocol: 'https:' })).toEqual(['https://hub.example.com', 'https://madx.tail4e2a.ts.net']);
  });
  test('a page the hub served stays on its own address', () => {
    expect(addressOrder('http://192.168.1.20:7717', ['https://madx.tail4e2a.ts.net'], { origin: 'http://192.168.1.20:7717', protocol: 'http:' })).toEqual(['http://192.168.1.20:7717']);
  });
  test('no saved addresses leaves the one in use', () => {
    expect(addressOrder('https://hub.example.com', [], app)).toEqual(['https://hub.example.com']);
  });
});

describe('retry backoff', () => {
  test('doubles from 2 seconds and stops at a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 12].map(retryDelay)).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });
  test('a negative count is the first wait', () => {
    expect(retryDelay(-3)).toBe(2000);
  });
  test('the banner says when the next try starts', () => {
    expect(nextTryWords(10_000 + 12_000, 10_000)).toBe('in 12 s');
    expect(nextTryWords(10_000 + 11_200, 10_000)).toBe('in 12 s');
    expect(nextTryWords(10_000 + 60_000, 10_000)).toBe('in 1 min');
    expect(nextTryWords(5_000, 10_000)).toBe('in 0 s');
    expect(nextTryWords(undefined, 10_000)).toBeUndefined();
  });
});

describe('passwordProblem', () => {
  test('12 characters or more, typed the same twice', () => {
    expect(passwordProblem('short', 'short')).toBe('Use 12 characters or more.');
    expect(passwordProblem('long enough pass', 'long enough pas')).toBe('The two passwords do not match. Type the same one twice.');
    expect(passwordProblem('long enough pass', 'long enough pass')).toBeUndefined();
  });
});

describe('reachHub', () => {
  /** hub: our hub; other: a machine with another key; old: a hub from before keys; down: no answer; refused: a 401. */
  type Answer = 'hub' | 'other' | 'old' | 'down' | 'refused';
  const g = globalThis as unknown as Record<string, unknown>;
  const b64url = (b: ArrayBuffer) => Buffer.from(b).toString('base64url');
  type Key = { publicKey: string; fingerprint: string; sign: (text: string) => Promise<string> };
  async function makeKey(): Promise<Key> {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { publicKey, fingerprint: await fingerprintOf(publicKey), sign: async (text) => b64url(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(text))) };
  }
  let ours: Key;
  let theirs: Key;
  beforeAll(async () => {
    ours = await makeKey();
    theirs = await makeKey();
  });

  /** Run fn with fetch answering per host, an app page origin and an in-memory localStorage. */
  async function withHosts(answers: Record<string, Answer>, saved: string[], fn: (store: Map<string, string>) => Promise<void>) {
    const before = { fetch: g.fetch, location: g.location, localStorage: g.localStorage };
    const store = new Map<string, string>();
    g.location = { origin: 'capacitor://localhost', protocol: 'capacitor:' };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    g.fetch = async (input: string) => {
      const u = new URL(input);
      const a = answers[u.host] ?? 'down';
      if (a === 'down') throw new TypeError('Failed to fetch');
      if (a === 'refused') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      if (u.pathname === '/api/identity') {
        if (a === 'old') return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        const k = a === 'hub' ? ours : theirs;
        const nonce = u.searchParams.get('nonce') ?? '';
        return new Response(JSON.stringify({ publicKey: k.publicKey, fingerprint: k.fingerprint, signature: await k.sign(IDENTITY_PREFIX + nonce) }));
      }
      return new Response(JSON.stringify({ name: 'madx', version: '1', startedAt: 0, devices: 1, defaultModel: 'm', features: [] }));
    };
    try {
      keepAddresses({ baseUrl: 'https://a.example.com', token: 't' }, saved);
      await fn(store);
    } finally {
      Object.assign(g, before);
    }
  }

  const conn = { baseUrl: 'https://a.example.com', token: 't' };
  const pinned = () => ({ ...conn, hubKey: ours.publicKey });
  const savedConn = (store: Map<string, string>) => JSON.parse(store.get('conclave.connection') ?? 'null');

  test('the address in use answers: saved with the hub name, and the key it proves on the first check', async () => {
    await withHosts({ 'a.example.com': 'hub' }, [], async (store) => {
      const r = await reachHub(conn);
      expect(r).toMatchObject({ kind: 'ok', conn: { baseUrl: 'https://a.example.com', hubName: 'madx', hubKey: ours.publicKey } });
      expect(savedConn(store)).toMatchObject({ baseUrl: 'https://a.example.com', hubName: 'madx', hubKey: ours.publicKey });
    });
  });

  test('a hub from before keys still connects, with no key kept', async () => {
    await withHosts({ 'a.example.com': 'old' }, [], async () => {
      const r = await reachHub(conn);
      expect(r.kind).toBe('ok');
      expect(r.kind === 'ok' && r.conn.hubKey).toBeFalsy();
    });
  });

  test('a pinned key that the hub proves is kept as it is', async () => {
    await withHosts({ 'a.example.com': 'hub' }, [], async () => {
      expect(await reachHub(pinned())).toMatchObject({ kind: 'ok', conn: { hubKey: ours.publicKey } });
    });
  });

  test('no answer at the address in use: the next address that answers', async () => {
    await withHosts({ 'a.example.com': 'down', 'b.example.com': 'down', 'c.example.com': 'hub' }, ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'], async (store) => {
      expect(await reachHub(pinned())).toMatchObject({ kind: 'ok', conn: { baseUrl: 'https://c.example.com' } });
      expect(savedConn(store).baseUrl).toBe('https://c.example.com');
    });
  });

  test('another key at the address in use and no other answer: stranger, nothing saved', async () => {
    await withHosts({ 'a.example.com': 'other', 'b.example.com': 'down' }, ['https://b.example.com'], async (store) => {
      expect(await reachHub(pinned())).toEqual({ kind: 'stranger', address: 'https://a.example.com' });
      expect(savedConn(store)).toBeNull();
    });
  });

  test('another key at the address in use, the hub at another: the other', async () => {
    await withHosts({ 'a.example.com': 'other', 'b.example.com': 'hub' }, ['https://b.example.com'], async () => {
      expect(await reachHub(pinned())).toMatchObject({ kind: 'ok', conn: { baseUrl: 'https://b.example.com' } });
    });
  });

  test('the address the owner picked is the only one tried', async () => {
    await withHosts({ 'a.example.com': 'hub', 'b.example.com': 'hub', 'c.example.com': 'down' }, ['https://b.example.com', 'https://c.example.com'], async () => {
      expect(await reachHub(pinned(), 'https://b.example.com')).toMatchObject({ kind: 'ok', conn: { baseUrl: 'https://b.example.com' } });
      expect(await reachHub(pinned(), 'https://c.example.com')).toEqual({ kind: 'offline' });
    });
  });

  test('a refused token stops at once; no answer anywhere is offline', async () => {
    await withHosts({ 'a.example.com': 'refused', 'b.example.com': 'hub' }, ['https://b.example.com'], async () => {
      expect(await reachHub(conn)).toEqual({ kind: 'refused', message: 'unauthorized' });
    });
    await withHosts({}, ['https://b.example.com'], async () => {
      expect(await reachHub(pinned())).toEqual({ kind: 'offline' });
    });
  });
});
