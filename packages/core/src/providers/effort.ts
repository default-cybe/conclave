/**
 * Effort: how hard a model thinks before it answers. One helper for the hub
 * (the model catalog, engine.thinkingFor, the Anthropic request) and the
 * clients (the composer's Effort menu, the session start, the /model sheet),
 * so all of them offer the same levels. No node imports: the web app bundles
 * this file.
 *
 * Claude (Anthropic's API docs, October 2026), sent as output_config.effort:
 * - Claude 5 family (Fable 5 and 5.1, Opus 5.5 and 5, Sonnet 5.5 and 5, Haiku
 *   5.5) and Opus 4.8 and 4.7: low, medium, high, xhigh and max.
 * - Opus 4.6 and Sonnet 4.6: low, medium, high and max (no xhigh).
 * - Haiku 4.5 and older: no effort control.
 * - Default high, except Opus 5.5 and Haiku 5.5 (medium).
 * - Off: Opus 5.5 and Fable cannot turn thinking off. Sonnet 5.5 turns it off
 *   with thinking {type: "between_tools"}; the others take {type: "disabled"}
 *   (Opus 5 and Haiku 5.5 only at effort high or below, so Off sends no level).
 * Mythos 5.1 is not in that list; it is treated as Fable 5.1.
 *
 * Other wires get the levels their adapters already send: reasoning effort
 * (OpenAI, OpenRouter), thinkingLevel or thinkingBudget (Gemini), a token
 * budget (Anthropic-compatible gateways, DashScope), or one switch (Z.ai and
 * DeepSeek on Chat Completions).
 *
 * A ChatGPT plan names each model's levels itself (its Codex model list, read
 * by the hub's CLIProxyAPI manager into ProviderConfig.modelMeta): GPT-6 and
 * GPT-5.6 Sol take low to ultra, "ultra" being maximum reasoning with
 * automatic task delegation. Those lists win over the rules here.
 */
import { normalizeModelId } from './model-id';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORTS)[number];
/** A stored setting: a level, or thinking off. */
export type EffortSetting = 'off' | Effort;
export const EFFORT_SETTINGS: readonly EffortSetting[] = ['off', ...EFFORTS];

/** What a model offers. */
export interface ModelEffort {
  /** Levels the model takes, lowest first. */
  levels: Effort[];
  /** Thinking can be turned off. */
  off: boolean;
  /** What the model does with no level set, when known. */
  default?: EffortSetting;
}

/**
 * How a request reaches the model, for its levels: the Anthropic wire, OpenAI
 * reasoning effort, OpenRouter's reasoning object, one thinking switch (Z.ai,
 * DeepSeek), a DashScope budget, Gemini, or a harness (its levels are learned
 * from the harness itself, engine.noteHarnessEffort).
 */
export type EffortWire = 'anthropic' | 'openai' | 'openrouter' | 'switch' | 'dashscope' | 'gemini' | 'harness';

export function isEffortSetting(v: unknown): v is EffortSetting {
  return typeof v === 'string' && (EFFORT_SETTINGS as readonly string[]).includes(v);
}

/** Claude's five levels (ultra is a ChatGPT plan's). */
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const BASIC: Effort[] = ['low', 'medium', 'high'];

/** A Claude model's levels, or undefined for models without effort control (Haiku 4.5 and older). */
export function claudeEffort(model: string): ModelEffort | undefined {
  const id = normalizeModelId(model);
  if (/^claude-opus-5-5/.test(id)) return { levels: ALL, off: false, default: 'medium' };
  if (/^claude-(fable|mythos)-5/.test(id)) return { levels: ALL, off: false, default: 'high' };
  if (/^claude-haiku-5-5/.test(id)) return { levels: ALL, off: true, default: 'medium' };
  if (/^claude-(opus|sonnet)-5/.test(id) || /^claude-opus-4-[78]/.test(id)) return { levels: ALL, off: true, default: 'high' };
  if (/^claude-(opus|sonnet)-4-6/.test(id)) return { levels: ['low', 'medium', 'high', 'max'], off: true, default: 'high' };
  return undefined;
}

/**
 * How Off reaches a Claude model: thinking {type: "disabled"}, {type:
 * "between_tools"} (Sonnet 5.5), no thinking field (4.6, which only thinks
 * when asked), or undefined when it cannot be turned off.
 */
export function claudeThinkingOff(model: string): 'disabled' | 'between_tools' | 'omit' | undefined {
  const id = normalizeModelId(model);
  if (/^claude-(opus-5-5|fable-5|mythos-5)/.test(id)) return undefined;
  if (/^claude-sonnet-5-5/.test(id)) return 'between_tools';
  if (/^claude-(opus|sonnet|haiku)-5/.test(id) || /^claude-opus-4-[78]/.test(id)) return 'disabled';
  return 'omit';
}

/** OpenAI reasoning effort: xhigh from GPT-5.2 on (and 5.1 Codex Max); none of them takes max. */
function openaiEffort(id: string): ModelEffort {
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  const major = m ? Number(m[1]) : 0;
  const minor = m?.[2] ? Number(m[2]) : 0;
  const xhigh = major > 5 || (major === 5 && minor >= 2) || id.startsWith('gpt-5.1-codex-max');
  return { levels: xhigh ? [...BASIC, 'xhigh'] : BASIC, off: false };
}

/** Gemini 3 and later take thinkingLevel (Pro: low or high), 2.5 a token budget. Neither turns off here. */
function geminiEffort(id: string): ModelEffort {
  if (/^gemini-([3-9]|\d{2})/.test(id)) return { levels: id.includes('pro') ? ['low', 'high'] : BASIC, off: false, default: 'high' };
  return { levels: BASIC, off: false };
}

/**
 * The levels a model offers on a wire, or undefined when it has no effort
 * control. `thinking` is ModelInfo.thinking. Harness models return undefined
 * here; their levels come from the harness (engine.noteHarnessEffort).
 */
export function modelEffort(model: string, thinking: boolean, wire: EffortWire): ModelEffort | undefined {
  if (!thinking || wire === 'harness') return undefined;
  const id = normalizeModelId(model);
  switch (wire) {
    case 'anthropic':
      // Claude on its own wire; other models there (GLM, MiniMax, Kimi gateways) get a thinking budget
      return id.startsWith('claude-') ? claudeEffort(id) : { levels: BASIC, off: true, default: 'off' };
    case 'openai':
      return id.startsWith('gpt-') || /^o\d/.test(id) ? openaiEffort(id) : { levels: BASIC, off: false };
    case 'openrouter':
      return { levels: BASIC, off: false };
    case 'switch':
      return { levels: ['high'], off: true };
    case 'dashscope':
      return { levels: BASIC, off: true, default: 'off' };
    case 'gemini':
      return geminiEffort(id);
  }
}

/**
 * A setting the model takes: the same one when it has it, else the nearest
 * level (the lower one on a tie). Off on a model that cannot turn thinking off
 * is its lowest level. Undefined stays undefined (the agent's or the model's
 * default), and so does anything on a model without effort control.
 */
export function clampEffort(setting: EffortSetting | undefined, e: ModelEffort | undefined): EffortSetting | undefined {
  if (!setting || !e) return undefined;
  if (setting === 'off') return e.off ? 'off' : e.levels[0];
  if (e.levels.includes(setting)) return setting;
  if (!e.levels.length) return e.off ? 'off' : undefined;
  const at = EFFORTS.indexOf(setting);
  let best = e.levels[0];
  for (const l of e.levels) {
    const d = Math.abs(EFFORTS.indexOf(l) - at);
    const bd = Math.abs(EFFORTS.indexOf(best) - at);
    if (d < bd || (d === bd && EFFORTS.indexOf(l) < EFFORTS.indexOf(best))) best = l;
  }
  return best;
}

/** The settings a menu lists for a model, lowest first: Off when it exists, then its levels. */
export function effortChoices(e: ModelEffort | undefined): EffortSetting[] {
  if (!e) return [];
  return [...(e.off ? (['off'] as const) : []), ...e.levels];
}

const LABELS: Record<EffortSetting, string> = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

/** The word for a setting. A model with one level calls it On. */
export function effortLabel(setting: EffortSetting, e?: ModelEffort): string {
  if (setting !== 'off' && e?.levels.length === 1 && e.levels[0] === setting) return 'On';
  return LABELS[setting];
}
