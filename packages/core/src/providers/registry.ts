import type { ModelGroup } from '../client';
import type { ConfigStore } from '../config';
import type { ProviderConfig } from '../config/schema';
import type { Usage } from '../types';
import { AnthropicProvider } from './anthropic';
import {
  catalogEntries,
  computeCost,
  familyForProvider,
  findCatalogEntry,
  lookupModel,
  refreshPricingFromLiteLLM,
  type ModelFamily,
} from './catalog';
import type { ProviderOptions } from './common';
import { EFFORTS, modelEffort, type Effort, type EffortWire } from './effort';
import { retiredAlias } from './access-programs';
import { GeminiProvider } from './gemini';
import { hostOf, type FetchFn } from './http';
import { OpenAIProvider } from './openai';
import { OpenAIResponsesProvider } from './openai-responses';
import { SplitWireProvider, splitAccount, wirePattern } from './split';
import { parseModelRef, type ModelInfo, type Provider } from './types';

/** How a provider's request carries thinking for a model (providers/effort.ts). */
export function effortWire(cfg: ProviderConfig, model: string): EffortWire {
  if (cfg.type === 'acp') return 'harness';
  if (cfg.type === 'gemini') return 'gemini';
  if (cfg.type === 'anthropic') return 'anthropic';
  if (cfg.anthropicWire?.models.some((g) => wirePattern(g).test(model))) return 'anthropic';
  const host = hostOf(cfg.baseUrl);
  if (host.endsWith('openrouter.ai')) return 'openrouter';
  if (/(^|\.)z\.ai$|bigmodel\.cn$|deepseek\.com$/.test(host)) return 'switch';
  if (/dashscope|aliyuncs\.com$/.test(host)) return 'dashscope';
  return 'openai';
}

/** Levels a harness offered for one of its models ("claude-code/opus"), learned from its own Effort option. */
export type HarnessEffortLookup = (ref: string) => Effort[] | undefined;

/** The models a harness's account offered the last time it was asked (acp/adapter.ts harnessModels). */
export type HarnessModelsLookup = (harness: string) => Array<{ id: string; name?: string }> | undefined;

export interface ResolvedModel {
  provider: string;
  model: string;
  info: ModelInfo;
  /** The provider is an external harness spoken to over ACP. */
  acp: boolean;
}

/**
 * The owner's account order (accounts/service.ts): provider ids for a model,
 * those with a usable account first. Undefined when no order applies.
 */
export interface AccountRouting {
  providersFor(model: string): string[] | undefined;
}

export interface RegistryOptions {
  /** Injected for tests. */
  fetch?: FetchFn;
  /** How long model listings are cached. */
  modelsTtlMs?: number;
  /** Max wait for one provider's model listing in groups(). */
  listTimeoutMs?: number;
  /** The key for a provider, instead of the hub's (a member's registry, docs/design/ACCOUNTS.md 6). */
  apiKey?: (providerId: string) => string | undefined;
  /** Whether this registry may use a provider at all (a member's: own key, or the owner allowed the hub's). */
  allowed?: (providerId: string) => boolean;
  /**
   * Entries this registry serves its own way, over the hub's of the same id
   * (a member's own signed in plans, people/plans.ts): their config, and the
   * provider for it, given the one the hub's entry makes (on the hub's key).
   */
  overlay?: RegistryOverlay;
}

export interface RegistryOverlay {
  configs(): Record<string, ProviderConfig>;
  make(providerId: string, cfg: ProviderConfig, hub: Provider | undefined): Provider | undefined;
}

const CLAUDE_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

/** Preference order for the "deep" alias. */
const DEEP_ORDER = ['claude-opus-5-5', 'gpt-5.5', 'gemini-3.1-pro-preview', 'glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'qwen3.8-max'];

/** Default provider ids that should win when several serve the same family. */
const FAMILY_HOME: Partial<Record<ModelFamily, string>> = { anthropic: 'anthropic', openai: 'openai', gemini: 'google', zai: 'zai' };

export function createProvider(id: string, cfg: ProviderConfig, deps: Omit<ProviderOptions, 'id' | 'config'> = {}): Provider | undefined {
  const opts: ProviderOptions = { id, config: cfg, ...deps };
  switch (cfg.type) {
    case 'anthropic':
      return new AnthropicProvider(opts);
    case 'openai':
      if (cfg.anthropicWire?.baseUrl && cfg.anthropicWire.models?.length) return new SplitWireProvider(opts);
      return cfg.responsesApi ? new OpenAIResponsesProvider(opts) : new OpenAIProvider(opts);
    case 'gemini':
      return new GeminiProvider(opts);
    default:
      return undefined;
  }
}

/** A server on this machine or the local network: it takes no key (Ollama, LM Studio, CLIProxyAPI). */
export function isLocalUrl(url: string | undefined): boolean {
  const h = hostOf(url);
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h)
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Builds providers from config on demand, resolves model refs and aliases,
 * lists models per provider and prices usage. Providers are rebuilt after any
 * config or secret change.
 */
export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  private listings = new Map<string, { at: number; models: ModelInfo[] }>();
  private unsubscribe: () => void;
  private routing?: AccountRouting;
  private harnessEffort?: HarnessEffortLookup;
  private harnessModels?: HarnessModelsLookup;

  constructor(
    private readonly config: ConfigStore,
    private readonly opts: RegistryOptions = {},
  ) {
    this.unsubscribe = config.onChange(() => {
      this.cache.clear();
      this.listings.clear();
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Follow the owner's account order: subscription first, API key last (accounts/service.ts). */
  setRouting(routing: AccountRouting | undefined): void {
    this.routing = routing;
  }

  /** Where harness models find the levels their harness offered (engine.noteHarnessEffort). */
  setHarnessEffort(lookup: HarnessEffortLookup | undefined): void {
    this.harnessEffort = lookup;
  }

  /** Where a harness's group finds the models its account offered (engine.noteHarnessModels). */
  setHarnessModels(lookup: HarnessModelsLookup | undefined): void {
    this.harnessModels = lookup;
  }

  /**
   * A harness's models: the configured list (the static fallback, "default"
   * when empty), then each model the harness reported that is not in it, by
   * the name the harness gave when no catalog knows the id.
   */
  private harnessGroupModels(id: string, cfg: ProviderConfig): ModelInfo[] {
    const base = cfg.models?.length ? cfg.models : ['default'];
    const out = base.map((m) => this.info(id, m));
    for (const m of this.harnessModels?.(id) ?? []) {
      if (base.includes(m.id)) continue;
      const info = this.info(id, m.id);
      out.push(m.name && info.name === m.id ? { ...info, name: m.name } : info);
    }
    return out;
  }

  /** The model with the Effort levels it offers on this provider (ModelInfo.effort). */
  private withEffort(provider: string, info: ModelInfo): ModelInfo {
    const cfg = this.providerConfigs()[provider];
    if (!cfg) return info;
    if (cfg.type === 'acp') {
      const levels = this.harnessEffort?.(`${provider}/${info.id}`);
      return levels?.length ? { ...info, effort: { levels, off: false } } : info;
    }
    // an account prefix ("neu/claude-opus-5-5") is the same model
    const bare = splitAccount(info.id).model;
    // a plan that names the levels it takes (a ChatGPT plan's model list, up to ultra) wins over the rules
    const meta = cfg.modelMeta?.[bare];
    const levels = (meta?.efforts ?? []).filter((l): l is Effort => (EFFORTS as readonly string[]).includes(l));
    if (levels.length) {
      const def = meta?.defaultEffort && (levels as string[]).includes(meta.defaultEffort) ? (meta.defaultEffort as Effort) : undefined;
      return { ...info, thinking: true, effort: { levels, off: false, ...(def ? { default: def } : {}) } };
    }
    const effort = modelEffort(bare, info.thinking, effortWire(cfg, info.id));
    return effort ? { ...info, effort } : info;
  }

  private providerConfigs(): Record<string, ProviderConfig> {
    const hub = this.config.get().providers;
    const own = this.opts.overlay?.configs();
    return own && Object.keys(own).length ? { ...hub, ...own } : hub;
  }

  /** Provider instance, or undefined for unknown and ACP providers. */
  get(providerId: string): Provider | undefined {
    const hit = this.cache.get(providerId);
    if (hit) return hit;
    const own = this.opts.overlay?.configs()[providerId];
    if (own) {
      if (this.opts.allowed && !this.opts.allowed(providerId)) return undefined;
      // the hub's entry of the same id, on the hub's key: the overlay decides per call whether it may be used
      const hubRaw = this.config.get().providers[providerId];
      const hub = hubRaw && hubRaw.type !== 'acp' ? this.build(providerId, hubRaw, this.config.apiKey(providerId)) : undefined;
      const p = this.opts.overlay!.make(providerId, own, hub);
      if (p) this.cache.set(providerId, p);
      return p;
    }
    const raw = this.providerConfigs()[providerId];
    if (!raw || raw.type === 'acp') return undefined;
    if (this.opts.allowed && !this.opts.allowed(providerId)) return undefined;
    const p = this.build(providerId, raw, this.opts.apiKey ? this.opts.apiKey(providerId) : this.config.apiKey(providerId));
    if (p) this.cache.set(providerId, p);
    return p;
  }

  /** A provider for a config entry, its addresses expanded. */
  private build(providerId: string, raw: ProviderConfig, apiKey: string | undefined): Provider | undefined {
    const cfg: ProviderConfig = { ...raw, baseUrl: raw.baseUrl ? this.config.expand(raw.baseUrl) : undefined };
    if (raw.anthropicWire) cfg.anthropicWire = { ...raw.anthropicWire, baseUrl: this.config.expand(raw.anthropicWire.baseUrl ?? '') };
    return createProvider(providerId, cfg, { apiKey, headers: this.config.expandRecord(raw.headers), fetch: this.opts.fetch });
  }

  /** Has credentials (or needs none: local servers, ACP commands on PATH). */
  isConfigured(providerId: string): boolean {
    const cfg = this.providerConfigs()[providerId];
    if (!cfg) return false;
    if (cfg.type === 'acp') return !!cfg.command && !!Bun.which(cfg.command);
    if (this.opts.allowed && !this.opts.allowed(providerId)) return false;
    const hasKey = this.opts.apiKey ? !!this.opts.apiKey(providerId) : this.config.hasProviderKey(providerId);
    return hasKey || isLocalUrl(cfg.baseUrl);
  }

  /** A registry on other keys (a member's), with the same config, options and account order. */
  withKeys(keys: { apiKey: (providerId: string) => string | undefined; allowed: (providerId: string) => boolean; overlay?: RegistryOverlay }): ProviderRegistry {
    const r = new ProviderRegistry(this.config, { ...this.opts, ...keys });
    r.setRouting(this.routing);
    r.setHarnessEffort(this.harnessEffort);
    r.setHarnessModels(this.harnessModels);
    return r;
  }

  /** Build providers again on the next call (the keys behind them changed). */
  invalidate(): void {
    this.cache.clear();
    this.listings.clear();
  }

  isEnabled(providerId: string): boolean {
    const cfg = this.providerConfigs()[providerId];
    return !!cfg && cfg.enabled !== false;
  }

  private usable(providerId: string): boolean {
    return this.isEnabled(providerId) && this.isConfigured(providerId);
  }

  private family(cfg: ProviderConfig): ModelFamily | 'any' | undefined {
    return cfg.type === 'acp' ? undefined : familyForProvider(cfg.type, cfg.baseUrl);
  }

  private info(provider: string, model: string): ModelInfo {
    return this.withEffort(provider, this.get(provider)?.model(model) ?? lookupModel(provider, model, { override: this.providerConfigs()[provider]?.modelOverrides?.[model] }));
  }

  private make(provider: string, model: string): ResolvedModel {
    const cfg = this.providerConfigs()[provider];
    return { provider, model, info: this.info(provider, model), acp: cfg?.type === 'acp' };
  }

  /**
   * Resolve a model ref: "provider/model", the routing aliases fast, smart
   * and deep, the Claude Code aliases opus, sonnet, haiku and inherit, or a
   * bare model id (searched across providers). "inherit" resolves to the
   * default model; callers with a parent session substitute its model first.
   */
  resolve(ref: string): ResolvedModel {
    return this.resolveDepth(ref.trim(), 0);
  }

  /** This provider and model, without the account order (a fallback the caller already picked). */
  resolveAt(provider: string, model: string): ResolvedModel {
    return this.make(provider, model);
  }

  private resolveDepth(ref: string, depth: number): ResolvedModel {
    if (depth > 4) throw new Error(`Model alias loop at "${ref}"`);
    const cfg = this.config.get();
    switch (ref) {
      case 'fast':
        return this.resolveDepth(cfg.smallModel, depth + 1);
      case 'smart':
      case 'default':
      case 'inherit':
        return this.resolveDepth(cfg.defaultModel, depth + 1);
      case 'deep':
        return this.resolveDepth(this.bestDeep() ?? cfg.defaultModel, depth + 1);
      case 'opus':
      case 'sonnet':
      case 'haiku':
        return this.claudeAlias(ref);
    }
    const parsed = parseModelRef(ref);
    const { provider } = parsed;
    let { model } = parsed;
    // a retiring Daybreak alias runs on its named model; the engine adds the access program (engine.accessProgramsFor)
    const alias = retiredAlias(model);
    if (alias) {
      const i = model.lastIndexOf('/');
      model = `${i < 0 ? '' : model.slice(0, i + 1)}${alias.model}`;
      if (!provider) return this.searchBare(model);
    }
    if (provider && this.providerConfigs()[provider]) return this.make(this.routed(model, provider) ?? provider, model);
    return this.searchBare(ref);
  }

  /**
   * The provider the owner's account order picks for a model: the first in
   * it that is usable and serves the model. A ref that names a provider moves
   * only within that order (anthropic/claude-x goes to the signed in plan
   * while it has room, and back to the key when the plan is blocked); a
   * usable provider outside the order, or an id with an account prefix,
   * stays. One the caller cannot use (anthropic/ after its key went, the
   * model pickers' merged entry, providers/merge.ts) follows the order.
   */
  private routed(model: string, named?: string): string | undefined {
    const list = this.routing?.providersFor(model);
    if (!list?.length) return undefined;
    if (named && !list.includes(named) && this.usable(named)) return undefined;
    return list.find((id) => this.usable(id) && this.serves(id, model));
  }

  /** A gateway serves the models it lists; a vendor's own provider serves its family. */
  private serves(id: string, model: string): boolean {
    const cfg = this.providerConfigs()[id];
    if (!cfg || cfg.type === 'acp') return false;
    if (cfg.anthropicWire || cfg.models?.includes(model)) return !!cfg.models?.includes(model);
    const entry = findCatalogEntry(model);
    return !!entry && this.family(cfg) === entry.family;
  }

  /** Providers in config order, usable ones first. */
  private ranked(filter: (id: string, cfg: ProviderConfig) => boolean, prefer?: string): string[] {
    const ids = Object.entries(this.providerConfigs())
      .filter(([id, cfg]) => filter(id, cfg))
      .map(([id]) => id);
    const score = (id: string) => (this.usable(id) ? 4 : 0) + (this.isEnabled(id) ? 2 : 0) + (id === prefer ? 1 : 0);
    return ids.sort((a, b) => score(b) - score(a));
  }

  private claudeAlias(alias: string): ResolvedModel {
    const target = CLAUDE_ALIASES[alias];
    const routed = this.routed(target);
    if (routed) return this.make(routed, target);
    const [best] = this.ranked((_, cfg) => cfg.type === 'anthropic' && this.family(cfg) === 'anthropic', 'anthropic');
    if (best && !this.usable(best)) {
      // no Anthropic key, but a signed in subscription serves it
      const gw = this.gatewayFor(target);
      if (gw) return this.make(gw, target);
    }
    return best ? this.make(best, target) : this.searchBare(target);
  }

  /**
   * A usable gateway (a provider with anthropicWire, such as CLIProxyAPI)
   * that lists this model. Gateways serve other vendors' models, so they
   * come after the vendor's own provider.
   */
  private gatewayFor(modelId: string): string | undefined {
    const [gw] = this.ranked((id, cfg) => !!cfg.anthropicWire && !!cfg.models?.includes(modelId) && this.usable(id));
    return gw;
  }

  private servingProvider(modelId: string): string | undefined {
    const routed = this.routed(modelId);
    if (routed) return routed;
    const entry = findCatalogEntry(modelId);
    if (!entry) return undefined;
    const [best] = this.ranked((id, cfg) => this.family(cfg) === entry.family && this.usable(id), FAMILY_HOME[entry.family]);
    return best ?? this.gatewayFor(modelId);
  }

  private bestDeep(): string | undefined {
    for (const id of DEEP_ORDER) {
      const p = this.servingProvider(id);
      if (p) return `${p}/${id}`;
    }
    return undefined;
  }

  private searchBare(id: string): ResolvedModel {
    const routed = this.routed(id);
    if (routed) return this.make(routed, id);
    const listed = this.ranked((_, cfg) => !!cfg.models?.includes(id));
    const serving = this.servingProvider(id);
    // a gateway lists other vendors' models; the vendor's own provider wins when it has a key
    if (listed.length && this.providerConfigs()[listed[0]]?.anthropicWire && serving && serving !== listed[0]) return this.make(serving, id);
    if (listed.length) return this.make(listed[0], id);

    if (serving) return this.make(serving, id);

    if (id.includes('/')) {
      const [router] = this.ranked((pid, cfg) => this.family(cfg) === 'any' && this.usable(pid));
      if (router) return this.make(router, id);
    }

    const entry = findCatalogEntry(id);
    if (entry) {
      // Nobody is configured for it: pick the family's provider so the error names the missing key.
      const [any] = this.ranked((_, cfg) => this.family(cfg) === entry.family, FAMILY_HOME[entry.family]);
      if (any) return this.make(any, id);
    }
    throw new Error(`Unknown model "${id}". Use "provider/model" or add the model to a provider's models list.`);
  }

  /** Models a provider offers without asking it: config list or catalog. */
  private staticModels(providerId: string, cfg: ProviderConfig): ModelInfo[] {
    if (cfg.models?.length) return cfg.models.map((m) => this.info(providerId, m));
    const fam = this.family(cfg);
    if (!fam || fam === 'any') return [];
    return catalogEntries(fam).map((e) => this.info(providerId, e.id));
  }

  private async listModels(providerId: string, p: Provider): Promise<ModelInfo[]> {
    const hit = this.listings.get(providerId);
    const ttl = this.opts.modelsTtlMs ?? 600_000;
    if (hit && Date.now() - hit.at < ttl) return hit.models;
    const listed = await withTimeout(p.listModels(), this.opts.listTimeoutMs ?? 15_000, `${providerId} model listing`);
    const models = listed.map((m) => this.withEffort(providerId, m));
    this.listings.set(providerId, { at: Date.now(), models });
    return models;
  }

  /** Every configured provider with its models, for pickers and settings. */
  async groups(): Promise<ModelGroup[]> {
    const entries = Object.entries(this.providerConfigs());
    return Promise.all(
      entries.map(async ([id, cfg]): Promise<ModelGroup> => {
        const group: ModelGroup = {
          provider: id,
          name: cfg.name ?? id,
          type: cfg.type,
          configured: this.isConfigured(id),
          enabled: cfg.enabled !== false,
          models: [],
        };
        if (cfg.type === 'acp') {
          group.models = this.harnessGroupModels(id, cfg);
          return group;
        }
        const p = this.get(id);
        if (!p || !group.configured || !group.enabled) {
          group.models = this.staticModels(id, cfg);
          return group;
        }
        try {
          group.models = await this.listModels(id, p);
        } catch (err) {
          group.error = (err as Error).message;
          group.models = this.staticModels(id, cfg);
        }
        return group;
      }),
    );
  }

  /** USD cost of a call. A provider-reported cost (OpenRouter) wins. */
  costOf(info: ModelInfo, usage: Usage): number {
    return usage.costUsd ?? computeCost(info, usage);
  }

  private testModel(providerId: string, cfg: ProviderConfig): string | undefined {
    if (cfg.models?.length) return cfg.models[0];
    const c = this.config.get();
    for (const ref of [c.smallModel, c.defaultModel]) {
      const { provider, model } = parseModelRef(ref);
      if (provider === providerId) return model;
    }
    const fam = this.family(cfg);
    if (!fam || fam === 'any') return undefined;
    const list = catalogEntries(fam);
    return (list.find((e) => e.tier === 'fast') ?? list[0])?.id;
  }

  /** Send a tiny request and report latency. ACP providers are checked for their command on PATH. */
  async test(providerId: string): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
    const cfg = this.providerConfigs()[providerId];
    if (!cfg) return { ok: false, detail: `Unknown provider "${providerId}"` };
    if (cfg.type === 'acp') {
      const path = cfg.command ? Bun.which(cfg.command) : null;
      return path ? { ok: true, detail: `${cfg.command} found at ${path}` } : { ok: false, detail: `${cfg.command ?? 'command'} not found on PATH` };
    }
    const p = this.get(providerId);
    const model = this.testModel(providerId, cfg);
    if (!p || !model) return { ok: false, detail: 'No model to test with. Add one to the provider\'s models list.' };
    const started = performance.now();
    try {
      let text = '';
      let stop = '';
      for await (const ev of p.stream({
        model,
        system: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] }],
        maxTokens: 32,
        signal: AbortSignal.timeout(60_000),
      })) {
        if (ev.type === 'text_delta') text += ev.text;
        else if (ev.type === 'done') stop = ev.stopReason;
      }
      const latencyMs = Math.round(performance.now() - started);
      return { ok: true, detail: `${model}: ${text.trim().slice(0, 80) || `stop ${stop}`}`, latencyMs };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, latencyMs: Math.round(performance.now() - started) };
    }
  }

  /** Refresh LiteLLM prices (at most daily) into the config cache dir. */
  async refreshPricing(force = false): Promise<Awaited<ReturnType<typeof refreshPricingFromLiteLLM>>> {
    const res = await refreshPricingFromLiteLLM(this.config.paths.cache, { fetch: this.opts.fetch, force });
    this.listings.clear();
    return res;
  }
}
