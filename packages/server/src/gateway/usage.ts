/**
 * Usage extraction from relayed responses. The gateway tees the upstream
 * body through a UsageTap while forwarding the original bytes untouched.
 *
 * Token fields follow Conclave's convention (Anthropic style): inputTokens
 * excludes cache reads, outputTokens includes reasoning.
 */

export type WireType = 'anthropic' | 'openai' | 'gemini';

export interface ParsedUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' ? (v as Record<string, any>) : undefined);

function empty(model?: string): ParsedUsage {
  return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/**
 * Anthropic usage object (message, message_start.message, or message_delta).
 * Deltas are cumulative; some compatible APIs send zeros for input fields
 * there, so a delta only overrides input counts with non-zero values.
 */
function anthropicUsage(u: Record<string, any>, into: ParsedUsage, delta = false): void {
  const set = (v: unknown, cur: number) => (typeof v === 'number' && (!delta || v > 0) ? v : cur);
  into.inputTokens = set(u.input_tokens, into.inputTokens);
  into.cacheReadTokens = set(u.cache_read_input_tokens, into.cacheReadTokens);
  into.cacheWriteTokens = set(u.cache_creation_input_tokens, into.cacheWriteTokens);
  if (typeof u.output_tokens === 'number') into.outputTokens = u.output_tokens;
}

/** OpenAI Chat Completions usage: prompt_tokens includes cached tokens. */
function openaiChatUsage(u: Record<string, any>, into: ParsedUsage): void {
  const cached = num(obj(u.prompt_tokens_details)?.cached_tokens);
  into.cacheReadTokens = cached;
  into.inputTokens = Math.max(0, num(u.prompt_tokens) - cached);
  into.outputTokens = num(u.completion_tokens);
  into.reasoningTokens = num(obj(u.completion_tokens_details)?.reasoning_tokens);
}

/** OpenAI Responses API usage. */
function openaiResponsesUsage(u: Record<string, any>, into: ParsedUsage): void {
  const cached = num(obj(u.input_tokens_details)?.cached_tokens);
  into.cacheReadTokens = cached;
  into.inputTokens = Math.max(0, num(u.input_tokens) - cached);
  into.outputTokens = num(u.output_tokens);
  into.reasoningTokens = num(obj(u.output_tokens_details)?.reasoning_tokens);
}

/** Gemini usageMetadata: promptTokenCount includes cached content; thoughts bill as output. */
function geminiUsage(u: Record<string, any>, into: ParsedUsage): void {
  const cached = num(u.cachedContentTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  into.cacheReadTokens = cached;
  into.inputTokens = Math.max(0, num(u.promptTokenCount) + num(u.toolUsePromptTokenCount) - cached);
  into.outputTokens = num(u.candidatesTokenCount) + thoughts;
  into.reasoningTokens = thoughts;
}

/** Usage from a complete (non-streaming) JSON response body. */
export function usageFromJson(type: WireType, body: unknown): ParsedUsage | undefined {
  if (Array.isArray(body)) {
    // Gemini streamGenerateContent without alt=sse returns a JSON array of chunks
    let last: ParsedUsage | undefined;
    for (const item of body) last = usageFromJson(type, item) ?? last;
    return last;
  }
  const b = obj(body);
  if (!b) return undefined;
  if (type === 'anthropic') {
    const u = obj(b.usage);
    if (!u) return undefined;
    const out = empty(typeof b.model === 'string' ? b.model : undefined);
    anthropicUsage(u, out);
    return out;
  }
  if (type === 'openai') {
    if (b.object === 'response' || b.type === 'response.completed') {
      const r = b.object === 'response' ? b : obj(b.response);
      const u = obj(r?.usage);
      if (!u) return undefined;
      const out = empty(typeof r?.model === 'string' ? r.model : undefined);
      openaiResponsesUsage(u, out);
      return out;
    }
    const u = obj(b.usage);
    if (!u) return undefined;
    const out = empty(typeof b.model === 'string' ? b.model : undefined);
    if ('prompt_tokens' in u || 'completion_tokens' in u) openaiChatUsage(u, out);
    else if ('input_tokens' in u) openaiResponsesUsage(u, out);
    else return undefined;
    return out;
  }
  const u = obj(b.usageMetadata);
  if (!u) return undefined;
  const out = empty(typeof b.modelVersion === 'string' ? b.modelVersion : undefined);
  geminiUsage(u, out);
  return out;
}

/** Max bytes buffered to parse a non-SSE JSON body. Bigger bodies are relayed but not metered. */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Incremental reader for a response body. Push every chunk, then call
 * finish(). Works for SSE (by content type) and plain JSON.
 */
export class UsageTap {
  private readonly sse: boolean;
  private readonly decoder = new TextDecoder();
  private buf = '';
  private dataLines: string[] = [];
  private jsonParts: Uint8Array[] = [];
  private jsonBytes = 0;
  private result: ParsedUsage | undefined;
  private model: string | undefined;
  private overflow = false;

  constructor(
    private readonly type: WireType,
    contentType: string | null,
  ) {
    this.sse = !!contentType && contentType.includes('text/event-stream');
  }

  push(chunk: Uint8Array): void {
    if (!this.sse) {
      if (this.overflow) return;
      this.jsonBytes += chunk.byteLength;
      if (this.jsonBytes > MAX_JSON_BYTES) {
        this.overflow = true;
        this.jsonParts = [];
        return;
      }
      this.jsonParts.push(chunk.slice());
      return;
    }
    this.buf += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
    // guard against a stream that never sends a newline
    if (this.buf.length > 4 * 1024 * 1024) this.buf = '';
  }

  private line(line: string): void {
    if (line === '') {
      this.flushEvent();
      return;
    }
    if (line.startsWith('data:')) this.dataLines.push(line.slice(line[5] === ' ' ? 6 : 5));
  }

  private flushEvent(): void {
    if (!this.dataLines.length) return;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    if (data === '[DONE]') return;
    // most chunks carry only text deltas; skip parsing those
    if (!/usage|"model"|modelVersion|message_start|response\.completed/.test(data)) return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    this.event(ev);
  }

  private ensure(): ParsedUsage {
    if (!this.result) this.result = empty(this.model);
    return this.result;
  }

  private event(ev: Record<string, any>): void {
    if (this.type === 'anthropic') {
      if (ev.type === 'message_start') {
        const m = obj(ev.message);
        if (typeof m?.model === 'string') this.model = m.model;
        const u = obj(m?.usage);
        if (u) anthropicUsage(u, this.ensure());
      } else if (ev.type === 'message_delta') {
        const u = obj(ev.usage);
        if (u) anthropicUsage(u, this.ensure(), true);
      }
      return;
    }
    if (this.type === 'openai') {
      if (typeof ev.type === 'string' && ev.type.startsWith('response.')) {
        const r = obj(ev.response);
        if (typeof r?.model === 'string') this.model = r.model;
        const u = obj(r?.usage);
        if (u && (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed')) {
          this.result = empty(this.model);
          openaiResponsesUsage(u, this.result);
        }
        return;
      }
      if (typeof ev.model === 'string') this.model = ev.model;
      const u = obj(ev.usage);
      if (u) {
        this.result = empty(this.model);
        openaiChatUsage(u, this.result);
      }
      return;
    }
    if (typeof ev.modelVersion === 'string') this.model = ev.modelVersion;
    const u = obj(ev.usageMetadata);
    if (u) {
      this.result = empty(this.model);
      geminiUsage(u, this.result);
    }
  }

  finish(): ParsedUsage | undefined {
    if (this.sse) {
      this.buf += this.decoder.decode();
      if (this.buf) {
        for (const l of this.buf.split('\n')) this.line(l.replace(/\r$/, ''));
        this.buf = '';
      }
      this.flushEvent();
      if (this.result && !this.result.model) this.result.model = this.model;
      return this.result;
    }
    if (this.overflow || !this.jsonBytes) return undefined;
    const all = new Uint8Array(this.jsonBytes);
    let off = 0;
    for (const p of this.jsonParts) {
      all.set(p, off);
      off += p.byteLength;
    }
    this.jsonParts = [];
    try {
      return usageFromJson(this.type, JSON.parse(new TextDecoder().decode(all)));
    } catch {
      return undefined;
    }
  }
}
