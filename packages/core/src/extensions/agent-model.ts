/**
 * The model an agent profile, a Task call or a workflow step runs on, for one
 * session (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2 item 1). Wraps
 * resolveModelRef with what the engine knows: which providers are set up and
 * the catalog's tiers.
 *
 * - fast: models.tiers.fast, else smallModel.
 * - smart: models.tiers.smart, else the session's model.
 * - deep: models.tiers.deep, else the cheapest deep-tier catalog model of a
 *   configured provider (the session model's provider first, newest on a
 *   tie), else claude-code/opus when that harness is set up, else the
 *   session's model.
 * - "provider/model" and ACP refs pass through when usable.
 */
import type { ConclaveConfig } from '../config/schema';
import { catalogEntries, familyForProvider, findCatalogEntry } from '../providers/catalog';
import { resolveModelRef, tierOf, type ResolvedModelRef } from './model-ref';

/** What the resolver needs from the engine. Engine satisfies it. */
export interface ModelHost {
  config: { get(): ConclaveConfig };
  isUsable(ref: string): boolean;
  /** For ACP harnesses: whether the command is found (providers/registry.ts). */
  providers?: { isConfigured(providerId: string): boolean };
}

/** isUsable, plus for an ACP harness its command must be found: a tier never lands on a harness that is not installed. */
function usable(host: ModelHost, ref: string): boolean {
  if (!host.isUsable(ref)) return false;
  const id = providerOf(ref);
  const p = id ? host.config.get().providers?.[id] : undefined;
  if (p?.type === 'acp' && host.providers) return host.providers.isConfigured(id!);
  return true;
}

function providerOf(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const i = ref.indexOf('/');
  return i > 0 ? ref.slice(0, i) : undefined;
}

/**
 * The deep-tier model to use when models.tiers.deep is unset. Providers are
 * tried in order: the session model's, the default model's, then the rest as
 * configured. ACP harnesses are skipped here (resolveModelRef offers
 * claude-code/opus after this).
 */
export function deepTierModel(host: ModelHost, sessionModel: string): string | undefined {
  const cfg = host.config.get();
  const order = [providerOf(sessionModel), providerOf(cfg.defaultModel), ...Object.keys(cfg.providers ?? {})].filter((p, i, all): p is string => !!p && all.indexOf(p) === i);
  for (const id of order) {
    const p = cfg.providers?.[id];
    if (!p || p.type === 'acp' || p.enabled === false) continue;
    // a provider that lists its models: the first listed deep one
    const listed = (p.models ?? []).filter((m) => findCatalogEntry(m)?.tier === 'deep');
    for (const m of listed) if (usable(host, `${id}/${m}`)) return `${id}/${m}`;
    if (p.models?.length) continue;
    const fam = familyForProvider(p.type, p.baseUrl);
    if (!fam || fam === 'any') continue;
    const deep = catalogEntries(fam).filter((e) => e.tier === 'deep' && !e.responsesOnly);
    if (!deep.length) continue;
    // the cheapest deep model; catalog order is newest first, so a tie keeps the newer one
    const pick = deep.reduce((best, e) => (e.outputPrice < best.outputPrice ? e : best), deep[0]);
    const ref = `${id}/${pick.id}`;
    if (usable(host, ref)) return ref;
  }
  return undefined;
}

/** Resolve a model word for a session whose model is `sessionModel`. */
export function agentModelRef(host: ModelHost, ref: string | undefined, sessionModel: string): ResolvedModelRef {
  const config = host.config.get();
  // deep without a configured tier: the catalog's pick, even when it is also the default model
  if (tierOf(ref) === 'deep') {
    const set = config.models?.tiers?.deep;
    if (!(set && usable(host, set))) {
      const deep = deepTierModel(host, sessionModel);
      if (deep) return { model: deep, tier: 'deep' };
    }
  }
  return resolveModelRef(ref, { config, sessionModel, isUsable: (r) => usable(host, r) });
}

/**
 * A subagent's model: the caller's override when it resolves to a usable
 * model, else the agent profile's model or tier, else the parent's model.
 */
export function subagentModel(host: ModelHost, override: string | undefined, agentModel: string | undefined, parentModel: string): string {
  if (override) {
    const r = agentModelRef(host, override, parentModel);
    if (!r.note) return r.model;
  }
  return agentModelRef(host, agentModel, parentModel).model;
}
