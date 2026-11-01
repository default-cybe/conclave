/**
 * Mock routes for password login and hub identity
 * (docs/design/HUB-LOGIN-AND-IDENTITY.md): the hub's Ed25519 key and its
 * signed proof, the fingerprint in /api/info, the password the owner sets in
 * Settings, Remote access, and POST /api/login.
 *
 * The owner token is the mock's own ("mock"); a token from pairing or
 * logging in is a paired client, which may not see or change the password.
 * The busy hub has a password set: any 12 characters or more log in, except
 * one with "wrong" in it. One the owner sets in this tab has to match.
 *
 * Scenarios, for the app's start (both open the normal mock):
 *   ?offline   the hub does not answer for 20 seconds, then it does
 *   ?stranger  the address in use answers with another key; the hub's other
 *              addresses answer 3 seconds after the page loads
 */
import { HubIdentityError } from '@conclave/core/client';
import { keepAddresses } from '@/lib/remote';
import type { MockCtx } from './index';

const LOADED = Date.now();
const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const OFFLINE = query.has('offline');
const STRANGER = query.has('stranger');
const OTHER_ADDRESSES = ['https://madx.tail4e2a.ts.net:7420', 'http://192.168.1.20:7717'];

/** The owner's token in the mock; pairing and logging in give other ones. */
export const OWNER_TOKEN = 'mock';

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

interface Keys {
  publicKey: string;
  fingerprint: string;
  sign: (text: string) => Promise<string>;
}

/** The mock hub's key seed: the same key on every load, so an app that pinned it keeps working. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 73 + 29) & 255);
/** PKCS #8 header for a raw Ed25519 private key (RFC 8410). */
const PKCS8_HEAD = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** A real Ed25519 key where the browser has one (secure pages), else a fixed stand-in whose signatures do not verify. */
async function makeKeys(): Promise<Keys> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const priv = await subtle.importKey('pkcs8', new Uint8Array([...PKCS8_HEAD, ...SEED]), { name: 'Ed25519' }, true, ['sign']);
      const x = (await subtle.exportKey('jwk', priv)).x ?? '';
      const raw = Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const fingerprint = hex(await subtle.digest('SHA-256', raw)).slice(0, 32);
      return {
        publicKey: x,
        fingerprint,
        sign: async (text) => b64url(await subtle.sign({ name: 'Ed25519' }, priv, new TextEncoder().encode(text))),
      };
    } catch {
      /* no Ed25519 in this browser */
    }
  }
  return { publicKey: b64url(SEED), fingerprint: '3f2a9c1b07e45d8a6b2c91f03e7d4a58', sign: async () => b64url(new Uint8Array(64)) };
}

const keys = makeKeys();

/** { publicKey, fingerprint } for /api/info, /api/pair and /api/login. */
export async function mockIdentity() {
  const k = await keys;
  return { publicKey: k.publicKey, fingerprint: k.fingerprint };
}

/** The error a scenario puts in place of the hub's answer, or undefined when the hub answers. */
export function scenarioError(url: URL): Error | undefined {
  if (OFFLINE && Date.now() - LOADED < 20_000) return new TypeError('Failed to fetch');
  if (!STRANGER || url.pathname === '/api/identity') return undefined;
  if (url.origin === location.origin) return new HubIdentityError(url.origin);
  if (Date.now() - LOADED < 3_000) return new TypeError('Failed to fetch');
  return undefined;
}

/** The scenario's other addresses of the hub, kept as the app keeps them after it connects. */
export function seedAddresses() {
  if (STRANGER) keepAddresses({ baseUrl: location.origin, token: OWNER_TOKEN }, [location.origin, ...OTHER_ADDRESSES]);
}

export function registerIdentity(ctx: MockCtx) {
  const { on, fail, uid } = ctx;
  // the busy hub has had a password for a while; a first-run hub has none
  const password: { set: boolean; setAt?: number; value?: string } = ctx.FRESH ? { set: false } : { set: true, setAt: Date.now() - 12 * 86_400_000 };
  const owner = (auth: string | undefined) => {
    if (auth !== OWNER_TOKEN) fail(403, 'Only the owner can change the password. Connect with the token from conclave serve.');
  };
  const status = () => ({ set: password.set, ...(password.setAt ? { setAt: password.setAt } : {}) });

  on('GET', '/api/identity', async ({ query: q }) => {
    const nonce = q.get('nonce') ?? '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) fail(400, 'nonce must be 16 to 128 base64url characters');
    const k = await keys;
    return { publicKey: k.publicKey, fingerprint: k.fingerprint, signature: await k.sign(`conclave-hub-identity-v1\n${nonce}`) };
  });

  on('GET', '/api/auth/password', ({ auth }) => {
    owner(auth);
    return status();
  });
  on('PUT', '/api/auth/password', ({ auth, body }) => {
    owner(auth);
    const value = String(body?.password ?? '');
    if (value.length < 12) fail(400, 'Use 12 characters or more.');
    Object.assign(password, { set: true, setAt: Date.now(), value });
    return status();
  });
  on('DELETE', '/api/auth/password', ({ auth }) => {
    owner(auth);
    Object.assign(password, { set: false, setAt: undefined, value: undefined });
    return status();
  });

  on('POST', '/api/login', async ({ body }) => {
    const given = String(body?.password ?? '');
    const ok = password.set && (password.value !== undefined ? given === password.value : given.length >= 12 && !/wrong/i.test(given));
    if (!ok) fail(401, 'Wrong password, or no password is set on this hub.');
    const hub = (await (await ctx.request('/api/info')).json()) as Record<string, unknown>;
    return { token: `mock-login-${uid('t')}`, clientId: uid('c'), hub, identity: await mockIdentity(), addresses: [location.origin, ...OTHER_ADDRESSES] };
  });
}
