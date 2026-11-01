/**
 * The same network: which addresses of this machine a phone on the same
 * Wi-Fi can use, and which peers count as local. Pure functions over
 * os.networkInterfaces() so they are easy to test.
 */
import { existsSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export interface LanAddress {
  ip: string;
  iface: string;
}

export type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/** Virtual and VPN interfaces a phone on the Wi-Fi cannot reach. */
const SKIP_IFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|tailscale|zt|wg|cni|flannel|cali|podman|lxcbr|lxdbr|awdl|llw|anpi|bridge)/i;

/** IPv4 as four numbers, or undefined. Accepts the ::ffff: mapped form. */
function v4(ip: string): number[] | undefined {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (!m) return undefined;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : undefined;
}

/** 10/8, 172.16/12, 192.168/16: home and office networks. */
export function isPrivateV4(ip: string): boolean {
  const n = v4(ip);
  if (!n) return false;
  return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168);
}

export function isLoopback(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s === '::1' || s === 'localhost') return true;
  const n = v4(s);
  return !!n && n[0] === 127;
}

/**
 * A peer that is on this machine or a private network: loopback, RFC 1918,
 * link-local, the 100.64/10 range (carrier NAT and Tailscale), IPv6 unique
 * local and link-local. Public internet peers are not.
 */
export function isLocalPeer(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (!s) return false;
  if (isLoopback(s) || isPrivateV4(s)) return true;
  const n = v4(s);
  if (n) return (n[0] === 169 && n[1] === 254) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127);
  return /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
}

/** True inside Docker or Podman, where interface addresses are the container's own. */
export function inContainer(): boolean {
  try {
    return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

/**
 * Private IPv4 addresses of this machine that phones on the same network can
 * use, best first: 192.168 (home Wi-Fi) before 10 and 172.16. In a container
 * the 172.16/12 bridge addresses are left out because nothing outside reaches
 * them.
 */
export function lanAddresses(ifaces: Interfaces = networkInterfaces(), opts: { container?: boolean } = {}): LanAddress[] {
  const container = opts.container ?? inContainer();
  const out: LanAddress[] = [];
  for (const [iface, list] of Object.entries(ifaces)) {
    if (!list || SKIP_IFACE.test(iface)) continue;
    for (const a of list) {
      // Node 18.0 reported the family as a number
      const fam = a.family as string | number;
      const family = fam === 4 ? 'IPv4' : fam === 6 ? 'IPv6' : fam;
      if (family !== 'IPv4' || a.internal || !isPrivateV4(a.address)) continue;
      if (container && a.address.startsWith('172.')) continue;
      if (!out.some((x) => x.ip === a.address)) out.push({ ip: a.address, iface });
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a.ip) - rank(b.ip));
}

/** "Wi-Fi" for wireless interface names, else "Network". */
export function ifaceWord(iface: string): string {
  return /^(wl|wlan|wlp|wifi|en0$|ath|ra\d)/i.test(iface) ? 'Wi-Fi' : 'Network';
}

/** http://ip:port, with brackets for IPv6. */
export function hostUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** The listen address covers every interface. */
export function isWildcard(host: string | undefined): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}
