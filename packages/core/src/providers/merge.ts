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
 *
 * The same model is the same normalized id (modelKey): an account prefix
 * ("neu/claude-opus-5-5" on CLIProxyAPI) or a gateway's vendor prefix
 * ("anthropic/claude-opus-5-5" on OpenRouter) and case do not count, and
 * "4.5" reads as "4-5". A dated snapshot or a "-latest" id stays its own
 * model. Harnesses are other engines and local models run on the owner's
 * machines: both are left alone.
 */
import type { ModelEntry, ModelGroup } from '../client';
import { bareModel } from '../accounts/policy';
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

/** Providers whose models run on the owner's own machines: never the same as a hosted one. */
const LOCAL = new Set(['ollama', 'lmstudio']);
/** A vendor's own provider: it serves a bare id before a gateway does (registry searchBare). */
const HOME: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', gemini: 'google', zai: 'zai' };

/** What makes two entries the same model: the id without account or vendor prefix, lower case, "4.5" as "4-5". */
export function modelKey(id: string): string {
  return bareModel(id)
    .toLowerCase()
    .replace(/(?<=\d)\.(?=\d)/g, '-');
}

export interface MergeOptions {
  member?: boolean;
  /** The vendor of a model id neither the catalog nor its name tells: the vendor of a plan that lists it (a new model only a ChatGPT plan lists). */
  vendorOf?: (model: string) => string | undefined;
}

interface Spot {
  m: ModelEntry;
  provider: string;
  /** Group and entry index: the hub's order, the last tie break. */
  at: number;
}

/**
 * Mark the duplicates. `routeOf` gives the owner's order for a bare model
 * id (accounts/service.ts routeOf), undefined where no order applies. The
 * entry pickers show is the first route's in that order (its bare id; an
 * account prefix names one plan and is a choice, not the route). With no
 * order: an entry on a usable provider, the vendor's own provider first,
 * then a bare id, then the hub's order. Every other entry of the model
 * points at it with sameAs, and it lists them all in refs, so a session
 * or agent that names any of them still finds it, and a picker can offer
 * a single account or provider as a choice. Groups are copied, never
 * changed in place.
 */
export function mergeModelGroups(groups: ModelGroup[], routeOf: (model: string) => RouteStep[] | undefined, opts: MergeOptions = {}): ModelGroup[] {
  const usable = new Set(groups.filter((g) => g.enabled && g.configured && g.type !== 'acp').map((g) => g.provider));
  const clusters = new Map<string, Spot[]>();
  let at = 0;
  for (const g of groups) {
    if (g.type === 'acp' || LOCAL.has(g.provider)) continue;
    for (const m of g.models) {
      const key = modelKey(m.id);
      const list = clusters.get(key) ?? [];
      if (!list.some((s) => s.m.ref === m.ref)) list.push({ m, provider: g.provider, at: at++ });
      clusters.set(key, list);
    }
  }
  const marks = new Map<string, Partial<ModelEntry>>();
  for (const spots of clusters.values()) {
    // the bare id the order and the registry know: an entry's own id without a slash, else the first one's without its prefix
    const id = spots.find((s) => !s.m.id.includes('/'))?.m.id ?? bareModel(spots[0].m.id);
    const vendor = vendorOfModel(id);
    const listedVendor = vendor ? undefined : opts.vendorOf?.(id);
    // a provider that does not list the bare id never gets the call (the registry's serves())
    const bareOn = (p: string) => spots.find((s) => s.provider === p && s.m.id === id);
    const all = vendor ? routeOf(id) : undefined;
    const steps = (all ?? []).filter((s) => usable.has(s.provider) && bareOn(s.provider));
    const rank = (s: Spot) => [usable.has(s.provider) ? 0 : 1, vendor && HOME[vendor] === s.provider ? 0 : 1, s.m.id.includes('/') ? 1 : 0, s.at];
    const byRank = (a: Spot, b: Spot) => {
      const x = rank(a);
      const y = rank(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    };
    const keep = steps.length ? bareOn(steps[0].provider)! : [...spots].sort(byRank)[0];
    const others = spots.filter((s) => s !== keep).sort((a, b) => a.at - b.at);
    // a ref that names a route of its own: one plan's prefix, or a provider outside the order (a ref on a provider in it
    // still follows the order, registry routed()). Only usable ones: a choice that cannot answer is no choice
    const inOrder = new Set((all ?? []).map((s) => s.provider));
    const choices = others.filter((s) => usable.has(s.provider) && (s.m.id.includes('/') || !inOrder.has(s.provider))).map((s) => s.m.ref);
    const mark: Partial<ModelEntry> = {
      ...(steps.length && vendor ? { via: routeWords(steps, vendor, opts) } : {}),
      ...(others.length ? { refs: [keep.m.ref, ...others.map((s) => s.m.ref)] } : {}),
      ...(choices.length ? { choices } : {}),
      ...(listedVendor ? { vendor: listedVendor } : {}),
    };
    if (Object.keys(mark).length) marks.set(keep.m.ref, mark);
    for (const s of others) marks.set(s.m.ref, { sameAs: keep.m.ref, ...(listedVendor ? { vendor: listedVendor } : {}) });
  }
  if (!marks.size) return groups;
  return groups.map((g) => (g.models.some((m) => marks.has(m.ref)) ? { ...g, models: g.models.map((m) => (marks.has(m.ref) ? { ...m, ...marks.get(m.ref) } : m)) } : g));
}

/** The ref a picker shows for a stored one: the entry it points at, else itself. */
export function shownRef(groups: ModelGroup[], ref: string): string {
  for (const g of groups) for (const m of g.models) if (m.ref === ref) return m.sameAs ?? ref;
  return ref;
}
