/**
 * One proxy: its parts, the URL the config writes it as, and the label the
 * owner and the agent see. A password is never part of the URL or the label;
 * it is a hub secret (proxy-provider.ts).
 *
 * Pure, with no node imports, so the web app uses it too.
 */

export type ProxyScheme = 'socks5' | 'http';

/** One proxy, with its credentials. Never logged or sent to an app as is: use proxyLabel. */
export interface ProxyEntry {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** A config value that only names a hub secret. */
export const SECRET_REF = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

/** scheme://user@host:port, never the password. */
export function proxyLabel(p: Pick<ProxyEntry, 'scheme' | 'host' | 'port' | 'username'>): string {
  const host = p.host.includes(':') ? `[${p.host}]` : p.host;
  return `${p.scheme}://${p.username ? `${encodeURIComponent(p.username)}@` : ''}${host}:${p.port}`;
}

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;

function validHost(h: string): boolean {
  if (!h || h.length > 253) return false;
  return HOST.test(h) || (h.includes(':') && IPV6.test(h));
}

/**
 * One proxy from a config URL: socks5://[user@]host:port or http://[user@]host:port.
 * A password in the URL is refused: it belongs in a hub secret.
 */
export function parseProxyUrl(raw: string): { ok: true; proxy: ProxyEntry } | { ok: false; why: string } {
  const s = (raw ?? '').trim();
  const m = /^([a-z0-9]+):\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^:/@]+):(\d+)\/?$/i.exec(s);
  if (!m) return { ok: false, why: 'Write it as socks5://host:port or http://host:port, with user@ before the host when it has a user name.' };
  const scheme = /^(socks5|http)$/i.test(m[1]) ? (m[1].toLowerCase() as ProxyScheme) : undefined;
  if (!scheme) return { ok: false, why: `${m[1]}:// is not supported. Use socks5:// or http://.` };
  const host = m[3].replace(/^\[|\]$/g, '');
  if (!validHost(host)) return { ok: false, why: `${host} is not a host name or IP address.` };
  const port = /^\d{1,5}$/.test(m[4]) ? Number(m[4]) : 0;
  if (port < 1 || port > 65535) return { ok: false, why: 'The port must be a number from 1 to 65535.' };
  let username: string | undefined;
  if (m[2] !== undefined) {
    if (m[2].includes(':')) return { ok: false, why: 'Leave the password out of the address. Save it as the proxy password, which the hub keeps as a secret.' };
    try {
      username = decodeURIComponent(m[2]) || undefined;
    } catch {
      return { ok: false, why: 'The user name has a bad % escape.' };
    }
  }
  return { ok: true, proxy: { scheme, host, port, ...(username ? { username } : {}) } };
}
