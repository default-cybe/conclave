/**
 * resolveModelRef: what a model word in an agent profile, a Task call or a
 * workflow agent() call means for one session
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2 item 1 and 6.1 item 8).
 *
 * - inherit or nothing: the session's model.
 * - fast: models.tiers.fast, else smallModel.
 * - smart: models.tiers.smart, else the session's model.
 * - deep: models.tiers.deep, else (extensions/agent-model.ts) the session's
 *   or default model when it is deep tier, else the first usable deep-tier
 *   model among the configured providers, else claude-code/opus when that
 *   harness is set up, else the session's model.
 * - Claude Code names: haiku is fast, sonnet is smart, opus and opusplan are deep.
 * - "provider/model" and ACP refs such as claude-code/sonnet or codex/default
 *   pass through.
 *
 * An unusable result falls back to the session's model, and `note` says so.
 */
import type { ConclaveConfig } from '../config/schema';

export type ModelTier = 'fast' | 'smart' | 'deep';

export interface ModelRefContext {
  config: ConclaveConfig;
  /** The model of the session the call runs for (the parent's, for a child). */
  sessionModel: string;
  /** True when the ref resolves to a configured, usable provider. */
  isUsable(ref: string): boolean;
  /** The registry's own answer for a tier word ("deep" picks the best deep model it can serve). */
  resolveTier?(tier: ModelTier): string | undefined;
}

export interface ResolvedModelRef {
  model: string;
  /** The tier the word asked for, when it was one. */
  tier?: ModelTier;
  /** Set when the ref could not be used as given. */
  note?: string;
}

const ALIAS_TIER: Record<string, ModelTier> = { fast: 'fast', smart: 'smart', deep: 'deep', haiku: 'fast', sonnet: 'smart', opus: 'deep', opusplan: 'deep' };

export function tierOf(ref: string | undefined): ModelTier | undefined {
  return ref ? ALIAS_TIER[ref.trim().toLowerCase()] : undefined;
}

export function resolveModelRef(ref: string | undefined, ctx: ModelRefContext): ResolvedModelRef {
  const word = ref?.trim();
  if (!word || word === 'inherit' || word === 'default') return { model: ctx.sessionModel };
  const tier = tierOf(word);
  if (tier) {
    const configured = ctx.config.models?.tiers?.[tier];
    if (configured && ctx.isUsable(configured)) return { model: configured, tier };
    if (tier === 'smart') return { model: ctx.sessionModel, tier };
    if (tier === 'fast') {
      const small = ctx.config.smallModel;
      return small && ctx.isUsable(small) ? { model: small, tier } : { model: ctx.sessionModel, tier, note: `fast tier: ${small || 'smallModel'} is not usable, using the session model` };
    }
    const deep = ctx.resolveTier?.('deep');
    if (deep && deep !== ctx.config.defaultModel && ctx.isUsable(deep)) return { model: deep, tier };
    const cc = ctx.config.providers['claude-code'];
    if (cc && cc.type === 'acp' && cc.enabled !== false && ctx.isUsable('claude-code/opus')) return { model: 'claude-code/opus', tier };
    return { model: ctx.sessionModel, tier, note: 'deep tier: no deep model is configured, using the session model' };
  }
  if (ctx.isUsable(word)) return { model: word };
  return { model: ctx.sessionModel, note: `model ${word} is not usable here, using the session model` };
}
