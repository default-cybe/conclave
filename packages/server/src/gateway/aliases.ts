import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { ModelInfo } from '@conclave/core/providers/types.ts';
import type { WireType } from './usage';
import type { GatewayRouteId, ProviderConfig } from '@conclave/core/config/schema.ts';

/** A provider takes requests of this wire format: its own type, or Anthropic through anthropicBaseUrl (Z.ai). */
export function speaks(cfg: ProviderConfig | undefined, type: WireType): boolean {
  return !!cfg && (cfg.type === type || (type === 'anthropic' && !!cfg.anthropicBaseUrl));
}

/**
 * Optional "gateway" block in the user config. Only routes is in the shared
 * schema (ConclaveConfig.gateway); the rest is read defensively.
 *
 * gateway: {
 *   aliases: { "glm": "zai/glm-5", "fast": { "anthropic": "claude-haiku-5-5", "openai": "gpt-5.5-mini" } },
 *   concurrency: 8,          // per upstream
 *   maxQueueWaitMs: 120000,  // longer waits answer 429 right away
 *   relay: "open",           // "key" requires a gateway key even for relayed credentials
 *   routes: { gemini: false } // close a route; anthropic, openai, gemini, provider (/gw/p/<id>)
 * }
 */
export interface GatewayConfig {
  /** Routes turned off: { gemini: false } closes /gw/gemini. Missing means on. */
  routes?: Partial<Record<GatewayRouteId, boolean>>;
  aliases?: Record<string, string | Partial<Record<WireType, string>>>;
  concurrency?: number;
  maxQueueWaitMs?: number;
  relay?: 'open' | 'key';
}

export function gatewayConfig(engine: EngineApi): GatewayConfig {
  const pick = (v: unknown): GatewayConfig | undefined => {
    const g = (v as { gateway?: unknown } | undefined)?.gateway;
    return g && typeof g === 'object' && !Array.isArray(g) ? (g as GatewayConfig) : undefined;
  };
  try {
    return pick(engine.config.getUser()) ?? pick(engine.config.get()) ?? {};
  } catch {
    return {};
  }
}

const TIERS = new Set(['fast', 'smart', 'deep']);

function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return i < 0 ? { provider: '', model: ref } : { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/**
 * Rewrites a requested model name. Built-in aliases fast, smart and deep map
 * to the small model, the default model and the best "deep" tier model of
 * the same wire type. A target with a provider prefix can move the request
 * to that provider when it speaks the same wire format.
 */
export class AliasResolver {
  private models: ModelInfo[] | undefined;
  private modelsAt = 0;
  private loading: Promise<void> | undefined;

  constructor(private readonly engine: EngineApi) {}

  async resolve(model: string, type: WireType, providerId: string): Promise<{ model: string; provider?: string } | undefined> {
    if (!model) return undefined;
    const cfg = gatewayConfig(this.engine);
    const entry = cfg.aliases?.[model];
    let target: string | undefined;
    if (typeof entry === 'string') target = entry;
    else if (entry && typeof entry === 'object') target = entry[type];
    if (!target && TIERS.has(model)) target = await this.tierTarget(model as 'fast' | 'smart' | 'deep', type, providerId);
    if (!target || target === model) return undefined;
    const providers = this.engine.config.get().providers;
    const ref = splitRef(target);
    if (ref.provider && providers[ref.provider]) {
      if (!speaks(providers[ref.provider], type)) return undefined;
      return { model: ref.model, provider: ref.provider };
    }
    return { model: target };
  }

  private async tierTarget(tier: 'fast' | 'smart' | 'deep', type: WireType, providerId: string): Promise<string | undefined> {
    const cfg = this.engine.config.get();
    const providers = cfg.providers;
    const fits = (ref: string | undefined) => {
      if (!ref) return false;
      return speaks(providers[splitRef(ref).provider], type);
    };
    if (tier === 'fast' && fits(cfg.smallModel)) return cfg.smallModel;
    if (tier === 'smart' && fits(cfg.defaultModel)) return cfg.defaultModel;
    const models = await this.loadModels();
    const ofTier = models.filter((m) => m.tier === tier && speaks(providers[m.provider], type));
    const pick = ofTier.find((m) => m.provider === providerId) ?? ofTier[0];
    if (pick) return `${pick.provider}/${pick.id}`;
    if (tier === 'deep' && fits(cfg.defaultModel)) return cfg.defaultModel;
    return undefined;
  }

  private async loadModels(): Promise<ModelInfo[]> {
    const fresh = this.models && Date.now() - this.modelsAt < 5 * 60_000;
    if (!fresh && !this.loading) {
      this.loading = this.engine
        .listModels()
        .then((groups) => {
          this.models = groups.filter((g) => g.enabled !== false).flatMap((g) => g.models);
          this.modelsAt = Date.now();
        })
        .catch(() => {
          this.models ??= [];
          this.modelsAt = Date.now();
        })
        .finally(() => (this.loading = undefined));
    }
    if (this.loading && !this.models) {
      // first use: wait a little, never block a request for long
      await Promise.race([this.loading, new Promise((r) => setTimeout(r, 3000))]);
    }
    return this.models ?? [];
  }
}
