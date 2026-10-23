import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Usage } from '../types';
import type { ModelOverride, ProviderType } from '../config/schema';
import { hostOf, type FetchFn } from './http';
import { normalizeModelId } from './model-id';
import type { ModelInfo } from './types';

/** Model vendor, used to pick catalog entries for a provider and LiteLLM key prefixes. */
export type ModelFamily = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'deepseek' | 'moonshot' | 'qwen' | 'minimax';

export interface CatalogEntry extends Omit<ModelInfo, 'ref' | 'provider'> {
  family: ModelFamily;
  /** Extra names that resolve to this entry (lowercase). */
  aliases?: string[];
  /** Only served by the OpenAI Responses API. */
  responsesOnly?: boolean;
}

type Prices = [input: number, output: number, cacheRead: number, cacheWrite: number];

/** flags: v = vision, t = tools, r = reasoning/thinking */
function e(
  family: ModelFamily,
  id: string,
  name: string,
  contextWindow: number,
  maxOutput: number,
  flags: string,
  [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice]: Prices,
  tier?: ModelInfo['tier'],
  extra: { aliases?: string[]; responsesOnly?: boolean } = {},
): CatalogEntry {
  return {
    family,
    id,
    name,
    contextWindow,
    maxOutput,
    vision: flags.includes('v'),
    tools: flags.includes('t'),
    thinking: flags.includes('r'),
    caching: family === 'anthropic' || family === 'minimax' ? 'explicit' : 'automatic',
    inputPrice,
    outputPrice,
    cacheReadPrice,
    cacheWritePrice,
    // Claude models take a 1 hour cache lifetime too (runner.ts cacheTtlFor), written at 2x input
    ...(family === 'anthropic' ? { cacheWrite1hPrice: inputPrice * 2 } : {}),
    tier,
    ...extra,
  };
}

const M = 1_000_000;
const K = 1000;

/**
 * Built-in catalog, October 2026. USD per million tokens.
 * Anthropic: Claude API model reference. cacheWrite is the 5 minute rate
 * (1.25x input); the 1 hour rate is 2x input (cacheWrite1hPrice, set in e()).
 * Cache reads are 0.1x input, except Opus 5.5 and Sonnet 5.5 at 0.05x and
 * Fable 5.1 and Mythos 5.1 at 0.025x. Opus 5.5 and Sonnet 5.5 were checked
 * against platform.claude.com/docs/en/about-claude/pricing on 2026-10-22.
 * Others: LiteLLM model_prices_and_context_window.json as of 2026-10-16 unless noted.
 * Tiered prices (long prompts) are not modeled; the base tier is used.
 */
export const CATALOG: CatalogEntry[] = [
  // Anthropic
  e('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', M, 128 * K, 'vtr', [10, 50, 0.25, 12.5], 'deep', { aliases: ['fable'] }),
  e('anthropic', 'claude-fable-5', 'Claude Fable 5', M, 128 * K, 'vtr', [10, 50, 1, 12.5], 'deep'),
  e('anthropic', 'claude-mythos-5-1', 'Claude Mythos 5.1', M, 128 * K, 'vtr', [10, 50, 0.25, 12.5], 'deep'),
  e('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', M, 128 * K, 'vtr', [4, 20, 0.2, 5], 'deep', { aliases: ['opus'] }),
  e('anthropic', 'claude-opus-5', 'Claude Opus 5', M, 128 * K, 'vtr', [5, 25, 0.5, 6.25], 'deep'),
  e('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', M, 128 * K, 'vtr', [5, 25, 0.5, 6.25], 'deep'),
  e('anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', M, 128 * K, 'vtr', [5, 25, 0.5, 6.25], 'deep'),
  e('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', M, 128 * K, 'vtr', [5, 25, 0.5, 6.25], 'deep'),
  e('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', 200 * K, 64 * K, 'vtr', [5, 25, 0.5, 6.25], 'deep'),
  e('anthropic', 'claude-opus-4-1', 'Claude Opus 4.1', 200 * K, 32 * K, 'vtr', [15, 75, 1.5, 18.75], 'deep'),
  e('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', M, 128 * K, 'vtr', [2, 10, 0.1, 2.5], 'smart', { aliases: ['sonnet'] }),
  e('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', M, 128 * K, 'vtr', [2, 10, 0.2, 2.5], 'smart'),
  e('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', M, 128 * K, 'vtr', [3, 15, 0.3, 3.75], 'smart'),
  e('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 200 * K, 64 * K, 'vtr', [3, 15, 0.3, 3.75], 'smart'),
  // Prompts over 100K tokens bill at 0.50 / 2.50. Not checked against the pricing page on 2026-10-22; kept as it was.
  e('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', M, 128 * K, 'vtr', [0.1, 0.5, 0.01, 0.125], 'fast', { aliases: ['haiku'] }),
  e('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 200 * K, 64 * K, 'vtr', [1, 5, 0.1, 1.25], 'fast'),

  // OpenAI. contextWindow is the input limit.
  // gpt-5.6 family: listed by LiteLLM with explicit cache write prices (1.25x input); verify against openai.com/api/pricing.
  // GPT-5.6 and GPT-5.5 were not confirmed with OpenAI on 2026-10-22 (its pricing page was unreachable); kept as they were.
  e('openai', 'gpt-5.6', 'GPT-5.6', 922 * K, 128 * K, 'vtr', [4, 20, 0.4, 5], 'deep'),
  e('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', 922 * K, 128 * K, 'vtr', [2, 12, 0.2, 2.5], 'smart'),
  e('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', 922 * K, 128 * K, 'vtr', [0.2, 1.2, 0.02, 0.25], 'fast'),
  e('openai', 'gpt-5.5', 'GPT-5.5', 1_050_000, 128 * K, 'vtr', [5, 30, 0.5, 0], 'deep'),
  e('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', 1_050_000, 128 * K, 'vtr', [30, 180, 0, 0], 'deep', { responsesOnly: true }),
  e('openai', 'gpt-5.4', 'GPT-5.4', 1_050_000, 128 * K, 'vtr', [2.5, 15, 0.25, 0], 'smart'),
  e('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', 272 * K, 128 * K, 'vtr', [0.75, 4.5, 0.075, 0], 'fast'),
  e('openai', 'gpt-5.4-nano', 'GPT-5.4 nano', 272 * K, 128 * K, 'vtr', [0.2, 1.25, 0.02, 0], 'fast'),
  e('openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', 272 * K, 128 * K, 'vtr', [1.75, 14, 0.175, 0], 'smart', { responsesOnly: true }),
  e('openai', 'gpt-5.2-codex', 'GPT-5.2 Codex', 272 * K, 128 * K, 'vtr', [1.75, 14, 0.175, 0], 'smart', { responsesOnly: true }),
  e('openai', 'gpt-5.2', 'GPT-5.2', 272 * K, 128 * K, 'vtr', [1.75, 14, 0.175, 0], 'smart'),
  e('openai', 'gpt-5.1-codex-max', 'GPT-5.1 Codex Max', 400 * K, 128 * K, 'vtr', [1.25, 10, 0.125, 0], 'smart', { responsesOnly: true }),
  e('openai', 'gpt-5.1-codex-mini', 'GPT-5.1 Codex mini', 400 * K, 128 * K, 'vtr', [0.25, 2, 0.025, 0], 'fast', { responsesOnly: true }),
  e('openai', 'gpt-5', 'GPT-5', 272 * K, 128 * K, 'vtr', [1.25, 10, 0.125, 0], 'smart'),
  e('openai', 'gpt-5-mini', 'GPT-5 mini', 272 * K, 128 * K, 'vtr', [0.25, 2, 0.025, 0], 'fast'),
  e('openai', 'gpt-5-nano', 'GPT-5 nano', 272 * K, 128 * K, 'vtr', [0.05, 0.4, 0.005, 0], 'fast'),
  e('openai', 'gpt-4.1', 'GPT-4.1', 1_047_576, 32_768, 'vt', [2, 8, 0.5, 0], 'smart'),

  // Google Gemini. Pro prompts over 200K bill at a higher tier.
  e('gemini', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 1_048_576, 65_536, 'vtr', [2, 12, 0.2, 0], 'deep', {
    aliases: ['gemini-3.1-pro', 'gemini-3-pro-preview', 'gemini-3-pro'],
  }),
  e('gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 1_048_576, 65_536, 'vtr', [1.5, 9, 0.15, 0], 'smart'),
  // Newest flash in LiteLLM; verify the id on ai.google.dev before relying on it.
  e('gemini', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 1_048_576, 65_536, 'vtr', [0.75, 3.75, 0.075, 0], 'fast'),
  e('gemini', 'gemini-3-flash-preview', 'Gemini 3 Flash', 1_048_576, 65_536, 'vtr', [0.5, 3, 0.05, 0], 'fast', { aliases: ['gemini-3-flash'] }),
  e('gemini', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 1_048_576, 65_536, 'vtr', [0.25, 1.5, 0.025, 0], 'fast', {
    aliases: ['gemini-3.1-flash-lite-preview'],
  }),
  e('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1_048_576, 65_536, 'vtr', [1.25, 10, 0.125, 0], 'smart'),
  e('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576, 65_536, 'vtr', [0.3, 2.5, 0.03, 0], 'fast'),

  // Z.ai GLM (API list prices; the coding plan is a flat subscription).
  e('zai', 'glm-5.3', 'GLM-5.3', M, 128 * K, 'tr', [1.4, 4.4, 0.26, 0], 'deep'),
  e('zai', 'glm-5.2', 'GLM-5.2', M, 128 * K, 'tr', [1.4, 4.4, 0.26, 0], 'smart'),
  e('zai', 'glm-5.1', 'GLM-5.1', 200 * K, 128 * K, 'tr', [1.4, 4.4, 0.26, 0], 'smart'),
  e('zai', 'glm-5', 'GLM-5', 200 * K, 128 * K, 'tr', [1, 3.2, 0.2, 0], 'smart'),
  e('zai', 'glm-5-code', 'GLM-5 Code', 200 * K, 128 * K, 'tr', [1.2, 5, 0.3, 0], 'smart'),
  e('zai', 'glm-5.3-flash', 'GLM-5.3 Flash', 1_048_576, 128 * K, 'vtr', [0.15, 0.5, 0.03, 0], 'fast'),
  e('zai', 'glm-4.7', 'GLM-4.7', 200 * K, 128 * K, 'tr', [0.6, 2.2, 0.11, 0], 'smart'),
  e('zai', 'glm-4.7-flash', 'GLM-4.7 Flash', 200 * K, 128 * K, 'tr', [0, 0, 0, 0], 'fast'),
  e('zai', 'glm-4.6', 'GLM-4.6', 200 * K, 128 * K, 'tr', [0.6, 2.2, 0.11, 0], 'smart'),
  // Cache read price not in LiteLLM; 0.03 is from the z.ai pricing page as remembered.
  e('zai', 'glm-4.5-air', 'GLM-4.5 Air', 128 * K, 96 * K, 'tr', [0.2, 1.1, 0.03, 0], 'fast'),

  // DeepSeek
  e('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', M, 384 * K, 'tr', [1.32, 3.96, 0.044, 0], 'smart'),
  e('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', M, 384 * K, 'vtr', [0.3, 1.2, 0.006, 0], 'fast'),
  e('deepseek', 'deepseek-chat', 'DeepSeek Chat', 131_072, 8192, 't', [0.28, 0.42, 0.028, 0], 'fast'),
  e('deepseek', 'deepseek-reasoner', 'DeepSeek Reasoner', 131_072, 64 * K, 'tr', [0.28, 0.42, 0.028, 0], 'smart'),

  // Moonshot Kimi. Max output is a guess; LiteLLM lists the full context.
  e('moonshot', 'kimi-k3', 'Kimi K3', 1_048_576, 128 * K, 'vtr', [3, 15, 0.3, 0], 'deep'),
  e('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', 262_144, 64 * K, 'vtr', [0.95, 4, 0.19, 0], 'smart'),
  e('moonshot', 'kimi-k2.6', 'Kimi K2.6', 262_144, 64 * K, 'vtr', [0.95, 4, 0.16, 0], 'smart'),
  e('moonshot', 'kimi-k2.5', 'Kimi K2.5', 262_144, 64 * K, 'vtr', [0.6, 3, 0.1, 0], 'smart'),

  // Alibaba Qwen (DashScope international)
  e('qwen', 'qwen3.8-max', 'Qwen3.8 Max', 991_808, 131_072, 'vtr', [2, 6, 0.25, 0], 'smart'),
  e('qwen', 'qwen3.8-flash', 'Qwen3.8 Flash', 991_808, 131_072, 'vtr', [0.15, 0.47, 0.016, 0.2], 'fast'),
  e('qwen', 'qwen3.7-max', 'Qwen3.7 Max', 991_808, 65_536, 'tr', [2.5, 7.5, 0.5, 0], 'smart'),
  // Prices not in LiteLLM; plausible values, verify.
  e('qwen', 'qwen3-coder-plus', 'Qwen3 Coder Plus', 997_952, 65_536, 'tr', [1, 5, 0.1, 0], 'smart'),

  // MiniMax. Context for M2.x is 204,800 per MiniMax docs (LiteLLM says 1M).
  e('minimax', 'MiniMax-M3', 'MiniMax M3', M, 128 * K, 'vtr', [0.3, 1.2, 0.06, 0], 'smart'),
  e('minimax', 'MiniMax-M2.5', 'MiniMax M2.5', 204_800, 128 * K, 'tr', [0.3, 1.2, 0.03, 0.375], 'smart'),
  e('minimax', 'MiniMax-M2.1', 'MiniMax M2.1', 204_800, 128 * K, 'tr', [0.3, 1.2, 0.03, 0.375], 'smart'),
  e('minimax', 'MiniMax-M2', 'MiniMax M2', 204_800, 128 * K, 'tr', [0.3, 1.2, 0.03, 0.375], 'smart'),
];

const BY_KEY = new Map<string, CatalogEntry>();
for (const entry of CATALOG) {
  BY_KEY.set(entry.id.toLowerCase(), entry);
  for (const a of entry.aliases ?? []) if (!BY_KEY.has(a)) BY_KEY.set(a, entry);
}

export { normalizeModelId };

/** Catalog entry for an id, by exact name, alias, or longest prefix ("glm-4.7-x" -> glm-4.7). */
export function findCatalogEntry(id: string): CatalogEntry | undefined {
  const n = normalizeModelId(id);
  const exact = BY_KEY.get(n);
  if (exact) return exact;
  let best: CatalogEntry | undefined;
  let bestLen = 0;
  for (const [key, entry] of BY_KEY) {
    if (key.length <= bestLen || !n.startsWith(key)) continue;
    const next = n[key.length];
    if (next === '-' || next === ':') {
      best = entry;
      bestLen = key.length;
    }
  }
  return best;
}

export function catalogEntries(family?: ModelFamily): CatalogEntry[] {
  return family ? CATALOG.filter((x) => x.family === family) : [...CATALOG];
}

/**
 * Which vendor's models a provider serves, from its type and base URL.
 * "any" means a router that serves every family with vendor-prefixed ids.
 */
export function familyForProvider(type: ProviderType, baseUrl?: string): ModelFamily | 'any' | undefined {
  if (type === 'gemini') return 'gemini';
  const host = hostOf(baseUrl);
  if (host.endsWith('openrouter.ai')) return 'any';
  if (/(^|\.)z\.ai$|bigmodel\.cn$/.test(host)) return 'zai';
  if (host.endsWith('deepseek.com')) return 'deepseek';
  if (/moonshot\.(ai|cn)$|kimi\.com$/.test(host)) return 'moonshot';
  if (/dashscope|aliyuncs\.com$/.test(host)) return 'qwen';
  if (/minimaxi?\.(io|com|chat)$/.test(host)) return 'minimax';
  if (type === 'anthropic' && (!host || host === 'api.anthropic.com')) return 'anthropic';
  if (type === 'openai' && host === 'api.openai.com') return 'openai';
  return undefined;
}

// ---------------------------------------------------------------------------
// LiteLLM price overlay
// ---------------------------------------------------------------------------

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

interface LiteEntry {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  cacheWrite1hPrice?: number;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  thinking?: boolean;
  tools?: boolean;
}

const LITELLM_PREFIXES: Record<ModelFamily, string[]> = {
  anthropic: ['', 'anthropic/'],
  openai: ['', 'openai/'],
  gemini: ['gemini/', ''],
  zai: ['zai/', ''],
  deepseek: ['deepseek/', ''],
  moonshot: ['moonshot/', ''],
  qwen: ['dashscope/', ''],
  minimax: ['minimax/', ''],
};

let overlay = new Map<string, LiteEntry>();

function perMillion(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : undefined;
}

/** Load LiteLLM's price table into the overlay. Returns the number of chat models loaded. */
export function applyLiteLLMData(data: Record<string, unknown>): number {
  const next = new Map<string, LiteEntry>();
  for (const [key, raw] of Object.entries(data)) {
    if (key === 'sample_spec' || !raw || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    if (v.mode !== undefined && v.mode !== 'chat' && v.mode !== 'responses') continue;
    next.set(key.toLowerCase(), {
      inputPrice: perMillion(v.input_cost_per_token),
      outputPrice: perMillion(v.output_cost_per_token),
      cacheReadPrice: perMillion(v.cache_read_input_token_cost),
      cacheWritePrice: perMillion(v.cache_creation_input_token_cost),
      cacheWrite1hPrice: perMillion(v.cache_creation_input_token_cost_above_1hr),
      contextWindow: typeof v.max_input_tokens === 'number' ? v.max_input_tokens : undefined,
      maxOutput: typeof v.max_output_tokens === 'number' ? v.max_output_tokens : undefined,
      vision: typeof v.supports_vision === 'boolean' ? v.supports_vision : undefined,
      thinking: typeof v.supports_reasoning === 'boolean' ? v.supports_reasoning : undefined,
      tools: typeof v.supports_function_calling === 'boolean' ? v.supports_function_calling : undefined,
    });
  }
  overlay = next;
  return next.size;
}

export function clearLiteLLMData(): void {
  overlay = new Map();
}

function liteLookup(id: string, family?: ModelFamily): LiteEntry | undefined {
  if (!overlay.size) return undefined;
  const n = id.toLowerCase();
  const prefixes = family ? LITELLM_PREFIXES[family] : ['', ...new Set(Object.values(LITELLM_PREFIXES).flat())];
  for (const p of prefixes) {
    const hit = overlay.get(p + n);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Download LiteLLM's price table at most once a day into cacheDir and merge
 * its prices into lookups. Falls back to a stale cached copy when offline.
 */
export async function refreshPricingFromLiteLLM(
  cacheDir: string,
  opts: { fetch?: FetchFn; url?: string; maxAgeMs?: number; force?: boolean } = {},
): Promise<{ models: number; source: 'cache' | 'network' | 'stale-cache' | 'none'; error?: string }> {
  const file = join(cacheDir, 'litellm-prices.json');
  let mtime: number | undefined;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    mtime = undefined;
  }
  const load = () => applyLiteLLMData(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
  if (mtime !== undefined && !opts.force && Date.now() - mtime < (opts.maxAgeMs ?? 86_400_000)) {
    try {
      return { models: load(), source: 'cache' };
    } catch {
      /* corrupt cache, download again */
    }
  }
  try {
    const res = await (opts.fetch ?? fetch)(opts.url ?? LITELLM_PRICES_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const models = applyLiteLLMData(JSON.parse(text) as Record<string, unknown>);
    // the home may be gone by the time the download ends (a closed engine, a deleted test home): do not make it again
    if (existsSync(dirname(cacheDir))) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, text);
    }
    return { models, source: 'network' };
  } catch (err) {
    const error = (err as Error).message;
    if (mtime !== undefined) {
      try {
        return { models: load(), source: 'stale-cache', error };
      } catch {
        /* fall through */
      }
    }
    return { models: 0, source: 'none', error };
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export interface LookupOptions {
  /** Provider wire type, used for defaults of unknown models. */
  type?: ProviderType;
  /** Per-model overrides from config. */
  override?: Partial<ModelOverride>;
}

/**
 * Capabilities and prices for a model. Matches ids fuzzily (dates, aliases,
 * vendor prefixes), applies LiteLLM prices when loaded and config overrides
 * last. Unknown models get conservative defaults.
 */
export function lookupModel(provider: string, id: string, opts: LookupOptions = {}): ModelInfo {
  const modelId = id.trim();
  const entry = findCatalogEntry(modelId);
  const lite = liteLookup(entry ? entry.id : normalizeModelId(modelId), entry?.family) ?? (entry ? undefined : liteLookup(modelId.toLowerCase()));

  const info: ModelInfo = entry
    ? {
        id: modelId,
        ref: `${provider}/${modelId}`,
        provider,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxOutput: entry.maxOutput,
        vision: entry.vision,
        tools: entry.tools,
        thinking: entry.thinking,
        caching: entry.caching,
        inputPrice: entry.inputPrice,
        outputPrice: entry.outputPrice,
        cacheReadPrice: entry.cacheReadPrice,
        cacheWritePrice: entry.cacheWritePrice,
        ...(entry.cacheWrite1hPrice !== undefined ? { cacheWrite1hPrice: entry.cacheWrite1hPrice } : {}),
        tier: entry.tier,
      }
    : {
        id: modelId,
        ref: `${provider}/${modelId}`,
        provider,
        name: modelId,
        contextWindow: lite?.contextWindow ?? 128_000,
        maxOutput: lite?.maxOutput ?? 8192,
        vision: lite?.vision ?? false,
        tools: lite?.tools ?? true,
        thinking: lite?.thinking ?? false,
        caching: opts.type === 'anthropic' ? 'explicit' : lite?.cacheReadPrice ? 'automatic' : 'none',
        inputPrice: 0,
        outputPrice: 0,
        cacheReadPrice: 0,
        cacheWritePrice: 0,
      };

  if (lite) {
    if (lite.inputPrice !== undefined) info.inputPrice = lite.inputPrice;
    if (lite.outputPrice !== undefined) info.outputPrice = lite.outputPrice;
    if (lite.cacheReadPrice !== undefined) info.cacheReadPrice = lite.cacheReadPrice;
    if (lite.cacheWritePrice !== undefined) info.cacheWritePrice = lite.cacheWritePrice;
    // a new input price moves the 1 hour write with it, unless LiteLLM names that price too
    if (lite.cacheWrite1hPrice !== undefined) info.cacheWrite1hPrice = lite.cacheWrite1hPrice;
    else if (info.cacheWrite1hPrice !== undefined) info.cacheWrite1hPrice = info.inputPrice * 2;
  }
  if (opts.override) {
    Object.assign(info, stripUndefined(opts.override));
    if (opts.override.inputPrice !== undefined && opts.override.cacheWrite1hPrice === undefined && info.cacheWrite1hPrice !== undefined) info.cacheWrite1hPrice = info.inputPrice * 2;
  }
  return info;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** USD per million tokens for a 1 hour cache write: the model's own price, else 2x input (Anthropic's rate). */
export function cacheWrite1hPriceOf(info: Pick<ModelInfo, 'inputPrice' | 'cacheWrite1hPrice'>): number {
  return info.cacheWrite1hPrice ?? info.inputPrice * 2;
}

/**
 * Cost in USD. Input tokens are the uncached part; cache reads and writes are
 * billed separately. Writes with the 1 hour lifetime (cacheWrite1hTokens, a
 * part of cacheWriteTokens) cost 2x input on Claude, the rest the 5 minute rate.
 */
export function computeCost(info: Pick<ModelInfo, 'inputPrice' | 'outputPrice' | 'cacheReadPrice' | 'cacheWritePrice' | 'cacheWrite1hPrice'>, usage: Usage): number {
  const writes = usage.cacheWriteTokens ?? 0;
  const hour = Math.min(writes, usage.cacheWrite1hTokens ?? 0);
  const cost =
    usage.inputTokens * info.inputPrice +
    usage.outputTokens * info.outputPrice +
    (usage.cacheReadTokens ?? 0) * info.cacheReadPrice +
    (writes - hour) * info.cacheWritePrice +
    hour * cacheWrite1hPriceOf(info);
  return cost / 1e6;
}
