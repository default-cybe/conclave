/**
 * Addresses a friend's hub is never at (docs/design/FRIENDS.md, "Addresses
 * a friend gives"). A friend's signed record, an invite link and an address
 * the owner types all name places this hub then calls, GET /api/identity
 * first, so without a check a friend could point the hub at its own machine
 * or at the cloud's metadata service. Same network (private) addresses stay:
 * a friend on the LAN is real, and invites carry those when asked.
 *
 * Pure functions; the service (service.ts addressRefused) resolves names and
 * knows this hub's own addresses and port.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/** A host name to its addresses. */
export type Lookup = (host: string) => Promise<string[]>;

export const systemLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** An address without brackets, in lower case, and IPv4 for the IPv4-mapped and IPv4-compatible IPv6 forms. */
export function plainIp(ip: string): string {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const dotted = /^(?:0*:)*:?(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted && a.includes(':')) return dotted[1];
  const hex = /^(?:0*:)*:?(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex && a.startsWith('::')) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return a;
}

/**
 * Why no friend's hub is ever at this IP address, or undefined when one may
 * be: loopback, unspecified, link local, multicast and broadcast (with the
 * rest of 240/4), and the cloud metadata addresses outside link local.
 * Private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are
 * fine. With `loopback` a loopback address is fine too: tests run two hubs
 * on one machine.
 */
export function neverAHub(ip: string, opts: { loopback?: boolean } = {}): string | undefined {
  const a = plainIp(ip);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    if (p === 127) return opts.loopback ? undefined : 'loopback';
    if (p === 0) return 'unspecified';
    if (p === 169 && q === 254) return 'link local';
    if (p >= 224 && p <= 239) return 'multicast';
    if (p >= 240) return 'broadcast';
    // Alibaba's metadata service and Azure's wire server
    if (a === '100.100.100.200' || a === '168.63.129.16') return 'cloud metadata';
    return undefined;
  }
  if (isIP(a) === 6) {
    if (a === '::1') return opts.loopback ? undefined : 'loopback';
    if (a === '::') return 'unspecified';
    if (/^fe[89ab][0-9a-f]:/.test(a)) return 'link local';
    if (a.startsWith('ff')) return 'multicast';
    // AWS's metadata service over IPv6
    if (/^fd00:0*ec2:(0*:)*:?0*254$/.test(a)) return 'cloud metadata';
  }
  return undefined;
}

/** Names that only ever mean this machine. */
export function isLoopbackName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

/** Every address of this machine, loopback too. */
export function machineAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.add(plainIp(a.address));
  return out;
}

/** host and port of an http(s) address (the scheme's port when none is written), or undefined. */
export function hostPort(url: string): { host: string; port: number } | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return { host: plainIp(u.hostname).replace(/\.$/, ''), port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  } catch {
    return undefined;
  }
}
