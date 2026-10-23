/**
 * Keys and sealing for conclave-peer/1 (docs/design/FRIENDS.md 2).
 *
 * The hub's Ed25519 key (identity.ts) signs. An X25519 subkey, made once and
 * kept in <home>/peer-key.pem (mode 0600, like hub-key.pem and never in a
 * backup), receives: a body for a friend is sealed to the friend's subkey,
 * so tunnels and proxies see only ciphertext.
 *
 * Seal: a fresh X25519 key per message, agreement with the recipient's
 * subkey, HKDF-SHA256 (salt: both public keys, info: "conclave-peer/1 seal"),
 * then AES-256-GCM. The associated data names the sender and recipient
 * fingerprints, the message id and its type, so a sealed body cannot be
 * moved to another message. Bun's node:crypto has X25519, HKDF and AES-GCM
 * but no ChaCha20-Poly1305, hence AES.
 *
 * All keys travel as raw bytes in base64url without padding, as the hub key
 * does in GET /api/identity.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

export const PEER_TAG = 'conclave-peer/1';
/** What the hub key signs for each use; the prefixes keep them apart. */
export const PREFIX = {
  subkey: `${PEER_TAG} subkey\n`,
  envelope: `${PEER_TAG} envelope\n`,
  addresses: `${PEER_TAG} addresses\n`,
  rotate: `${PEER_TAG} key-rotate\n`,
  invite: `${PEER_TAG} invite\n`,
} as const;
export const SEAL_ALG = 'x25519-hkdf-sha256-a256gcm';

const B64U = /^[A-Za-z0-9_-]*$/;

export function toB64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Bytes from base64url, or undefined when it is not base64url. */
export function fromB64u(s: unknown): Buffer | undefined {
  if (typeof s !== 'string' || !B64U.test(s)) return undefined;
  return Buffer.from(s, 'base64url');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A hub fingerprint: the first 16 bytes of SHA-256 of the raw Ed25519 key, hex (identity.ts). */
export function fingerprintOf(publicKey: string): string {
  const raw = fromB64u(publicKey);
  if (!raw || raw.length !== 32) throw new Error('not an Ed25519 public key');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export const FINGERPRINT = /^[0-9a-f]{32}$/;

function edPublic(publicKey: string): KeyObject | undefined {
  const raw = fromB64u(publicKey);
  if (!raw || raw.length !== 32) return undefined;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  } catch {
    return undefined;
  }
}

/** True when `signature` (base64url) is the hub key `publicKey` signing `prefix` then `data` (HubKey.sign). */
export function verifySigned(publicKey: string, prefix: string, data: string | Uint8Array, signature: string): boolean {
  const key = edPublic(publicKey);
  const sig = fromB64u(signature);
  if (!key || !sig || sig.length !== 64) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(data)]), key, sig);
  } catch {
    return false;
  }
}

/** Anything that signs like the hub key (HubKey in identity.ts). */
export interface Signer {
  readonly publicKey: string;
  readonly fingerprint: string;
  sign(prefix: string, data: string | Uint8Array): string;
}

// ---------------------------------------------------------------------------
// The X25519 subkey
// ---------------------------------------------------------------------------

function xPublic(publicKey: string): KeyObject | undefined {
  const raw = fromB64u(publicKey);
  if (!raw || raw.length !== 32) return undefined;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicKey }, format: 'jwk' });
  } catch {
    return undefined;
  }
}

export class PeerSubkey {
  readonly publicKey: string;

  constructor(private readonly privateKey: KeyObject) {
    this.publicKey = (createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x;
  }

  /** X25519 with another public key (32 bytes). Throws when the key is not one. */
  agree(publicKey: string): Buffer {
    const pub = xPublic(publicKey);
    if (!pub) throw new Error('not an X25519 public key');
    return diffieHellman({ privateKey: this.privateKey, publicKey: pub });
  }

  /** A subkey from its 32 raw private bytes (tests and known vectors). */
  static fromRaw(priv: Uint8Array): PeerSubkey {
    const d = toB64u(priv);
    // node wants x with d in a JWK; derive it from a key made from d alone
    const x = (createPublicKey(createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d, x: '' }, format: 'jwk' } as never)).export({ format: 'jwk' }) as { x: string }).x;
    return new PeerSubkey(createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d, x }, format: 'jwk' }));
  }

  static generate(): PeerSubkey {
    return new PeerSubkey(generateKeyPairSync('x25519').privateKey);
  }
}

export function subkeyFile(home: string): string {
  return join(home, 'peer-key.pem');
}

/** Read the subkey, or make it on first start (the first writer wins a race, as for hub-key.pem). */
export function loadSubkey(home: string): PeerSubkey {
  const file = subkeyFile(home);
  if (!existsSync(file)) {
    const pem = generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    try {
      writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`The hub's friends key in ${file} cannot be read (${(err as Error).message}). Move the file away to make a new one; friends then need the hub's new address record.`);
  }
  if (key.asymmetricKeyType !== 'x25519') throw new Error(`The hub's friends key in ${file} is a ${key.asymmetricKeyType} key, not X25519. Move the file away to make a new one.`);
  return new PeerSubkey(key);
}

/** The hub key's signature over its subkey. */
export function signSubkey(hub: Signer, subkey: string): string {
  return hub.sign(PREFIX.subkey, `${hub.fingerprint}\n${subkey}`);
}

export function verifySubkey(hubPublicKey: string, subkey: string, signature: string): boolean {
  let fp: string;
  try {
    fp = fingerprintOf(hubPublicKey);
  } catch {
    return false;
  }
  return !!xPublic(subkey) && verifySigned(hubPublicKey, PREFIX.subkey, `${fp}\n${subkey}`, signature);
}

// ---------------------------------------------------------------------------
// Seal and open
// ---------------------------------------------------------------------------

export interface SealedBox {
  alg: typeof SEAL_ALG;
  /** The sender's one time X25519 public key. */
  epk: string;
  iv: string;
  /** Ciphertext with the 16 byte GCM tag at the end. */
  ct: string;
}

/** What the associated data binds a sealed body to. */
export interface SealContext {
  from: string;
  to: string;
  id: string;
  type: string;
}

export function associatedData(c: SealContext): Buffer {
  return Buffer.from(`${PEER_TAG}\n${c.from}\n${c.to}\n${c.id}\n${c.type}`, 'utf8');
}

function sealKey(shared: Buffer, epk: string, recipient: string): Buffer {
  const salt = Buffer.concat([fromB64u(epk)!, fromB64u(recipient)!]);
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(`${PEER_TAG} seal`, 'utf8'), 32));
}

/**
 * Seal `plaintext` to the recipient's subkey. `fixed` sets the one time key
 * and the IV, for known vectors in tests only.
 */
export function seal(recipientSubkey: string, plaintext: string | Uint8Array, ctx: SealContext, fixed?: { ephemeral: PeerSubkey; iv: Uint8Array }): SealedBox {
  const eph = fixed?.ephemeral ?? PeerSubkey.generate();
  const shared = eph.agree(recipientSubkey);
  const key = sealKey(shared, eph.publicKey, recipientSubkey);
  const iv = Buffer.from(fixed?.iv ?? randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(ctx));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return { alg: SEAL_ALG, epk: eph.publicKey, iv: toB64u(iv), ct: toB64u(ct) };
}

/** Open a sealed body with our subkey. Throws when it was changed, sealed for someone else, or moved to another message. */
export function open(subkey: PeerSubkey, box: SealedBox, ctx: SealContext): Buffer {
  if (!box || box.alg !== SEAL_ALG) throw new Error('unknown seal');
  const iv = fromB64u(box.iv);
  const ct = fromB64u(box.ct);
  if (!iv || iv.length !== 12 || !ct || ct.length < 16 || !fromB64u(box.epk)) throw new Error('malformed seal');
  const key = sealKey(subkey.agree(box.epk), box.epk, subkey.publicKey);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(associatedData(ctx));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  } catch {
    throw new Error('the sealed body does not open: changed, or not for this hub');
  }
}

export function isSealedBox(v: unknown): v is SealedBox {
  const b = v as SealedBox;
  return !!b && typeof b === 'object' && b.alg === SEAL_ALG && typeof b.epk === 'string' && typeof b.iv === 'string' && typeof b.ct === 'string';
}

// ---------------------------------------------------------------------------
// Invites and safety codes
// ---------------------------------------------------------------------------

/**
 * The proof that a friend request knows the invite secret, bound to both
 * keys and the message. The secret itself never travels: a tunnel that sees
 * the request cannot reuse it for another key. The inviter keeps only
 * SHA-256 of the secret, which is the HMAC key.
 */
export function inviteProof(secretHash: string, requester: string, inviter: string, msgId: string): string {
  return createHmac('sha256', Buffer.from(secretHash, 'hex')).update(`${PREFIX.invite}${requester}\n${inviter}\n${msgId}`).digest('base64url');
}

export function inviteSecretHash(secret: string): string {
  return sha256Hex(Buffer.from(secret, 'utf8'));
}

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A short code both owners compare: SHA-256 of the two fingerprints sorted,
 * read as four groups of five digits (each group is 5 bytes mod 100000).
 */
export function safetyCode(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  const h = createHash('sha256').update(`${PEER_TAG} safety\n${x}\n${y}`).digest();
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) {
    const n = h.readUIntBE(i * 5, 5) % 100_000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups.join(' ');
}
