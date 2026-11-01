/**
 * The hub's identity (docs/design/HUB-LOGIN-AND-IDENTITY.md): an Ed25519 key
 * pair made on first start and kept in <home>/hub-key.pem, mode 0600, next to
 * secrets.json. Apps keep the public key with their token. Before they send
 * the token to an address, they ask it to sign a fresh nonce
 * (GET /api/identity). A machine that now answers at an address the hub used
 * to have cannot sign, so the token never reaches it.
 *
 * publicKey: the 32 raw bytes, base64url without padding.
 * fingerprint: the first 16 bytes of SHA-256 of those bytes, lowercase hex.
 * signature: base64url of the Ed25519 signature of `conclave-hub-identity-v1\n<nonce>`.
 *
 * The same key signs session bundles (core session/share.ts) over
 * `conclave-bundle-v1\n<canonical JSON>`. Each use has its own prefix, so a
 * signature made for one can never pass as the other.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { HubIdentity, IdentityProof } from '@conclave/core/client/index.ts';
import { BUNDLE_PREFIX, type BundleSigner } from '@conclave/core/session/share.ts';

/** What the hub signs: this, then the nonce. */
export const IDENTITY_PREFIX = 'conclave-hub-identity-v1\n';
/** A nonce is 16 to 128 base64url characters. */
export const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export class HubKey {
  readonly publicKey: string;
  readonly fingerprint: string;

  constructor(private readonly privateKey: KeyObject) {
    // the JWK form of an Ed25519 public key is its 32 raw bytes
    const raw = Buffer.from((createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x, 'base64url');
    this.publicKey = raw.toString('base64url');
    this.fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  identity(): HubIdentity {
    return { publicKey: this.publicKey, fingerprint: this.fingerprint };
  }

  /** The reply to GET /api/identity. The caller checks the nonce. */
  prove(nonce: string): IdentityProof {
    const signature = sign(null, Buffer.from(IDENTITY_PREFIX + nonce, 'utf8'), this.privateKey).toString('base64url');
    return { ...this.identity(), signature };
  }

  /** What core signs bundles with. It hands over the payload only; the bundle prefix is added here. */
  bundleSigner(name?: string): BundleSigner {
    return {
      publicKey: this.publicKey,
      fingerprint: this.fingerprint,
      ...(name ? { name } : {}),
      signBundle: (payload) => sign(null, Buffer.from(BUNDLE_PREFIX + payload, 'utf8'), this.privateKey).toString('base64url'),
    };
  }

  /** Sign `prefix` and then `data` (base64url). Each use has its own prefix, so a signature made for one never passes for another. */
  sign(prefix: string, data: string | Uint8Array): string {
    return sign(null, Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(data)]), this.privateKey).toString('base64url');
  }
}

export function hubKeyFile(home: string): string {
  return join(home, 'hub-key.pem');
}

/**
 * Read the hub's key, or make it on first start. When two starts race, the
 * file the first one wrote wins. A file that is not an Ed25519 key stops the
 * start: making a new key quietly would turn every paired app away.
 */
export function loadHubKey(home: string): HubKey {
  const file = hubKeyFile(home);
  if (!existsSync(file)) {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
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
    throw new Error(`The hub's identity key in ${file} cannot be read (${(err as Error).message}). Move the file away to make a new key; paired apps then have to pair again.`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`The hub's identity key in ${file} is a ${key.asymmetricKeyType} key, not Ed25519. Move the file away to make a new key; paired apps then have to pair again.`);
  }
  return new HubKey(key);
}
