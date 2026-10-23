import type { ContentBlock, ImageBlock, TextBlock, ToolResultBlock } from '../types';
import { isZip, mediaTypeFor } from '../attachments/limits';
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
  return /^text\/|^application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|sql|x-ndjson)|\+(json|xml|yaml)$/.test(mediaType);
}

/** One attached document's text at most; the rest is cut with a note. */
export const DOC_TEXT_MAX_BYTES = 200 * 1024;
/** All documents' text in one message: the budget the hub gives a zip's text files (attachments/zip.ts ZIP_TEXT_MAX_BYTES). */
export const MESSAGE_DOCS_MAX_BYTES = 512 * 1024;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Its text when it is UTF-8 with no NUL bytes, else undefined (a binary). */
function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * A user message's documents as a wire takes them. Text documents become
 * `<document name type>` text blocks, cut at DOC_TEXT_MAX_BYTES each and
 * MESSAGE_DOCS_MAX_BYTES together; PDFs stay document blocks when the wire
 * reads them (`pdf`); anything else (a binary, an archive, a PDF the wire
 * cannot read) becomes a one-line note, so the model always learns what was
 * attached. Base64 of a binary is never sent as text.
 */
export function documentsForWire(content: ContentBlock[], pdf: boolean): ContentBlock[] {
  if (!content.some((b) => b.type === 'document')) return content;
  let room = MESSAGE_DOCS_MAX_BYTES;
  const note = (text: string): TextBlock => ({ type: 'text', text });
  return content.map((b): ContentBlock => {
    if (b.type !== 'document') return b;
    const name = (b.title ?? '').replace(/["\r\n\t]+/g, ' ').trim() || 'document';
    const type = mediaTypeFor(b.mediaType, b.title);
    if (type === 'application/pdf') return pdf && (b.data || b.url) ? { ...b, mediaType: type } : note(`[PDF ${name} not readable by this model]`);
    if (!b.data) return note(b.url ? `[Attached ${name} (${type}): ${b.url}]` : `[Attached ${name} (${type}): empty]`);
    const bytes = Buffer.from(b.data, 'base64');
    if (isZip(type, b.title) || bytes.subarray(0, 4).equals(ZIP_MAGIC)) return note(`[archive ${name}, ${bytes.length} bytes: not opened]`);
    const text = isTextMediaType(type) ? textOf(bytes) : undefined;
    if (text === undefined) return note(`[Attached ${name} (${type}, ${bytes.length} bytes): not readable by this model]`);
    if (room <= 0) return note(`[Attached ${name} (${type}, ${kb(bytes.length)}): left out, this message's attachments pass ${kb(MESSAGE_DOCS_MAX_BYTES)} of text]`);
    const max = Math.min(DOC_TEXT_MAX_BYTES, room);
    // cut on a byte boundary, then drop a character split in half
    const body = bytes.length > max ? `${bytes.subarray(0, max).toString('utf8').replace(/\uFFFD$/, '')}\n[truncated after ${kb(max)}]` : text;
    room -= Math.min(bytes.length, max);
    return note(`<document name="${name}" type="${type}">\n${body}\n</document>`);
  });
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
  return { low: 4096, medium: 12_000, high: 32_000, xhigh: 48_000, max: 64_000, ultra: 64_000 }[thinking.effort ?? 'medium'];
}
