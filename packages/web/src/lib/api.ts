/** Hub connection: settings in localStorage, the shared client, #token= handling. */
import { ConclaveClient, type AccountRef } from '@conclave/core/client';
import { reportHubError } from './identity';
import { logRequestFailure, startClientLog } from './clientLog';

export const MOCK = import.meta.env.VITE_MOCK === '1';

const KEY = 'conclave.connection';

export interface Connection {
  baseUrl: string;
  token: string;
  /** The hub's public key (PairResult.identity.publicKey). The client proves the hub holds it before it sends the token. */
  hubKey?: string;
  /** The hub's name when it last answered, for the offline banner. */
  hubName?: string;
  /** Who this token signs in as (docs/design/ACCOUNTS.md). Missing: the owner, or a hub from before accounts. */
  account?: AccountRef;
  /** The paired app's id, so Sign out can end it on the hub. */
  clientId?: string;
}

let client: ConclaveClient | null = null;
let wsImpl: typeof WebSocket | undefined;

export function api(): ConclaveClient {
  if (!client) throw new Error('Not connected');
  return client;
}

export function webSocketImpl() {
  return wsImpl;
}

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Connection;
    return c.token ? c : null;
  } catch {
    return null;
  }
}

export function saveConnection(c: Connection) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode: keep it in memory only */
  }
  void idbSet('auth', c).catch(() => {});
}

/** Resolves once the service worker's copy of the token is gone too. */
export function clearConnection(): Promise<void> {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  client = null;
  return idbSet('auth', null).catch(() => {});
}

/** Accept #token=...&hub=... once, save it, then strip it from the URL. */
export function consumeHashToken(): Connection | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.includes('token=')) return null;
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  if (!token) return null;
  const conn = { baseUrl: params.get('hub') || window.location.origin, token };
  saveConnection(conn);
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return conn;
}

/**
 * The address without ?connect, which opens the Connect screen even with a
 * sign in kept (Sign out, Add account, Connect again). Once signed in it
 * must go, or a reload shows Connect again as if signed out. Undefined when
 * there is none.
 */
export function withoutConnectParam(path: string, search: string, hash: string): string | undefined {
  const q = new URLSearchParams(search);
  if (!q.has('connect')) return undefined;
  q.delete('connect');
  const rest = q.toString();
  return `${path}${rest ? `?${rest}` : ''}${hash}`;
}

export async function connectClient(conn: Connection): Promise<ConclaveClient> {
  if (MOCK) {
    const mock = await import('../mock');
    client = watch(new ConclaveClient({ baseUrl: conn.baseUrl, token: conn.token, hubKey: conn.hubKey, fetch: mock.mockFetch }));
    wsImpl = mock.MockWebSocket as unknown as typeof WebSocket;
    startClientLog((b) => api().sendClientLogs(b));
    return client;
  }
  client = watch(new ConclaveClient({ baseUrl: conn.baseUrl, token: conn.token, hubKey: conn.hubKey }));
  wsImpl = undefined;
  // what this app reports about itself goes to the hub's log files (lib/clientLog.ts)
  startClientLog((b) => api().sendClientLogs(b));
  return client;
}

/** A throwaway client for pairing, logging in and token checks before saving. */
export async function probeClient(baseUrl: string, token?: string, hubKey?: string): Promise<ConclaveClient> {
  if (MOCK) {
    const mock = await import('../mock');
    return new ConclaveClient({ baseUrl, token, hubKey, fetch: mock.mockFetch });
  }
  return new ConclaveClient({ baseUrl, token, hubKey });
}

/** Every request of the app's client passes a HubIdentityError on to the app, which then shows the full screen state. */
function watch(c: ConclaveClient): ConclaveClient {
  const request = c.request.bind(c);
  c.request = <T>(method: string, path: string, body?: unknown, query?: Parameters<ConclaveClient['request']>[3]) =>
    request<T>(method, path, body, query).catch((e: unknown) => {
      reportHubError(e);
      logRequestFailure(method, path, e);
      throw e;
    });
  return c;
}

// ---------------------------------------------------------------------------
// IndexedDB key/value, shared with the service worker (approval actions)
// ---------------------------------------------------------------------------

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('conclave', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbGet(key: string): Promise<unknown> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

/** Rejects when the write did not land: a full disk aborts the transaction, a value that cannot be cloned throws. */
export async function idbSet(key: string, value: unknown) {
  const db = await idb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === null) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

/** Delete every key that starts with the prefix. */
export async function idbDropPrefix(prefix: string) {
  const db = await idb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
  });
}
