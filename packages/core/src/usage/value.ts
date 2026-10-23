/**
 * What a call is worth at API prices (docs/DESIGN.md, Usage and costs).
 *
 * A signed in plan (a provider with config.subscription, such as the hub's
 * CLIProxyAPI accounts) bills nothing per token, so its rows cost $0. The
 * tokens and the model's API prices are still known: the same tokens priced
 * with the catalog's rates (input, output, cache read, cache write, 1 hour
 * write) are what the call would have cost on an API key. For a key the
 * value is what was billed.
 */
import type { ConclaveConfig } from '../config/schema';
import { computeCost, lookupModel } from '../providers/catalog';
import type { Usage } from '../types';

export interface ValueRow {
  provider: string;
  model: string;
  /** models.accounts id that served it. */
  account?: string;
  costUsd: number;
}

/**
 * True when a plan served the call: its provider bills as a subscription and
 * no price override names the model (an override is the price the owner
 * pays), or the account that served it is a signed in plan.
 */
export function isPlanCall(config: Pick<ConclaveConfig, 'providers' | 'models'>, row: Pick<ValueRow, 'provider' | 'model' | 'account'>): boolean {
  const cfg = config.providers?.[row.provider];
  if (cfg?.subscription && !cfg.modelOverrides?.[row.model]) return true;
  if (!row.account) return false;
  return (config.models?.accounts ?? []).some((a) => a.id === row.account && a.kind === 'subscription');
}

/** The tokens of a call at the model's API prices from the catalog, ignoring the plan's zero prices. */
export function catalogCost(provider: string, model: string, usage: Usage, type?: string): number {
  // "neu/claude-opus-5-5" is the same model from a second account (providers/split.ts splitAccount)
  const bare = model.slice(model.lastIndexOf('/') + 1);
  const info = lookupModel(provider, bare, type === 'anthropic' || type === 'openai' || type === 'gemini' ? { type } : {});
  return computeCost(info, usage);
}

/** The API value of a call: the catalog price for a plan (never less than billed), what was billed otherwise. */
export function apiValueOf(config: Pick<ConclaveConfig, 'providers' | 'models'>, row: ValueRow, usage: Usage): number {
  if (!isPlanCall(config, row)) return row.costUsd;
  const value = catalogCost(row.provider, row.model, usage, config.providers?.[row.provider]?.type);
  return Number.isFinite(value) && value > row.costUsd ? value : row.costUsd;
}
