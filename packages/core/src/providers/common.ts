import type { ContentBlock, ImageBlock, TextBlock, ToolResultBlock } from '../types';
import type { ProviderConfig } from '../config/schema';
import { catalogEntries, familyForProvider, lookupModel, type CatalogEntry } from './catalog';
import { DEFAULT_IDLE_TIMEOUT_MS, type FetchFn, type HttpOptions } from './http';
import type { Effort } from './effort';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types';

export interface ProviderOptions {
  /** Provider id from config ("anthropic", "zai", ...). */
  id: string;
  config: ProviderConfig;
  /** Resolved API key. */
  apiKey?: string;
  /** Extra headers with placeholders already expanded. */
  headers?: Record<string, string>;
  /** Injected for tests. */
  fetch?: FetchFn;
}

export abstract class BaseProvider implements Provider {
  abstract readonly type: 'anthropic' | 'openai' | 'gemini';
  readonly id: string;

  constructor(protected readonly opts: ProviderOptions) {
    this.id = opts.id;
  }

  abstract stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  abstract listModels(): Promise<ModelInfo[]>;

  model(id: string): ModelInfo {
    return lookupModel(this.id, id, { type: this.opts.config.type, override: this.opts.config.modelOverrides?.[id] });
  }

  protected http(signal?: AbortSignal): HttpOptions {
    return { provider: this.id, fetch: this.opts.fetch, signal, timeoutMs: this.opts.config.timeoutMs };
  }

  /** The session header (config.sessionHeader), so a gateway keeps the conversation on one account. */
  protected sessionHeaders(req: ChatRequest): Record<string, string> {
    const name = this.opts.config.sessionHeader;
    return name && req.session ? { [name]: req.session } : {};
  }

  protected get idleTimeoutMs(): number {
    return Math.max(this.opts.config.timeoutMs ?? 0, DEFAULT_IDLE_TIMEOUT_MS);
  }

  /** Models from config, else the catalog entries this provider serves. */
  protected staticModels(): ModelInfo[] {
    const configured = this.opts.config.models;
    if (configured?.length) return configured.map((m) => this.model(m));
    const fam = familyForProvider(this.opts.config.type, this.opts.config.baseUrl);
    if (!fam || fam === 'any') return [];
    return catalogEntries(fam).map((c: CatalogEntry) => this.model(c.id));
  }

  /** Configured models win over the endpoint; otherwise the endpoint, falling back to the catalog. */
  protected async listWith(fetchIds: () => Promise<Array<string | ModelInfo>>): Promise<ModelInfo[]> {
    if (this.opts.config.models?.length) return this.staticModels();
    try {
      const items = await fetchIds();
      if (!items.length) return this.staticModels();
      return items.map((x) => (typeof x === 'string' ? this.model(x) : x));
    } catch (err) {
      const fallback = this.staticModels();
      if (fallback.length) return fallback;
      throw err;
    }
  }
}

/** Parse streamed tool input JSON. Invalid JSON is kept under _raw and marked with _parseError. */
export function parseToolInput(raw: string, initial?: Record<string, unknown>): Record<string, unknown> {
  if (!raw.trim()) return initial ?? {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { _raw: raw, _parseError: 'tool input is not a JSON object' };
  } catch (err) {
    return { _raw: raw, _parseError: (err as Error).message };
  }
}

export function toolResultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content;
  return block.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Tool result as one string for text-only wire formats. Errors are prefixed since there is no is_error flag. */
export function toolResultString(block: ToolResultBlock): string {
  const text = toolResultText(block) || (toolResultImages(block).length ? '(image output follows)' : '(no output)');
  return block.isError ? `Error: ${text}` : text;
}

export function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  if (typeof block.content === 'string') return [];
  return block.content.filter((b): b is ImageBlock => b.type === 'image');
}

export function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

export function isTextMediaType(mediaType: string): boolean {
  return /^text\/|^application\/(json|xml|yaml|x-yaml|javascript|typescript|x-sh)/.test(mediaType);
}

export function decodeBase64Text(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8');
}

/** A text rendering of a document for providers without native document input. */
export function documentAsText(block: Extract<ContentBlock, { type: 'document' }>): string | undefined {
  const title = block.title ? `Document: ${block.title}\n` : '';
  if (block.data && isTextMediaType(block.mediaType)) return `${title}${decodeBase64Text(block.data)}`;
  if (block.url) return `${title}${block.url}`;
  return undefined;
}

/** True when the request asks for thinking: a level or a budget, not Off. */
export function wantsThinking(thinking: ChatRequest['thinking']): boolean {
  return !!thinking && !thinking.off;
}

/** Effort from an explicit level or a token budget. */
export function effortOf(thinking: ChatRequest['thinking']): Effort | undefined {
  if (!thinking || thinking.off) return undefined;
  if (thinking.effort) return thinking.effort;
  const b = thinking.budgetTokens;
  if (b === undefined) return 'medium';
  if (b <= 4096) return 'low';
  if (b <= 16_384) return 'medium';
  return 'high';
}

/** Token budget from an explicit budget or an effort level. */
export function budgetOf(thinking: ChatRequest['thinking']): number | undefined {
  if (!thinking || thinking.off) return undefined;
  if (thinking.budgetTokens !== undefined) return thinking.budgetTokens;
  return { low: 4096, medium: 12_000, high: 32_000, xhigh: 48_000, max: 64_000 }[thinking.effort ?? 'medium'];
}
