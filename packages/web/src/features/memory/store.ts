/**
 * Memory connections, loaded once and shared by the Memory tabs (the store
 * line under the title, the Notes meta lines, the Connections list). Reloads
 * after every change and when the hub config changes.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { ApiError, type MemoryConnectionInfo } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useHub } from '@/store/store';

interface ConnState {
  list?: MemoryConnectionInfo[];
  error?: string;
  loading: boolean;
}

export const useConnections = create<ConnState>(() => ({ loading: false }));

/** Shown instead of an error when the hub predates memory connections (the route is a 404). */
export const OLD_HUB = 'This hub is older and has no memory connections. Update the hub to connect other stores. Notes still work.';

let inflight: Promise<void> | null = null;
let again = false;

/**
 * Load the list. A call while a load is running asks for one more load after
 * it, so a reload right after a change never ends on a list read before it.
 */
export function reloadConnections(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  useConnections.setState({ loading: true });
  inflight = api()
    .memoryConnections()
    .then((list) => useConnections.setState({ list, error: undefined }))
    .catch((e) => useConnections.setState({ error: e instanceof ApiError && e.status === 404 ? OLD_HUB : e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      useConnections.setState({ loading: false });
      inflight = null;
    })
    .then(() => {
      if (!again) return;
      again = false;
      return reloadConnections();
    });
  return inflight;
}

/**
 * Reload the notes. The hub sends an event per note for small changes only;
 * after a big sync or import it expects clients to fetch the list again.
 */
export async function reloadMemories(): Promise<void> {
  try {
    const list = await api().memories({ limit: 500 });
    useHub.setState({ memories: Object.fromEntries(list.map((m) => [m.id, m])) });
  } catch {
    /* the events already applied are kept */
  }
}

/** Put a changed connection in the list at once, before the reload. */
export function upsertConnection(c: MemoryConnectionInfo) {
  const list = useConnections.getState().list ?? [];
  const i = list.findIndex((x) => x.id === c.id);
  useConnections.setState({ list: i >= 0 ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c] });
}

export function dropConnection(id: string) {
  useConnections.setState((s) => ({ list: s.list?.filter((x) => x.id !== id) }));
}

/** Load on mount and after config.updated (configVersion moves on every reload). */
export function useConnectionList() {
  const version = useHub((s) => s.configVersion);
  const conn = useHub((s) => s.conn);
  useEffect(() => {
    if (conn === 'closed') return;
    void reloadConnections();
  }, [version, conn]);
  return useConnections();
}

/** Display name of a connection id, for "from Basic Memory" on imported notes. A removed connection reads "notes, removed". */
export function connectionName(list: MemoryConnectionInfo[] | undefined, id: string): string {
  const c = list?.find((x) => x.id === id);
  if (c) return c.name;
  return list ? `${id}, a removed connection` : id;
}
