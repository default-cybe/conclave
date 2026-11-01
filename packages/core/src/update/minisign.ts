/**
 * minisign signatures, as the Tauri updater makes them (`tauri signer sign`).
 *
 * A public key is 42 bytes: "Ed", an 8 byte key id and the 32 byte Ed25519
 * key, base64 on the second line of a key file. Tauri stores the whole key
 * file base64 encoded again, as one line; both forms are read here.
 *
 * A signature file has four lines:
 *
 *   untrusted comment: <anything>
 *   <base64: "ED", the key id, the 64 byte signature of BLAKE2b-512(file)>
 *   trusted comment: <text, such as timestamp:... file:...>
 *   <base64: the 64 byte signature of (signature || trusted comment)>
 *
 * Tauri's .sig files are that text base64 encoded once more. Only prehashed
 * ("ED") signatures are taken, as the Tauri updater does; the legacy "Ed"
 * kind signs the whole file and is refused.
 *
 * The same check is written in Rust (packages/daemon-rs/src/update.rs, with
 * the minisign-verify crate) and Kotlin (packages/android/client, Minisign.kt).
 */
import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

export interface MinisignKey {
  /** 8 bytes. */
  keyId: Uint8Array;
  /** 32 bytes, Ed25519. */
  key: Uint8Array;
}

export interface MinisignSignature {
  keyId: Uint8Array;
  /** 64 bytes over BLAKE2b-512 of the file. */
  signature: Uint8Array;
  /** The text after "trusted comment: ". */
  trusted: string;
  /** 64 bytes over signature || trusted. */
  global: Uint8Array;
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

const B64 = /^[A-Za-z0-9+/=_-]+$/;

function b64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.trim(), 'base64'));
}

/** The text of a key or signature file: as given, or base64 of it (Tauri's form). */
export function minisignText(input: string): string {
  const t = input.trim();
  if (/untrusted comment:/i.test(t)) return t;
  if (B64.test(t)) {
    const decoded = Buffer.from(t, 'base64').toString('utf8');
    if (/^untrusted comment:/i.test(decoded.trim())) return decoded.trim();
  }
  return t;
}

/** A public key: a key file, Tauri's base64 of one, or the bare RWQ... line. Throws when it is none of those. */
export function parsePublicKey(input: string): MinisignKey {
  const text = minisignText(input);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^untrusted comment:/i.test(l)) ?? '';
  if (!B64.test(line)) throw new SignatureError('The update key is not a minisign public key.');
  const raw = b64(line);
  if (raw.length !== 42 || raw[0] !== 0x45 || raw[1] !== 0x64) throw new SignatureError('The update key is not a minisign Ed25519 public key.');
  return { keyId: raw.slice(2, 10), key: raw.slice(10, 42) };
}

/** A signature file, or Tauri's base64 of one. Throws when it is not one. */
export function parseSignature(input: string): MinisignSignature {
  const text = minisignText(input);
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const at = lines.findIndex((l) => /^untrusted comment:/i.test(l.trim()));
  if (at < 0 || lines.length < at + 4) throw new SignatureError('The signature is not a minisign signature.');
  const sigLine = lines[at + 1].trim();
  const trustedLine = lines[at + 2];
  const globalLine = lines[at + 3].trim();
  if (!trustedLine.startsWith('trusted comment: ')) throw new SignatureError('The signature has no trusted comment.');
  const raw = b64(sigLine);
  if (raw.length !== 74) throw new SignatureError('The signature has the wrong length.');
  const alg = String.fromCharCode(raw[0], raw[1]);
  if (alg === 'Ed') throw new SignatureError('The signature is the legacy kind, which updates do not take. Sign with tauri signer.');
  if (alg !== 'ED') throw new SignatureError('The signature is not an Ed25519 minisign signature.');
  const global = b64(globalLine);
  if (global.length !== 64) throw new SignatureError('The signature has a broken global signature.');
  return { keyId: raw.slice(2, 10), signature: raw.slice(10, 74), trusted: trustedLine.slice('trusted comment: '.length), global };
}

// X.509 SubjectPublicKeyInfo for Ed25519 (OID 1.3.101.112); the 32 raw key bytes follow
const SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

function edKey(key: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(key)]), format: 'der', type: 'spki' });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** BLAKE2b-512, the prehash of an "ED" signature. Feed a file through update() for large ones. */
export function blake2b512() {
  return createHash('blake2b512');
}

/**
 * Check a signature against the BLAKE2b-512 of the file and the key. Returns
 * the trusted comment. Throws a SignatureError that says what is wrong.
 */
export function verifyPrehashed(prehash: Uint8Array, signatureText: string, key: MinisignKey): string {
  const sig = parseSignature(signatureText);
  if (!sameBytes(sig.keyId, key.keyId)) throw new SignatureError('The update was signed with another key than the one this build trusts.');
  const pub = edKey(key.key);
  if (!edVerify(null, Buffer.from(prehash), pub, Buffer.from(sig.signature))) throw new SignatureError('The update signature does not match the file. Nothing was installed.');
  const signed = Buffer.concat([Buffer.from(sig.signature), Buffer.from(sig.trusted, 'utf8')]);
  if (!edVerify(null, signed, pub, Buffer.from(sig.global))) throw new SignatureError('The signature comment was changed. Nothing was installed.');
  return sig.trusted;
}

/** verifyPrehashed for bytes in memory. */
export function verifyMinisign(data: Uint8Array, signatureText: string, key: MinisignKey): string {
  return verifyPrehashed(new Uint8Array(blake2b512().update(data).digest()), signatureText, key);
}

// ---------------------------------------------------------------------------
// Signing: for tests and local tools. Releases sign with `tauri signer sign`
// in CI, with the private key only CI holds.
// ---------------------------------------------------------------------------

export interface TestSigner {
  /** The public key as Tauri writes it: base64 of the key file. */
  publicKey: string;
  keyId: Uint8Array;
  /** The .sig text as Tauri writes it: base64 of the signature file. */
  sign(data: Uint8Array, trusted?: string): string;
}

/** A signer with an Ed25519 key from node:crypto. `privateKey` is a node KeyObject. */
export function minisignSigner(privateKey: KeyObject, publicKey: KeyObject, keyId: Uint8Array = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])): TestSigner {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const raw = Buffer.concat([Buffer.from('Ed'), Buffer.from(keyId), Buffer.from(jwk.x, 'base64url')]);
  const id = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
  const keyFile = `untrusted comment: minisign public key: ${id}\n${raw.toString('base64')}\n`;
  return {
    publicKey: Buffer.from(keyFile).toString('base64'),
    keyId,
    sign(data, trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:update`) {
      const prehash = blake2b512().update(data).digest();
      const sig = edSign(null, prehash, privateKey);
      const line = Buffer.concat([Buffer.from('ED'), Buffer.from(keyId), sig]).toString('base64');
      const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted, 'utf8')]), privateKey).toString('base64');
      const text = `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${trusted}\n${global}\n`;
      return Buffer.from(text).toString('base64');
    },
  };
}
