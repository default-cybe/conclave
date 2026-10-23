import type { ContentBlock, StopReason, Usage } from '../types';
import type { ProviderConfig } from '../config/schema';
import { sanitizeToolId } from '../util/ids';
import { normalizeModelId } from './catalog';
import { BaseProvider, budgetOf, documentsForWire, effortOf, parseToolInput } from './common';
import { clampEffort, claudeEffort, claudeThinkingOff, type Effort } from './effort';
import { classifyStreamError, parseRateLimitHeaders } from './errors';
import { getJson, hostOf, openStream, postJson, trimSlash } from './http';
import { isTaggedSignature } from './signatures';
import { parseSse, parseSseJson } from './sse';
import { ToolNameMap } from './tool-names';
import type { ChatRequest, ModelInfo, ProviderMessage, StreamEvent } from './types';

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const MAX_CACHE_BREAKPOINTS = 4;

type Wire = Record<string, unknown>;

/** Gateways that take a bearer token (ANTHROPIC_AUTH_TOKEN style) instead of x-api-key. */
function usesBearer(config: ProviderConfig, key: string): boolean {
  return /AUTH_TOKEN$/i.test(config.apiKeyEnv ?? '') || key.startsWith('sk-ant-oat');
}

// ---------------------------------------------------------------------------
// Thinking: the one place that knows per-model thinking rules
// ---------------------------------------------------------------------------

export interface AnthropicThinkingPlan {
  thinking?: Wire;
  effort?: Effort;
  /** Sampling parameters are rejected (or must stay default) for this request. */
  dropTemperature: boolean;
  /** tool_choice "any" / "tool" is rejected for this request; use "auto". */
  noForcedToolChoice: boolean;
  maxTokens: number;
}

/**
 * Thinking request shape per Claude generation (October 2026, providers/effort.ts has the table):
 * - Claude 5 family (Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5, Fable, Mythos) and Opus 4.7/4.8:
 *   adaptive only, budget_tokens is a 400, depth via output_config.effort, no sampling params.
 *   We always ask for summarized display.
 * - Opus 4.6 / Sonnet 4.6: adaptive, effort without xhigh.
 * - With no level these models think adaptively at their default effort (Effort's
 *   default). Off is the model's own switch: {type: "disabled"}, {type: "between_tools"}
 *   on Sonnet 5.5 (no level with either), nothing on 4.6, and Opus 5.5, Fable and Mythos,
 *   which cannot stop thinking, get their lowest level.
 * - Older Claude and Anthropic-compatible gateways (GLM, MiniMax, Kimi): enabled + budget_tokens.
 * Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 reject forced tool_choice; so does any request with thinking on.
 */
export function planAnthropicThinking(model: string, req: ChatRequest, info: ModelInfo, maxTokens: number): AnthropicThinkingPlan {
  const id = normalizeModelId(model);
  const claude = id.startsWith('claude-');
  const gen5 = /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(id);
  const adaptiveOnly = gen5 || /^claude-opus-4-[78]/.test(id);
  const adaptive = adaptiveOnly || /^claude-(opus|sonnet)-4-6/.test(id);
  const asked = !!req.thinking && info.thinking;
  const off = asked && !!req.thinking?.off;
  const wants = asked && !off;
  const plan: AnthropicThinkingPlan = {
    dropTemperature: claude && adaptiveOnly,
    noForcedToolChoice: /^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/.test(id),
    maxTokens,
  };

  if (claude && adaptive) {
    const offWith = off ? claudeThinkingOff(id) : undefined;
    if (offWith) {
      if (offWith !== 'omit') plan.thinking = { type: offWith };
      return plan;
    }
    // a 4.x model set not to think (modelOverrides) is left as it is; the 5 family thinks either way
    if (!gen5 && !info.thinking) return plan;
    plan.thinking = adaptiveOnly ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
    plan.noForcedToolChoice = true;
    const levels = claudeEffort(id);
    if (wants) {
      const level = effortOf(req.thinking);
      plan.effort = (clampEffort(level, levels) as Effort | undefined) ?? level;
    } else if (off) plan.effort = levels?.levels[0] ?? 'low';
    return plan;
  }

  if (!wants) return plan;
  let budget = Math.max(1024, budgetOf(req.thinking) ?? 12_000);
  let max = maxTokens;
  if (max <= budget) max = Math.min(info.maxOutput, budget + 8192);
  if (max <= budget) budget = max - 1024;
  if (budget < 1024) return plan;
  return { thinking: { type: 'enabled', budget_tokens: budget }, dropTemperature: true, noForcedToolChoice: true, maxTokens: max };
}

/** Claude models that take an effort level (output_config.effort): the 5 family and Opus/Sonnet 4.6 to 4.8. */
export function takesEffort(model: string): boolean {
  const id = normalizeModelId(model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model);
  return /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(id) || /^claude-(opus|sonnet)-4-[678]/.test(id);
}

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

function mapBlock(b: ContentBlock, names: ToolNameMap): Wire | undefined {
  switch (b.type) {
    case 'text':
      return b.text.trim() ? { type: 'text', text: b.text } : undefined;
    case 'thinking':
      // Unsigned blocks are rejected, and tagged ones belong to other providers.
      if (!b.signature || isTaggedSignature(b.signature)) return undefined;
      return { type: 'thinking', thinking: b.thinking, signature: b.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: b.data };
    case 'image':
      if (b.data) return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
      if (b.url) return { type: 'image', source: { type: 'url', url: b.url } };
      return undefined;
    case 'document': {
      const title = b.title ? { title: b.title } : {};
      if (b.data && b.mediaType === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: b.mediaType, data: b.data }, ...title };
      }
      if (b.url) return { type: 'document', source: { type: 'url', url: b.url }, ...title };
      return { type: 'text', text: `[Attached ${b.mediaType} document${b.title ? ` "${b.title}"` : ''} could not be sent to this model]` };
    }
    case 'tool_use':
      return { type: 'tool_use', id: sanitizeToolId(b.id), name: names.wire(b.name), input: b.input ?? {} };
    case 'tool_result': {
      const content =
        typeof b.content === 'string'
          ? b.content
          : b.content
              .map((c) => (c.type === 'text' ? (c.text ? { type: 'text', text: c.text } : undefined) : mapBlock(c, names)))
              .filter((x): x is Wire => !!x);
      const out: Wire = { type: 'tool_result', tool_use_id: sanitizeToolId(b.toolUseId), content };
      if (b.isError) out.is_error = true;
      return out;
    }
  }
}

function lastCacheable(blocks: Wire[]): Wire | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].type;
    if (t !== 'thinking' && t !== 'redacted_thinking') return blocks[i];
  }
  return undefined;
}

function mapMessages(msgs: ProviderMessage[], names: ToolNameMap, breakpoints: Wire[]): Wire[] {
  const out: Wire[] = [];
  for (const m of msgs) {
    // text documents as text: Anthropic-compatible endpoints (Z.ai) drop a text-source document
    const content = m.role === 'user' ? documentsForWire(m.content, true) : m.content;
    let blocks = content.map((b) => mapBlock(b, names)).filter((x): x is Wire => !!x);
    // Tool results must lead the user turn.
    if (m.role === 'user') blocks = [...blocks.filter((b) => b.type === 'tool_result'), ...blocks.filter((b) => b.type !== 'tool_result')];
    if (!blocks.length) continue;
    if (m.cache) {
      const target = lastCacheable(blocks);
      if (target) breakpoints.push(target);
    }
    out.push({ role: m.role, content: blocks });
  }
  return out;
}

/** Anthropic stop_reason to Conclave's. refusal is the safety classifier's stop (stop_details names the category). */
export function mapStopReason(r: unknown): StopReason | undefined {
  switch (r) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'refusal':
    case 'pause_turn':
      return r;
    case 'model_context_window_exceeded':
      return 'max_tokens';
    // Z.ai's Anthropic-compatible endpoint: its safety review's stop, as on its Chat Completions API
    case 'sensitive':
      return 'refusal';
    case null:
    case undefined:
      return undefined;
    default:
      return 'end_turn';
  }
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

class AnthropicStream {
  private blocks = new Map<number, ContentBlock>();
  private json = new Map<number, string>();
  private initialInput = new Map<number, Record<string, unknown>>();
  private finalized = new Set<number>();
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private stopReason?: StopReason;
  private started = false;

  constructor(
    private provider: string,
    private names: ToolNameMap,
    private headers: Headers,
  ) {}

  private setUsage(u: unknown): void {
    if (!u || typeof u !== 'object') return;
    const x = u as Record<string, unknown>;
    const pick = (k: string) => (typeof x[k] === 'number' ? (x[k] as number) : undefined);
    const max = (a: number | undefined, b: number | undefined) => (b === undefined ? a : Math.max(a ?? 0, b));
    this.usage.inputTokens = max(this.usage.inputTokens, pick('input_tokens')) ?? 0;
    this.usage.outputTokens = max(this.usage.outputTokens, pick('output_tokens')) ?? 0;
    const cr = max(this.usage.cacheReadTokens, pick('cache_read_input_tokens'));
    // cache_creation splits the writes by lifetime: a 1 hour write costs 2x input, a 5 minute one 1.25x
    const split = x.cache_creation && typeof x.cache_creation === 'object' ? (x.cache_creation as Record<string, unknown>) : undefined;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const hour = num(split?.ephemeral_1h_input_tokens);
    const five = num(split?.ephemeral_5m_input_tokens);
    const parts = hour !== undefined || five !== undefined ? (hour ?? 0) + (five ?? 0) : undefined;
    const cw = max(max(this.usage.cacheWriteTokens, pick('cache_creation_input_tokens')), parts);
    if (cr !== undefined) this.usage.cacheReadTokens = cr;
    if (cw !== undefined) this.usage.cacheWriteTokens = cw;
    const h = max(this.usage.cacheWrite1hTokens, hour);
    if (h !== undefined) this.usage.cacheWrite1hTokens = h;
  }

  private startEvents(id?: string, model?: string): StreamEvent[] {
    if (this.started) return [];
    this.started = true;
    const out: StreamEvent[] = [{ type: 'start', id, model }];
    const windows = parseRateLimitHeaders(this.provider, this.headers);
    if (windows.length) out.push({ type: 'rate_limit', windows });
    return out;
  }

  private finalizeTool(index: number): void {
    const b = this.blocks.get(index);
    if (!b || b.type !== 'tool_use' || this.finalized.has(index)) return;
    this.finalized.add(index);
    b.input = parseToolInput(this.json.get(index) ?? '', this.initialInput.get(index));
  }

  handle(eventName: string, raw: unknown): StreamEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const data = raw as Record<string, any>;
    const type = (data.type as string) ?? eventName;
    const out: StreamEvent[] = [];

    if (type === 'error') throw classifyStreamError(this.provider, data.error ?? data, this.headers);
    if (type === 'ping') return out;
    if (type === 'message_start') {
      const msg = data.message ?? {};
      out.push(...this.startEvents(msg.id, msg.model));
      this.setUsage(msg.usage);
      return out;
    }
    out.push(...this.startEvents());

    const index = typeof data.index === 'number' ? data.index : 0;
    if (type === 'content_block_start') {
      const cb = data.content_block ?? {};
      if (cb.type === 'text') {
        this.blocks.set(index, { type: 'text', text: cb.text ?? '' });
        if (cb.text) out.push({ type: 'text_delta', index, text: cb.text });
      } else if (cb.type === 'thinking') {
        this.blocks.set(index, { type: 'thinking', thinking: cb.thinking ?? '', signature: cb.signature || undefined });
        if (cb.thinking) out.push({ type: 'thinking_delta', index, text: cb.thinking });
      } else if (cb.type === 'redacted_thinking') {
        this.blocks.set(index, { type: 'redacted_thinking', data: cb.data ?? '' });
      } else if (cb.type === 'tool_use') {
        const name = this.names.original(cb.name ?? '');
        this.blocks.set(index, { type: 'tool_use', id: cb.id ?? `toolu_${index}`, name, input: {} });
        if (cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length) this.initialInput.set(index, cb.input);
        out.push({ type: 'tool_use_start', index, id: cb.id ?? `toolu_${index}`, name });
      }
      return out;
    }

    if (type === 'content_block_delta') {
      const d = data.delta ?? {};
      let b = this.blocks.get(index);
      if (d.type === 'text_delta') {
        if (!b) this.blocks.set(index, (b = { type: 'text', text: '' }));
        if (b.type === 'text') b.text += d.text ?? '';
        out.push({ type: 'text_delta', index, text: d.text ?? '' });
      } else if (d.type === 'thinking_delta') {
        if (!b) this.blocks.set(index, (b = { type: 'thinking', thinking: '' }));
        if (b.type === 'thinking') b.thinking += d.thinking ?? '';
        out.push({ type: 'thinking_delta', index, text: d.thinking ?? '' });
      } else if (d.type === 'signature_delta') {
        if (b?.type === 'thinking') b.signature = (b.signature ?? '') + (d.signature ?? '');
      } else if (d.type === 'input_json_delta') {
        if (b?.type === 'tool_use') {
          this.json.set(index, (this.json.get(index) ?? '') + (d.partial_json ?? ''));
          out.push({ type: 'tool_use_delta', index, partialJson: d.partial_json ?? '' });
        }
      }
      return out;
    }

    if (type === 'content_block_stop') {
      this.finalizeTool(index);
      return out;
    }

    if (type === 'message_delta') {
      const r = mapStopReason(data.delta?.stop_reason);
      if (r) this.stopReason = r;
      this.setUsage(data.usage);
    }
    return out;
  }

  finish(): StreamEvent[] {
    const out = this.startEvents();
    for (const i of this.blocks.keys()) this.finalizeTool(i);
    const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const hasTools = content.some((b) => b.type === 'tool_use');
    const stopReason = this.stopReason ?? (hasTools ? 'tool_use' : 'end_turn');
    out.push({ type: 'done', content, stopReason, usage: this.usage });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages API. Also used for Anthropic-compatible endpoints
 * (Z.ai, MiniMax, Kimi, CLIProxyAPI), so missing fields are tolerated.
 */
export class AnthropicProvider extends BaseProvider {
  readonly type = 'anthropic' as const;

  get baseUrl(): string {
    return trimSlash(this.opts.config.baseUrl ?? DEFAULT_BASE);
  }

  /** The first-party API, where newer request fields are safe to send. */
  get native(): boolean {
    return hostOf(this.baseUrl) === 'api.anthropic.com';
  }

  headers(): Record<string, string> {
    const extra = this.opts.headers ?? {};
    const h: Record<string, string> = { 'anthropic-version': API_VERSION };
    const key = this.opts.apiKey;
    const hasAuth = Object.keys(extra).some((k) => /^(authorization|x-api-key)$/i.test(k));
    if (key && !hasAuth) {
      if (usesBearer(this.opts.config, key)) h.authorization = `Bearer ${key}`;
      else h['x-api-key'] = key;
    }
    return { ...h, ...extra };
  }

  /** Request body for /v1/messages. Public for tests and token counting. */
  buildBody(req: ChatRequest, names = new ToolNameMap()): Wire {
    const info = this.model(req.model);
    const plan = planAnthropicThinking(req.model, req, info, req.maxTokens ?? Math.min(info.maxOutput, 64_000));
    const body: Wire = { model: req.model, max_tokens: plan.maxTokens };
    const breakpoints: Wire[] = [];

    if (req.tools?.length) {
      const tools: Wire[] = req.tools.map((t) => {
        const tool: Wire = { name: names.wire(t.name), description: t.description, input_schema: t.inputSchema ?? { type: 'object' } };
        // Stream large tool inputs as they are generated; gateways may reject the field.
        if (this.native) tool.eager_input_streaming = true;
        return tool;
      });
      body.tools = tools;
      breakpoints.push(tools[tools.length - 1]);
    }

    const system: Wire[] = [];
    for (const s of req.system) {
      if (!s.text) continue;
      const b: Wire = { type: 'text', text: s.text };
      if (s.cache) breakpoints.push(b);
      system.push(b);
    }
    if (req.responseSchema && !this.native) {
      system.push({ type: 'text', text: `Reply with only JSON that matches this schema:\n${JSON.stringify(req.responseSchema)}` });
    }
    if (system.length) body.system = system;

    body.messages = mapMessages(req.messages, names, breakpoints);

    // Keep the newest breakpoints: later ones cover the earlier prefix anyway. One lifetime for all of them:
    // a 1h entry may not follow a 5m one. The ttl is sent explicitly to Claude models only (a gateway may
    // otherwise pick 1h for us); other models on this wire format get the plain marker.
    const ttl = req.cacheTtl && /^claude-/.test(normalizeModelId(req.model)) ? req.cacheTtl : undefined;
    for (const b of breakpoints.slice(Math.max(0, breakpoints.length - MAX_CACHE_BREAKPOINTS))) {
      b.cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
    }

    if (req.tools?.length && req.toolChoice) {
      let tc = req.toolChoice;
      if (tc !== 'auto' && tc !== 'none' && plan.noForcedToolChoice) tc = 'auto';
      body.tool_choice =
        tc === 'auto' ? { type: 'auto' } : tc === 'none' ? { type: 'none' } : tc === 'any' ? { type: 'any' } : { type: 'tool', name: names.wire(tc.name) };
    }

    if (plan.thinking) body.thinking = plan.thinking;
    const outputConfig: Wire = {};
    if (plan.effort) outputConfig.effort = plan.effort;
    if (req.responseSchema && this.native) outputConfig.format = { type: 'json_schema', schema: req.responseSchema };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (req.temperature !== undefined && !plan.dropTemperature) body.temperature = req.temperature;
    // the Messages API rejects a stop sequence that is only whitespace
    const stops = req.stopSequences?.filter((x) => /\S/.test(x));
    if (stops?.length) body.stop_sequences = stops;
    if (req.userId) body.metadata = { user_id: req.userId };
    return body;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const names = new ToolNameMap();
    const body = { ...this.buildBody(req, names), stream: true };
    const res = await openStream(`${this.baseUrl}/v1/messages`, { ...this.headers(), ...this.sessionHeaders(req) }, body, this.http(req.signal));
    const state = new AnthropicStream(this.id, names, res.headers);
    for await (const msg of parseSse(res, { signal: req.signal, idleTimeoutMs: this.idleTimeoutMs, provider: this.id })) {
      for (const data of parseSseJson(msg.data)) yield* state.handle(msg.event, data);
    }
    yield* state.finish();
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.listWith(async () => {
      const out: ModelInfo[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const url = `${this.baseUrl}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
        const res = await getJson<{
          data?: Array<{ id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }>;
          has_more?: boolean;
          last_id?: string;
        }>(url, this.headers(), this.http());
        for (const m of res.data ?? []) {
          const info = this.model(m.id);
          if (!this.opts.config.modelOverrides?.[m.id]) {
            if (m.display_name) info.name = m.display_name;
            if (m.max_input_tokens) info.contextWindow = m.max_input_tokens;
            if (m.max_tokens) info.maxOutput = m.max_tokens;
          }
          out.push(info);
        }
        if (!res.has_more || !res.last_id) break;
        after = res.last_id;
      }
      return out;
    });
  }

  async countTokens(req: ChatRequest): Promise<number> {
    const body = this.buildBody(req);
    for (const k of ['max_tokens', 'temperature', 'metadata', 'output_config']) delete body[k];
    const res = await postJson<{ input_tokens?: number }>(`${this.baseUrl}/v1/messages/count_tokens`, this.headers(), body, this.http(req.signal));
    return res.input_tokens ?? 0;
  }
}
