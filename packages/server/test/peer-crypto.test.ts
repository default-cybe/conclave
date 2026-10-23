/**
 * conclave-peer/1 building blocks: hub key signatures, the X25519 subkey,
 * sealing, safety codes, invite proofs, signed requests, envelopes, address
 * records and ULIDs. Known vectors come from RFC 8032 (Ed25519) and RFC 7748
 * (X25519); the seal vector is checked against a derivation done here with
 * plain node:crypto.
 */
import { describe, expect, test } from 'bun:test';
import { createCipheriv, createHash, createPrivateKey, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubKey } from '../src/identity';
import {
  PREFIX,
  PeerSubkey,
  fingerprintOf,
  inviteProof,
  inviteSecretHash,
  loadSubkey,
  open,
  safetyCode,
  seal,
  signSubkey,
  subkeyFile,
  verifySigned,
  verifySubkey,
} from '../src/peer/crypto';
import { buildEnvelope, keyRotateBody, openEnvelope, parseEnvelope, signRecord, verifyEnvelope, verifyKeyRotate, verifyRecord } from '../src/peer/envelope';
import { MAX_TTL_SEC, contentDigest, isRefusal, parseSignature, signRequest, verifySignature, type IncomingRequest, type ParsedSignature } from '../src/peer/signing';
import { ULID, ulid, ulidTime } from '../src/peer/ulid';

const hex = (s: string) => Buffer.from(s, 'hex');
const b64u = (b: Buffer) => b.toString('base64url');

// RFC 8032 7.1, test 1
const ED_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const ED_PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const ED_SIG = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
// RFC 7748 6.1
const X_ALICE = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
const X_ALICE_PUB = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
const X_BOB = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
const X_BOB_PUB = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
const X_SHARED = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

function rfcHubKey(): HubKey {
  return new HubKey(createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(hex(ED_SEED)), x: b64u(hex(ED_PUB)) }, format: 'jwk' }));
}

const newHubKey = () => new HubKey(generateKeyPairSync('ed25519').privateKey);

describe('hub key signatures', () => {
  test('HubKey.sign matches RFC 8032 test 1 and adds its prefix before the data', () => {
    const key = rfcHubKey();
    expect(key.publicKey).toBe(b64u(hex(ED_PUB)));
    expect(Buffer.from(key.sign('', ''), 'base64url').toString('hex')).toBe(ED_SIG);
    expect(key.sign('ab', 'cd')).toBe(key.sign('', 'abcd'));
    expect(key.fingerprint).toBe(createHash('sha256').update(hex(ED_PUB)).digest('hex').slice(0, 32));
    expect(fingerprintOf(key.publicKey)).toBe(key.fingerprint);
  });

  test('verifySigned refuses a changed message, prefix, key or signature', () => {
    const key = newHubKey();
    const sig = key.sign('p\n', 'data');
    expect(verifySigned(key.publicKey, 'p\n', 'data', sig)).toBe(true);
    expect(verifySigned(key.publicKey, 'p\n', 'datA', sig)).toBe(false);
    expect(verifySigned(key.publicKey, 'q\n', 'data', sig)).toBe(false);
    expect(verifySigned(newHubKey().publicKey, 'p\n', 'data', sig)).toBe(false);
    const bad = Buffer.from(sig, 'base64url');
    bad[0] ^= 1;
    expect(verifySigned(key.publicKey, 'p\n', 'data', b64u(bad))).toBe(false);
    expect(verifySigned('not a key', 'p\n', 'data', sig)).toBe(false);
    expect(() => fingerprintOf('short')).toThrow();
  });
});

describe('the X25519 subkey and sealing', () => {
  test('agreement matches RFC 7748', () => {
    const alice = PeerSubkey.fromRaw(hex(X_ALICE));
    const bob = PeerSubkey.fromRaw(hex(X_BOB));
    expect(Buffer.from(alice.publicKey, 'base64url').toString('hex')).toBe(X_ALICE_PUB);
    expect(Buffer.from(bob.publicKey, 'base64url').toString('hex')).toBe(X_BOB_PUB);
    expect(alice.agree(bob.publicKey).toString('hex')).toBe(X_SHARED);
    expect(bob.agree(alice.publicKey).toString('hex')).toBe(X_SHARED);
  });

  const ctx = { from: 'a'.repeat(32), to: 'b'.repeat(32), id: '01J0000000000000000000000A', type: 'note' };

  test('a known seal vector, derived again here with plain node:crypto', () => {
    const alice = PeerSubkey.fromRaw(hex(X_ALICE));
    const bob = PeerSubkey.fromRaw(hex(X_BOB));
    const box = seal(bob.publicKey, 'hello friend', ctx, { ephemeral: alice, iv: new Uint8Array(12) });
    expect(box).toEqual({ alg: 'x25519-hkdf-sha256-a256gcm', epk: b64u(hex(X_ALICE_PUB)), iv: 'AAAAAAAAAAAAAAAA', ct: 'gSkYmhhx9sccdul1XiaDHYpzXfG1sqKj_51oNA' });
    // the same steps by hand: HKDF-SHA256 over the RFC 7748 secret, then AES-256-GCM
    const key = Buffer.from(hkdfSync('sha256', hex(X_SHARED), Buffer.concat([hex(X_ALICE_PUB), hex(X_BOB_PUB)]), Buffer.from('conclave-peer/1 seal'), 32));
    const c = createCipheriv('aes-256-gcm', key, Buffer.alloc(12));
    c.setAAD(Buffer.from(`conclave-peer/1\n${ctx.from}\n${ctx.to}\n${ctx.id}\n${ctx.type}`));
    const ct = Buffer.concat([c.update('hello friend'), c.final(), c.getAuthTag()]);
    expect(b64u(ct)).toBe(box.ct);
    expect(open(bob, box, ctx).toString()).toBe('hello friend');
  });

  test('a changed byte, another message or another recipient does not open', () => {
    const bob = PeerSubkey.generate();
    const box = seal(bob.publicKey, 'secret', ctx);
    expect(open(bob, box, ctx).toString()).toBe('secret');
    const ct = Buffer.from(box.ct, 'base64url');
    ct[0] ^= 1;
    expect(() => open(bob, { ...box, ct: b64u(ct) }, ctx)).toThrow('does not open');
    const tag = Buffer.from(box.ct, 'base64url');
    tag[tag.length - 1] ^= 1;
    expect(() => open(bob, { ...box, ct: b64u(tag) }, ctx)).toThrow('does not open');
    for (const k of ['from', 'to', 'id', 'type'] as const) expect(() => open(bob, box, { ...ctx, [k]: `${ctx[k]}x` })).toThrow('does not open');
    expect(() => open(PeerSubkey.generate(), box, ctx)).toThrow('does not open');
    expect(() => open(bob, { ...box, epk: PeerSubkey.generate().publicKey }, ctx)).toThrow('does not open');
    expect(() => open(bob, { ...box, alg: 'other' as never }, ctx)).toThrow('unknown seal');
    // two seals of the same text differ (a fresh key and IV each time)
    expect(seal(bob.publicKey, 'secret', ctx).ct).not.toBe(box.ct);
  });

  test('the subkey file is made once, mode 0600, and its signature is the hub key over it', () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-peer-key-'));
    try {
      const first = loadSubkey(home);
      expect(loadSubkey(home).publicKey).toBe(first.publicKey);
      if (process.platform !== 'win32') expect(statSync(subkeyFile(home)).mode & 0o777).toBe(0o600);
      const hub = newHubKey();
      const sig = signSubkey(hub, first.publicKey);
      expect(verifySubkey(hub.publicKey, first.publicKey, sig)).toBe(true);
      expect(verifySubkey(newHubKey().publicKey, first.publicKey, sig)).toBe(false);
      expect(verifySubkey(hub.publicKey, PeerSubkey.generate().publicKey, sig)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('safety codes and invite proofs', () => {
  test('the safety code is the same from both sides and differs for another pair', () => {
    const [x, y, z] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    expect(safetyCode(x, y)).toBe('71549 98950 82607 66059');
    expect(safetyCode(y, x)).toBe(safetyCode(x, y));
    expect(safetyCode(x, z)).not.toBe(safetyCode(x, y));
    expect(safetyCode(x.toUpperCase(), y)).toBe(safetyCode(x, y));
  });

  test('an invite proof is bound to the secret, both keys and the message', () => {
    const h = inviteSecretHash('s3cret-s3cret-s3cret-00');
    expect(h).toBe(createHash('sha256').update('s3cret-s3cret-s3cret-00').digest('hex'));
    const p = inviteProof(h, 'b'.repeat(32), 'a'.repeat(32), 'ID1');
    expect(inviteProof(h, 'b'.repeat(32), 'a'.repeat(32), 'ID1')).toBe(p);
    expect(inviteProof(h, 'c'.repeat(32), 'a'.repeat(32), 'ID1')).not.toBe(p);
    expect(inviteProof(h, 'b'.repeat(32), 'c'.repeat(32), 'ID1')).not.toBe(p);
    expect(inviteProof(h, 'b'.repeat(32), 'a'.repeat(32), 'ID2')).not.toBe(p);
    expect(inviteProof(inviteSecretHash('another-secret-000000'), 'b'.repeat(32), 'a'.repeat(32), 'ID1')).not.toBe(p);
  });
});

describe('signed requests', () => {
  const sender = newHubKey();
  const to = newHubKey().fingerprint;
  const url = 'https://alice.example.com/peer/v1/inbox/01J0000000000000000000000A';
  const body = '{"hello":"there"}';
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);

  const incoming = (headers: Record<string, string>, over: Partial<IncomingRequest> = {}): IncomingRequest => ({ method: 'PUT', url, headers: new Headers(headers), body: new TextEncoder().encode(body), ...over });

  test('the headers carry the RFC 9421 shape the verifier reads', () => {
    const h = signRequest(sender, { method: 'PUT', url, body, to }, { now, nonce: 'nonce-nonce-nonce-1' });
    expect(h['content-digest']).toBe(contentDigest(body));
    expect(h['content-digest']).toBe(`sha-256=:${createHash('sha256').update(body).digest('base64')}:`);
    expect(h['conclave-to']).toBe(to);
    expect(h['signature-input']).toBe(
      `peer=("@method" "@path" "@query" "@authority" "content-digest" "conclave-to");created=${now / 1000};expires=${now / 1000 + MAX_TTL_SEC};nonce="nonce-nonce-nonce-1";keyid="${sender.fingerprint}";alg="ed25519";tag="conclave-peer/1"`,
    );
    expect(h.signature).toMatch(/^peer=:[A-Za-z0-9+/]+=*:$/);
  });

  test('a good request passes; the verifier works out the authority from the hub addresses', () => {
    const h = signRequest(sender, { method: 'PUT', url, body, to }, { now });
    const p = parseSignature(incoming(h), to, now) as ParsedSignature;
    expect(isRefusal(p)).toBe(false);
    expect(p.keyid).toBe(sender.fingerprint);
    expect(verifySignature(p, incoming(h), sender.publicKey, ['alice.example.com'])).toBe(true);
    // a tunnel rewrote Host: the hub's own address still matches
    const viaTunnel = incoming(h, { url: 'http://127.0.0.1:7717/peer/v1/inbox/01J0000000000000000000000A' });
    expect(verifySignature(p, viaTunnel, sender.publicKey, ['127.0.0.1:7717'])).toBe(false);
    expect(verifySignature(p, viaTunnel, sender.publicKey, ['127.0.0.1:7717', 'alice.example.com'])).toBe(true);
    expect(verifySignature(p, incoming(h), newHubKey().publicKey, ['alice.example.com'])).toBe(false);
  });

  test('a changed method, path, query, body or recipient is refused', () => {
    const h = signRequest(sender, { method: 'PUT', url, body, to }, { now });
    const p = parseSignature(incoming(h), to, now) as ParsedSignature;
    expect(verifySignature(p, incoming(h, { method: 'POST' }), sender.publicKey, ['alice.example.com'])).toBe(false);
    expect(verifySignature(p, incoming(h, { url: url.replace('0A', '0B') }), sender.publicKey, ['alice.example.com'])).toBe(false);
    expect(verifySignature(p, incoming(h, { url: `${url}?ack=1` }), sender.publicKey, ['alice.example.com'])).toBe(false);
    expect(parseSignature(incoming(h, { body: new TextEncoder().encode('{"hello":"world"}') }), to, now)).toMatchObject({ status: 400, code: 'digest' });
    expect(parseSignature(incoming(h), newHubKey().fingerprint, now)).toMatchObject({ status: 401, code: 'recipient' });
    expect(parseSignature(incoming({ ...h, 'conclave-to': newHubKey().fingerprint }), to, now)).toMatchObject({ code: 'recipient' });
  });

  test('the clock: dated in the future, expired, or living too long', () => {
    const h = signRequest(sender, { method: 'PUT', url, body, to }, { now });
    expect(isRefusal(parseSignature(incoming(h), to, now + 59_000 + MAX_TTL_SEC * 1000))).toBe(false);
    expect(parseSignature(incoming(h), to, now + (MAX_TTL_SEC + 61) * 1000)).toMatchObject({ code: 'expired' });
    expect(parseSignature(incoming(h), to, now - 61_000)).toMatchObject({ code: 'skew' });
    expect(isRefusal(parseSignature(incoming(h), to, now - 59_000))).toBe(false);
    const long = { ...h, 'signature-input': h['signature-input'].replace(/expires=\d+/, `expires=${now / 1000 + MAX_TTL_SEC + 1}`) };
    expect(parseSignature(incoming(long), to, now)).toMatchObject({ code: 'lifetime' });
  });

  test('missing or malformed parts', () => {
    const h = signRequest(sender, { method: 'PUT', url, body, to }, { now });
    expect(parseSignature(incoming({}), to, now)).toMatchObject({ status: 401, code: 'unsigned' });
    const { signature: _s, ...noSig } = h;
    expect(parseSignature(incoming(noSig), to, now)).toMatchObject({ code: 'unsigned' });
    expect(parseSignature(incoming({ ...h, 'signature-input': h['signature-input'].replace(' "conclave-to"', '') }), to, now)).toMatchObject({ code: 'components' });
    expect(parseSignature(incoming({ ...h, 'signature-input': h['signature-input'].replace('conclave-peer/1', 'other/1') }), to, now)).toMatchObject({ code: 'tag' });
    expect(parseSignature(incoming({ ...h, 'signature-input': h['signature-input'].replace('alg="ed25519"', 'alg="rsa"') }), to, now)).toMatchObject({ code: 'tag' });
    expect(parseSignature(incoming({ ...h, signature: 'peer=:AAAA:' }), to, now)).toMatchObject({ code: 'signature' });
    expect(parseSignature(incoming({ ...h, 'signature-input': h['signature-input'].replace(/^peer=/, 'other=') }), to, now)).toMatchObject({ code: 'signature-input' });
  });
});

describe('envelopes and address records', () => {
  const alice = newHubKey();
  const bob = newHubKey();
  const bobSub = PeerSubkey.generate();
  const id = ulid();

  test('a sealed envelope verifies, opens, and hides its body', () => {
    const { envelope, blob } = buildEnvelope(alice, { id, type: 'note', to: bob.fingerprint, body: { text: 'hi Bob' }, recipientSubkey: bobSub.publicKey });
    expect(blob).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toContain('hi Bob');
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)))!;
    expect(verifyEnvelope(parsed, alice.publicKey)).toBe(true);
    expect(verifyEnvelope(parsed, bob.publicKey)).toBe(false);
    expect(openEnvelope(parsed, bobSub)).toEqual({ text: 'hi Bob' });
    expect(() => openEnvelope(parsed, PeerSubkey.generate())).toThrow();
  });

  test('changing any signed field breaks the signature', () => {
    const { envelope } = buildEnvelope(alice, { id, type: 'note', to: bob.fingerprint, body: { text: 'x' }, recipientSubkey: bobSub.publicKey });
    const ct = Buffer.from(envelope.sealed!.ct, 'base64url');
    ct[3] ^= 1;
    const changes = [
      { type: 'friend.remove' },
      { to: newHubKey().fingerprint },
      { created: envelope.created + 1 },
      { id: ulid() },
      { sealed: { ...envelope.sealed!, ct: b64u(ct) } },
    ];
    for (const c of changes) expect(verifyEnvelope({ ...envelope, ...c }, alice.publicKey)).toBe(false);
  });

  test('a large body goes as a blob whose hash the envelope signs', () => {
    const text = 'y'.repeat(5000);
    const { envelope, blob } = buildEnvelope(alice, { id, type: 'note', to: bob.fingerprint, body: { text }, recipientSubkey: bobSub.publicKey, blobThreshold: 1024 });
    expect(blob).toBeDefined();
    expect(envelope.sealed).toBeUndefined();
    expect(envelope.blob).toEqual({ sha256: createHash('sha256').update(blob!).digest('hex'), size: blob!.length });
    expect(verifyEnvelope(envelope, alice.publicKey)).toBe(true);
    expect(openEnvelope(envelope, bobSub, blob)).toEqual({ text });
    const bad = Buffer.from(blob!);
    bad[10] ^= 1;
    expect(() => openEnvelope(envelope, bobSub, bad)).toThrow('does not match its hash');
    expect(() => openEnvelope(envelope, bobSub)).toThrow('blob is missing');
  });

  test('only a friend request goes in the clear', () => {
    expect(() => buildEnvelope(alice, { id, type: 'note', to: bob.fingerprint, body: {} })).toThrow('must be sealed');
    const { envelope } = buildEnvelope(alice, { id, type: 'friend.request', to: bob.fingerprint, body: { name: 'Alice' } });
    expect(envelope.plain).toBe('{"name":"Alice"}');
    expect(verifyEnvelope(envelope, alice.publicKey)).toBe(true);
    expect(parseEnvelope({ ...envelope, sealed: { alg: 'x' } })).toBeUndefined();
    expect(parseEnvelope({ ...envelope, id: 'not-a-ulid' })).toBeUndefined();
    expect(parseEnvelope({ ...envelope, from: 'x' })).toBeUndefined();
  });

  test('an address record is signed with its subkey, and a changed one is refused', () => {
    const r = signRecord(alice, bobSub.publicKey, [{ url: 'https://a.example.com', kind: 'stable' }], 3);
    expect(verifyRecord(JSON.parse(JSON.stringify(r)), alice.publicKey)).toEqual(r);
    expect(verifyRecord(r, bob.publicKey)).toBeUndefined();
    expect(verifyRecord({ ...r, seq: 4 }, alice.publicKey)).toBeUndefined();
    expect(verifyRecord({ ...r, addrs: [{ url: 'https://evil.example.com', kind: 'stable' }] }, alice.publicKey)).toBeUndefined();
    expect(verifyRecord({ ...r, subkey: PeerSubkey.generate().publicKey }, alice.publicKey)).toBeUndefined();
    const badUrl = signRecord(alice, bobSub.publicKey, [{ url: 'javascript:alert(1)', kind: 'stable' }], 3);
    expect(verifyRecord(badUrl, alice.publicKey)).toBeUndefined();
  });

  test('a key rotation needs the new key to sign both fingerprints', () => {
    const next = newHubKey();
    const record = signRecord(next, bobSub.publicKey, [], 1);
    const body = keyRotateBody(alice.fingerprint, next, record);
    expect(verifyKeyRotate(alice.fingerprint, body)).toMatchObject({ fingerprint: next.fingerprint, publicKey: next.publicKey });
    expect(verifyKeyRotate(bob.fingerprint, body)).toBeUndefined();
    expect(verifyKeyRotate(alice.fingerprint, { ...body, proof: next.sign(PREFIX.rotate, 'other') })).toBeUndefined();
    expect(verifyKeyRotate(alice.fingerprint, { ...body, record: signRecord(alice, bobSub.publicKey, [], 1) })).toBeUndefined();
  });
});

describe('ULIDs', () => {
  test('ids sort by time and count up inside one millisecond', () => {
    const t = Date.now() + 86_400_000;
    const ids = Array.from({ length: 50 }, () => ulid(t));
    for (const id of ids) expect(id).toMatch(ULID);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ulidTime(ids[0])).toBe(t);
    expect(ulid(t + 1) > ids[49]).toBe(true);
    // a clock that went back does not make an id that sorts first
    expect(ulid(t - 60_000) > ids[49]).toBe(true);
  });
});
