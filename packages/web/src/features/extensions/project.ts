/**
 * The project folder picked in the Extensions header. Project scope changes
 * what loads (.claude/, .conclave/, .agents/, ...), so every Extensions view
 * and API call passes it as `cwd`. undefined means "No project". Kept for the
 * tab in sessionStorage so moving between tabs keeps the choice.
 *
 * A tab shown in a session's sheet (the "/" menu) takes the session's folder
 * through ExtCwdProvider instead, and leaves the picked one alone.
 */
import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';

const KEY = 'conclave.ext.cwd';
const listeners = new Set<() => void>();

function read(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

let current = read();

export function setExtCwd(cwd: string | undefined) {
  current = cwd || undefined;
  try {
    if (current) sessionStorage.setItem(KEY, current);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: keep it in memory */
  }
  for (const l of listeners) l();
}

const Override = createContext<{ cwd: string | undefined } | null>(null);

/** The tabs under it use this folder (a session's) instead of the one picked in Extensions. */
export function ExtCwdProvider({ cwd, children }: { cwd: string | undefined; children: ReactNode }) {
  return createElement(Override.Provider, { value: { cwd } }, children);
}

export function useExtCwd(): string | undefined {
  const override = useContext(Override);
  const picked = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return override ? override.cwd : picked;
}
