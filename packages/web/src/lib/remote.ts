/**
 * Remote access in the web app: words for the modes and states, which way a
 * URL reaches the hub, and what to do when the hub's address changes (a quick
 * tunnel that restarted) or stops answering.
 */
import type { HubAddress, RemoteMode, RemoteStatus } from '@conclave/core/types';
import { loadConnection, MOCK, saveConnection, type Connection } from './api';
import { isDesktopApp } from './notify';

export const MODE_LABEL: Record<RemoteMode, string> = {
  quick: 'Quick tunnel',
  stable: 'Stable address on your domain',
  tailscale: 'Tailscale',
  custom: 'My own URL',
  off: 'Local only',
};

export const MODE_HELP: Record<RemoteMode, string> = {
  quick: 'Built in, no account. The hub runs a Cloudflare tunnel and gets an https address. The address changes when the hub restarts.',
  stable: 'A fixed name such as conclave.example.com, through your Cloudflare account. Paste an API token once and pick the domain.',
  tailscale: 'Only devices on your tailnet. Tailscale has to run on the hub and on every phone and computer.',
  custom: 'A reverse proxy or domain you already run in front of the hub.',
  off: 'No outside address. Devices on the same network can still connect.',
};

export const MODES: RemoteMode[] = ['quick', 'stable', 'tailscale', 'custom', 'off'];

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** How a URL reaches the hub, in words: "a Cloudflare tunnel", "Tailscale", "this network", "this computer". */
export function transportWords(url: string | undefined): string {
  const host = hostOf(url);
  if (!host) return 'Unknown';
  if (/\.trycloudflare\.com$/i.test(host)) return 'Cloudflare quick tunnel';
  if (/\.ts\.net$/i.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'Tailscale';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'This computer';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$|\.lan$/.test(host)) return 'Same network';
  return 'Internet';
}

/** True for an address that phones away from home can use. */
export function isOutside(a: HubAddress): boolean {
  return a.kind !== 'lan';
}

/** The first address phones can use away from home, if any. */
export function outsideAddress(s: RemoteStatus | undefined): HubAddress | undefined {
  return s?.addresses.find(isOutside);
}

/**
 * A pairing code shown before the hub's addresses changed (remote access set,
 * a tunnel moved): its QR does not carry the list the hub has now, best first
 * (docs/INSTALL.md 2). A hub with no addresses of its own, only this
 * computer, has nothing newer to give.
 */
export function pairingStale(info: { url: string; addresses?: string[] }, remote: Pick<RemoteStatus, 'addresses'> | undefined): boolean {
  const now = remote?.addresses.map((a) => a.url) ?? [];
  if (!now.length) return false;
  const had = info.addresses?.length ? info.addresses : [info.url];
  return now.length !== had.length || now.some((u, i) => u !== had[i]);
}

/** End a line with a full stop when it has none. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** One line on what the state means, for status lines. */
export function stateSentence(s: RemoteStatus): { word: string; tone: 'ok' | 'fault' | 'dim' | 'live'; rest: string } {
  if (s.state === 'on') {
    const out = outsideAddress(s);
    return out ? { word: 'On.', tone: 'ok', rest: `Phones and computers reach the hub at ${out.url}.` } : { word: 'On.', tone: 'ok', rest: 'Devices on the same network can connect.' };
  }
  if (s.state === 'starting' || s.state === 'installing') return { word: s.state === 'installing' ? 'Installing.' : 'Starting.', tone: 'live', rest: sentence(s.detail ?? 'Getting the tunnel ready') };
  if (s.state === 'error') return { word: 'Not working.', tone: 'fault', rest: s.error ?? 'Remote access stopped.' };
  const lan = s.addresses.find((a) => a.kind === 'lan');
  return lan
    ? { word: 'Off.', tone: 'dim', rest: 'Only devices on the same network can reach the hub.' }
    : { word: 'Off.', tone: 'dim', rest: 'Only this computer can reach the hub.' };
}

/**
 * The hub moved to a new address (a quick tunnel got a new one). When this
 * app talks to the old address it follows: an app with its own saved
 * connection switches over and reconnects; a page the old address served
 * offers a link to the new one, with the token, because the old one is about
 * to stop. In the desktop app that page goes there by itself, and the
 * desktop shell saves the new address.
 */
export function followMove(s: RemoteStatus, how: { notify: (newUrl: string, open: () => void) => void; reconnect: (conn: Connection) => void }): void {
  if (MOCK || !s.previousUrl || !s.url || s.state !== 'on') return;
  const conn = loadConnection();
  if (!conn) return;
  const old = s.previousUrl.replace(/\/+$/, '');
  if (conn.baseUrl.replace(/\/+$/, '') !== old) return;
  const next = s.url.replace(/\/+$/, '');
  if (location.origin === old) {
    const open = () => location.assign(`${next}/#token=${encodeURIComponent(conn.token)}`);
    // the desktop app goes by itself: its shell saves the new address when the page moves there with its token
    if (isDesktopApp()) open();
    else how.notify(next, open);
    return;
  }
  const moved = { ...conn, baseUrl: next };
  saveConnection(moved);
  how.reconnect(moved);
}

// ---------------------------------------------------------------------------
// Every address of the hub, for when the one in use stops answering
// ---------------------------------------------------------------------------

const ADDR_KEY = 'conclave.addresses';

/** A short tag for a token, so a saved list only applies to the hub it came from. */
function tag(token: string): string {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const trim = (u: string) => u.trim().replace(/\/+$/, '');

/** Keep the hub's addresses (best first) next to the saved connection. */
export function rememberAddresses(s: RemoteStatus | undefined): void {
  if (MOCK || !s) return;
  const conn = loadConnection();
  if (conn) keepAddresses(conn, s.addresses.map((a) => a.url));
}

/** Keep these addresses of the hub (best first) for the connection with this token: the pairing reply's list, or the remote status. */
export function keepAddresses(conn: Connection, urls: string[] | undefined): void {
  const list = (urls ?? []).map(trim).filter((u) => /^https?:\/\//.test(u));
  if (!list.length) return;
  try {
    localStorage.setItem(ADDR_KEY, JSON.stringify({ tag: tag(conn.token), urls: list }));
  } catch {
    /* private mode */
  }
}

/** Every address this hub gave, best first, for the saved connection's token. */
export function savedAddresses(conn: Connection): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ADDR_KEY) ?? 'null') as { tag?: string; urls?: unknown } | null;
    if (!raw || raw.tag !== tag(conn.token) || !Array.isArray(raw.urls)) return [];
    return raw.urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)).map(trim);
  } catch {
    return [];
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    if (!r.ok) return false;
    return (await r.json().catch(() => null))?.ok === true;
  } catch {
    return false;
  }
}

let lastTry = 0;
let trying = false;

/**
 * The live connection dropped. When the hub's address no longer answers, try
 * the other addresses it gave (the same network, your own URL, a stable
 * tunnel) and move to the first that does. A page that the old address served
 * cannot move (another origin, maybe plain http), and a quick tunnel address
 * never comes back, so then the owner is told to pair again. At most one try
 * every 15 seconds while the address is down.
 */
export async function recoverAddress(how: { reconnect: (conn: Connection) => void; lost: (host: string) => void }): Promise<void> {
  if (MOCK || trying || Date.now() - lastTry < 15_000) return;
  const conn = loadConnection();
  if (!conn) return;
  trying = true;
  try {
    const current = trim(conn.baseUrl);
    // the socket closed but the hub still answers (a restart, a closed tab): nothing to do, and no wait counted
    if (await answers(current)) return;
    lastTry = Date.now();
    const moved = await findOtherAddress(conn, false);
    if (moved) {
      how.reconnect(moved);
      return;
    }
    if (/\.trycloudflare\.com$/i.test(hostOf(current))) how.lost(hostOf(current));
  } finally {
    trying = false;
  }
}

/**
 * The first other saved address of this hub that answers, saved as the
 * connection. Undefined when none does, or when this page was served by the
 * address in use (it cannot call another origin with the token it has).
 * checkCurrent: return undefined when the address in use still answers.
 */
export async function findOtherAddress(conn: Connection, checkCurrent = true): Promise<Connection | undefined> {
  if (MOCK) return undefined;
  const current = trim(conn.baseUrl);
  if (checkCurrent && (await answers(current))) return undefined;
  for (const url of addressOrder(current, savedAddresses(conn), thisPage()).slice(1)) {
    if (!(await answers(url))) continue;
    const moved = { ...conn, baseUrl: url };
    saveConnection(moved);
    return moved;
  }
  return undefined;
}

/** This page, for addressOrder. The mock's page is not one a hub served, so it may use every address. */
export function thisPage(): { origin: string; protocol: string } {
  return MOCK ? { origin: '', protocol: location.protocol } : location;
}

/**
 * The addresses to try for a hub, in order: the one in use, then the others
 * it gave, best first, each once. A page the hub served stays on its own
 * address (another origin cannot use the token it has), and an https page
 * skips plain http ones (the browser blocks them).
 */
export function addressOrder(current: string, saved: string[], page: { origin: string; protocol: string }): string[] {
  const first = trim(current);
  if (trim(page.origin) === first) return [first];
  const out = [first];
  for (const raw of saved) {
    const url = trim(raw);
    if (!url || out.includes(url)) continue;
    if (page.protocol === 'https:' && url.startsWith('http:')) continue;
    out.push(url);
  }
  return out;
}
