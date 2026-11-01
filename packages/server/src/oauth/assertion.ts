/**
 * private_key_jwt client authentication (RFC 7523 sections 2.2 and 3, as
 * OpenID Connect Core section 9 and the client ID metadata document draft use
 * it): the client signs a short lived JWT with a private key, and the hub
 * checks it against the public keys the client published (jwks_uri or an
 * inline jwks). Pure checks: the keys come from the caller, which fetches
 * them (cimd.ts). Only RS256, PS256 and ES256 are accepted. "none" and the
 * HMAC algorithms are refused, and keys named in the JWT header (jwk, jku,
 * x5u) are never used.
 */
import { constants, createPublicKey, verify, type KeyObject, type webcrypto } from 'node:crypto';

export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const ASSERTION_ALGS = ['RS256', 'PS256', 'ES256'] as const;
export type AssertionAlg = (typeof ASSERTION_ALGS)[number];
/** Clock skew allowed on exp, nbf and iat, in seconds. */
export const CLOCK_SKEW_S = 60;
/**
 * The longest an assertion may live, in seconds: exp at most this far ahead,
 * iat at most this far back. Okta and Google use the same cap, and Python's
 * Authlib signs for an hour by default. Each jti is remembered until its exp.
 */
export const MAX_ASSERTION_LIFETIME_S = 3600;
export const MAX_ASSERTION_BYTES = 8 * 1024;
export const MAX_JWKS_KEYS = 20;
const MIN_RSA_BITS = 2048;

/** A public signing key as the hub keeps it: only the members it needs. */
export interface PublicJwk {
  kty: 'RSA' | 'EC';
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: 'P-256';
  x?: string;
  y?: string;
}

export function isAssertionAlg(v: unknown): v is AssertionAlg {
  return typeof v === 'string' && (ASSERTION_ALGS as readonly string[]).includes(v);
}

/** JWK members that only a private or shared key has. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

function importKey(jwk: PublicJwk): KeyObject | undefined {
  try {
    const fields: webcrypto.JsonWebKey = jwk.kty === 'RSA' ? { kty: 'RSA', n: jwk.n, e: jwk.e } : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
    return createPublicKey({ key: fields, format: 'jwk' });
  } catch {
    return undefined;
  }
}

/**
 * The usable signing keys of a JWK set (RFC 7517), or a sentence saying why
 * there are none. A private or shared key anywhere in it refuses the whole
 * set. Encryption keys, other curves and RSA keys under 2048 bits are left out.
 */
export function parseJwks(raw: unknown, what: string): PublicJwk[] | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { keys?: unknown }).keys)) return `${what} are not a JWK set (an object with a keys list).`;
  const list = (raw as { keys: unknown[] }).keys;
  if (list.length > MAX_JWKS_KEYS) return `${what} hold more than ${MAX_JWKS_KEYS} keys.`;
  const out: PublicJwk[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `${what} hold a key that is not a JSON object.`;
    const j = item as Record<string, unknown>;
    if (j.kty === 'oct' || PRIVATE_MEMBERS.some((m) => m in j)) return `${what} hold a private or shared key. Publish public keys only.`;
    if (j.use !== undefined && j.use !== 'sig') continue;
    if (j.key_ops !== undefined && (!Array.isArray(j.key_ops) || !j.key_ops.includes('verify'))) continue;
    if (j.kid !== undefined && (typeof j.kid !== 'string' || j.kid.length > 256)) continue;
    if (j.alg !== undefined && typeof j.alg !== 'string') continue;
    const extra = { ...(typeof j.kid === 'string' ? { kid: j.kid } : {}), ...(typeof j.alg === 'string' ? { alg: j.alg } : {}) };
    let key: PublicJwk | undefined;
    if (j.kty === 'RSA' && typeof j.n === 'string' && typeof j.e === 'string') key = { kty: 'RSA', n: j.n, e: j.e, ...extra };
    else if (j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string') key = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, ...extra };
    if (!key) continue;
    const made = importKey(key);
    if (!made) continue;
    if (key.kty === 'RSA' && (made.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) continue;
    out.push(key);
  }
  if (!out.length) return `${what} have no usable signing key: an RSA key of ${MIN_RSA_BITS} bits or more, or an EC P-256 key.`;
  return out;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodePart(part: string): Record<string, unknown> | undefined {
  if (!B64URL.test(part)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

interface Parsed {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  input: Buffer;
  signature: Buffer;
}

function parseJwt(jwt: string): Parsed | string {
  if (jwt.length > MAX_ASSERTION_BYTES) return 'The client_assertion is too long.';
  const parts = jwt.split('.');
  if (parts.length !== 3) return 'The client_assertion is not a signed JWT.';
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || !claims) return 'The client_assertion is not a well formed JWT.';
  if (parts[2] && !B64URL.test(parts[2])) return 'The client_assertion is not a well formed JWT.';
  return { header, claims, input: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], 'base64url') };
}

/** The sub claim, read without checking anything: only to find which client to check the assertion for. */
export function assertionSubject(jwt: string): string | undefined {
  const p = parseJwt(jwt);
  return typeof p === 'string' || typeof p.claims.sub !== 'string' ? undefined : p.claims.sub;
}

function fits(key: PublicJwk, alg: AssertionAlg): boolean {
  if (key.alg !== undefined && key.alg !== alg) return false;
  return alg === 'ES256' ? key.kty === 'EC' && key.crv === 'P-256' : key.kty === 'RSA';
}

function signatureOk(key: PublicJwk, alg: AssertionAlg, input: Buffer, signature: Buffer): boolean {
  const made = importKey(key);
  if (!made) return false;
  try {
    if (alg === 'ES256') return signature.length === 64 && verify('sha256', input, { key: made, dsaEncoding: 'ieee-p1363' }, signature);
    if (alg === 'PS256') return verify('sha256', input, { key: made, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    return verify('sha256', input, { key: made, padding: constants.RSA_PKCS1_PADDING }, signature);
  } catch {
    return false;
  }
}

export interface AssertionCheck {
  clientId: string;
  /** aud values that name this hub: its issuer and its token endpoint (and the endpoint being called). */
  audiences: readonly string[];
  nowMs: number;
  /** The client's token_endpoint_auth_signing_alg, when it named one. */
  alg?: AssertionAlg;
  /** The client's public keys. force: fetch them again, after an unknown kid. Throws with a sentence when they cannot be had. */
  keys: (force: boolean) => Promise<PublicJwk[]>;
}

export type AssertionResult = { ok: true; jti: string; exp: number } | { ok: false; reason: string };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Check a client_assertion. The caller still has to record the jti (once per
 * client until exp) and refuse a second use.
 */
export async function verifyClientAssertion(jwt: string, check: AssertionCheck): Promise<AssertionResult> {
  const fail = (reason: string): AssertionResult => ({ ok: false, reason });
  const p = parseJwt(jwt);
  if (typeof p === 'string') return fail(p);
  const { header, claims } = p;

  const alg = header.alg;
  if (typeof alg === 'string' && alg.toLowerCase() === 'none') return fail('An unsigned client_assertion (alg none) is not accepted.');
  if (typeof alg === 'string' && /^HS/i.test(alg)) return fail(`The client_assertion must be signed with the app's private key (RS256, PS256 or ES256), not a shared secret (${alg.slice(0, 10)}).`);
  if (!isAssertionAlg(alg)) return fail('The client_assertion must be signed with RS256, PS256 or ES256.');
  if (!p.signature.length) return fail('The client_assertion has no signature.');
  if (check.alg && alg !== check.alg) return fail(`The app said it signs with ${check.alg}, but this client_assertion uses ${alg}.`);
  if (header.crit !== undefined) return fail('The client_assertion names critical header parameters the hub does not know.');
  const kid = header.kid;
  if (kid !== undefined && typeof kid !== 'string') return fail('The client_assertion kid must be a string.');

  if (claims.iss !== check.clientId || claims.sub !== check.clientId) return fail('The client_assertion iss and sub must both be the client_id.');
  const aud = claims.aud;
  const auds = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];
  if (!auds.some((a) => check.audiences.includes(a))) return fail("The client_assertion aud must be this hub's issuer or its token endpoint.");
  const now = check.nowMs / 1000;
  if (!num(claims.exp)) return fail('The client_assertion needs exp.');
  if (now >= claims.exp + CLOCK_SKEW_S) return fail('The client_assertion has expired.');
  if (claims.exp > now + MAX_ASSERTION_LIFETIME_S + CLOCK_SKEW_S) return fail('The client_assertion lives too long: exp may be at most an hour ahead.');
  if (claims.nbf !== undefined && (!num(claims.nbf) || claims.nbf > now + CLOCK_SKEW_S)) return fail('The client_assertion is not valid yet (nbf).');
  if (claims.iat !== undefined) {
    if (!num(claims.iat) || claims.iat > now + CLOCK_SKEW_S) return fail('The client_assertion was issued in the future (iat).');
    if (claims.iat < now - MAX_ASSERTION_LIFETIME_S - CLOCK_SKEW_S) return fail('The client_assertion is more than an hour old (iat).');
  }
  const jti = claims.jti;
  if (typeof jti !== 'string' || !jti || jti.length > 256) return fail('The client_assertion needs a jti, a unique id of at most 256 characters.');

  const pick = (keys: PublicJwk[]) => {
    const usable = keys.filter((k) => fits(k, alg));
    if (kid === undefined) return usable;
    const named = usable.filter((k) => k.kid === kid);
    // a set whose keys carry no kid at all: try them
    return named.length ? named : usable.filter((k) => k.kid === undefined);
  };
  let pool: PublicJwk[];
  try {
    pool = pick(await check.keys(false));
    // an unknown kid: the app may have rotated its keys, so fetch them once more
    if (!pool.length && kid !== undefined) pool = pick(await check.keys(true));
  } catch (err) {
    return fail(err instanceof Error && err.message ? err.message : "The hub could not get the app's public keys.");
  }
  if (!pool.length) return fail(kid !== undefined ? "The client_assertion kid names no key in the app's public keys." : `The app's public keys have no ${alg} key.`);
  if (!pool.some((k) => signatureOk(k, alg, p.input, p.signature))) return fail('The client_assertion signature does not verify with the app\'s public keys.');
  return { ok: true, jti, exp: claims.exp };
}
