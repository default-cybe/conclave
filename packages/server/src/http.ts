import type { Context } from 'hono';
import { createHash } from 'node:crypto';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import { ProviderError } from '@conclave/core/providers/types.ts';
import type { HonoEnv } from './context';
import { isLoopback } from './remote/lan';

/** Throw from a route to answer with {error} and this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'not found') => new HttpError(404, msg);

/** A body went past the size its reader takes. */
export class BodyTooLarge extends Error {
  constructor(readonly max: number) {
    super(`The body is over ${max} bytes.`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * A request's or a response's body, read up to `max` bytes. Past that it
 * stops reading and throws BodyTooLarge, so a body sent without a
 * Content-Length (chunked) cannot make the hub hold more than `max` in
 * memory before a size check.
 */
export async function readCapped(stream: ReadableStream<Uint8Array> | null | undefined, max: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge(max);
      }
      parts.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* released already */
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A response's JSON, read up to `max` bytes. Throws BodyTooLarge, or a SyntaxError when it is not JSON. */
export async function readJsonCapped<T = unknown>(res: Response, max: number): Promise<T> {
  return JSON.parse(Buffer.from(await readCapped(res.body, max)).toString('utf8')) as T;
}

/** A body from someone with no token yet: pairing, login, an invite, an approval link, an OAuth client. */
export const PUBLIC_BODY_MAX = 64 * 1024;
/** A signed-in app's JSON body (a message with pictures). Bun's own limit for any request is 128 MB. */
export const JSON_BODY_MAX = 64 * 1024 * 1024;

function tooLarge(max: number): HttpError {
  return new HttpError(413, `The request body is ${max >= 1024 * 1024 ? `${max / 1024 / 1024} MB` : `${max / 1024} KB`} at most.`);
}

/**
 * A request's body as text, up to `max` bytes: a larger Content-Length is
 * refused before anything is read, and a chunked body stops being read at
 * the cap. Either way a 413.
 */
export async function readBody(c: Context, max: number): Promise<string> {
  const length = Number(c.req.header('content-length'));
  if (Number.isFinite(length) && length > max) throw tooLarge(max);
  try {
    return Buffer.from(await readCapped(c.req.raw.body, max)).toString('utf8');
  } catch (err) {
    if (err instanceof BodyTooLarge) throw tooLarge(max);
    throw err;
  }
}

/** The cap for a JSON body: small for a request with no token (the route is public), larger for a signed-in app. */
function jsonCap(c: Context): number {
  return (c as Context<HonoEnv>).get('auth') ? JSON_BODY_MAX : PUBLIC_BODY_MAX;
}

/** Parse a JSON body, read up to its cap (see jsonCap). Empty body gives {}. Bad JSON or a non-object is a 400, too large a 413. */
export async function readJson<T = Record<string, unknown>>(c: Context, max = jsonCap(c)): Promise<T> {
  const text = await readBody(c, max);
  if (!text.trim()) return {} as T;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw badRequest('invalid JSON body');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('JSON body must be an object');
  return data as T;
}

export function qNum(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`not a number: ${v}`);
  return n;
}

export function qBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw badRequest(`not a boolean: ${v}`);
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${name} is required`);
  return v;
}

/** An optional string field: undefined when missing or empty, a 400 when it is not a string or is longer than max. */
export function optString(v: unknown, name: string, max = Infinity): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw badRequest(`${name} must be a string`);
  if (v.length > max) throw badRequest(`${name} is too long`);
  return v;
}

/** An optional boolean field: a 400 when it is anything but true or false. */
export function optBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`${name} must be true or false`);
  return v;
}

/** Map any thrown value to a status. Engine errors may carry status or statusCode. */
export function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  // a model provider's status is not the hub's: its 401 means a bad provider key, not a bad hub token
  if (err instanceof ProviderError) return 502;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; name?: string } | undefined;
  const s = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (s && s >= 400 && s < 600) return s;
  if (e?.code === 'ENOENT') return 404;
  if (e?.name === 'SyntaxError') return 400;
  return 500;
}

/** The socket peer's address ("" when unknown, as in tests that call app.fetch directly). */
export function peerAddress(c: Context): string {
  const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? '';
  } catch {
    return '';
  }
}

let trustedProxies = new Set<string>();

/** server.trustedProxies: proxies on other machines whose forwarded address counts (app.ts keeps it current). */
export function setTrustedProxies(list: unknown): void {
  // a hand edited config can hold anything: only strings count
  trustedProxies = new Set((Array.isArray(list) ? list : []).filter((x): x is string => typeof x === 'string').map(normalIp).filter(Boolean));
}

/** Lowercase, and an IPv4-mapped IPv6 peer (::ffff:192.168.1.5) as its IPv4. */
function normalIp(ip: string): string {
  const s = ip.trim().toLowerCase();
  return s.startsWith('::ffff:') && s.includes('.') ? s.slice(7) : s;
}

/**
 * Client IP. Trusts X-Forwarded-For only when the socket peer is loopback (a
 * local reverse proxy, or cloudflared for a tunnel) or in server.trustedProxies,
 * and then takes its last entry: the one that proxy added. Earlier entries come
 * from the client and can say anything. "local" means this machine with no
 * proxy in front.
 */
export function clientIp(c: Context): string {
  const peer = peerAddress(c);
  const trusted = !peer || isLoopback(peer) || trustedProxies.has(normalIp(peer));
  if (trusted) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').map((x) => x.trim()).filter(Boolean).pop();
    if (last) return last;
    const cf = c.req.header('cf-connecting-ip')?.trim();
    if (cf) return cf;
  }
  return peer || 'local';
}

/**
 * A request from this machine itself: the socket peer is loopback and no
 * proxy header is set. Rate limits never block these. A request that came
 * through a tunnel or proxy on this machine is not one, whatever its headers
 * claim, because those headers can come from the internet.
 */
export function isDirectLocal(c: Context): boolean {
  const peer = peerAddress(c);
  if (peer && !isLoopback(peer)) return false;
  return !c.req.header('x-forwarded-for') && !c.req.header('cf-connecting-ip') && !c.req.header('forwarded') && !c.req.header('x-real-ip');
}

/** Who made a request, as the audit log names them: owner, client:<id>, or ip:<address> on a route without a token. */
export function actorOf(c: Context<HonoEnv>): string {
  const who = c.get('auth');
  return who ? (who.kind === 'owner' ? 'owner' : `client:${who.clientId}`) : `ip:${clientIp(c)}`;
}

/** An audit line for a request. Auditing never breaks the request. */
export function auditFor(engine: EngineApi) {
  return (c: Context<HonoEnv>, action: string, detail: string, extra: { sessionId?: string; device?: string; accountId?: string } = {}): void => {
    try {
      // whose action it was: the caller's account (docs/design/ACCOUNTS.md); each account reads its own log
      const accountId = extra.accountId ?? (c.get('auth') as { accountId?: string } | undefined)?.accountId;
      engine.repos.audit.add({ actor: actorOf(c), action, detail, ...extra, ...(accountId ? { accountId } : {}) });
    } catch {
      /* auditing must not break the request */
    }
  };
}

/** A short hash of the credential a request carried (header, ?token=, x-api-key, or a friend hub's signature), or "none". Rate limits count each wrong value once. */
export function credentialMark(c: Context): string {
  const v = c.req.header('authorization') ?? c.req.header('x-api-key') ?? new URL(c.req.url).searchParams.get('token') ?? c.req.header('signature') ?? '';
  return v ? createHash('sha256').update(v).digest('hex').slice(0, 16) : 'none';
}

/** Origin the request came in on, honoring a reverse proxy. */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim();
  if (host) return `${proto || url.protocol.replace(':', '')}://${host}`;
  if (proto) return `${proto}://${url.host}`;
  return url.origin;
}
