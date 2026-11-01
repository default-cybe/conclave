/**
 * The tap: a small recording pass-through that sits between both arms and
 * CLIProxyAPI. Every model request from either arm goes through it, so one
 * parser counts tokens for both, reads the model id the API says it served,
 * and records what each harness sent (tools offered, thinking, effort,
 * max_tokens, system prompt size). It also scans what the model was shown in
 * tool results for paths to hidden material and for lines of the hidden
 * tests (see leaks.ts), the same way for both arms.
 *
 * Runs are sequential, so the runner tells the tap which run is current
 * (begin/end). A request outside a run is kept as "unattributed".
 */
import { appendFileSync } from 'node:fs';
import { sha256 } from './util';
import { scanRequest, type LeakProbe } from './leaks';

export interface TapUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Part of cache_write written with the 1 hour TTL (priced higher), when the API says. */
  cache_write_1h: number;
}

export interface TapRecord {
  i: number;
  run: string | null;
  ts: number;
  method: string;
  path: string;
  status: number | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  stream: boolean;
  model_requested: string | null;
  model_served: string | null;
  max_tokens: number | null;
  thinking: unknown;
  effort: unknown;
  tools: string[] | null;
  system_chars: number | null;
  system_sha: string | null;
  messages: number | null;
  usage: TapUsage | null;
  stop_reason: string | null;
  error: string | null;
  /** The task prompt appears as text in the first user message. */
  prompt_found: boolean | null;
  /** Hidden-material paths the agent named in a tool call (attempts). */
  marker_in_calls: string[];
  /** Hidden-material paths the model was shown in tool results. */
  marker_in_results: string[];
  /** Lines of the hidden tests the model was shown and never wrote itself. */
  canary_lines: string[];
}

interface RunState {
  id: string;
  probe: LeakProbe | null;
  prompt: string | null;
  records: TapRecord[];
  liveTokens: number;
}

const zero = (): TapUsage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 });

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Fold one Anthropic usage object into a TapUsage (fields in later events are cumulative). */
export function foldAnthropicUsage(into: TapUsage, u: any): void {
  if (!u || typeof u !== 'object') return;
  const max = (a: number, b: number | undefined) => (b === undefined ? a : Math.max(a, b));
  into.input = max(into.input, num(u.input_tokens));
  into.output = max(into.output, num(u.output_tokens));
  into.cache_read = max(into.cache_read, num(u.cache_read_input_tokens));
  into.cache_write = max(into.cache_write, num(u.cache_creation_input_tokens));
  const cc = u.cache_creation;
  if (cc && typeof cc === 'object') into.cache_write_1h = max(into.cache_write_1h, num(cc.ephemeral_1h_input_tokens));
}

/** OpenAI chat completions usage, with Anthropic semantics (input is the uncached part). */
export function foldOpenAiUsage(into: TapUsage, u: any): void {
  if (!u || typeof u !== 'object') return;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0;
  const cached = num(u.prompt_tokens_details?.cached_tokens) ?? 0;
  const written = num(u.prompt_tokens_details?.cache_write_tokens) ?? num(u.prompt_tokens_details?.cache_creation_tokens) ?? 0;
  into.input = Math.max(0, prompt - cached - written);
  into.output = num(u.completion_tokens) ?? num(u.output_tokens) ?? into.output;
  into.cache_read = cached;
  into.cache_write = written;
}

/** Parse a whole SSE body or a chunk stream: yields each data payload as JSON. */
export function* sseEvents(text: string): Generator<any> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data);
    } catch {
      /* partial or non JSON */
    }
  }
}

export function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function firstUserTexts(messages: any[]): string[] {
  const first = messages.find((m) => m?.role === 'user');
  if (!first) return [];
  if (typeof first.content === 'string') return [first.content];
  if (!Array.isArray(first.content)) return [];
  return first.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text);
}

/** Read what a request asks for. Works for Anthropic Messages and OpenAI chat bodies. */
export function describeRequest(body: any, prompt: string | null): Partial<TapRecord> {
  const out: Partial<TapRecord> = {};
  out.model_requested = typeof body?.model === 'string' ? body.model : null;
  out.stream = !!body?.stream;
  out.max_tokens = num(body?.max_tokens) ?? num(body?.max_completion_tokens) ?? null;
  out.thinking = body?.thinking ?? body?.reasoning_effort ?? null;
  out.effort = body?.output_config?.effort ?? body?.reasoning?.effort ?? null;
  out.tools = Array.isArray(body?.tools) ? body.tools.map((t: any) => t?.name ?? t?.function?.name).filter(Boolean) : null;
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  out.messages = msgs.length;
  let sys = systemText(body?.system);
  if (!sys) sys = msgs.filter((m) => m?.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : systemText(m.content))).join('\n');
  out.system_chars = sys ? sys.length : null;
  out.system_sha = sys ? sha256(sys).slice(0, 16) : null;
  if (prompt !== null && (out.tools?.length ?? 0) > 0) {
    const texts = firstUserTexts(msgs.filter((m) => m?.role !== 'system'));
    out.prompt_found = texts.some((t) => t === prompt || t.includes(prompt));
  } else out.prompt_found = null;
  return out;
}

export class Tap {
  private server?: ReturnType<typeof Bun.serve>;
  private current: RunState | null = null;
  private inflight = 0;
  private seq = 0;
  readonly unattributed: TapRecord[] = [];

  constructor(
    private upstream: string,
    private port: number,
    private logFile?: string,
  ) {}

  /** The address both arms use as their model API base URL. */
  get url(): string {
    return `http://127.0.0.1:${this.server?.port ?? this.port}`;
  }

  start(): void {
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch(req) {
        return self.handle(req);
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  /** Mark the start of a run. Every request until end() belongs to it. */
  begin(runId: string, opts: { prompt: string | null; probe: LeakProbe | null }): void {
    this.current = { id: runId, probe: opts.probe, prompt: opts.prompt, records: [], liveTokens: 0 };
  }

  /** Tokens seen so far in the current run (for the per run cap, the same for both arms). */
  liveTokens(): number {
    return this.current?.liveTokens ?? 0;
  }

  /** End the current run after in-flight requests finish (or the wait runs out). */
  async end(waitMs = 10_000): Promise<TapRecord[]> {
    const until = Date.now() + waitMs;
    while (this.inflight > 0 && Date.now() < until) await Bun.sleep(100);
    const recs = this.current?.records ?? [];
    this.current = null;
    return recs;
  }

  private log(rec: TapRecord): void {
    if (!this.logFile) return;
    try {
      appendFileSync(this.logFile, JSON.stringify(rec) + '\n');
    } catch {
      /* logging is best effort */
    }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const run = this.current;
    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
    const rec: TapRecord = {
      i: ++this.seq,
      run: run?.id ?? null,
      ts: Date.now(),
      method: req.method,
      path: url.pathname,
      status: null,
      latency_ms: null,
      ttft_ms: null,
      stream: false,
      model_requested: null,
      model_served: null,
      max_tokens: null,
      thinking: null,
      effort: null,
      tools: null,
      system_chars: null,
      system_sha: null,
      messages: null,
      usage: null,
      stop_reason: null,
      error: null,
      prompt_found: null,
      marker_in_calls: [],
      marker_in_results: [],
      canary_lines: [],
    };
    const isMessages = /\/v1\/(messages|chat\/completions)$/.test(url.pathname);
    if (isMessages && bodyText) {
      try {
        const body = JSON.parse(bodyText);
        const firstMain = run && !run.records.some((r) => (r.tools?.length ?? 0) > 0);
        Object.assign(rec, describeRequest(body, firstMain ? run.prompt : null));
        if (run?.probe) {
          const s = scanRequest(body, run.probe);
          rec.marker_in_calls = s.markerInCalls;
          rec.marker_in_results = s.markerInResults;
          rec.canary_lines = s.canaryLines;
        }
      } catch (e) {
        rec.error = `bad request body: ${(e as Error).message}`;
      }
    }
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.set('accept-encoding', 'identity');
    const started = Date.now();
    this.inflight++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.inflight--;
      rec.latency_ms = Date.now() - started;
      if (run) {
        run.records.push(rec);
        if (rec.usage) run.liveTokens += rec.usage.input + rec.usage.output + rec.usage.cache_read + rec.usage.cache_write;
      } else this.unattributed.push(rec);
      this.log(rec);
    };
    let up: Response;
    try {
      up = await fetch(this.upstream + url.pathname + url.search, { method: req.method, headers, body: bodyText, redirect: 'manual', timeout: false } as RequestInit);
    } catch (e) {
      rec.error = `upstream unreachable: ${(e as Error).message}`;
      finish();
      return Response.json({ type: 'error', error: { type: 'api_error', message: `bench tap: upstream unreachable: ${(e as Error).message}` } }, { status: 502 });
    }
    rec.status = up.status;
    const outHeaders = new Headers(up.headers);
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) outHeaders.delete(h);
    if (!up.body) {
      finish();
      return new Response(null, { status: up.status, headers: outHeaders });
    }
    const [toClient, toTap] = up.body.tee();
    const isSse = /event-stream/.test(up.headers.get('content-type') ?? '');
    void this.consume(toTap, rec, isSse, started).finally(finish);
    return new Response(toClient, { status: up.status, headers: outHeaders });
  }

  private async consume(stream: ReadableStream<Uint8Array>, rec: TapRecord, isSse: boolean, started: number): Promise<void> {
    const dec = new TextDecoder();
    let buf = '';
    let all = '';
    const usage = zero();
    let sawUsage = false;
    const onEvent = (ev: any) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'message_start' && ev.message) {
        rec.model_served = ev.message.model ?? rec.model_served;
        foldAnthropicUsage(usage, ev.message.usage);
        sawUsage = true;
      } else if (ev.type === 'message_delta') {
        foldAnthropicUsage(usage, ev.usage);
        sawUsage = true;
        if (ev.delta?.stop_reason) rec.stop_reason = ev.delta.stop_reason;
      } else if (ev.type === 'content_block_delta' || ev.type === 'content_block_start') {
        if (rec.ttft_ms === null) rec.ttft_ms = Date.now() - started;
      } else if (ev.type === 'error') {
        rec.error = String(ev.error?.message ?? ev.error?.type ?? 'error');
      } else if (Array.isArray(ev.choices)) {
        // OpenAI chunk
        if (ev.model) rec.model_served = ev.model;
        if (rec.ttft_ms === null && ev.choices.some((c: any) => c?.delta?.content || c?.delta?.tool_calls)) rec.ttft_ms = Date.now() - started;
        const fr = ev.choices.find((c: any) => c?.finish_reason)?.finish_reason;
        if (fr) rec.stop_reason = fr;
        if (ev.usage) {
          foldOpenAiUsage(usage, ev.usage);
          sawUsage = true;
        }
      }
    };
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const text = dec.decode(chunk, { stream: true });
        if (isSse) {
          buf += text;
          let k: number;
          while ((k = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, k);
            buf = buf.slice(k).replace(/^\r?\n\r?\n/, '');
            for (const ev of sseEvents(block + '\n\n')) onEvent(ev);
          }
        } else if (all.length < 4_000_000) all += text;
      }
      if (isSse && buf.trim()) for (const ev of sseEvents(buf + '\n\n')) onEvent(ev);
      if (!isSse && all) {
        try {
          const body = JSON.parse(all);
          if (body?.type === 'error' || (rec.status !== null && rec.status >= 400)) rec.error = String(body?.error?.message ?? body?.error ?? all.slice(0, 300));
          if (body?.model) rec.model_served = body.model;
          if (body?.usage) {
            if (Array.isArray(body.choices)) foldOpenAiUsage(usage, body.usage);
            else foldAnthropicUsage(usage, body.usage);
            sawUsage = true;
          }
          if (body?.stop_reason) rec.stop_reason = body.stop_reason;
        } catch {
          if (rec.status !== null && rec.status >= 400) rec.error = all.slice(0, 300);
        }
      }
    } catch (e) {
      rec.error = rec.error ?? `stream cut: ${(e as Error).message}`;
    }
    if (sawUsage) rec.usage = usage;
  }
}

/** Per run summary of tap records, in the same shape for every arm. */
export interface TapSummary {
  requests: number;
  messages_requests: number;
  errors: number;
  status_429: number;
  tokens: (TapUsage & { by_model: Record<string, TapUsage> }) | null;
  models_requested: string[];
  models_served: Record<string, string[]>;
  main_requests: number;
  first_main: { tokens: number | null; tools: string[]; max_tokens: number | null; thinking: unknown; effort: unknown; system_chars: number | null; system_sha: string | null } | null;
  tools_offered: string[];
  max_tokens: Array<number | null>;
  thinking: string[];
  effort: string[];
  prompt_found: boolean | null;
  api_ms: number;
  ttft_first_ms: number | null;
  leak: { marker_in_calls: string[]; marker_in_results: string[]; canary_lines: string[] };
}

export function summarizeTap(recs: TapRecord[], mainModel: string): TapSummary {
  const msgs = recs.filter((r) => /\/v1\/(messages|chat\/completions)$/.test(r.path));
  const strip = (m: string | null) => (m ?? '').replace(/^neu\//, '');
  const isMain = (r: TapRecord) => strip(r.model_requested) === strip(mainModel);
  const total = zero();
  const byModel: Record<string, TapUsage> = {};
  let haveUsage = false;
  for (const r of msgs) {
    if (!r.usage) continue;
    haveUsage = true;
    const k = r.model_served ?? r.model_requested ?? 'unknown';
    const m = (byModel[k] ??= zero());
    for (const f of ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'] as const) {
      total[f] += r.usage[f];
      m[f] += r.usage[f];
    }
  }
  const served: Record<string, Set<string>> = {};
  for (const r of msgs) if (r.model_requested && r.model_served) (served[r.model_requested] ??= new Set()).add(r.model_served);
  const main = msgs.filter((r) => isMain(r) && (r.tools?.length ?? 0) > 0);
  const first = main[0] ?? null;
  const uniq = (xs: unknown[]) => [...new Set(xs.map((x) => (x === null || x === undefined ? 'none' : typeof x === 'string' ? x : JSON.stringify(x))))];
  const firstWithPrompt = msgs.find((r) => r.prompt_found !== null);
  return {
    requests: recs.length,
    messages_requests: msgs.length,
    errors: msgs.filter((r) => r.error || (r.status ?? 0) >= 400).length,
    status_429: msgs.filter((r) => r.status === 429).length,
    tokens: haveUsage ? { ...total, by_model: byModel } : null,
    models_requested: uniq(msgs.map((r) => r.model_requested)),
    models_served: Object.fromEntries(Object.entries(served).map(([k, v]) => [k, [...v]])),
    main_requests: main.length,
    first_main: first
      ? {
          tokens: first.usage ? first.usage.input + first.usage.output + first.usage.cache_read + first.usage.cache_write : null,
          tools: first.tools ?? [],
          max_tokens: first.max_tokens,
          thinking: first.thinking,
          effort: first.effort,
          system_chars: first.system_chars,
          system_sha: first.system_sha,
        }
      : null,
    tools_offered: [...new Set(main.flatMap((r) => r.tools ?? []))].sort(),
    max_tokens: [...new Set(main.map((r) => r.max_tokens))],
    thinking: uniq(main.map((r) => r.thinking)),
    effort: uniq(main.map((r) => r.effort)),
    prompt_found: firstWithPrompt ? firstWithPrompt.prompt_found : null,
    api_ms: msgs.reduce((a, r) => a + (r.latency_ms ?? 0), 0),
    ttft_first_ms: first?.ttft_ms ?? null,
    leak: {
      marker_in_calls: [...new Set(msgs.flatMap((r) => r.marker_in_calls))].slice(0, 10),
      marker_in_results: [...new Set(msgs.flatMap((r) => r.marker_in_results))].slice(0, 10),
      canary_lines: [...new Set(msgs.flatMap((r) => r.canary_lines))].slice(0, 20),
    },
  };
}
