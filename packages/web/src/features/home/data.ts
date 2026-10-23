/**
 * What Home needs beyond the store: plan steps of running sessions and
 * today's routine runs, fetched through the typed client, and the hub's
 * name and state while it is offline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Todo } from '@conclave/core/types';
import { api, loadConnection } from '@/lib/api';
import { useReach } from '@/lib/reach';
import { hostOf } from '@/lib/remote';
import { loadRuns, useHub } from '@/store/store';
import type { Offline } from './status';

/** The hub's name. Offline at start the hub has not answered yet: the banner's name for it, else the saved one. */
export function useHubName(): string {
  const hub = useHub((s) => s.hub?.name);
  const offlineName = useReach((s) => s.offline?.label);
  return hub || offlineName || loadConnection()?.hubName || hostOf(loadConnection()?.baseUrl) || 'hub';
}

/** Set while the hub does not answer: its name, and when the counts were last good (none if this app never had them). */
export function useOffline(): Offline | undefined {
  const name = useHubName();
  const closed = useHub((s) => s.conn === 'closed');
  const at = useHub((s) => (s.booted ? s.syncedAt : undefined));
  return useMemo(() => (closed ? { name, at } : undefined), [closed, name, at]);
}

/**
 * Plan steps (todos) for sessions the store has not loaded yet. Store todos
 * win when present because they update live.
 */
export function useTodos(sessionIds: string[]): Record<string, Todo[] | undefined> {
  const storeTodos = useHub((s) => s.todos);
  const [fetched, setFetched] = useState<Record<string, Todo[]>>({});
  const asked = useRef(new Set<string>());
  const key = sessionIds.join(',');
  useEffect(() => {
    for (const id of sessionIds) {
      if (asked.current.has(id) || storeTodos[id]) continue;
      asked.current.add(id);
      api()
        .todos(id)
        .then((list) => setFetched((f) => ({ ...f, [id]: list })))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const out: Record<string, Todo[] | undefined> = {};
    for (const id of sessionIds) out[id] = storeTodos[id] ?? fetched[id];
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, storeTodos, fetched]);
}

/** "4 of 5" and the active step's words, from a plan. */
export function planStep(todos: Todo[] | undefined): { index: number; total: number; text?: string } | undefined {
  if (!todos?.length) return undefined;
  const active = todos.findIndex((t) => t.status === 'in_progress');
  const done = todos.filter((t) => t.status === 'completed').length;
  if (active >= 0) return { index: active + 1, total: todos.length, text: todos[active].activeForm ?? todos[active].content };
  return { index: Math.min(todos.length, done), total: todos.length };
}

/** Load the runs of every enabled routine once, so today's axis has its marks. */
export function useRoutineRuns() {
  const routines = useHub((s) => s.routines);
  const runs = useHub((s) => s.runs);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const r of Object.values(routines)) {
      if (!r.enabled || runs[r.id] || asked.current.has(r.id)) continue;
      asked.current.add(r.id);
      void loadRuns(r.id);
    }
  }, [routines, runs]);
  return runs;
}
