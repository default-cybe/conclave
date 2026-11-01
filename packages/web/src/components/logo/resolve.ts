/**
 * Which mark to show (spec 8.2, three tiers):
 * - a session or run that goes through a CLI shows the harness mark
 * - a model shows its model family mark
 * - a plan, key, bill or provider account shows the company mark
 */
import { harnessId, splitRef } from '@/lib/models';
import { isLogoId, type LogoId } from './registry';

export type { LogoId } from './registry';

/** 'claude-code/opus' -> 'claude-code'. Undefined for non-harness refs. */
export function harnessLogo(ref: string | undefined): LogoId | undefined {
  const h = harnessId(ref);
  return h && isLogoId(h) ? h : undefined;
}

const FAMILY: Array<[RegExp, LogoId]> = [
  [/claude|opus|sonnet|haiku/, 'claude'],
  [/gpt|(^|[^a-z])o\d|codex|chatgpt/, 'gpt'],
  [/gemini|gemma/, 'gemini'],
  [/glm|chatglm/, 'glm'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'],
  [/kimi|moonshot/, 'kimi'],
  [/mistral|codestral|devstral|magistral|ministral|mixtral/, 'mistral'],
  [/grok/, 'grok'],
  [/llama/, 'llama'],
  [/minimax|abab/, 'minimax'],
];

/** Harness defaults when the ref names no model ('codex/default' is GPT). */
const HARNESS_FAMILY: Partial<Record<string, LogoId>> = {
  'claude-code': 'claude',
  codex: 'gpt',
  'gemini-cli': 'gemini',
};

/**
 * Model family mark, matched on the model id. OpenRouter refs use the routed
 * model. A harness ref with a known model ('claude-code/opus') returns the
 * family ('claude'). Undefined when nothing matches: render a monogram.
 */
export function modelLogo(ref: string | undefined): LogoId | undefined {
  if (!ref) return undefined;
  const { provider, model } = splitRef(ref);
  const id = (model || ref).toLowerCase();
  for (const [re, logo] of FAMILY) if (re.test(id)) return logo;
  const h = harnessId(ref);
  if (h) return HARNESS_FAMILY[h];
  return companyLogo(provider || ref);
}

const COMPANY: Array<[RegExp, LogoId]> = [
  [/^(anthropic|claude)/, 'anthropic'],
  [/^(openai|chatgpt|codex)/, 'openai'],
  [/^(google|gemini|ai-studio|vertex)/, 'google'],
  [/^(zai|z\.ai|glm)/, 'zai'],
  [/^(zhipu|bigmodel)/, 'zhipu'],
  [/^(moonshot|kimi)/, 'moonshot'],
  [/^openrouter/, 'openrouter'],
  [/^ollama/, 'ollama'],
  [/^(lmstudio|lm-studio)/, 'lmstudio'],
  [/^groq/, 'groq'],
  [/^(xai|x-ai|grok)/, 'xai'],
  [/^deepseek/, 'deepseek'],
  [/^(mistral|codestral)/, 'mistral'],
  [/^(qwen|dashscope|alibaba)/, 'qwen'],
  [/^minimax/, 'minimax'],
  [/^(meta|llama)/, 'llama'],
];

/**
 * Company mark for a provider id, plan or limit id:
 * 'claude-max' -> 'anthropic', 'codex' -> 'openai', 'zai-coding' -> 'zai'.
 * Undefined for unknown providers (cliproxy, custom endpoints): monogram.
 */
export function companyLogo(providerOrLimitId: string | undefined): LogoId | undefined {
  if (!providerOrLimitId) return undefined;
  const p = providerOrLimitId.toLowerCase();
  if (p === 'gemini-cli') return 'google';
  if (p === 'claude-code') return 'anthropic';
  for (const [re, logo] of COMPANY) if (re.test(p)) return logo;
  return undefined;
}
