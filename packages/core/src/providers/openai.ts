import type { ContentBlock, ImageBlock, StopReason, Usage } from '../types';
import { findCatalogEntry, normalizeModelId } from './catalog';
import { BaseProvider, budgetOf, dataUrl, documentsForWire, effortOf, parseToolInput, toolResultMedia, toolResultString, wantsThinking } from './common';
import { classifyStreamError, parseRateLimitHeaders } from './errors';
import { SKIP_SIGNATURE as GEMINI_SKIP_SIGNATURE } from './gemini';
import { hostOf, openStream, trimSlash } from './http';
import { OpenAIResponsesProvider } from './openai-responses';
import { OPENAI_DEFAULT_BASE, listOpenAIModels, openaiEmbed, openaiHeaders, openaiUsage } from './openai-shared';
import { ownSignature, tagSignature } from './signatures';
import { parseSse, parseSseJson } from './sse';
import { ToolNameMap } from './tool-names';
import type { ChatRequest, ModelInfo, ProviderMessage, StreamEvent } from './types';

type Wire = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

function imagePart(b: ImageBlock): Wire | undefined {
  const url = b.data ? dataUrl(b.mediaType, b.data) : b.url;
  return url ? { type: 'image_url', image_url: { url } } : undefined;
}

function userPart(b: ContentBlock): Wire | undefined {
  switch (b.type) {
    case 'text':
      return b.text ? { type: 'text', text: b.text } : undefined;
    case 'image':
      return imagePart(b);
    case 'document':
      // only PDFs are left as documents (documentsForWire); the file part takes data, not a URL
      if (b.data) return { type: 'file', file: { filename: b.title ?? 'document.pdf', file_data: dataUrl(b.mediaType, b.data) } };
      return b.url ? { type: 'text', text: `[PDF ${b.title ?? 'document'}: ${b.url}]` } : undefined;
    default:
      return undefined;
  }
}

/** Plain string when every part is text: several compatible APIs reject content arrays. */
function partsToContent(parts: Wire[]): string | Wire[] {
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text as string).join('\n\n');
  return parts;
}

function assistantMessage(m: ProviderMessage, names: ToolNameMap, model: string): Wire | undefined {
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: Wire[] = [];
  for (const b of m.content) {
    if (b.type === 'text' && b.text) text.push(b.text);
    else if (b.type === 'thinking' && b.thinking && ownSignature(b.signature, 'openai-chat', model)) reasoning.push(b.thinking);
    else if (b.type === 'tool_use') {
      const call: Wire = { id: b.id, type: 'function', function: { name: names.wire(b.name), arguments: JSON.stringify(b.input ?? {}) } };
      // Gemini 3 behind a Chat Completions endpoint checks the thought signature on the first call of a turn; a call from another model gets the documented skip value
      const sig = ownSignature(b.signature, 'openai-chat', model)?.payload || (!toolCalls.length && GEMINI3.test(normalizeModelId(model)) ? GEMINI_SKIP_SIGNATURE : '');
      if (sig) call.extra_content = { google: { thought_signature: sig } };
      toolCalls.push(call);
    }
  }
  if (!text.length && !toolCalls.length) return undefined;
  const msg: Wire = { role: 'assistant', content: text.length ? text.join('\n\n') : null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  // DeepSeek, GLM and Kimi expect their own reasoning back during tool loops.
  if (reasoning.length) msg.reasoning_content = reasoning.join('\n\n');
  return msg;
}

/**
 * Chat Completions messages. Tool results become role "tool" messages; tool
 * messages are text only, so images from tool results go into the next user
 * message.
 */
export function chatMessages(req: ChatRequest, names: ToolNameMap, pdf = true, vision = true): Wire[] {
  const out: Wire[] = [];
  const system = req.system
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const a = assistantMessage(m, names, req.model);
      if (a) out.push(a);
      continue;
    }
    const tools: Wire[] = [];
    const parts: Wire[] = [];
    for (const b of documentsForWire(m.content, pdf, vision)) {
      if (b.type === 'tool_result') {
        tools.push({ role: 'tool', tool_call_id: b.toolUseId, content: toolResultString(b) });
        const imgs = toolResultMedia(b)
          .map(userPart)
          .filter((x): x is Wire => !!x);
        if (imgs.length) parts.push({ type: 'text', text: `Images returned by tool call ${b.toolUseId}:` }, ...imgs);
      } else {
        const p = userPart(b);
        if (p) parts.push(p);
      }
    }
    out.push(...tools);
    if (parts.length) out.push({ role: 'user', content: partsToContent(parts) });
  }
  return out;
}

const GEMINI3 = /^gemini-([3-9]|\d{2})/;

/** Z.ai and its mainland twin (open.bigmodel.cn). */
const ZAI_HOST = /(^|\.)z\.ai$|bigmodel\.cn$/;

/** Reasoning switches differ per vendor behind the same wire format. */
function reasoningParams(host: string, req: ChatRequest, info: ModelInfo): Wire {
  // Z.ai thinks unless told not to, so off (or unset, as on titles and memory calls) is sent; clear_thinking false keeps GLM's reasoning across a tool loop
  if (info.thinking && ZAI_HOST.test(host)) {
    return req.thinking && wantsThinking(req.thinking) ? { thinking: { type: 'enabled', clear_thinking: false } } : { thinking: { type: 'disabled' } };
  }
  if (!req.thinking || !wantsThinking(req.thinking) || !info.thinking) return {};
  const effort = effortOf(req.thinking);
  if (host.endsWith('openrouter.ai')) {
    return { reasoning: req.thinking.budgetTokens ? { max_tokens: req.thinking.budgetTokens } : { effort } };
  }
  if (/deepseek\.com$/.test(host)) return { thinking: { type: 'enabled' } };
  if (/dashscope|aliyuncs\.com$/.test(host)) return { enable_thinking: true, thinking_budget: budgetOf(req.thinking) };
  return { reasoning_effort: effort };
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

interface ToolAcc {
  index: number;
  id: string;
  name: string;
  args: string;
  started: boolean;
  /** Gemini's thought signature (extra_content.google.thought_signature), sent back with the call. */
  sig?: string;
}

/**
 * finish_reason values that are not a plain stop. content_filter is OpenAI's
 * (and Azure's) filter; sensitive is Z.ai's: its OpenAI-compatible API ends a
 * reply its safety review stopped with finish_reason "sensitive"
 * (docs.z.ai, chat completions). Both are refusals the provider signals.
 */
export const CHAT_FINISH: Record<string, StopReason> = {
  length: 'max_tokens',
  content_filter: 'refusal',
  sensitive: 'refusal',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
};

class ChatStream {
  private blocks = new Map<number, ContentBlock>();
  private next = 0;
  private textIndex?: number;
  private thinkingIndex?: number;
  private tools: ToolAcc[] = [];
  private byWireIndex = new Map<number, ToolAcc>();
  private byId = new Map<string, ToolAcc>();
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private finish?: string;
  /** The model said it refuses (OpenAI's refusal field on the message). */
  private refused = false;
  private started = false;

  constructor(
    private provider: string,
    private model: string,
    private names: ToolNameMap,
    private headers: Headers,
  ) {}

  private newTool(id: string, wireIndex: number): ToolAcc {
    const acc: ToolAcc = { index: this.next++, id, name: '', args: '', started: false };
    this.tools.push(acc);
    this.byWireIndex.set(wireIndex, acc);
    if (id) this.byId.set(id, acc);
    return acc;
  }

  /**
   * Find the accumulator for a tool call delta. Ids win when present
   * (some servers reuse index 0 for every call); id-less deltas continue the
   * latest call at that index.
   */
  private toolFor(tc: Record<string, any>): ToolAcc {
    const wi = typeof tc.index === 'number' ? tc.index : 0;
    const id = typeof tc.id === 'string' && tc.id ? tc.id : undefined;
    if (id) {
      const known = this.byId.get(id);
      if (known) return known;
      const cur = this.byWireIndex.get(wi);
      if (cur && !cur.id) {
        cur.id = id;
        this.byId.set(id, cur);
        return cur;
      }
      return this.newTool(id, wi);
    }
    return this.byWireIndex.get(wi) ?? this.newTool('', wi);
  }

  handle(raw: unknown): StreamEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const chunk = raw as Record<string, any>;
    if (chunk.error) throw classifyStreamError(this.provider, chunk.error, this.headers);
    const out: StreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({ type: 'start', id: chunk.id, model: chunk.model });
      const windows = parseRateLimitHeaders(this.provider, this.headers);
      if (windows.length) out.push({ type: 'rate_limit', windows });
    }
    if (chunk.usage) this.usage = openaiUsage(chunk.usage);

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return out;
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, any>;

    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning) {
      if (this.thinkingIndex === undefined) {
        this.thinkingIndex = this.next++;
        this.blocks.set(this.thinkingIndex, { type: 'thinking', thinking: '', signature: tagSignature('openai-chat', this.model) });
      }
      const b = this.blocks.get(this.thinkingIndex);
      if (b?.type === 'thinking') b.thinking += reasoning;
      out.push({ type: 'thinking_delta', index: this.thinkingIndex, text: reasoning });
    }

    // OpenAI sends a refusal in its own field (structured outputs, safety): shown as the reply's text, and the stop is a refusal
    const refusal = typeof delta.refusal === 'string' ? delta.refusal : '';
    if (refusal) this.refused = true;
    const content =
      (Array.isArray(delta.content)
        ? delta.content.map((c: { text?: string; refusal?: string; type?: string }) => {
            if (c?.type === 'refusal' || typeof c?.refusal === 'string') this.refused = true;
            return c?.text ?? c?.refusal ?? '';
          }).join('')
        : typeof delta.content === 'string'
          ? delta.content
          : '') + refusal;
    if (content) {
      if (this.textIndex === undefined) {
        this.textIndex = this.next++;
        this.blocks.set(this.textIndex, { type: 'text', text: '' });
      }
      const b = this.blocks.get(this.textIndex);
      if (b?.type === 'text') b.text += content;
      out.push({ type: 'text_delta', index: this.textIndex, text: content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, any>>) {
        const acc = this.toolFor(tc);
        const fn = tc.function ?? {};
        if (fn.name && !acc.name) acc.name = fn.name;
        const sig = tc.extra_content?.google?.thought_signature;
        if (typeof sig === 'string' && sig) acc.sig = sig;
        const args = typeof fn.arguments === 'string' ? fn.arguments : fn.arguments ? JSON.stringify(fn.arguments) : '';
        if (!acc.started && acc.name) {
          acc.started = true;
          if (!acc.id) acc.id = `call_${acc.index}_${Date.now().toString(36)}`;
          out.push({ type: 'tool_use_start', index: acc.index, id: acc.id, name: this.names.original(acc.name) });
          if (acc.args) out.push({ type: 'tool_use_delta', index: acc.index, partialJson: acc.args });
        }
        if (args) {
          acc.args += args;
          if (acc.started) out.push({ type: 'tool_use_delta', index: acc.index, partialJson: args });
        }
      }
    }

    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  done(): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (!this.started) out.push({ type: 'start' });
    for (const t of this.tools) {
      if (!t.name) continue;
      this.blocks.set(t.index, {
        type: 'tool_use',
        id: t.id || `call_${t.index}`,
        name: this.names.original(t.name),
        input: parseToolInput(t.args),
        ...(t.sig ? { signature: tagSignature('openai-chat', this.model, t.sig) } : {}),
      });
    }
    const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const hasTools = content.some((b) => b.type === 'tool_use');
    const stopReason = this.refused ? 'refusal' : (this.finish && CHAT_FINISH[this.finish]) || (hasTools ? 'tool_use' : 'end_turn');
    out.push({ type: 'done', content, stopReason, usage: this.usage });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * OpenAI Chat Completions and compatible servers (OpenRouter, DeepSeek, Z.ai
 * paas, Groq, Ollama, LM Studio, CLIProxyAPI). Responses-only models on
 * api.openai.com (pro, codex) are sent to the Responses API.
 */
export class OpenAIProvider extends BaseProvider {
  readonly type = 'openai' as const;
  /** The Chat Completions wire takes PDFs only from a model that reads more than text (chatMessages' pdf flag). */
  readsPdf(id: string): boolean {
    return this.model(id).vision;
  }
  private responses?: OpenAIResponsesProvider;

  get baseUrl(): string {
    return trimSlash(this.opts.config.baseUrl ?? OPENAI_DEFAULT_BASE);
  }

  get host(): string {
    return hostOf(this.baseUrl);
  }

  get official(): boolean {
    return this.host === 'api.openai.com';
  }

  headers(): Record<string, string> {
    return openaiHeaders(this.opts);
  }

  buildBody(req: ChatRequest, names = new ToolNameMap()): Wire {
    const info = this.model(req.model);
    // Z.ai's response_format takes only text or json_object, so the schema goes in the system prompt
    const zaiJson = !!req.responseSchema && ZAI_HOST.test(this.host);
    const msgReq = zaiJson ? { ...req, system: [...req.system, { text: `Reply with only JSON that matches this schema:\n${JSON.stringify(req.responseSchema)}` }] } : req;
    // a file part only for a model that reads more than text; others get a note per PDF
    const body: Wire = { model: req.model, messages: chatMessages(msgReq, names, info.vision, this.seesImages(req.model, info)) };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: names.wire(t.name), description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
      }));
      const tc = req.toolChoice;
      if (tc) body.tool_choice = tc === 'any' ? 'required' : typeof tc === 'object' ? { type: 'function', function: { name: names.wire(tc.name) } } : tc;
    }
    if (req.maxTokens) body[this.official ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
    // OpenAI reasoning models only accept the default temperature.
    if (req.temperature !== undefined && !(this.official && info.thinking)) body.temperature = req.temperature;
    if (req.stopSequences?.length) body.stop = req.stopSequences;
    Object.assign(body, reasoningParams(this.host, req, info));
    if (req.cacheKey && this.official) body.prompt_cache_key = req.cacheKey;
    if (zaiJson) body.response_format = { type: 'json_object' };
    else if (req.responseSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: req.responseSchema, strict: false } };
    }
    return body;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    if (this.official && findCatalogEntry(req.model)?.responsesOnly) {
      this.responses ??= new OpenAIResponsesProvider(this.opts);
      yield* this.responses.stream(req);
      return;
    }
    const names = new ToolNameMap();
    const body = { ...this.buildBody(req, names), stream: true, stream_options: { include_usage: true } };
    const res = await openStream(`${this.baseUrl}/chat/completions`, { ...this.headers(), ...this.sessionHeaders(req) }, body, this.http(req.signal));
    const state = new ChatStream(this.id, req.model, names, res.headers);
    for await (const msg of parseSse(res, { signal: req.signal, idleTimeoutMs: this.idleTimeoutMs, provider: this.id })) {
      for (const data of parseSseJson(msg.data)) yield* state.handle(data);
    }
    yield* state.done();
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
