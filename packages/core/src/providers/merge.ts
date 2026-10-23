/**
 * One entry per model in the pickers. The owner's Claude plan (through
 * CLIProxyAPI, provider cliproxy) and their API key (provider anthropic)
 * both list claude-opus-5-5, and the same goes for ChatGPT and Gemini.
 * Calls already follow the owner's order of plans and keys (the registry's
 * routing, accounts/service.ts), so a picker needs the model once: the
 * entry of the first route that lists it, with the route in words ("your
 * Claude plan, then API key"). The other entries stay in their groups for
 * Settings and point at it with sameAs, so a session or agent that names
 * one of them still finds its entry. A member sees only the routes they may
 * use (docs/design/ACCOUNTS.md 6).
 */
import type { ModelEntry, ModelGroup } from '../client';
import { vendorName, vendorOfModel } from '../accounts/vendors';

export interface RouteStep {
  provider: string;
  kind: 'subscription' | 'api';
}

/**
 * The route in words: "your Claude plan, then API key". Steps on the same
 * provider and kind in a row read as one ("your Claude plans"). A member is
 * told the plans are the hub's.
 */
export function routeWords(steps: RouteStep[], vendor: string, opts: { member?: boolean } = {}): string {
  const runs: Array<{ step: RouteStep; n: number }> = [];
  for (const s of steps) {
    const last = runs[runs.length - 1];
    if (last && last.step.provider === s.provider && last.step.kind === s.kind) last.n++;
    else runs.push({ step: s, n: 1 });
  }
  const whose = opts.member ? "the hub's" : 'your';
  return runs.map(({ step, n }) => (step.kind === 'api' ? 'API key' : `${whose} ${vendorName(vendor)} plan${n > 1 ? 's' : ''}`)).join(', then ');
}

/**
 * Mark the duplicates. `routeOf` gives the owner's order for a bare model
 * id (accounts/service.ts routeOf), undefined where no order applies. Only
 * groups that are on and usable for the caller count as routes; an entry
 * on a provider in the order that the caller may not use, or one on a
 * provider with no key, points at the entry too. Groups are copied, never
 * changed in place.
 */
export function mergeModelGroups(groups: ModelGroup[], routeOf: (model: string) => RouteStep[] | undefined, opts: { member?: boolean } = {}): ModelGroup[] {
  const usable = new Set(groups.filter((g) => g.enabled && g.configured && g.type !== 'acp').map((g) => g.provider));
  // where each bare model id is listed: provider -> its entry
  const listed = new Map<string, Map<string, ModelEntry>>();
  for (const g of groups) {
    if (!g.enabled || g.type === 'acp') continue;
    for (const m of g.models) {
      if (m.id.includes('/')) continue;
      const at = listed.get(m.id) ?? new Map<string, ModelEntry>();
      if (!at.has(g.provider)) at.set(g.provider, m);
      listed.set(m.id, at);
    }
  }
  const marks = new Map<string, Partial<ModelEntry>>();
  for (const [id, at] of listed) {
    const all = routeOf(id);
    const vendor = vendorOfModel(id);
    if (!all?.length || !vendor) continue;
    // a provider that does not list the model never gets the call (the registry's serves())
    const steps = all.filter((s) => usable.has(s.provider) && at.has(s.provider));
    if (!steps.length) continue;
    const keep = at.get(steps[0].provider)!;
    const inOrder = new Set(all.map((s) => s.provider));
    // the same model on a later route, on a provider the caller may not use, or on one with no key
    const same = [...at.entries()].filter(([p]) => p !== steps[0].provider && (inOrder.has(p) || !usable.has(p))).map(([, m]) => m.ref);
    marks.set(keep.ref, { via: routeWords(steps, vendor, opts), ...(same.length ? { refs: [keep.ref, ...same] } : {}) });
    for (const ref of same) marks.set(ref, { sameAs: keep.ref });
  }
  if (!marks.size) return groups;
  return groups.map((g) => (g.models.some((m) => marks.has(m.ref)) ? { ...g, models: g.models.map((m) => (marks.has(m.ref) ? { ...m, ...marks.get(m.ref) } : m)) } : g));
}

/** The ref a picker shows for a stored one: the entry it points at, else itself. */
export function shownRef(groups: ModelGroup[], ref: string): string {
  for (const g of groups) for (const m of g.models) if (m.ref === ref) return m.sameAs ?? ref;
  return ref;
}
