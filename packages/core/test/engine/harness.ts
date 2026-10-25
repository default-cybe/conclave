/**
 * Real engine with a scripted Anthropic-compatible model, for engine tests.
 * Requests that carry tools take the next step of the script (or the step a
 * `route` picks by request content); chores (titles, compaction summaries)
 * carry none and get "ok" unless a `chore` handler answers them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { CreateEngineOptions } from '../../src/engine/create';
import type { Engine } from '../../src/engine/engine';
import type { ConclaveConfig, HooksConfig } from '../../src/config/schema';
import { tempDir, cleanup } from '../extensions/_helpers';

export type Block = { text: string } | { tool: string; input: Record<string, unknown> };

/**
 * One scripted reply: its blocks, or blocks with an explicit stop reason
 * (Anthropic wire name, e.g. "max_tokens", "refusal"), usage, and a delay
 * before the reply is sent.
 */
export type Step = Block[] | StepSpec;
export interface StepSpec {
  blocks: Block[];
  stop?: string;
  usage?: { input?: number; output?: number };
  delayMs?: number;
  /** Hold the reply until this settles (a test releases it by hand, no timing). */
  gate?: Promise<unknown>;
}

/** Request body as the mock server received it. */
export type RequestBody = { tools?: Array<{ name: string }>; tool_choice?: unknown; system?: unknown; messages?: unknown[]; [key: string]: unknown };

export const HOOK_SCRIPT = join(import.meta.dir, 'fixtures', 'hook-log.ts');

function stepOf(step: Step): StepSpec {
  return Array.isArray(step) ? { blocks: step } : step;
}

function sse(step: Step, turn: number): string {
  const { blocks, stop: stopOverride, usage } = stepOf(step);
  const events: unknown[] = [{ type: 'message_start', message: { id: `msg_${turn}`, model: 'claude-sonnet-5-5', usage: { input_tokens: usage?.input ?? 10, output_tokens: 0 } } }];
  blocks.forEach((b, index) => {
    if ('text' in b) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${turn}_${index}`, name: b.tool, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  const stop = stopOverride ?? (blocks.some((b) => 'tool' in b) ? 'tool_use' : 'end_turn');
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: usage?.output ?? 5 } }, { type: 'message_stop' });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const PREFILL_400 = 'This model does not support assistant message prefill. The conversation must end with a user message.';

/**
 * The transcript checks the Messages API makes, so a bad shape fails here as
 * it does in production. Text after the tool calls in an assistant message is
 * answered like a prefill: run r4e37h sent that shape (an unknown tool's call
 * flattened to text behind two real calls) and got the prefill 400.
 */
export function apiShapeError(body: RequestBody): string | undefined {
  const msgs = (body.messages ?? []) as Array<{ role: string; content: Array<Record<string, any>> | string }>;
  if (!msgs.length) return 'messages: at least one message is required';
  if (msgs[0].role !== 'user') return 'messages.0: the first message must use the "user" role';
  if (msgs[msgs.length - 1].role === 'assistant') return PREFILL_400;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (typeof m.content === 'string') continue;
    if (m.role === 'assistant') {
      const first = m.content.findIndex((b) => b.type === 'tool_use');
      if (first < 0) continue;
      if (m.content.slice(first).some((b) => b.type === 'text')) return PREFILL_400;
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id as string);
      const next = msgs[i + 1];
      const got = next && typeof next.content !== 'string' ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id as string) : [];
      const missing = ids.filter((id) => !got.includes(id));
      if (missing.length) return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
    } else {
      const prev = msgs[i - 1];
      const ids = prev && typeof prev.content !== 'string' && prev.role === 'assistant' ? prev.content.filter((b) => b.type === 'tool_use').map((b) => b.id as string) : [];
      let seenOther = false;
      for (const b of m.content) {
        if (b.type !== 'tool_result') {
          seenOther = true;
          continue;
        }
        if (!ids.includes(b.tool_use_id)) return `messages.${i}.content: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${b.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
        if (seenOther) return `messages.${i}.content: tool_result blocks must come first in the user message`;
      }
    }
  }
  return undefined;
}

export interface TestEngine {
  engine: Engine;
  home: string;
  cwd: string;
  claudeDir: string;
  log: string;
  /** Bodies of scripted requests, as JSON text. */
  requests: string[];
  /** The provider each scripted request went to: "mock", or an id from extraProviders. */
  requestProviders: string[];
  /** Bodies of chore requests (no tools: titles, summaries), as JSON text. */
  chores: string[];
  /** Requests answered with a 400 because their shape was wrong, and the error sent. */
  rejected: Array<{ body: string; error: string }>;
  approvals: string[];
  /** Lines the hook script wrote. */
  hookLog(): Array<{ mode: string; input: Record<string, any> }>;
  hook(mode: string, extra?: Record<string, unknown>): { type: 'command'; command: string; timeout: number };
  /** Send a prompt and wait for the turn to end. */
  run(sessionId: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface TestEngineOptions {
  script: Step[];
  /**
   * Pick the reply for a request with tools by its content (text is the raw
   * body). Return undefined to take the next script step, or a number to
   * answer with that HTTP status. Use it when parent and subagent requests
   * interleave.
   */
  route?: (body: RequestBody, text: string, provider: string) => Step | number | { status: number; error?: string; type?: string; delayMs?: number } | undefined;
  /** Reply for chore requests (no tools). A number answers with that HTTP status. Default: text "ok". */
  chore?: (body: RequestBody, text: string) => Step | number | undefined;
  hooks?: (t: { hook: TestEngine['hook'] }) => HooksConfig;
  /** Answer approvals: allow, deny (default) or leave pending. */
  approve?: 'allow' | 'deny';
  overrides?: Partial<ConclaveConfig>;
  /** Reject requests whose transcript shape the Messages API would reject (apiShapeError). Default true. */
  checkShape?: boolean;
  /** Per-model overrides for the mock provider (a smaller context window, a price). */
  modelOverrides?: NonNullable<ConclaveConfig['providers'][string]['modelOverrides']>;
  /** Models the mock provider lists. Default claude-sonnet-5-5 only; every model answers from the same script. */
  models?: string[];
  /** Calendar and mail endpoints and OAuth clients (fake servers). */
  pim?: CreateEngineOptions['pim'];
  /** More Anthropic-wire providers on the same mock server, by id, with the models each lists. route() is told which one a request went to. */
  extraProviders?: Record<string, string[]>;
}

export async function startTestEngine(opts: TestEngineOptions): Promise<TestEngine> {
  const home = tempDir('conclave-eng-home-');
  const cwd = tempDir('conclave-eng-cwd-');
  const claudeDir = tempDir('conclave-eng-claude-');
  const savedClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const log = join(home, 'hooks.log');
  const hook: TestEngine['hook'] = (mode, extra = {}) => ({ type: 'command', command: `HOOK_LOG=${log} bun ${HOOK_SCRIPT} ${mode}`, timeout: 30, ...extra });

  const requests: string[] = [];
  const requestProviders: string[] = [];
  const chores: string[] = [];
  const rejected: Array<{ body: string; error: string }> = [];
  let turn = 0;
  let routed = 0;
  const mock = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const body = JSON.parse(text) as RequestBody;
      const failWith = (status: number, message = `scripted ${status}`, type = status === 400 ? 'invalid_request_error' : 'api_error') =>
        new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const shape = opts.checkShape === false ? undefined : apiShapeError(body);
      if (shape) {
        rejected.push({ body: text, error: shape });
        return failWith(400, shape);
      }
      if (!body.tools?.length) {
        chores.push(text);
        const reply = opts.chore?.(body, text);
        if (typeof reply === 'number') return failWith(reply);
        if (reply && stepOf(reply).delayMs) await Bun.sleep(stepOf(reply).delayMs!);
        return new Response(sse(reply ?? [{ text: 'ok' }], 999), { headers: { 'content-type': 'text/event-stream' } });
      }
      const provider = /^\/p\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? 'mock';
      requests.push(text);
      requestProviders.push(provider);
      const routedReply = opts.route?.(body, text, provider);
      if (typeof routedReply === 'number') return failWith(routedReply);
      if (routedReply && 'status' in routedReply) {
        if (routedReply.delayMs) await Bun.sleep(routedReply.delayMs);
        return failWith(routedReply.status, routedReply.error, routedReply.type);
      }
      const picked = routedReply;
      const n = picked ? 500 + ++routed : ++turn;
      const step = picked ?? opts.script[Math.min(n - 1, opts.script.length - 1)];
      const delay = stepOf(step).delayMs;
      if (delay) await Bun.sleep(delay);
      await stepOf(step).gate;
      return new Response(sse(step, n), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    ...(opts.pim ? { pim: opts.pim } : {}),
    overrides: {
      defaultModel: 'mock/claude-sonnet-5-5',
      smallModel: 'mock/claude-sonnet-5-5',
      providers: {
        mock: { type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'test', models: opts.models ?? ['claude-sonnet-5-5'], ...(opts.modelOverrides ? { modelOverrides: opts.modelOverrides } : {}) },
        ...Object.fromEntries(Object.entries(opts.extraProviders ?? {}).map(([id, models]) => [id, { type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.port}/p/${id}`, apiKey: 'test', models }])),
      },
      permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [] },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      hooks: opts.hooks?.({ hook }) ?? {},
      // tier words in agent profiles (verifier: deep) stay on the scripted model: never a real API key or harness found on this machine
      models: { tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'mock/claude-sonnet-5-5' } },
      ...(opts.overrides ?? {}),
    } as never,
  });

  const approvals: string[] = [];
  const off = engine.bus.on((e: { type: string; approval?: { id: string; summary: string; input?: unknown } }) => {
    if (e.type === 'approval.requested' && e.approval) {
      approvals.push(`${e.approval.summary} ${JSON.stringify(e.approval.input ?? {})}`);
      const decision = opts.approve ?? 'deny';
      queueMicrotask(() => engine.resolveApproval(e.approval!.id, decision === 'allow' ? { decision: 'allow', scope: 'once' } : { decision: 'deny', message: 'headless' }));
    }
  });

  return {
    engine,
    home,
    cwd,
    claudeDir,
    log,
    requests,
    requestProviders,
    chores,
    rejected,
    approvals,
    hook,
    hookLog: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    async run(sessionId, text) {
      const runner = engine.runnerFor(sessionId);
      await runner.enqueue({ text });
      await Promise.race([runner.waitIdle(), Bun.sleep(30_000)]);
    },
    async close() {
      off();
      await engine.shutdown();
      mock.stop(true);
      if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedClaude;
      cleanup(home, cwd, claudeDir);
    },
  };
}

/** Text of the first message in a request body (to tell a subagent's requests from its parent's). */
export function firstUserText(body: { messages?: unknown[] }): string {
  const first = body.messages?.[0] as { content?: unknown } | undefined;
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return JSON.stringify(first.content ?? '');
}

/** Wait until pred() holds (fire-and-forget hooks), up to ms. */
export async function until(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

/** Text of every tool result in a session. */
export function toolResults(engine: Engine, sessionId: string): Array<{ name: string; content: string; isError: boolean }> {
  const msgs = engine.getMessages(sessionId);
  const names = new Map<string, string>();
  for (const m of msgs) for (const b of m.content as Array<Record<string, any>>) if (b.type === 'tool_use') names.set(b.id, b.name);
  const out: Array<{ name: string; content: string; isError: boolean }> = [];
  for (const m of msgs) {
    for (const b of m.content as Array<Record<string, any>>) {
      if (b.type !== 'tool_result') continue;
      out.push({ name: names.get(b.toolUseId) ?? '', content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: !!b.isError });
    }
  }
  return out;
}
