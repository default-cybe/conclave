/**
 * Signed requests between hubs, in the shape of RFC 9421 (HTTP Message
 * Signatures) with an RFC 9530 Content-Digest:
 *
 *   content-digest:  sha-256=:<base64 of SHA-256 of the body>:
 *   conclave-to:     <the recipient hub's fingerprint>
 *   signature-input: peer=("@method" "@path" "@query" "@authority" "content-digest" "conclave-to");
 *                    created=<s>;expires=<s>;nonce="<random>";keyid="<sender fingerprint>";alg="ed25519";tag="conclave-peer/1"
 *   signature:       peer=:<base64 Ed25519 signature of the signature base>:
 *
 * A request lives 5 minutes at most. The receiver checks the shape, the
 * digest, that conclave-to is its own fingerprint and the clock, then looks
 * up the key by keyid (a friend, or the key a friend request carries), checks
 * the signature, and only then records the nonce, so strangers cannot fill
 * the nonce cache. The receiver works out @authority from the Host header,
 * X-Forwarded-Host and its own addresses, because a tunnel may rewrite Host;
 * conclave-to already binds the request to this hub.
 */
import { createHash, randomBytes } from 'node:crypto';
import { FINGERPRINT, PEER_TAG, verifySigned, type Signer } from './crypto';

export const SIG_LABEL = 'peer';
export const COMPONENTS = ['@method', '@path', '@query', '@authority', 'content-digest', 'conclave-to'] as const;
/** Longest life of a signed request. */
export const MAX_TTL_SEC = 300;
/** Clocks may differ this much. */
export const SKEW_SEC = 60;

export function contentDigest(body: Uint8Array | string): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

interface Values {
  method: string;
  path: string;
  query: string;
  authority: string;
  digest: string;
  to: string;
}

function value(name: string, v: Values): string {
  switch (name) {
    case '@method':
      return v.method.toUpperCase();
    case '@path':
      return v.path;
    case '@query':
      return v.query;
    case '@authority':
      return v.authority.toLowerCase();
    case 'content-digest':
      return v.digest;
    case 'conclave-to':
      return v.to;
    default:
      throw new Error(`unknown component ${name}`);
  }
}

/** The signature base (RFC 9421 2.5) for these components and the raw @signature-params. */
export function signatureBase(components: readonly string[], v: Values, params: string): string {
  return [...components.map((c) => `"${c}": ${value(c, v)}`), `"@signature-params": ${params}`].join('\n');
}

export interface OutgoingRequest {
  method: string;
  url: string;
  body?: Uint8Array | string;
  /** The recipient's fingerprint. */
  to: string;
}

/** Headers that sign a request to another hub. */
export function signRequest(signer: Signer, req: OutgoingRequest, opts: { now?: number; ttlSec?: number; nonce?: string } = {}): Record<string, string> {
  const url = new URL(req.url);
  const created = Math.floor((opts.now ?? Date.now()) / 1000);
  const expires = created + Math.min(opts.ttlSec ?? MAX_TTL_SEC, MAX_TTL_SEC);
  const nonce = opts.nonce ?? randomBytes(16).toString('base64url');
  const digest = contentDigest(req.body ?? '');
  const params = `(${COMPONENTS.map((c) => `"${c}"`).join(' ')});created=${created};expires=${expires};nonce="${nonce}";keyid="${signer.fingerprint}";alg="ed25519";tag="${PEER_TAG}"`;
  const base = signatureBase(COMPONENTS, { method: req.method, path: url.pathname, query: url.search || '?', authority: url.host, digest, to: req.to }, params);
  const sig = Buffer.from(signer.sign('', base), 'base64url').toString('base64');
  return {
    'content-digest': digest,
    'conclave-to': req.to,
    'signature-input': `${SIG_LABEL}=${params}`,
    signature: `${SIG_LABEL}=:${sig}:`,
  };
}

export interface IncomingRequest {
  method: string;
  /** The URL as this hub received it. */
  url: string;
  headers: Headers;
  body: Uint8Array;
}

export interface ParsedSignature {
  keyid: string;
  nonce: string;
  created: number;
  expires: number;
  components: string[];
  params: string;
  signature: Buffer;
  digest: string;
  to: string;
}

/** Why a request was turned away. code is for logs and tests; status is what the sender gets. */
export interface Refusal {
  status: 400 | 401 | 403;
  code: string;
  message: string;
}

const refuse = (status: Refusal['status'], code: string, message: string): Refusal => ({ status, code, message });

export function isRefusal(v: unknown): v is Refusal {
  return !!v && typeof v === 'object' && 'code' in v && 'status' in v && !('keyid' in v);
}

/**
 * Everything that can be checked before knowing the key: shape, tag,
 * lifetime and clock, recipient and digest.
 */
export function parseSignature(req: IncomingRequest, self: string, now = Date.now()): ParsedSignature | Refusal {
  const input = req.headers.get('signature-input');
  const sigHeader = req.headers.get('signature');
  const digest = req.headers.get('content-digest');
  const to = req.headers.get('conclave-to');
  if (!input || !sigHeader || !digest || !to) return refuse(401, 'unsigned', 'This address takes only signed requests from friends.');
  const m = /^([a-z][a-z0-9_-]*)=(\(([^)]*)\)(.*))$/.exec(input.trim());
  if (!m || m[1] !== SIG_LABEL) return refuse(401, 'signature-input', 'The signature input is not one this hub reads.');
  const [, label, params, list, rest] = m;
  const components = [...list.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (COMPONENTS.some((c) => !components.includes(c)) || components.some((c) => !(COMPONENTS as readonly string[]).includes(c))) {
    return refuse(401, 'components', 'The signature does not cover method, path, query, authority, digest and recipient.');
  }
  const p: Record<string, string> = {};
  for (const x of rest.matchAll(/;([a-z]+)=(?:"([^"]*)"|(-?\d+))/g)) p[x[1]] = x[2] ?? x[3];
  if (p.tag !== PEER_TAG || p.alg !== 'ed25519') return refuse(401, 'tag', `The signature is not ${PEER_TAG} with ed25519.`);
  if (!FINGERPRINT.test(p.keyid ?? '')) return refuse(401, 'keyid', 'The signature names no hub key.');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(p.nonce ?? '')) return refuse(401, 'nonce', 'The signature has no usable nonce.');
  const created = Number(p.created);
  const expires = Number(p.expires);
  if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires) || expires <= created || expires - created > MAX_TTL_SEC) {
    return refuse(401, 'lifetime', `A signed request lives ${MAX_TTL_SEC / 60} minutes at most.`);
  }
  const nowSec = Math.floor(now / 1000);
  if (created > nowSec + SKEW_SEC) return refuse(401, 'skew', "The request is dated in the future. Check both hubs' clocks.");
  if (expires < nowSec - SKEW_SEC) return refuse(401, 'expired', "The request has expired. Check both hubs' clocks.");
  if (to !== self) return refuse(401, 'recipient', 'The request is for another hub.');
  if (digest !== contentDigest(req.body)) return refuse(400, 'digest', 'The body does not match its digest.');
  const sm = new RegExp(`^${label}=:([A-Za-z0-9+/]+={0,2}):$`).exec(sigHeader.trim());
  const signature = sm ? Buffer.from(sm[1], 'base64') : undefined;
  if (!signature || signature.length !== 64) return refuse(401, 'signature', 'The signature is malformed.');
  return { keyid: p.keyid, nonce: p.nonce, created, expires, components, params, signature, digest, to };
}

/** True when the signature is `publicKey`'s, for one of the authorities this hub answers as. */
export function verifySignature(parsed: ParsedSignature, req: IncomingRequest, publicKey: string, authorities: string[]): boolean {
  const url = new URL(req.url);
  const sig = parsed.signature.toString('base64url');
  for (const authority of new Set(authorities.filter(Boolean).map((a) => a.toLowerCase()))) {
    const base = signatureBase(parsed.components, { method: req.method, path: url.pathname, query: url.search || '?', authority, digest: parsed.digest, to: parsed.to }, parsed.params);
    if (verifySigned(publicKey, '', base, sig)) return true;
  }
  return false;
}
