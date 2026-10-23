/**
 * Messages between hubs (conclave-peer/1). Every message is an envelope the
 * sender's hub key signs, whichever way it travels: pushed with
 * PUT /peer/v1/inbox/<id>, or pulled from GET /peer/v1/outbox. The body is
 * sealed to the recipient's subkey (crypto.ts); a large one is kept as a
 * content addressed blob the recipient fetches (GET /peer/v1/blobs/<sha256>),
 * and the envelope carries its hash. Only friend.request goes unsealed,
 * because the requester does not have the other hub's subkey yet; it holds
 * no secret (the invite secret is proven with an HMAC, crypto.ts).
 *
 * The address record is the hub's card: its key, its subkey with the hub
 * key's signature, and the addresses friends try, numbered by seq so an old
 * record never replaces a newer one.
 */
import type { HubAddress } from '@conclave/core/types.ts';
import {
  FINGERPRINT,
  PEER_TAG,
  PREFIX,
  fingerprintOf,
  isSealedBox,
  open,
  seal,
  sha256Hex,
  signSubkey,
  verifySigned,
  verifySubkey,
  type PeerSubkey,
  type SealedBox,
  type Signer,
} from './crypto';
import { ULID } from './ulid';

export type PeerMessageType =
  | 'friend.request'
  | 'friend.accept'
  | 'friend.remove'
  | 'address.update'
  | 'key.rotate'
  | 'note'
  | 'share.offer'
  | 'share.update'
  | 'share.revoke'
  | 'share.ack'
  // shared projects (projects.ts): the owner's hub is the hub of a star; items carry their author's own signature
  | 'project.invite'
  | 'project.join'
  | 'project.leave'
  | 'project.meta'
  | 'project.item'
  | 'project.state'
  | 'project.sync';
/** Types this hub takes. A later phase adds agent.task.*. */
export const MESSAGE_TYPES: readonly PeerMessageType[] = [
  'friend.request',
  'friend.accept',
  'friend.remove',
  'address.update',
  'key.rotate',
  'note',
  'share.offer',
  'share.update',
  'share.revoke',
  'share.ack',
  'project.invite',
  'project.join',
  'project.leave',
  'project.meta',
  'project.item',
  'project.state',
  'project.sync',
];

export interface PeerEnvelope {
  v: 1;
  /** ULID, made by the sender. */
  id: string;
  type: string;
  /** Sender fingerprint. */
  from: string;
  /** Recipient fingerprint. */
  to: string;
  created: number;
  sealed?: SealedBox;
  /** friend.request only: the body as JSON text. */
  plain?: string;
  /** A sealed body too big to send inline: the SealedBox JSON, fetched by hash. */
  blob?: { sha256: string; size: number };
  sig: string;
}

function canonical(e: Omit<PeerEnvelope, 'sig'>): string {
  return JSON.stringify([
    PEER_TAG,
    e.v,
    e.id,
    e.type,
    e.from,
    e.to,
    e.created,
    e.sealed ? [e.sealed.alg, e.sealed.epk, e.sealed.iv, e.sealed.ct] : null,
    e.plain ?? null,
    e.blob ? [e.blob.sha256, e.blob.size] : null,
  ]);
}

export interface BuildInput {
  id: string;
  type: string;
  to: string;
  body: unknown;
  created?: number;
  /** The recipient's subkey. Without it the body goes in the clear (friend.request only). */
  recipientSubkey?: string;
  /** A sealed body larger than this many bytes goes as a blob. */
  blobThreshold?: number;
}

/** A signed envelope, and the blob's bytes when the body went into one. */
export function buildEnvelope(signer: Signer, input: BuildInput): { envelope: PeerEnvelope; blob?: Buffer } {
  const base = { v: 1 as const, id: input.id, type: input.type, from: signer.fingerprint, to: input.to, created: input.created ?? Date.now() };
  const text = JSON.stringify(input.body ?? {});
  let unsigned: Omit<PeerEnvelope, 'sig'>;
  let blob: Buffer | undefined;
  if (!input.recipientSubkey) {
    if (input.type !== 'friend.request') throw new Error(`a ${input.type} message must be sealed`);
    unsigned = { ...base, plain: text };
  } else {
    const sealed = seal(input.recipientSubkey, text, { from: base.from, to: base.to, id: base.id, type: base.type });
    const json = JSON.stringify(sealed);
    if (input.blobThreshold !== undefined && json.length > input.blobThreshold) {
      blob = Buffer.from(json, 'utf8');
      unsigned = { ...base, blob: { sha256: sha256Hex(blob), size: blob.length } };
    } else {
      unsigned = { ...base, sealed };
    }
  }
  return { envelope: { ...unsigned, sig: signer.sign(PREFIX.envelope, canonical(unsigned)) }, blob };
}

/** An envelope from JSON, or undefined when it does not have the shape. */
export function parseEnvelope(v: unknown): PeerEnvelope | undefined {
  const e = v as PeerEnvelope;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return undefined;
  if (e.v !== 1 || typeof e.id !== 'string' || !ULID.test(e.id)) return undefined;
  if (typeof e.type !== 'string' || !/^[a-z][a-z0-9.-]{0,40}$/.test(e.type)) return undefined;
  if (typeof e.from !== 'string' || !FINGERPRINT.test(e.from) || typeof e.to !== 'string' || !FINGERPRINT.test(e.to)) return undefined;
  if (typeof e.created !== 'number' || !Number.isFinite(e.created) || typeof e.sig !== 'string') return undefined;
  const bodies = [e.sealed !== undefined, e.plain !== undefined, e.blob !== undefined].filter(Boolean).length;
  if (bodies !== 1) return undefined;
  if (e.sealed !== undefined && !isSealedBox(e.sealed)) return undefined;
  if (e.plain !== undefined && typeof e.plain !== 'string') return undefined;
  if (e.blob !== undefined && (typeof e.blob !== 'object' || !/^[0-9a-f]{64}$/.test(e.blob.sha256) || !Number.isSafeInteger(e.blob.size) || e.blob.size <= 0)) return undefined;
  return { v: 1, id: e.id, type: e.type, from: e.from, to: e.to, created: e.created, sealed: e.sealed, plain: e.plain, blob: e.blob, sig: e.sig };
}

/** True when the envelope is signed by `publicKey` and names it as the sender. */
export function verifyEnvelope(e: PeerEnvelope, publicKey: string): boolean {
  try {
    if (fingerprintOf(publicKey) !== e.from) return false;
  } catch {
    return false;
  }
  const { sig, ...rest } = e;
  return verifySigned(publicKey, PREFIX.envelope, canonical(rest), sig);
}

/**
 * The body of a verified envelope. A sealed body opens with our subkey; a
 * blob's bytes must hash to what the envelope says. Throws when it does not
 * open or is not JSON.
 */
export function openEnvelope(e: PeerEnvelope, subkey: PeerSubkey, blob?: Uint8Array): unknown {
  let text: string;
  if (e.plain !== undefined) text = e.plain;
  else {
    let box = e.sealed;
    if (e.blob) {
      if (!blob) throw new Error('the blob is missing');
      if (blob.length !== e.blob.size || sha256Hex(blob) !== e.blob.sha256) throw new Error('the blob does not match its hash');
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(blob).toString('utf8'));
      } catch {
        throw new Error('the blob is not a sealed body');
      }
      if (!isSealedBox(parsed)) throw new Error('the blob is not a sealed body');
      box = parsed;
    }
    text = open(subkey, box!, { from: e.from, to: e.to, id: e.id, type: e.type }).toString('utf8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the body is not JSON');
  }
}

// ---------------------------------------------------------------------------
// The address record
// ---------------------------------------------------------------------------

export interface PeerAddress {
  url: string;
  kind: HubAddress['kind'];
}

export interface AddressRecord {
  fp: string;
  publicKey: string;
  subkey: string;
  /** The hub key's signature of the subkey (crypto.ts signSubkey). */
  subkeySig: string;
  /** Best first. */
  addrs: PeerAddress[];
  seq: number;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}

/** How long a record counts as fresh. An old one is still a hint. */
export const RECORD_TTL_MS = 30 * 86_400_000;
const KINDS: ReadonlyArray<PeerAddress['kind']> = ['stable', 'quick', 'own', 'lan'];

function recordBytes(r: Omit<AddressRecord, 'sig'>): string {
  return JSON.stringify([PEER_TAG, r.fp, r.publicKey, r.subkey, r.subkeySig, r.addrs.map((a) => [a.url, a.kind]), r.seq, r.issuedAt, r.expiresAt]);
}

export function signRecord(signer: Signer, subkey: string, addrs: PeerAddress[], seq: number, now = Date.now()): AddressRecord {
  const r = { fp: signer.fingerprint, publicKey: signer.publicKey, subkey, subkeySig: signSubkey(signer, subkey), addrs, seq, issuedAt: now, expiresAt: now + RECORD_TTL_MS };
  return { ...r, sig: signer.sign(PREFIX.addresses, recordBytes(r)) };
}

/** A web address a friend may call: http or https with a host and nothing after the path. */
export function cleanAddress(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 2048) return undefined;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || u.search || u.hash) return undefined;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** The record from JSON when it has the shape and `publicKey` signed it (and its subkey). */
export function verifyRecord(v: unknown, publicKey: string): AddressRecord | undefined {
  const r = v as AddressRecord;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  if (r.publicKey !== publicKey || typeof r.fp !== 'string' || typeof r.subkey !== 'string' || typeof r.subkeySig !== 'string' || typeof r.sig !== 'string') return undefined;
  if (!Number.isSafeInteger(r.seq) || r.seq < 0 || !Number.isFinite(r.issuedAt) || !Number.isFinite(r.expiresAt)) return undefined;
  if (!Array.isArray(r.addrs) || r.addrs.length > 16) return undefined;
  const addrs: PeerAddress[] = [];
  for (const a of r.addrs) {
    if (!a || typeof a !== 'object' || !KINDS.includes(a.kind) || cleanAddress(a.url) !== a.url) return undefined;
    addrs.push({ url: a.url, kind: a.kind });
  }
  try {
    if (fingerprintOf(publicKey) !== r.fp) return undefined;
  } catch {
    return undefined;
  }
  const clean = { fp: r.fp, publicKey: r.publicKey, subkey: r.subkey, subkeySig: r.subkeySig, addrs, seq: r.seq, issuedAt: r.issuedAt, expiresAt: r.expiresAt };
  if (!verifySubkey(publicKey, r.subkey, r.subkeySig)) return undefined;
  if (!verifySigned(publicKey, PREFIX.addresses, recordBytes(clean), r.sig)) return undefined;
  return { ...clean, sig: r.sig };
}

// ---------------------------------------------------------------------------
// key.rotate
// ---------------------------------------------------------------------------

/**
 * The body of key.rotate: the new key, its signature over both
 * fingerprints, and a record the new key signed. The envelope around it is
 * signed by the old key, so both keys vouch for the change.
 */
export function keyRotateBody(oldFingerprint: string, next: Signer, record: AddressRecord): { publicKey: string; proof: string; record: AddressRecord } {
  return { publicKey: next.publicKey, proof: next.sign(PREFIX.rotate, `${oldFingerprint}\n${next.fingerprint}`), record };
}

export function verifyKeyRotate(oldFingerprint: string, body: unknown): { publicKey: string; fingerprint: string; record: AddressRecord } | undefined {
  const b = body as { publicKey?: unknown; proof?: unknown; record?: unknown };
  if (!b || typeof b.publicKey !== 'string' || typeof b.proof !== 'string') return undefined;
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(b.publicKey);
  } catch {
    return undefined;
  }
  if (fingerprint === oldFingerprint) return undefined;
  if (!verifySigned(b.publicKey, PREFIX.rotate, `${oldFingerprint}\n${fingerprint}`, b.proof)) return undefined;
  const record = verifyRecord(b.record, b.publicKey);
  return record ? { publicKey: b.publicKey, fingerprint, record } : undefined;
}
