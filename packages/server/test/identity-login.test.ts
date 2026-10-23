import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import QRCode from 'qrcode';
import { ConclaveClient, verifyIdentity, type PairResult } from '@conclave/core/client/index.ts';
import { hubKeyFile, loadHubKey } from '../src/identity';
import { pairDeepLink } from '../src/routes';
// the hub password is the owner's password, kept as a hash on the owner's account (docs/design/ACCOUNTS.md)
const ownerHash = (hub: TestHub): string | null => hub.engine.people.passwordHash('owner') ?? null;
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

const NONCE = 'abcdefghijklmnop0123456789_-ABCD';
const PASSWORD = 'correct horse battery staple';
const WRONG = 'Wrong password, or no password is set on this hub.';

/** Ed25519 check with node:crypto, from the raw key. */
function nodeVerify(publicKey: string, signature: string, nonce: string): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  return verify(null, Buffer.from(`conclave-hub-identity-v1\n${nonce}`, 'utf8'), key, Buffer.from(signature, 'base64url'));
}

async function pairClient(): Promise<PairResult> {
  const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
  return hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'phone' } }).then((r) => r.json());
}

const login = (password: string, ip?: string) =>
  hub.api('/api/login', { method: 'POST', token: null, json: { password, name: 'Pixel', platform: 'android' }, headers: ip ? { 'x-forwarded-for': ip } : {} });

describe('hub identity', () => {
  test('GET /api/identity signs the nonce, with no token', async () => {
    const res = await hub.api(`/api/identity?nonce=${NONCE}`, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const proof = await res.json();
    const raw = Buffer.from(proof.publicKey, 'base64url');
    expect(raw).toHaveLength(32);
    expect(proof.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof.fingerprint).toBe(createHash('sha256').update(raw).digest('hex').slice(0, 32));
    expect(nodeVerify(proof.publicKey, proof.signature, NONCE)).toBe(true);
    expect(nodeVerify(proof.publicKey, proof.signature, `${NONCE}x`)).toBe(false);
    // the shared client agrees
    expect(await verifyIdentity(proof, NONCE, proof.publicKey)).toBe(true);
    expect(await verifyIdentity(proof, `${NONCE}x`, proof.publicKey)).toBe(false);
  });

  test('a missing or bad nonce is a 400', async () => {
    const bad = ['', '?nonce=', '?nonce=short', `?nonce=${'a'.repeat(15)}`, `?nonce=${'a'.repeat(129)}`, `?nonce=${encodeURIComponent('abcdefghijklmnop+/==')}`, `?nonce=${encodeURIComponent('abcdefghijklmnop.q')}`];
    for (const q of bad) {
      const res = await hub.api(`/api/identity${q}`, { token: null });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('nonce must be 16 to 128 base64url characters');
    }
    expect((await hub.api(`/api/identity?nonce=${'a'.repeat(16)}`, { token: null })).status).toBe(200);
    expect((await hub.api(`/api/identity?nonce=${'-'.repeat(128)}`, { token: null })).status).toBe(200);
  });

  test('the key lives in the data folder with mode 0600 and stays the same', () => {
    const home = hub.engine.config.paths.home;
    const file = hubKeyFile(home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toStartWith('-----BEGIN PRIVATE KEY-----');
    expect(loadHubKey(home).publicKey).toBe(hub.running.conclave.ctx.identity.publicKey);
  });

  test('/api/info, the pair reply and the QR code carry the fingerprint', async () => {
    const { publicKey, fingerprint } = hub.running.conclave.ctx.identity;
    expect((await hub.api('/api/info').then((r) => r.json())).fingerprint).toBe(fingerprint);
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    expect(pairing.fingerprint).toBe(fingerprint);
    expect(new URL(pairing.deepLink).searchParams.get('fp')).toBe(fingerprint);
    // the QR code is the link, fp included
    expect(pairing.qrSvg).toBe(await QRCode.toString(pairing.deepLink, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
    const paired = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'phone' } }).then((r) => r.json());
    expect(paired.identity).toEqual({ publicKey, fingerprint });
    expect(paired.hub.fingerprint).toBe(fingerprint);
  });

  test('fp comes before the other addresses in the link', () => {
    const fp = 'f'.repeat(32);
    expect(pairDeepLink(['https://a.example', 'http://192.168.1.4:7717'], 'ABCD-EFGH', fp)).toBe(
      `conclave://pair?url=https%3A%2F%2Fa.example&code=ABCD-EFGH&fp=${fp}&alt=http%3A%2F%2F192.168.1.4%3A7717`,
    );
  });
});

describe('password login', () => {
  test('the password routes are for the owner token only', async () => {
    const paired = await pairClient();
    for (const [method, json] of [['GET'], ['PUT', { password: PASSWORD }], ['DELETE']] as const) {
      const res = await hub.api('/api/auth/password', { method, json, token: paired.token });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Only the owner token can see or change the hub password.');
      expect((await hub.api('/api/auth/password', { method, json, token: null })).status).toBe(401);
    }
    expect(ownerHash(hub)).toBeNull();
  });

  test('set, status and clear; only an argon2id hash is kept, on the owner account', async () => {
    const short = await hub.api('/api/auth/password', { method: 'PUT', json: { password: 'eleven char' } });
    expect(short.status).toBe(400);
    expect((await short.json()).error).toBe('The password needs 12 characters or more.');
    expect(await hub.api('/api/auth/password').then((r) => r.json())).toEqual({ set: false });

    const set = await hub.api('/api/auth/password', { method: 'PUT', json: { password: PASSWORD } }).then((r) => r.json());
    expect(set.set).toBe(true);
    expect(set.setAt).toBeGreaterThan(0);
    expect(await hub.api('/api/auth/password').then((r) => r.json())).toEqual(set);
    const stored = ownerHash(hub);
    expect(stored).toStartWith('$argon2id$');
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(readFileSync(hub.engine.config.paths.config, 'utf8')).not.toContain('argon2');

    expect(await hub.api('/api/auth/password', { method: 'DELETE' }).then((r) => r.json())).toEqual({ set: false });
    expect(ownerHash(hub)).toBeNull();
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.map((a: { action: string }) => a.action)).toContain('password.set');
    expect(audit.map((a: { action: string }) => a.action)).toContain('password.clear');
  });

  test('the right password gives the same reply as pairing', async () => {
    await hub.api('/api/auth/password', { method: 'PUT', json: { password: PASSWORD } });
    const client = new ConclaveClient({ baseUrl: hub.url });
    const res = await client.login(PASSWORD, 'Pixel', 'android');
    expect(res.token).toStartWith('ccl_');
    expect(res.hub.name).toBe('test hub');
    expect(res.addresses).toEqual([hub.url]);
    expect(res.identity).toEqual(hub.running.conclave.ctx.identity.identity());
    client.token = res.token;
    expect((await client.listSessions()).length).toBeGreaterThanOrEqual(0);
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.find((a: { action: string }) => a.action === 'login.client')?.detail).toContain('Pixel (android)');
  });

  test('a wrong password and no password give the same 400', async () => {
    await hub.api('/api/auth/password', { method: 'PUT', json: { password: PASSWORD } });
    const wrong = await login('not the password at all');
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe(WRONG);
    await hub.api('/api/auth/password', { method: 'DELETE' });
    const none = await login(PASSWORD);
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe(WRONG);
    const audit = await hub.api('/api/audit').then((r) => r.json());
    expect(audit.filter((a: { action: string }) => a.action === 'login.failed').length).toBeGreaterThanOrEqual(2);
  });

  test(
    'wrong passwords count with wrong pairing codes, and the address is blocked',
    async () => {
      await hub.api('/api/auth/password', { method: 'PUT', json: { password: PASSWORD } });
      const guard = hub.running.conclave.ctx.pairGuard;
      // the same wrong password again is not a new guess
      const ip = '203.0.113.60';
      for (let i = 0; i < 3; i++) expect((await login('the same wrong one', ip)).status).toBe(400);
      expect(guard.failures(ip)).toBe(1);

      const ip2 = '203.0.113.61';
      for (let i = 0; i < 5; i++) {
        const r = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: `WRNG-000${i}` }, headers: { 'x-forwarded-for': ip2 } });
        expect(r.status).toBe(400);
      }
      for (let i = 0; i < 5; i++) expect((await login(`wrong guess number ${i}`, ip2)).status).toBe(400);
      expect(guard.blocked(ip2)).toBeGreaterThan(0);
      const blocked = await login(PASSWORD, ip2);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      const audit = await hub.api('/api/audit').then((r) => r.json());
      expect(audit.find((a: { action: string }) => a.action === 'login.blocked')).toMatchObject({ actor: `ip:${ip2}` });

      // a blocked address cannot log in even with the right password, and says why
      const ip3 = '203.0.113.62';
      for (let i = 0; i < guard.opts.limit; i++) guard.fail(ip3, Date.now(), `x${i}`);
      const res = await login(PASSWORD, ip3);
      expect(res.status).toBe(429);
      expect((await res.json()).error).toContain('Too many wrong pairing codes or passwords from this address');
      // others are fine
      expect((await login(PASSWORD, '203.0.113.63')).status).toBe(200);
    },
    30_000,
  );

  test('a backup never holds the password hash', async () => {
    await hub.api('/api/auth/password', { method: 'PUT', json: { password: PASSWORD } });
    const hash = ownerHash(hub) ?? '';
    expect(hash).toStartWith('$argon2id$');
    for (const q of ['', '?secrets=1']) {
      const text = await hub.api(`/api/backup${q}`).then((r) => r.text());
      expect(text).toContain('conclave-backup');
      expect(text).not.toContain(hash);
      expect(text).not.toContain('argon2');
    }
  });
});
