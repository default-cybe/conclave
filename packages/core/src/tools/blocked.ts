/**
 * When a site blocks the hub's address (docs/EXTENSIONS.md, Browser proxy).
 *
 * The owner's rule: when a site bans the hub's IP, retry through the hub's
 * proxy (Settings > Browser) in the hub's own country. looksBlocked spots a
 * block page; WebFetch, WebSearch and browser_navigate then try that same
 * request once more through the proxy. The proxy is the owner's: a member's
 * call never goes through it (members get no browser settings, ACCOUNTS.md).
 */
import { currentAccount, isMember } from '../people/context';
import { parseTrace, PROBE_TARGET } from '../browser/proxy-net';
import { defaultCountry, resolveProxy, type BrowserProxyConfig, type SecretReader } from '../browser/proxy-provider';

export interface BlockCheck {
  status: number;
  /** The URL that answered. */
  url?: string;
  /** A redirect's Location. */
  location?: string | null;
  body?: string;
  headers?: Headers;
}

const REDDIT = /(^|\.)reddit\.com$/i;
const DDG = /(^|\.)duckduckgo\.com$/i;
const CLOUDFLARE = /<title>\s*(Attention Required! \| Cloudflare|Just a moment\.\.\.)|error code:?\s*1020|cf-error-code[^>]*>\s*1020|cf_chl_opt|\/cdn-cgi\/challenge-platform\//i;
const BLOCK_PAGE = /blocked by network security|access denied|you have been blocked|request (?:was |has been )?(?:blocked|rejected)|captcha|are you a (?:robot|human)|prove your humanity|unusual traffic/i;

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

/**
 * Why a response looks like the site blocked the hub, or undefined. Kept
 * narrow: a plain 404, an API's 401 or an ordinary 403 is not a block.
 */
export function looksBlocked(r: BlockCheck): string | undefined {
  const host = hostOf(r.url);
  if (r.status >= 300 && r.status < 400) {
    const to = r.location ?? '';
    // Reddit sends visitors it refuses to the login page (old.reddit's reason=lor2)
    if (/[?&]reason=lor2\b/.test(to) || (REDDIT.test(host) && /\/login\b|\/account\/login/.test(to))) return 'sent to the login page';
    return undefined;
  }
  const body = (r.body ?? '').slice(0, 200_000);
  if (/blocked by network security/i.test(body)) return 'blocked by network security';
  if (body.includes('anomaly-modal') || (r.status === 202 && DDG.test(host))) return 'a bot check';
  if (r.headers?.get('cf-mitigated') === 'challenge' || ((r.status === 403 || r.status === 429 || r.status === 503) && CLOUDFLARE.test(body))) return 'a Cloudflare challenge';
  if ((r.status === 403 || r.status === 429) && (BLOCK_PAGE.test(body) || REDDIT.test(host))) return `HTTP ${r.status} with a block page`;
  return undefined;
}

/** "Reddit", "DuckDuckGo", else the host without www. */
export function siteName(url: string): string {
  const host = hostOf(url);
  if (REDDIT.test(host)) return 'Reddit';
  if (DDG.test(host)) return 'DuckDuckGo';
  return host.replace(/^www\./, '') || url;
}

// ---------------------------------------------------------------------------
// The proxy for one retry
// ---------------------------------------------------------------------------

export const NO_PROXY_HINT = 'Set a proxy in Settings > Browser to retry these through it.';
export const MEMBER_HINT = "The hub's proxy belongs to the owner, so a member's request does not retry through it.";

export interface ProxySource {
  cfg(): BrowserProxyConfig | undefined;
  read: SecretReader;
}

let source: ProxySource | undefined;
/** Where the proxy settings and their secrets come from (engine/create.ts; tests). */
export function setProxySource(s?: ProxySource): void {
  source = s;
}

const TRACE_URL = `https://${PROBE_TARGET.host}${PROBE_TARGET.path}`;
const defaultLookup = async (): Promise<string | undefined> => parseTrace(await (await fetch(TRACE_URL, { signal: AbortSignal.timeout(5_000) })).text()).country;
let countryLookup = defaultLookup;
let countryAsk: Promise<string | undefined> | undefined;

/** Replace how the hub finds its own country (tests). Pass nothing to restore it. Clears the cache. */
export function setHubCountryLookup(fn?: () => Promise<string | undefined>): void {
  countryLookup = fn ?? defaultLookup;
  countryAsk = undefined;
}

/**
 * The country of the hub's own public IP, asked once per process from
 * Cloudflare's trace page (no key; the same page the proxy check reads). A
 * failed answer is not kept, so the next blocked request asks again.
 */
export function hubCountry(): Promise<string | undefined> {
  countryAsk ??= countryLookup()
    .catch(() => undefined)
    .then((cc) => {
      if (!cc) countryAsk = undefined;
      return cc?.toUpperCase();
    });
  return countryAsk;
}

type Pick = { cfg: BrowserProxyConfig; country?: string } | { skip: string };

async function pick(accountId: string | undefined): Promise<Pick> {
  if (isMember(accountId)) return { skip: MEMBER_HINT };
  const cfg = source?.cfg();
  if (!cfg?.provider) return { skip: NO_PROXY_HINT };
  // a custom proxy has no country choice: it is used as configured
  if (cfg.provider !== 'dataimpulse') return { cfg };
  const country = (await hubCountry()) ?? defaultCountry(cfg);
  return { cfg, ...(country ? { country } : {}) };
}

/** The country for browser_navigate's retry (manager.useProxy), or why there is none. */
export async function retryCountry(accountId: string | undefined = currentAccount()): Promise<{ country?: string } | { skip: string }> {
  const p = await pick(accountId);
  return 'skip' in p ? p : p.country ? { country: p.country } : {};
}

/**
 * The proxy URL for Bun's fetch `proxy` option, for one retry of a blocked
 * request, or why there is none. The URL carries the login: never log it or
 * put it in a result.
 */
export async function retryProxy(accountId: string | undefined = currentAccount()): Promise<{ url: string; country?: string } | { skip: string }> {
  const p = await pick(accountId);
  if ('skip' in p) return p;
  let r: ReturnType<typeof resolveProxy>;
  try {
    r = resolveProxy(p.cfg, source!.read, p.country);
  } catch (err) {
    return { skip: (err as Error).message };
  }
  const { entry: e, country } = r;
  // Bun's fetch speaks HTTP proxies only; the browser handles SOCKS5 itself
  if (e.scheme !== 'http') return { skip: "The hub's proxy is a SOCKS5 one, which only the browser tools can use; WebFetch and WebSearch need an HTTP proxy." };
  const host = e.host.includes(':') ? `[${e.host}]` : e.host;
  const auth = e.username ? `${encodeURIComponent(e.username)}:${encodeURIComponent(e.password ?? '')}@` : '';
  return { url: `http://${auth}${host}:${e.port}`, ...(country ? { country } : {}) };
}

/** "Reddit blocked the hub's address; fetched through the proxy (US)." */
export function proxiedLine(site: string, country: string | undefined, verb = 'fetched'): string {
  return `${site} blocked the hub's address; ${verb} through the proxy${country ? ` (${country})` : ''}.`;
}

export interface FetchedText {
  status: number;
  body: string;
  headers: Headers;
  /** looksBlocked's reason, when the answer kept is still a block. */
  blocked?: string;
  /** What to tell the agent when it stayed blocked: no proxy, a member, the proxy failed too. */
  hint?: string;
}

/**
 * GET a URL as text; when the answer looks blocked, once more through the
 * hub's proxy. A retry that worked pushes the one line for the agent to notes.
 */
export async function fetchUnblocked(url: string, init: { headers: Record<string, string>; signal: AbortSignal }, notes?: string[]): Promise<FetchedText> {
  const get = async (proxy?: string): Promise<FetchedText> => {
    const res = await fetch(url, { ...init, ...(proxy ? { proxy } : {}) });
    const body = await res.text();
    return { status: res.status, body, headers: res.headers, blocked: looksBlocked({ status: res.status, url, body, headers: res.headers }) };
  };
  const first = await get();
  if (!first.blocked) return first;
  const p = await retryProxy();
  if ('skip' in p) return { ...first, hint: p.skip };
  const where = p.country ? ` (${p.country})` : '';
  let again: FetchedText;
  try {
    again = await get(p.url);
  } catch (err) {
    if (init.signal.aborted) throw err;
    // the error names the target, never the proxy URL
    return { ...first, hint: `The retry through the proxy${where} failed: ${(err as Error).message}` };
  }
  if (again.blocked) return { ...again, hint: `It was blocked through the proxy${where} too.` };
  notes?.push(proxiedLine(siteName(url), p.country));
  return again;
}
