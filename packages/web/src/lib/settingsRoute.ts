/**
 * Settings opens over the app on a computer (docs/design/SPEC.md 5.3), like
 * the Claude app's: /settings/... stays the address (deep links, reloads,
 * the back button), and the page that was open stays drawn under it. The
 * app's routes read the location through useAppLocation, which gives them
 * the last place outside Settings while Settings is open, so nothing under
 * the overlay changes or reloads. Phones open Settings as a page.
 *
 * Back from Settings goes to that place, however many sections were opened
 * on the way (the overlay's own nav replaces the address instead of adding
 * one); a deep link into Settings closes to Home. The bookkeeping is pure
 * (settingsMove) so test/settings-overlay.test.ts follows it.
 */
import { navigate as browserNavigate, useBrowserLocation, useSearch } from 'wouter/use-browser-location';
import { useIsMobile } from './hooks';

export const isSettingsPath = (path: string) => path === '/settings' || path.startsWith('/settings/');

export interface SettingsTrail {
  /** The last place outside Settings: path and search (with its "?"). */
  outside: { path: string; search: string };
  /** Entries Settings added to the history since it opened from that place; 0 for a deep link. */
  depth: number;
}

/** A move of the address: a push, a replace, or back or forward (pop). */
export type Move = { kind: 'push' | 'replace' | 'pop'; path: string; search: string };

/** The trail after a move. */
export function settingsMove(t: SettingsTrail, m: Move): SettingsTrail {
  if (!isSettingsPath(m.path)) return { outside: { path: m.path, search: m.search }, depth: 0 };
  if (m.kind === 'push') return { ...t, depth: t.depth + 1 };
  // back inside Settings: one entry fewer (forward is rare, and close never goes too far: it stops at 0)
  if (m.kind === 'pop') return { ...t, depth: Math.max(0, t.depth - 1) };
  return t;
}

/** The first trail: a start outside Settings is that place, a deep link into it has Home under it. */
export function startTrail(path: string, search: string): SettingsTrail {
  return isSettingsPath(path) ? { outside: { path: '/', search: '' }, depth: 0 } : { outside: { path, search }, depth: 0 };
}

let trail: SettingsTrail = typeof location === 'undefined' ? startTrail('/', '') : startTrail(location.pathname, location.search);

if (typeof window !== 'undefined') {
  const on = (kind: Move['kind']) => () => (trail = settingsMove(trail, { kind, path: location.pathname, search: location.search }));
  // added before wouter's own listeners (they subscribe when the app first renders), so the routes read the new trail
  window.addEventListener('pushState', on('push'));
  window.addEventListener('replaceState', on('replace'));
  window.addEventListener('popstate', on('pop'));
}

/** Where Settings closes to. */
export function outsideSettings(): string {
  return trail.outside.path + trail.outside.search;
}

/** Close Settings: back through what it added, or to Home after a deep link. */
export function closeSettings(): void {
  if (trail.depth > 0) history.go(-trail.depth);
  else browserNavigate(outsideSettings(), { replace: true });
}

/** The location the app's routes see: the place under Settings while it is open over the app. */
export function useAppLocation(): [string, typeof browserNavigate] {
  const [path] = useBrowserLocation();
  const phone = useIsMobile();
  return [!phone && isSettingsPath(path) ? trail.outside.path : path, browserNavigate];
}

/** The search the app's routes see, the same way. */
export function useAppSearch(): string {
  const [path] = useBrowserLocation();
  const search = useSearch();
  const phone = useIsMobile();
  return !phone && isSettingsPath(path) ? trail.outside.search : search;
}

/** For tests: start the trail over. */
export function resetTrail(path: string, search = ''): void {
  trail = startTrail(path, search);
}

/** For tests: the trail now. */
export function currentTrail(): SettingsTrail {
  return trail;
}
