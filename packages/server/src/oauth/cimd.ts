/**
 * Client ID metadata documents (draft-ietf-oauth-client-id-metadata-document,
 * MCP 2025-11-25): the client_id is an https URL and the hub reads the
 * client's name and redirect URIs from it. That URL comes from whoever opens
 * the authorize link, so the fetch is fenced in: https on port 443 only, no
 * private, loopback or link-local address (checked after DNS), no redirects,
 * 5 seconds and 64 KB at most. A client that signs in with private_key_jwt
 * names its public keys there, inline (jwks) or at a jwks_uri; that URL is
 * fetched with the same fences, when the hub needs the keys.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { OAuthScope } from '@conclave/core/client/index.ts';
import { isAssertionAlg, parseJwks, type AssertionAlg, type PublicJwk } from './assertion';
import { cleanName, redirectProblem } from './checks';
import { parseScopes } from './scopes';

export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_MAX_BYTES = 64 * 1024;

export interface ClientDocument extends KeySource {
  name: string;
  redirectUris: string[];
  applicationType: 'web' | 'native';
  scope?: OAuthScope[];
  /** none (a public client) or private_key_jwt with the keys in jwksUri or jwks. */
  authMethod: 'none' | 'private_key_jwt';
}

export interface CimdOptions {
  /** Tests: answer without the network. The address check still runs on the URL's host. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Tests: DNS answers. */
  resolve?: (host: string) => Promise<string[]>;
}

export class CimdError extends Error {}

/** Looks like a client ID metadata document URL: https with a path. */
export function isDocumentUrl(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false;
  try {
    const u = new URL(clientId);
    return u.pathname !== '/' && !u.hash;
  } catch {
    return false;
  }
}

function v4parts(ip: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : undefined;
}

function publicV4(n: number[]): boolean {
  const [a, b, c] = n;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** An address on the public internet, not this machine, a private network or a reserved range. */
export function isPublicAddress(ip: string): boolean {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const n4 = v4parts(s);
  if (n4) return publicV4(n4);
  if (isIP(s) !== 6) return false;
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible and NAT64 (64:ff9b::a.b.c.d)
  const tail = /(?:^::ffff:|^::|^64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) return !!v4parts(tail[1]) && publicV4(v4parts(tail[1])!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return publicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (s === '::' || s === '::1') return false;
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (s.startsWith('2001:db8:') || s.startsWith('100::') || s.startsWith('64:ff9b:')) return false;
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  const list = await lookup(host, { all: true, verbatim: true });
  return list.map((a) => a.address);
}

async function readCapped(res: Response, max: number, what: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      throw new CimdError(`${what} are larger than ${max / 1024} KB.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Why a URL the hub would fetch is refused before any lookup: https on the standard port, no user info, no fragment. */
function fetchUrlProblem(raw: string, label: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${label} is not a URL.`;
  }
  if (url.protocol !== 'https:') return `${label} must be an https URL.`;
  if (url.username || url.password) return `${label} may not carry a user name or password.`;
  if (url.port && url.port !== '443') return `${label} must use the standard https port.`;
  if (raw.includes('#')) return `${label} may not have a fragment.`;
  return undefined;
}

interface Fetching {
  /** The URL as a sentence starts with it: "The client_id URL". */
  label: string;
  /** What is fetched, lower case: "the app's details". */
  what: string;
  /** Where it must be: "its client_id URL". */
  where: string;
}

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * GET a small JSON object from a URL that a stranger named: https on port
 * 443, public addresses only (checked after DNS), no redirects, 5 seconds,
 * 64 KB. Throws CimdError with a sentence for the error page.
 */
export async function fetchPublicJson(raw: string, f: Fetching, opts: CimdOptions = {}): Promise<Record<string, unknown>> {
  const problem = fetchUrlProblem(raw, f.label);
  if (problem) throw new CimdError(problem);
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(host);
    } catch {
      throw new CimdError(`The hub could not look up ${host}.`);
    }
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) throw new CimdError(`${host} is not a public internet address, so the hub will not fetch ${f.what} from it.`);

  let res: Response;
  try {
    res = await (opts.fetch ?? ((u, i) => fetch(u, i)))(raw, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    throw new CimdError(`The hub could not fetch ${f.what} from ${host}.`);
  }
  if (res.status >= 300 && res.status < 400) throw new CimdError(`${host} answered with a redirect. ${upper(f.what)} must be at ${f.where}.`);
  if (res.status !== 200) throw new CimdError(`${host} answered ${res.status} for ${f.what}.`);
  const text = await readCapped(res, CIMD_MAX_BYTES, upper(f.what));
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CimdError(`${upper(f.what)} are not JSON.`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CimdError(`${upper(f.what)} are not a JSON object.`);
  return doc as Record<string, unknown>;
}

/** The keys a private_key_jwt client published, from its metadata document or its registration. */
export interface KeySource {
  jwksUri?: string;
  jwks?: PublicJwk[];
  authAlg?: AssertionAlg;
}

/**
 * Where a private_key_jwt client keeps its public keys: a jwks_uri (fetched
 * when needed, with the same fences as a client document) or an inline jwks,
 * never both (RFC 7591 section 2). Returns a sentence when it is unusable.
 * `what` starts the sentence: "The app's details" or "The registration".
 */
export function keySource(meta: Record<string, unknown>, what: string): KeySource | string {
  const alg = meta.token_endpoint_auth_signing_alg;
  if (alg !== undefined && !isAssertionAlg(alg)) return `${what} name a signing algorithm this hub does not accept. Use RS256, PS256 or ES256.`;
  const authAlg = alg !== undefined ? { authAlg: alg as AssertionAlg } : {};
  const hasUri = meta.jwks_uri !== undefined;
  const hasSet = meta.jwks !== undefined;
  if (hasUri && hasSet) return `${what} may name jwks_uri or jwks, not both.`;
  if (!hasUri && !hasSet) return `${what} say private_key_jwt but give no public keys (jwks_uri or jwks).`;
  if (hasUri) {
    const uri = meta.jwks_uri;
    if (typeof uri !== 'string' || uri.length > 2000) return `${what} have a jwks_uri that is not a URL.`;
    const problem = fetchUrlProblem(uri, 'The jwks_uri');
    if (problem) return problem;
    const host = new URL(uri).hostname.replace(/^\[|\]$/g, '');
    // a literal address can be checked now; a name is checked after DNS, when the keys are fetched
    if (isIP(host) && !isPublicAddress(host)) return `${host} is not a public internet address, so the hub will not fetch the app's keys from it.`;
    return { jwksUri: uri, ...authAlg };
  }
  const keys = parseJwks(meta.jwks, `The keys in ${what.replace(/^The /, 'the ')}`);
  if (typeof keys === 'string') return keys;
  return { jwks: keys, ...authAlg };
}

export const JWKS_TTL_MS = 5 * 60_000;
/** An unknown kid fetches a jwks_uri again at most this often. */
export const JWKS_REFETCH_MS = 60_000;
const JWKS_CACHE_MAX = 100;

/**
 * Public keys from jwks_uri, kept for 5 minutes. An unknown kid may fetch
 * them again at once (the app rotated its keys), but at most once a minute
 * per URL, so a stream of made up kids cannot make the hub hammer it. A
 * fetch that failed is not tried again for a minute either.
 */
export class JwksCache {
  private readonly entries = new Map<string, { keys: PublicJwk[]; at: number; forcedAt?: number }>();
  private readonly failed = new Map<string, { at: number; message: string }>();
  private readonly running = new Map<string, Promise<PublicJwk[]>>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(url: string, opts: CimdOptions = {}, force = false): Promise<PublicJwk[]> {
    const now = this.now();
    const hit = this.entries.get(url);
    const fresh = hit !== undefined && now - hit.at < JWKS_TTL_MS;
    if (hit && fresh && (!force || (hit.forcedAt !== undefined && now - hit.forcedAt < JWKS_REFETCH_MS))) return hit.keys;
    const failed = this.failed.get(url);
    if (failed && now - failed.at < JWKS_REFETCH_MS) {
      if (hit && fresh) return hit.keys;
      throw new CimdError(failed.message);
    }
    const busy = this.running.get(url);
    if (busy) return busy;
    const job = (async () => {
      try {
        const raw = await fetchPublicJson(url, { label: 'The jwks_uri', what: "the app's keys", where: 'its jwks_uri' }, opts);
        const keys = parseJwks(raw, "The app's keys");
        if (typeof keys === 'string') throw new CimdError(keys);
        const forcedAt = force ? this.now() : hit?.forcedAt;
        this.failed.delete(url);
        this.entries.delete(url);
        this.entries.set(url, { keys, at: this.now(), ...(forcedAt !== undefined ? { forcedAt } : {}) });
        while (this.entries.size > JWKS_CACHE_MAX) this.entries.delete(this.entries.keys().next().value as string);
        return keys;
      } catch (err) {
        const message = err instanceof CimdError ? err.message : "The hub could not fetch the app's keys.";
        this.failed.delete(url);
        this.failed.set(url, { at: this.now(), message });
        while (this.failed.size > JWKS_CACHE_MAX) this.failed.delete(this.failed.keys().next().value as string);
        throw new CimdError(message);
      }
    })();
    this.running.set(url, job);
    try {
      return await job;
    } finally {
      this.running.delete(url);
    }
  }
}

/** Fetch and check a client's metadata document. Throws CimdError with a sentence for the error page. */
export async function fetchClientDocument(clientId: string, opts: CimdOptions = {}): Promise<ClientDocument> {
  if (!isDocumentUrl(clientId)) throw new CimdError('The client_id is not an https URL with a path.');
  const host = new URL(clientId).hostname.replace(/^\[|\]$/g, '');
  const doc = await fetchPublicJson(clientId, { label: 'The client_id URL', what: "the app's details", where: 'its client_id URL' }, opts);
  if (doc.client_id !== clientId) throw new CimdError("The app's details name a different client_id than the URL they came from.");
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) throw new CimdError("The app's details may not hold a client secret.");
  // the draft rules out every method built on a shared secret; of the rest the hub takes none and private_key_jwt
  const method = doc.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'private_key_jwt') throw new CimdError('This hub accepts apps identified by a URL as public clients (token_endpoint_auth_method none) or with private_key_jwt, never with a client secret.');
  let auth: Pick<ClientDocument, 'authMethod' | 'jwksUri' | 'jwks' | 'authAlg'> = { authMethod: 'none' };
  if (method === 'private_key_jwt') {
    const keys = keySource(doc, "The app's details");
    if (typeof keys === 'string') throw new CimdError(keys);
    auth = { authMethod: 'private_key_jwt', ...keys };
  }
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new CimdError("The app's details need one to ten redirect_uris.");
  for (const u of uris) {
    const problem = redirectProblem(u);
    if (problem) throw new CimdError(problem);
  }
  if (Array.isArray(doc.grant_types) && !doc.grant_types.includes('authorization_code')) throw new CimdError('The app does not use the authorization_code grant.');
  if (Array.isArray(doc.response_types) && !doc.response_types.includes('code')) throw new CimdError('The app does not use the code response type.');
  const scope = typeof doc.scope === 'string' ? parseScopes(doc.scope) : undefined;
  return {
    name: cleanName(doc.client_name) || host,
    redirectUris: uris as string[],
    applicationType: doc.application_type === 'native' ? 'native' : 'web',
    ...(scope && scope.length ? { scope } : {}),
    ...auth,
  };
}
