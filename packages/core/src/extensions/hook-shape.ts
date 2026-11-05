/**
 * Read a hooks config by hand-edited or foreign rules: an event can hold an
 * object, a string or null instead of a list, and a group can lack its hooks
 * list. Readers go through these helpers so one malformed entry is skipped
 * instead of throwing (hook-lint.ts reports it).
 */
import type { HookEvent, HookMatcher, HooksConfig } from '../config/schema';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The well-formed groups of one event: objects with a hooks list, keeping only object handlers. Anything else is []. */
export function hookGroupsOf(list: unknown): HookMatcher[] {
  if (!Array.isArray(list)) return [];
  const out: HookMatcher[] = [];
  for (const g of list) {
    if (!isObj(g) || !Array.isArray(g.hooks)) continue;
    const hooks = g.hooks.filter(isObj) as unknown as HookMatcher['hooks'];
    out.push(hooks.length === g.hooks.length ? (g as unknown as HookMatcher) : ({ ...g, hooks } as unknown as HookMatcher));
  }
  return out;
}

/** The whole config with malformed events and groups left out. */
export function cleanHooks(raw: unknown): HooksConfig {
  if (!isObj(raw)) return {};
  const out: HooksConfig = {};
  for (const [event, list] of Object.entries(raw)) {
    const groups = hookGroupsOf(list);
    if (groups.length) out[event as HookEvent] = groups;
  }
  return out;
}

/** An event value that is an empty object, null or an empty list: no hooks, not a problem. */
export function isEmptyEvent(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
}

/**
 * A list saved as an object keyed by position ({"0": {...}, "6": {...}}), as a
 * path-style write like hooks.PreToolUse[6].hooks[0].command leaves it. Returns
 * the list it meant, or undefined when the value is not such an object.
 */
export function listFromIndexed(v: unknown): unknown[] | undefined {
  if (!isObj(v)) return undefined;
  const keys = Object.keys(v);
  if (!keys.length || !keys.every((k) => /^\d+$/.test(k))) return undefined;
  return keys.sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
}
