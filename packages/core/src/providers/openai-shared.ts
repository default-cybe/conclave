import type { Usage } from '../types';
import type { ProviderOptions } from './common';
import { getJson, postJson, type HttpOptions } from './http';
import type { ModelInfo } from './types';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

export function openaiHeaders(opts: ProviderOptions): Record<string, string> {
  const extra = opts.headers ?? {};
  const h: Record<string, string> = {};
  const hasAuth = Object.keys(extra).some((k) => k.toLowerCase() === 'authorization');
  if (opts.apiKey && !hasAuth) h.authorization = `Bearer ${opts.apiKey}`;
  return { ...h, ...extra };
}

type Num = number | undefined;
const n = (v: unknown): Num => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Normalize OpenAI style usage. inputTokens is the uncached part so that
 * cost = input * price + cacheRead * cachePrice, matching Anthropic semantics.
 * Handles Chat Completions (prompt_tokens), Responses (input_tokens),
 * DeepSeek (prompt_cache_hit_tokens), Moonshot (cached_tokens) and
 * OpenRouter (cost).
 */
export function openaiUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, any>;
  const prompt = n(u.prompt_tokens) ?? n(u.input_tokens) ?? 0;
  const output = n(u.completion_tokens) ?? n(u.output_tokens) ?? 0;
  const inDetails = u.prompt_tokens_details ?? u.input_tokens_details ?? {};
  const outDetails = u.completion_tokens_details ?? u.output_tokens_details ?? {};
  const cached = n(inDetails.cached_tokens) ?? n(u.prompt_cache_hit_tokens) ?? n(u.cached_tokens) ?? 0;
  const usage: Usage = { inputTokens: Math.max(0, prompt - cached), outputTokens: output };
  if (cached) usage.cacheReadTokens = cached;
  const written = n(inDetails.cache_write_tokens) ?? n(inDetails.cache_creation_tokens);
  if (written) {
    usage.cacheWriteTokens = written;
    usage.inputTokens = Math.max(0, usage.inputTokens - written);
  }
  const reasoning = n(outDetails.reasoning_tokens);
  if (reasoning) usage.reasoningTokens = reasoning;
  if (n(u.cost) !== undefined) usage.costUsd = u.cost;
  return usage;
}

const OFFICIAL_SKIP = /audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct|dall-e|whisper|babbage|davinci|sora/;

interface ListedModel {
  id: string;
  name?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null; context_length?: number | null };
  pricing?: Record<string, string | number | undefined>;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

const perTokenToMillion = (v: unknown): number | undefined => {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) && x >= 0 ? Math.round(x * 1e6 * 1e6) / 1e6 : undefined;
};

/**
 * GET {base}/models. On api.openai.com only chat-capable families are kept.
 * Rich listings (OpenRouter: context_length, pricing, modalities) fill in
 * what the catalog does not know, unless config overrides the model.
 */
export async function listOpenAIModels(args: {
  baseUrl: string;
  headers: Record<string, string>;
  http: HttpOptions;
  official: boolean;
  model: (id: string) => ModelInfo;
  hasOverride: (id: string) => boolean;
}): Promise<ModelInfo[]> {
  const res = await getJson<{ data?: ListedModel[] } | ListedModel[]>(`${args.baseUrl}/models`, args.headers, args.http);
  const items = Array.isArray(res) ? res : (res.data ?? []);
  const out: ModelInfo[] = [];
  for (const m of items) {
    if (!m?.id) continue;
    if (args.official ? !/^(gpt-|o\d|codex|chatgpt-)/.test(m.id) || OFFICIAL_SKIP.test(m.id) : /embed|whisper|tts|rerank/i.test(m.id)) continue;
    const info = args.model(m.id);
    if (!args.hasOverride(m.id)) {
      if (m.name && info.name === m.id) info.name = m.name;
      const ctx = m.context_length ?? m.top_provider?.context_length;
      if (ctx) info.contextWindow = ctx;
      if (m.top_provider?.max_completion_tokens) info.maxOutput = m.top_provider.max_completion_tokens;
      if (m.architecture?.input_modalities?.includes('image')) info.vision = true;
      if (m.supported_parameters?.includes('reasoning')) info.thinking = true;
      if (m.supported_parameters && !m.supported_parameters.includes('tools')) info.tools = false;
      const p = m.pricing;
      if (p) {
        info.inputPrice = perTokenToMillion(p.prompt) ?? info.inputPrice;
        info.outputPrice = perTokenToMillion(p.completion) ?? info.outputPrice;
        info.cacheReadPrice = perTokenToMillion(p.input_cache_read) ?? info.cacheReadPrice;
        info.cacheWritePrice = perTokenToMillion(p.input_cache_write) ?? info.cacheWritePrice;
      }
    }
    out.push(info);
  }
  return out;
}

/** POST {base}/embeddings in batches, results in input order. */
export async function openaiEmbed(
  baseUrl: string,
  headers: Record<string, string>,
  http: HttpOptions,
  texts: string[],
  model: string,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 256) {
    const batch = texts.slice(i, i + 256);
    const res = await postJson<{ data?: Array<{ index: number; embedding: number[] }> }>(
      `${baseUrl}/embeddings`,
      headers,
      { model, input: batch },
      http,
    );
    const data = [...(res.data ?? [])].sort((a, b) => a.index - b.index);
    out.push(...data.map((d) => d.embedding));
  }
  return out;
}
