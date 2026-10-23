import type { ContentBlock, ImageBlock, StopReason, Usage } from '../types';
import { BaseProvider, dataUrl, documentsForWire, effortOf, parseToolInput, toolResultImages, toolResultString, wantsThinking } from './common';
import { classifyStreamError, parseRateLimitHeaders } from './errors';
import { hostOf, openStream, trimSlash } from './http';
import { OPENAI_DEFAULT_BASE, listOpenAIModels, openaiEmbed, openaiHeaders, openaiUsage } from './openai-shared';
import { ownSignature, tagSignature } from './signatures';
import { parseSse, parseSseJson } from './sse';
import { ToolNameMap } from './tool-names';
import type { ChatRequest, ModelInfo, StreamEvent } from './types';

type Wire = Record<string, unknown>;

/** Encrypted reasoning travels in ThinkingBlock.signature as a tagged JSON payload. */
interface ReasoningPayload {
  id?: string;
  enc: string;
}

function encodeReasoning(model: string, p: ReasoningPayload): string {
  return tagSignature('openai-responses', model, JSON.stringify(p));
}

function decodeReasoning(sig: string | undefined, model: string): ReasoningPayload | undefined {
  const own = ownSignature(sig, 'openai-responses', model);
  if (!own) return undefined;
  try {
    const p = JSON.parse(own.payload) as ReasoningPayload;
    return p.enc ? p : undefined;
  } catch {
    return undefined;
  }
}

function imagePart(b: ImageBlock): Wire | undefined {
  const url = b.data ? dataUrl(b.mediaType, b.data) : b.url;
  return url ? { type: 'input_image', image_url: url, detail: 'auto' } : undefined;
}

function userPart(b: ContentBlock): Wire | undefined {
  switch (b.type) {
    case 'text':
      return b.text ? { type: 'input_text', text: b.text } : undefined;
    case 'image':
      return imagePart(b);
    case 'document':
      // only PDFs are left as documents (documentsForWire)
      if (b.data) return { type: 'input_file', filename: b.title ?? 'document.pdf', file_data: dataUrl(b.mediaType, b.data) };
      return b.url ? { type: 'input_file', file_url: b.url } : undefined;
    default:
      return undefined;
  }
}

/** Conversation as Responses input items. Encrypted reasoning is replayed only for the model that produced it. */
export function responsesInput(req: ChatRequest, names: ToolNameMap): Wire[] {
  const items: Wire[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      let text: string[] = [];
      const flush = () => {
        if (text.length) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text.join('\n\n') }] });
        text = [];
      };
      for (const b of m.content) {
        if (b.type === 'text') {
          if (b.text) text.push(b.text);
        } else if (b.type === 'thinking') {
          const r = decodeReasoning(b.signature, req.model);
          if (!r) continue;
          flush();
          // The id is left out: with store=false the server cannot resolve item ids.
          items.push({ type: 'reasoning', summary: b.thinking ? [{ type: 'summary_text', text: b.thinking }] : [], encrypted_content: r.enc });
        } else if (b.type === 'tool_use') {
          flush();
          items.push({ type: 'function_call', call_id: b.id, name: names.wire(b.name), arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      flush();
      continue;
    }

    const parts: Wire[] = [];
    for (const b of documentsForWire(m.content, true)) {
      if (b.type === 'tool_result') {
        items.push({ type: 'function_call_output', call_id: b.toolUseId, output: toolResultString(b) });
        const imgs = toolResultImages(b)
          .map(imagePart)
          .filter((x): x is Wire => !!x);
        if (imgs.length) parts.push({ type: 'input_text', text: `Images returned by tool call ${b.toolUseId}:` }, ...imgs);
      } else {
        const p = userPart(b);
        if (p) parts.push(p);
      }
    }
    if (parts.length) items.push({ type: 'message', role: 'user', content: parts });
  }
  return items;
}

class ResponsesStream {
  private blocks = new Map<number, ContentBlock>();
  private byItem = new Map<string, number>();
  private byOutput = new Map<number, number>();
  private args = new Map<number, string>();
  private next = 0;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private stop?: StopReason;
  private accessPrograms?: Record<string, string>;
  private started = false;

  constructor(
    private provider: string,
    private model: string,
    private names: ToolNameMap,
    private headers: Headers,
  ) {}

  private startEvents(id?: string, model?: string): StreamEvent[] {
    if (this.started) return [];
    this.started = true;
    const out: StreamEvent[] = [{ type: 'start', id, model }];
    const windows = parseRateLimitHeaders(this.provider, this.headers);
    if (windows.length) out.push({ type: 'rate_limit', windows });
    return out;
  }

  private indexOf(data: Record<string, any>): number | undefined {
    if (typeof data.item_id === 'string' && this.byItem.has(data.item_id)) return this.byItem.get(data.item_id);
    if (typeof data.output_index === 'number') return this.byOutput.get(data.output_index);
    return undefined;
  }

  private alloc(data: Record<string, any>, itemId?: string): number {
    const idx = this.next++;
    if (itemId) this.byItem.set(itemId, idx);
    if (typeof data.output_index === 'number') this.byOutput.set(data.output_index, idx);
    return idx;
  }

  /** Block for a delta event, created if the server skipped output_item.added. */
  private blockFor(data: Record<string, any>, make: () => ContentBlock): [number, ContentBlock] {
    let idx = this.indexOf(data);
    if (idx === undefined) {
      idx = this.alloc(data, data.item_id);
      this.blocks.set(idx, make());
    }
    return [idx, this.blocks.get(idx)!];
  }

  handle(raw: unknown): StreamEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const data = raw as Record<string, any>;
    const type = data.type as string;
    const out: StreamEvent[] = [];

    if (type === 'error') throw classifyStreamError(this.provider, data, this.headers);
    if (type === 'response.failed') throw classifyStreamError(this.provider, data.response?.error ?? { message: 'response failed' }, this.headers);
    if (type === 'response.created' || type === 'response.in_progress') {
      out.push(...this.startEvents(data.response?.id, data.response?.model));
      return out;
    }
    out.push(...this.startEvents());

    switch (type) {
      case 'response.output_item.added': {
        const item = data.item ?? {};
        if (item.type === 'reasoning') {
          this.blocks.set(this.alloc(data, item.id), { type: 'thinking', thinking: '' });
        } else if (item.type === 'message') {
          this.blocks.set(this.alloc(data, item.id), { type: 'text', text: '' });
        } else if (item.type === 'function_call') {
          const idx = this.alloc(data, item.id);
          const id = item.call_id ?? item.id ?? `call_${idx}`;
          const name = this.names.original(item.name ?? '');
          this.blocks.set(idx, { type: 'tool_use', id, name, input: {} });
          out.push({ type: 'tool_use_start', index: idx, id, name });
          if (item.arguments) {
            this.args.set(idx, item.arguments);
            out.push({ type: 'tool_use_delta', index: idx, partialJson: item.arguments });
          }
        }
        break;
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        if (type === 'response.refusal.delta') this.stop = 'refusal';
        const [idx, b] = this.blockFor(data, () => ({ type: 'text', text: '' }));
        if (b.type === 'text') b.text += data.delta ?? '';
        out.push({ type: 'text_delta', index: idx, text: data.delta ?? '' });
        break;
      }
      case 'response.reasoning_summary_part.added': {
        const [idx, b] = this.blockFor(data, () => ({ type: 'thinking', thinking: '' }));
        if (b.type === 'thinking' && b.thinking) {
          b.thinking += '\n\n';
          out.push({ type: 'thinking_delta', index: idx, text: '\n\n' });
        }
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const [idx, b] = this.blockFor(data, () => ({ type: 'thinking', thinking: '' }));
        if (b.type === 'thinking') b.thinking += data.delta ?? '';
        out.push({ type: 'thinking_delta', index: idx, text: data.delta ?? '' });
        break;
      }
      case 'response.function_call_arguments.delta': {
        const idx = this.indexOf(data);
        if (idx === undefined) break;
        this.args.set(idx, (this.args.get(idx) ?? '') + (data.delta ?? ''));
        out.push({ type: 'tool_use_delta', index: idx, partialJson: data.delta ?? '' });
        break;
      }
      case 'response.function_call_arguments.done': {
        const idx = this.indexOf(data);
        if (idx !== undefined && typeof data.arguments === 'string') this.args.set(idx, data.arguments);
        break;
      }
      case 'response.output_item.done': {
        const item = data.item ?? {};
        const idx = typeof item.id === 'string' && this.byItem.has(item.id) ? this.byItem.get(item.id) : this.indexOf(data);
        if (idx === undefined) break;
        const b = this.blocks.get(idx);
        if (!b) break;
        if (b.type === 'thinking' && item.type === 'reasoning') {
          if (!b.thinking && Array.isArray(item.summary)) b.thinking = item.summary.map((s: { text?: string }) => s.text ?? '').join('\n\n');
          if (item.encrypted_content) b.signature = encodeReasoning(this.model, { id: item.id, enc: item.encrypted_content });
        } else if (b.type === 'text' && item.type === 'message' && Array.isArray(item.content)) {
          // a refusal part (type "refusal") is the model saying no, even when it came without deltas
          if (item.content.some((c: { type?: string; refusal?: unknown }) => c.type === 'refusal' || typeof c.refusal === 'string')) this.stop = 'refusal';
          if (!b.text) b.text = item.content.map((c: { text?: string; refusal?: string }) => c.text ?? c.refusal ?? '').join('');
        } else if (b.type === 'tool_use' && item.type === 'function_call') {
          if (typeof item.arguments === 'string') this.args.set(idx, item.arguments);
          if (item.call_id) b.id = item.call_id;
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = data.response ?? {};
        if (r.usage) this.usage = openaiUsage(r.usage);
        // the access program that served the answer (a ChatGPT plan asked for Daybreak Blue may be served standard)
        if (r.access_programs && typeof r.access_programs === 'object') this.accessPrograms = r.access_programs;
        if (type === 'response.incomplete' && this.stop !== 'refusal') {
          this.stop = r.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'max_tokens';
        }
        break;
      }
    }
    return out;
  }

  finish(): StreamEvent[] {
    const out = this.startEvents();
    const content: ContentBlock[] = [];
    for (const [idx, b] of [...this.blocks.entries()].sort((a, c) => a[0] - c[0])) {
      if (b.type === 'tool_use') b.input = parseToolInput(this.args.get(idx) ?? '');
      content.push(b);
    }
    const stopReason = this.stop ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    out.push({ type: 'done', content, stopReason, usage: this.usage, ...(this.accessPrograms ? { accessPrograms: this.accessPrograms } : {}) });
    return out;
  }
}

/** OpenAI Responses API (GPT-5.x, codex). Stateless: store=false with encrypted reasoning replay. */
export class OpenAIResponsesProvider extends BaseProvider {
  readonly type = 'openai' as const;

  get baseUrl(): string {
    return trimSlash(this.opts.config.baseUrl ?? OPENAI_DEFAULT_BASE);
  }

  get official(): boolean {
    return hostOf(this.baseUrl) === 'api.openai.com';
  }

  headers(): Record<string, string> {
    return openaiHeaders(this.opts);
  }

  buildBody(req: ChatRequest, names = new ToolNameMap()): Wire {
    const info = this.model(req.model);
    const body: Wire = { model: req.model, input: responsesInput(req, names), store: false };
    const instructions = req.system
      .map((s) => s.text)
      .filter(Boolean)
      .join('\n\n');
    if (instructions) body.instructions = instructions;
    if (info.thinking) body.include = ['reasoning.encrypted_content'];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        name: names.wire(t.name),
        description: t.description,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        strict: false,
      }));
      body.parallel_tool_calls = true;
      const tc = req.toolChoice;
      if (tc) body.tool_choice = tc === 'any' ? 'required' : typeof tc === 'object' ? { type: 'function', name: names.wire(tc.name) } : tc;
    }
    if (req.maxTokens) body.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined && !info.thinking) body.temperature = req.temperature;
    if (wantsThinking(req.thinking) && info.thinking) body.reasoning = { effort: effortOf(req.thinking), summary: 'auto' };
    if (req.cacheKey && this.official) body.prompt_cache_key = req.cacheKey;
    if (req.responseSchema) body.text = { format: { type: 'json_schema', name: 'response', schema: req.responseSchema, strict: false } };
    if (req.accessPrograms) body.access_programs = { cyber: req.accessPrograms.cyber };
    return body;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const names = new ToolNameMap();
    const body = { ...this.buildBody(req, names), stream: true };
    const res = await openStream(`${this.baseUrl}/responses`, { ...this.headers(), ...this.sessionHeaders(req) }, body, this.http(req.signal));
    const state = new ResponsesStream(this.id, req.model, names, res.headers);
    for await (const msg of parseSse(res, { signal: req.signal, idleTimeoutMs: this.idleTimeoutMs, provider: this.id })) {
      for (const data of parseSseJson(msg.data)) yield* state.handle(data);
    }
    yield* state.finish();
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.listWith(() =>
      listOpenAIModels({
        baseUrl: this.baseUrl,
        headers: this.headers(),
        http: this.http(),
        official: this.official,
        model: (id) => this.model(id),
        hasOverride: (id) => !!this.opts.config.modelOverrides?.[id],
      }),
    );
  }

  embed(texts: string[], model = 'text-embedding-3-small'): Promise<number[][]> {
    return openaiEmbed(this.baseUrl, this.headers(), this.http(), texts, model);
  }
}
