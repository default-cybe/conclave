/**
 * Custom providers from Settings > Providers: check a provider entry at the
 * config trust boundary, and probe an endpoint the owner typed (its model
 * list, one model) without saving anything. Owner only (route-policy admin):
 * the owner can already point a provider at any address, so a probe reaches
 * nothing on the hub's network that config could not. The key is never
 * logged and never echoed back.
 */
import type { ProviderConfig, ProviderType } from '@conclave/core/config/schema.ts';
import { createProvider } from '@conclave/core/providers/registry.ts';
import type { ProviderError } from '@conclave/core/providers/types.ts';
import { badRequest } from './http';

const PROVIDER_TYPES: readonly ProviderType[] = ['anthropic', 'openai', 'gemini', 'acp'];
/** The wires a custom endpoint can speak (the dialog's API style). */
export const CUSTOM_TYPES = ['openai', 'anthropic'] as const;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PROBE_TIMEOUT_MS = 10_000;

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * What is wrong with the providers part of a config patch, or undefined.
 * A new id needs a safe id and a supported type; a baseUrl (after ${VAR}
 * expansion) must be http(s) on any entry. null removes an entry.
 */
export function providerPatchProblem(providers: unknown, known: Record<string, unknown>, expand: (s: string) => string): string | undefined {
  if (providers === undefined) return undefined;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return 'providers must be an object';
  for (const [id, p] of Object.entries(providers as Record<string, unknown>)) {
    if (p === null) continue;
    if (typeof p !== 'object' || Array.isArray(p)) return `providers.${id} must be an object`;
    const e = p as Partial<Record<keyof ProviderConfig, unknown>>;
    const isNew = !known[id];
    if (isNew && !PROVIDER_ID.test(id)) return `providers.${id}: the id must be lowercase letters, digits and dashes`;
    if ((isNew || e.type !== undefined) && !PROVIDER_TYPES.includes(e.type as ProviderType)) return `providers.${id}.type must be one of ${PROVIDER_TYPES.join(', ')}`;
    if (e.baseUrl !== undefined && (typeof e.baseUrl !== 'string' || !isHttpUrl(expand(e.baseUrl)))) return `providers.${id}.baseUrl must be an http or https URL`;
  }
  return undefined;
}

/** The ids in a providers patch that are set to null (remove the entry). */
export function removedProviders(providers: unknown): string[] {
  if (!providers || typeof providers !== 'object') return [];
  return Object.entries(providers as Record<string, unknown>)
    .filter(([, p]) => p === null)
    .map(([id]) => id);
}

interface ProbeBody {
  type?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
}

function probeTarget(b: ProbeBody) {
  if (!CUSTOM_TYPES.includes(b.type as (typeof CUSTOM_TYPES)[number])) throw badRequest(`type must be one of ${CUSTOM_TYPES.join(', ')}`);
  if (typeof b.baseUrl !== 'string' || !isHttpUrl(b.baseUrl.trim())) throw badRequest('baseUrl must be an http or https URL');
  if (b.apiKey !== undefined && b.apiKey !== null && typeof b.apiKey !== 'string') throw badRequest('apiKey must be a string');
  const baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  const provider = createProvider('custom', { type: b.type as ProviderType, baseUrl, timeoutMs: PROBE_TIMEOUT_MS }, { apiKey: apiKey || undefined })!;
  const host = new URL(baseUrl).host;
  // an error body may quote the request back: never let the key leave in it
  const clean = (s: string) => (apiKey ? s.split(apiKey).join('***') : s).slice(0, 300);
  return { provider, host, clean };
}

/** A provider error in words: a rejected key, a missing model list, an unreachable host. */
function errorWords(err: unknown, host: string, list: boolean): string {
  const e = err as ProviderError;
  const msg = e?.message ?? String(err);
  if (e?.status === 401 || e?.status === 403) return `${host} rejected the key (${e.status}).`;
  if (list && e?.status === 404) return `${host} has no model list (404). Add model ids by hand.`;
  if (e?.kind === 'network' || /timed out|timeout/i.test(msg)) return `Could not reach ${host}. ${msg}`;
  return msg;
}

/** The model ids the endpoint lists (OpenAI GET /models, Anthropic GET /v1/models). */
export async function probeModels(b: ProbeBody): Promise<{ ok: boolean; models: string[]; detail?: string }> {
  const t = probeTarget(b);
  try {
    const models = (await t.provider.listModels()).map((m) => m.id);
    return models.length
      ? { ok: true, models }
      : {
          ok: false,
          models: [],
          detail: `${t.host} listed no models. Add model ids by hand.`,
        };
  } catch (err) {
    return {
      ok: false,
      models: [],
      detail: t.clean(errorWords(err, t.host, true)),
    };
  }
}

/** One tiny real request (max 1 token) to one model on the endpoint's wire. */
export async function probeModel(b: ProbeBody): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
  if (typeof b.model !== 'string' || !b.model.trim()) throw badRequest('model is required');
  const model = b.model.trim();
  const t = probeTarget(b);
  const started = performance.now();
  try {
    for await (const _ of t.provider.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
      maxTokens: 1,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
    })) {
      // drain: an error on this wire throws
    }
    return {
      ok: true,
      detail: `${model} answered`,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      detail: t.clean(errorWords(err, t.host, false)),
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
