/**
 * Addresses a member's work may not reach from the hub (docs/design/ACCOUNTS.md
 * 5): the hub itself, its LAN and its tunnel's private range. WebFetch and a
 * member's memory connections check every hop against this.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Loopback, private, link local, carrier grade NAT, unique local, unspecified and multicast. */
export function isPrivateAddress(ip: string): boolean {
  let a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return (
      p === 0 ||
      p === 10 ||
      p === 127 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 198 && (q === 18 || q === 19)) ||
      p >= 224
    );
  }
  if (isIP(a) === 6) {
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
  }
  return false;
}

/** Names that only mean something on the hub's own network. */
export function isLocalName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.');
}

export const PRIVATE_REFUSED = 'Refused: that address is on the hub\'s own network. Only the owner can reach it from the hub.';
export const PRIVATE_LOOKUP_FAILED = 'Refused: the hub could not look up that address, so it cannot tell whether it is public. Try again later.';

/** Throws when a URL's host is private, or resolves to a private address. */
export async function checkPublicUrl(raw: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true, verbatim: true })).map((r) => r.address)): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That address does not look right.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https addresses work here.');
  await checkPublicHost(u.hostname, resolve);
}

/**
 * Throws when a host name (a mail server) is private, resolves to a private
 * address, or does not resolve: every caller checks for a member, and a name
 * the check cannot see may still reach the hub's network (fail closed).
 */
export async function checkPublicHost(name: string, resolve?: (host: string) => Promise<string[]>): Promise<void> {
  await resolvePublic(name, resolve);
}

/** The public address to connect to for a host name, after the checks of checkPublicHost. */
export async function resolvePublic(name: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true, verbatim: true })).map((r) => r.address)): Promise<string> {
  const host = name.trim().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('That address does not look right.');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(PRIVATE_REFUSED);
    return host;
  }
  if (isLocalName(host)) throw new Error(PRIVATE_REFUSED);
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new Error(PRIVATE_LOOKUP_FAILED);
  }
  if (!addrs.length) throw new Error(PRIVATE_LOOKUP_FAILED);
  if (addrs.some(isPrivateAddress)) throw new Error(PRIVATE_REFUSED);
  return addrs[0];
}

/**
 * fetch that refuses addresses on the hub's network, for what a member points the hub at (a CalDAV server).
 * It connects to the checked address itself (Host header and TLS name kept), so DNS cannot change in between,
 * and never follows a redirect on its own: a caller that wants one asks for 'manual' and fetches the next hop through here.
 */
export function publicOnlyFetch(base: typeof fetch = fetch, resolve?: (host: string) => Promise<string[]>): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses work here.');
      const address = await resolvePublic(url.hostname, resolve);
      const target = new URL(url);
      target.hostname = isIP(address) === 6 ? `[${address}]` : address;
      const headers = new Headers(req.headers);
      headers.set('host', url.host);
      const name = url.hostname.replace(/^\[|\]$/g, '');
      return base(target.href, {
        method: req.method,
        headers,
        body: req.body,
        signal: req.signal,
        redirect: req.redirect === 'manual' ? 'manual' : 'error',
        ...(isIP(name) ? {} : { tls: { serverName: name } }),
        ...(req.body ? { duplex: 'half' } : {}),
      } as RequestInit);
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
}
