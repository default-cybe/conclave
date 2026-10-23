import type { ContentBlock, JsonSchema, StopReason, Usage } from '../types';
import { normalizeModelId } from './catalog';
import { BaseProvider, budgetOf, documentsForWire, effortOf, toolResultMedia, toolResultText, wantsThinking } from './common';
import { classifyStreamError } from './errors';
import { getJson, openStream, postJson, trimSlash } from './http';
import { ownSignature, tagSignature } from './signatures';
import { parseSse, parseSseJson } from './sse';
import { GEMINI_TOOL_NAME_RULES, ToolNameMap } from './tool-names';
import type { ChatRequest, ModelInfo, ProviderMessage, StreamEvent } from './types';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
/**
 * Gemini 3 validates thought signatures on function calls. For calls that
 * came from another model there is no signature; Google documents this value
 * as the way to skip validation for such transplanted history.
 */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

type Wire = Record<string, unknown>;
type Part = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Schema sanitizing
// ---------------------------------------------------------------------------

const KEEP_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'title',
]);

const KEEP_FORMATS: Record<string, string[]> = { string: ['enum', 'date-time'], number: ['float', 'double'], integer: ['int32', 'int64'] };

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  const m = ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
  if (!m) return undefined;
  const defs = root[m[1]] as Record<string, JsonSchema> | undefined;
  return defs?.[decodeURIComponent(m[2])];
}

/**
 * Reduce a JSON schema to the OpenAPI subset Gemini accepts: inline $ref,
 * merge allOf, turn type arrays and null unions into nullable, make enums
 * strings, drop $schema, additionalProperties, default, examples and other
 * unsupported keys.
 */
export function sanitizeGeminiSchema(schema: JsonSchema, root: JsonSchema = schema, refs: string[] = []): Wire {
  let s: JsonSchema = { ...schema };

  if (typeof s.$ref === 'string') {
    const ref = s.$ref;
    const target = refs.includes(ref) ? undefined : resolveRef(ref, root);
    const rest = { ...s };
    delete rest.$ref;
    if (!target) return { type: 'object', ...(s.description ? { description: s.description } : {}) };
    return sanitizeGeminiSchema({ ...target, ...rest }, root, [...refs, ref]);
  }

  if (Array.isArray(s.allOf)) {
    const merged: JsonSchema = { ...s };
    delete merged.allOf;
    for (const part of s.allOf as JsonSchema[]) {
      const p = typeof part.$ref === 'string' ? (resolveRef(part.$ref, root) ?? {}) : part;
      merged.properties = { ...(merged.properties ?? {}), ...(p.properties ?? {}) };
      merged.required = [...(merged.required ?? []), ...(p.required ?? [])];
      if (p.type && !merged.type) merged.type = p.type;
      if (p.description && !merged.description) merged.description = p.description;
    }
    s = merged;
  }

  let nullable = s.nullable === true;
  if ('const' in s && s.const !== undefined) s.enum = [s.const];

  if (Array.isArray(s.type)) {
    const types = s.type.filter((t) => t !== 'null');
    nullable ||= types.length !== s.type.length;
    if (types.length === 1) s.type = types[0];
    else if (types.length === 0) s.type = 'string';
    else {
      s.anyOf = types.map((t) => ({ type: t }));
      delete s.type;
    }
  }

  const union = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(union)) {
    const isNull = (u: JsonSchema) => u.type === 'null' || (Array.isArray(u.enum) && u.enum.length === 1 && u.enum[0] === null);
    const rest = union.filter((u) => !isNull(u));
    nullable ||= rest.length !== union.length;
    delete s.oneOf;
    delete s.anyOf;
    if (rest.length === 1) {
      // Optional<T>: flatten into T and sanitize again (T may be a $ref).
      const outer = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
      const merged: JsonSchema = { ...rest[0], ...outer };
      if (rest[0].type !== undefined && outer.type === undefined) merged.type = rest[0].type;
      if (nullable) merged.nullable = true;
      return sanitizeGeminiSchema(merged, root, refs);
    }
    s.anyOf = rest;
  }

  const out: Wire = {};
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP_KEYS.has(k) || v === undefined) continue;
    out[k] = v;
  }

  if (Array.isArray(s.enum)) {
    const vals = s.enum.filter((v) => v !== null);
    nullable ||= vals.length !== s.enum.length;
    out.enum = vals.map(String);
    out.type = 'string';
  }
  if (typeof out.format === 'string') {
    const ok = KEEP_FORMATS[String(out.type)] ?? [];
    if (!ok.includes(out.format)) delete out.format;
  }
  if (s.properties && typeof s.properties === 'object') {
    const props: Wire = {};
    for (const [k, v] of Object.entries(s.properties)) props[k] = sanitizeGeminiSchema(v, root, refs);
    if (Object.keys(props).length) out.properties = props;
    else delete out.properties;
    if (Array.isArray(s.required)) {
      const req = [...new Set(s.required)].filter((r) => r in props);
      if (req.length) out.required = req;
      else delete out.required;
    }
  } else {
    delete out.required;
  }
  if (s.items && typeof s.items === 'object') {
    const items = Array.isArray(s.items) ? (s.items[0] as JsonSchema) : s.items;
    out.items = items ? sanitizeGeminiSchema(items, root, refs) : { type: 'string' };
  } else if (out.type === 'array') {
    out.items = { type: 'string' };
  }
  if (Array.isArray(out.anyOf)) out.anyOf = (out.anyOf as JsonSchema[]).map((u) => sanitizeGeminiSchema(u, root, refs));
  if (nullable) out.nullable = true;
  return out;
}

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

type SigMode = 'next' | 'prev';

function encodeSig(model: string, mode: SigMode, sig: string): string {
  return tagSignature('gemini', model, `${mode}:${sig}`);
}

function decodeSig(signature: string | undefined, model: string): { mode: SigMode; sig: string } | undefined {
  const own = ownSignature(signature, 'gemini', model);
  if (!own) return undefined;
  const i = own.payload.indexOf(':');
  if (i < 0) return undefined;
  return { mode: own.payload.slice(0, i) as SigMode, sig: own.payload.slice(i + 1) };
}

function mediaPart(mediaType: string, data?: string, url?: string): Part | undefined {
  if (data) return { inlineData: { mimeType: mediaType, data } };
  if (url) return { fileData: { mimeType: mediaType, fileUri: url } };
  return undefined;
}

/**
 * Model turn parts. Thought text is not replayed (only signatures matter).
 * Each signature is re-attached to the part it came with: "next" means the
 * following part, "prev" the preceding one.
 */
function modelParts(m: ProviderMessage, names: ToolNameMap, model: string, gemini3: boolean): Part[] {
  const parts: Part[] = [];
  let pending: string | undefined;
  for (const b of m.content) {
    if (b.type === 'thinking') {
      const s = decodeSig(b.signature, model);
      if (!s) continue;
      if (s.mode === 'prev' && parts.length && !parts[parts.length - 1].thoughtSignature) parts[parts.length - 1].thoughtSignature = s.sig;
      else pending = s.sig;
      continue;
    }
    let part: Part | undefined;
    if (b.type === 'text' && b.text) part = { text: b.text };
    else if (b.type === 'tool_use') part = { functionCall: { name: names.wire(b.name), args: b.input ?? {} } };
    if (!part) continue;
    if (pending) {
      part.thoughtSignature = pending;
      pending = undefined;
    }
    parts.push(part);
  }
  if (pending) {
    const last = parts[parts.length - 1];
    if (last && !last.thoughtSignature) last.thoughtSignature = pending;
    else parts.push({ text: '', thoughtSignature: pending });
  }
  if (gemini3) {
    const firstCall = parts.find((p) => p.functionCall);
    if (firstCall && !firstCall.thoughtSignature) firstCall.thoughtSignature = SKIP_SIGNATURE;
  }
  return parts;
}

function userParts(m: ProviderMessage, toolNames: Map<string, string>, vision: boolean): Part[] {
  const responses: Part[] = [];
  const parts: Part[] = [];
  for (const b of documentsForWire(m.content, true, vision)) {
    switch (b.type) {
      case 'text':
        if (b.text) parts.push({ text: b.text });
        break;
      case 'image': {
        const p = mediaPart(b.mediaType, b.data, b.url);
        if (p) parts.push(p);
        break;
      }
      case 'document': {
        // only PDFs are left as documents
        const p = mediaPart(b.mediaType, b.data, b.url);
        if (p) parts.push(p);
        break;
      }
      case 'tool_result': {
        const text = toolResultText(b);
        // Gemini pairs responses with calls by name; ids are not echoed back.
        const name = toolNames.get(b.toolUseId) ?? 'unknown_tool';
        responses.push({ functionResponse: { name, response: b.isError ? { error: text } : { output: text } } });
        const imgs = toolResultMedia(b)
          .map((i) => mediaPart(i.mediaType, i.data, i.url))
          .filter((x): x is Part => !!x);
        if (imgs.length) parts.push({ text: `Images returned by ${name}:` }, ...imgs);
        break;
      }
    }
  }
  return [...responses, ...parts];
}

export function geminiContents(req: ChatRequest, names: ToolNameMap, vision = true): Array<{ role: 'user' | 'model'; parts: Part[] }> {
  const toolNames = new Map<string, string>();
  for (const m of req.messages) for (const b of m.content) if (b.type === 'tool_use') toolNames.set(b.id, names.wire(b.name));
  const gemini3 = /^gemini-([3-9]|\d{2})/.test(normalizeModelId(req.model));
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
  for (const m of req.messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = m.role === 'assistant' ? modelParts(m, names, req.model, gemini3) : userParts(m, toolNames, vision);
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

/** thinkingLevel for Gemini 3+, thinkingBudget for 2.5. Thought summaries are always requested. */
export function geminiThinkingConfig(model: string, req: ChatRequest, info: ModelInfo): Wire | undefined {
  if (!info.thinking) return undefined;
  const cfg: Wire = { includeThoughts: true };
  if (!wantsThinking(req.thinking)) return cfg;
  const id = normalizeModelId(model);
  if (/^gemini-([3-9]|\d{2})/.test(id)) {
    const asked = effortOf(req.thinking);
    // nothing above high; Pro models take low or high only
    const effort = asked === 'xhigh' || asked === 'max' ? 'high' : asked;
    cfg.thinkingLevel = effort === 'medium' && id.includes('pro') ? 'high' : effort;
  } else {
    cfg.thinkingBudget = budgetOf(req.thinking);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

function geminiUsage(raw: Record<string, any>): Usage {
  const prompt = (raw.promptTokenCount ?? 0) + (raw.toolUsePromptTokenCount ?? 0);
  const cached = raw.cachedContentTokenCount ?? 0;
  const thoughts = raw.thoughtsTokenCount ?? 0;
  const usage: Usage = { inputTokens: Math.max(0, prompt - cached), outputTokens: (raw.candidatesTokenCount ?? 0) + thoughts };
  if (cached) usage.cacheReadTokens = cached;
  if (thoughts) usage.reasoningTokens = thoughts;
  return usage;
}

/**
 * finishReason values where Gemini's own filters stopped the reply (SAFETY,
 * PROHIBITED_CONTENT, BLOCKLIST, SPII, RECITATION and their image kinds), and
 * LANGUAGE, a language it will not answer in. promptFeedback.blockReason
 * (the prompt itself was blocked) is a refusal too.
 */
export const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'LANGUAGE']);

class GeminiStream {
  private blocks = new Map<number, ContentBlock>();
  private next = 0;
  private cur?: { kind: 'text' | 'thinking'; index: number };
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private finishReason?: string;
  private blocked = false;
  private started = false;
  private callSeq = 0;

  constructor(
    private provider: string,
    private model: string,
    private names: ToolNameMap,
  ) {}

  private sigBlock(mode: SigMode, sig: string): void {
    this.blocks.set(this.next++, { type: 'thinking', thinking: '', signature: encodeSig(this.model, mode, sig) });
  }

  handle(raw: unknown): StreamEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const chunk = raw as Record<string, any>;
    if (chunk.error) throw classifyStreamError(this.provider, chunk.error);
    const out: StreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({ type: 'start', id: chunk.responseId, model: chunk.modelVersion });
    }
    if (chunk.usageMetadata) this.usage = geminiUsage(chunk.usageMetadata);
    if (chunk.promptFeedback?.blockReason) this.blocked = true;

    const cand = Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined;
    const parts: Array<Record<string, any>> = cand?.content?.parts ?? [];
    for (const part of parts) {
      const sig: string | undefined = part.thoughtSignature;
      if (part.functionCall) {
        if (sig) this.sigBlock('next', sig);
        const fc = part.functionCall;
        const index = this.next++;
        const id = fc.id ?? `call_${Date.now().toString(36)}_${this.callSeq++}`;
        const name = this.names.original(fc.name ?? '');
        const input = fc.args && typeof fc.args === 'object' ? (fc.args as Record<string, unknown>) : {};
        this.blocks.set(index, { type: 'tool_use', id, name, input });
        out.push({ type: 'tool_use_start', index, id, name }, { type: 'tool_use_delta', index, partialJson: JSON.stringify(input) });
        this.cur = undefined;
        continue;
      }
      if (typeof part.text !== 'string') continue;

      if (part.thought) {
        if (this.cur?.kind !== 'thinking') {
          this.cur = { kind: 'thinking', index: this.next++ };
          this.blocks.set(this.cur.index, { type: 'thinking', thinking: '' });
        }
        const b = this.blocks.get(this.cur.index);
        if (b?.type === 'thinking') {
          b.thinking += part.text;
          if (sig) b.signature = encodeSig(this.model, 'next', sig);
        }
        if (part.text) out.push({ type: 'thinking_delta', index: this.cur.index, text: part.text });
        continue;
      }

      if (!part.text) {
        if (sig) this.sigBlock(this.next > 0 ? 'prev' : 'next', sig);
        continue;
      }
      if (this.cur?.kind !== 'text') {
        if (sig) this.sigBlock('next', sig);
        this.cur = { kind: 'text', index: this.next++ };
        this.blocks.set(this.cur.index, { type: 'text', text: '' });
      } else if (sig) {
        this.sigBlock('prev', sig);
      }
      const b = this.blocks.get(this.cur.index);
      if (b?.type === 'text') b.text += part.text;
      out.push({ type: 'text_delta', index: this.cur.index, text: part.text });
    }
    if (cand?.finishReason) this.finishReason = cand.finishReason;
    return out;
  }

  finish(): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (!this.started) out.push({ type: 'start' });
    const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const hasTools = content.some((b) => b.type === 'tool_use');
    let stopReason: StopReason = hasTools ? 'tool_use' : 'end_turn';
    if (this.blocked || (this.finishReason && REFUSAL_REASONS.has(this.finishReason))) stopReason = 'refusal';
    else if (this.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
    else if (this.finishReason === 'MALFORMED_FUNCTION_CALL') stopReason = 'error';
    out.push({ type: 'done', content, stopReason, usage: this.usage });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Google Generative Language API (Gemini). */
export class GeminiProvider extends BaseProvider {
  readonly type = 'gemini' as const;

  get baseUrl(): string {
    return trimSlash(this.opts.config.baseUrl ?? DEFAULT_BASE).replace(/\/v1(beta)?$/, '');
  }

  headers(): Record<string, string> {
    const extra = this.opts.headers ?? {};
    const h: Record<string, string> = {};
    const hasAuth = Object.keys(extra).some((k) => /^(x-goog-api-key|authorization)$/i.test(k));
    if (this.opts.apiKey && !hasAuth) h['x-goog-api-key'] = this.opts.apiKey;
    return { ...h, ...extra };
  }

  private modelPath(model: string): string {
    return `${this.baseUrl}/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}`;
  }

  buildBody(req: ChatRequest, names = new ToolNameMap(GEMINI_TOOL_NAME_RULES)): Wire {
    const info = this.model(req.model);
    const body: Wire = { contents: geminiContents(req, names, this.seesImages(req.model, info)) };
    const system = req.system
      .map((s) => s.text)
      .filter(Boolean)
      .join('\n\n');
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => {
            const decl: Wire = { name: names.wire(t.name), description: t.description };
            const params = sanitizeGeminiSchema(t.inputSchema ?? { type: 'object' });
            if (params.properties) decl.parameters = params;
            return decl;
          }),
        },
      ];
      const tc = req.toolChoice;
      if (tc) {
        const cfg: Wire =
          tc === 'auto'
            ? { mode: 'AUTO' }
            : tc === 'none'
              ? { mode: 'NONE' }
              : tc === 'any'
                ? { mode: 'ANY' }
                : { mode: 'ANY', allowedFunctionNames: [names.wire(tc.name)] };
        body.toolConfig = { functionCallingConfig: cfg };
      }
    }
    const gen: Wire = {};
    if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    if (req.stopSequences?.length) gen.stopSequences = req.stopSequences;
    const thinking = geminiThinkingConfig(req.model, req, info);
    if (thinking) gen.thinkingConfig = thinking;
    if (req.responseSchema) {
      gen.responseMimeType = 'application/json';
      gen.responseSchema = sanitizeGeminiSchema(req.responseSchema);
    }
    if (Object.keys(gen).length) body.generationConfig = gen;
    return body;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const names = new ToolNameMap(GEMINI_TOOL_NAME_RULES);
    const body = this.buildBody(req, names);
    const res = await openStream(`${this.modelPath(req.model)}:streamGenerateContent?alt=sse`, this.headers(), body, this.http(req.signal));
    const state = new GeminiStream(this.id, req.model, names);
    for await (const msg of parseSse(res, { signal: req.signal, idleTimeoutMs: this.idleTimeoutMs, provider: this.id })) {
      for (const data of parseSseJson(msg.data)) yield* state.handle(data);
    }
    yield* state.finish();
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.listWith(async () => {
      const out: ModelInfo[] = [];
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        const url = `${this.baseUrl}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
        const res = await getJson<{
          models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[]; thinking?: boolean }>;
          nextPageToken?: string;
        }>(url, this.headers(), this.http());
        for (const m of res.models ?? []) {
          if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
          const id = m.name.replace(/^models\//, '');
          if (!id.startsWith('gemini')) continue;
          const info = this.model(id);
          if (!this.opts.config.modelOverrides?.[id]) {
            if (m.displayName && info.name === id) info.name = m.displayName;
            if (m.inputTokenLimit) info.contextWindow = m.inputTokenLimit;
            if (m.outputTokenLimit) info.maxOutput = m.outputTokenLimit;
            if (m.thinking) info.thinking = true;
          }
          out.push(info);
        }
        if (!res.nextPageToken) break;
        token = res.nextPageToken;
      }
      return out;
    });
  }

  async embed(texts: string[], model = 'gemini-embedding-001'): Promise<number[][]> {
    const out: number[][] = [];
    const name = model.replace(/^models\//, '');
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await postJson<{ embeddings?: Array<{ values: number[] }> }>(
        `${this.modelPath(name)}:batchEmbedContents`,
        this.headers(),
        { requests: batch.map((text) => ({ model: `models/${name}`, content: { parts: [{ text }] } })) },
        this.http(),
      );
      out.push(...(res.embeddings ?? []).map((e) => e.values));
    }
    return out;
  }

  async countTokens(req: ChatRequest): Promise<number> {
    const body = this.buildBody(req);
    const request: Wire = { model: `models/${req.model.replace(/^models\//, '')}`, contents: body.contents };
    if (body.systemInstruction) request.systemInstruction = body.systemInstruction;
    if (body.tools) request.tools = body.tools;
    const res = await postJson<{ totalTokens?: number }>(`${this.modelPath(req.model)}:countTokens`, this.headers(), { generateContentRequest: request }, this.http(req.signal));
    return res.totalTokens ?? 0;
  }
}
