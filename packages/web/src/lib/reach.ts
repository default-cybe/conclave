/**
 * Reaching the saved hub when the app starts. The address in use comes
 * first, then the hub's other addresses (lib/remote.ts). One that answers
 * becomes the connection. A hub that answers nowhere is offline: the app
 * opens its shell with a banner and tries again with backoff until one
 * answers. An address that answers with another key is a stranger
 * (docs/design/HUB-LOGIN-AND-IDENTITY.md): nothing with the token in it
 * was sent, and the app says so on a screen of its own. So does a phone
 * that cannot check the key at all (no Ed25519 before iOS 17).
 */
import { create } from 'zustand';
import { ApiError, type HubInfo } from '@conclave/core/client';
import { probeClient, saveConnection, type Connection } from './api';
import { cannotCheckWords, isCannotCheckError, isHubIdentityError } from './identity';
import { addressOrder, hostOf, savedAddresses, thisPage } from './remote';

/** How long one address gets to answer. */
const ANSWER_MS = 8000;

/** The wait before try n (0 is the first retry): 2, 4, 8, 16, 32 seconds, then every minute. */
export function retryDelay(n: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, n));
}

export type Reached =
  | { kind: 'ok'; conn: Connection; hub: HubInfo }
  /** No address answered. */
  | { kind: 'offline' }
  /** An address answered with another key and none of the others answered. */
  | { kind: 'stranger'; address: string }
  /** The hub answered and refused the token (revoked, or the hub was reset). */
  | { kind: 'refused'; message: string }
  /** This platform cannot check the hub's key, so nothing was sent. */
  | { kind: 'unchecked'; message: string };

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Try the hub's addresses in order, or only `only` (the address the owner
 * picked on the stranger screen). The address that answers is saved
 * as the connection, with the hub's name, and with its key when the
 * connection had none yet (trust on first use, for apps paired before hubs
 * had keys).
 */
export async function reachHub(conn: Connection, only?: string): Promise<Reached> {
  const tried = new Set<string>();
  let stranger: string | undefined;
  const order = () => (only ? [only] : addressOrder(conn.baseUrl, savedAddresses(conn), thisPage()));
  // the list is read again after each try: the first one loads the mock in mock mode, which may add addresses
  for (let url: string | undefined = order()[0]; url; url = order().find((u) => !tried.has(u))) {
    tried.add(url);
    const at = { ...conn, baseUrl: url };
    try {
      const c = await probeClient(at.baseUrl, at.token, at.hubKey);
      const hub = await within(c.info(), ANSWER_MS);
      const key = at.hubKey ?? (await firstKey(at));
      const saved = { ...at, hubName: hub.name, ...(key ? { hubKey: key } : {}) };
      saveConnection(saved);
      return { kind: 'ok', conn: saved, hub };
    } catch (e) {
      if (isHubIdentityError(e)) stranger ??= url;
      else if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return { kind: 'refused', message: e.message };
      else if (isCannotCheckError(e)) return { kind: 'unchecked', message: cannotCheckWords(e) };
      // anything else (no answer, a tunnel's 502, a page that is not a hub): the next address
    }
  }
  return stranger ? { kind: 'stranger', address: stranger } : { kind: 'offline' };
}

/** The key the hub at this address proves it holds, kept from the first check. Undefined from a hub without keys, or where the check cannot run. */
async function firstKey(conn: Connection): Promise<string | undefined> {
  try {
    const c = await probeClient(conn.baseUrl);
    return (await within(c.checkIdentity(), ANSWER_MS)).publicKey;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Offline and stranger state, for the banner and the screen
// ---------------------------------------------------------------------------

interface ReachState {
  /** The saved hub did not answer at start. */
  offline?: {
    /** The hub's name, or its address. */
    label: string;
    /** When the next try starts. Undefined while a try runs. */
    nextAt?: number;
  };
  /** An address answered with another key, or (unchecked: the words to show) this phone cannot check the key. */
  stranger?: { address: string; unchecked?: string };
}

export const useReach = create<ReachState>(() => ({}));

/** "madx", or the address when the name is not known. */
export function hubLabel(conn: Connection): string {
  return conn.hubName || hostOf(conn.baseUrl) || conn.baseUrl;
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryNow: (() => void) | undefined;

/**
 * The hub did not answer at start: keep trying every address with backoff.
 * `back` runs once one answers (the banner clears then), `lost` when one
 * turns out to be a stranger or refuses the token. Returns a function that stops.
 */
export function keepTrying(conn: Connection, how: { back: (r: Extract<Reached, { kind: 'ok' }>) => void; lost: (r: Reached) => void }): () => void {
  let n = 0;
  let stopped = false;
  const label = hubLabel(conn);
  const schedule = () => {
    if (stopped) return;
    const wait = retryDelay(n++);
    useReach.setState({ offline: { label, nextAt: Date.now() + wait } });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(attempt, wait);
  };
  const attempt = async () => {
    if (stopped) return;
    clearTimeout(retryTimer);
    useReach.setState({ offline: { label } });
    const r = await reachHub(conn);
    if (stopped) return;
    if (r.kind === 'offline') return schedule();
    stop();
    if (r.kind === 'ok') how.back(r);
    else how.lost(r);
  };
  const stop = () => {
    stopped = true;
    clearTimeout(retryTimer);
    retryNow = undefined;
    useReach.setState({ offline: undefined });
  };
  retryNow = () => void attempt();
  schedule();
  return stop;
}

/** The banner's Retry: try now instead of waiting. */
export function retryHubNow() {
  retryNow?.();
}
