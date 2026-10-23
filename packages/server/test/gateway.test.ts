import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import type { ConclaveConfig } from '@conclave/core/config/index.ts';
import type { UsageRecord } from '@conclave/core/types.ts';
import { UsageTap, joinUpstream, limitFromHeaders } from '../src/gateway';
import { UpstreamLimiter } from '../src/gateway/limiter';
import { startHub, type TestHub } from './helpers';

// ---------------------------------------------------------------------------
// Mock upstream: streams SSE in timed chunks and records what it received
// ---------------------------------------------------------------------------

interface Received {
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

const received: Received[] = [];
let inflight = 0;
let maxInflight = 0;
let fail429 = 0;
let anthropicStreamDone = false;

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-test","content":[],"usage":{"input_tokens":120,"cache_read_input_tokens":3000,"cache_creation_input_tokens":40,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: ping\ndata: {"type": "ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel',
  'lo"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" wörld ✓"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const OPENAI_CHAT_SSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{"content":"Hi"}}],"usage":null}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","model":"gpt-test","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":800},"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
  'data: [DONE]\n\n',
];

const OPENAI_RESPONSES_SSE = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","model":"gpt-resp","usage":null}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","model":"gpt-resp","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":10},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2}}}}\n\n',
];

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}],"modelVersion":"gemini-test"}\r\n\r\n',
  'data: {"candidates":[{"content":{"parts":[{"text":"b"}]}}],"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":4,"thoughtsTokenCount":6,"cachedContentTokenCount":10},"modelVersion":"gemini-test"}\r\n\r\n',
];

function sse(chunks: string[], delayMs: number, onDone?: () => void, headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i >= chunks.length) {
        onDone?.();
        c.close();
        return;
      }
      if (i > 0) await Bun.sleep(delayMs);
      c.enqueue(enc.encode(chunks[i++]));
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } });
}

let upstream: Server<undefined>;
let hub: TestHub;
let keyA: string;
const usage: UsageRecord[] = [];

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      received.push({ path: url.pathname, search: url.search, headers, body, at: Date.now() });
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        if (url.pathname === '/slow/v1/messages') {
          await Bun.sleep(80);
          return Response.json({ model: 'slow', usage: { input_tokens: 1, output_tokens: 1 } });
        }
        if (url.pathname === '/limited/v1/messages') {
          if (fail429 > 0) {
            fail429--;
            return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '1' } });
          }
          return Response.json({ model: 'm', usage: { input_tokens: 2, output_tokens: 3 } });
        }
        if (url.pathname.endsWith('/v1/messages')) {
          const parsed = JSON.parse(body);
          if (!parsed.stream) {
            return Response.json({ id: 'msg_2', model: parsed.model, usage: { input_tokens: 11, output_tokens: 22 } }, { headers: { 'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '49' } });
          }
          return sse(ANTHROPIC_SSE, 40, () => (anthropicStreamDone = true), {
            'anthropic-ratelimit-unified-5h-utilization': '0.25',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
            'anthropic-ratelimit-unified-status': 'allowed',
          });
        }
        if (url.pathname === '/v1/chat/completions') return sse(OPENAI_CHAT_SSE, 5, undefined, { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '90', 'x-ratelimit-reset-requests': '6m0s' });
        if (url.pathname === '/v1/responses') return sse(OPENAI_RESPONSES_SSE, 5);
        if (url.pathname.startsWith('/v1beta/models/')) return sse(GEMINI_SSE, 5);
        return new Response('not found', { status: 404 });
      } finally {
        inflight--;
      }
    },
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  const providers = {
    anthropic: { type: 'anthropic', baseUrl: base, apiKey: 'sk-upstream-anthropic' },
    openai: { type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-upstream-openai' },
    google: { type: 'gemini', baseUrl: base, apiKey: 'g-upstream' },
    relay: { type: 'anthropic', baseUrl: `${base}/relay`, name: 'Relay' },
    zai: { type: 'anthropic', baseUrl: `${base}/zai`, apiKey: 'zai-key', subscription: 'zai-coding' },
    slow: { type: 'anthropic', baseUrl: `${base}/slow`, apiKey: 'k' },
    limited: { type: 'anthropic', baseUrl: `${base}/limited`, apiKey: 'k' },
  };
  hub = startHub(
    { gateway: { onUsage: (r) => usage.push(r) } },
    {
      providers,
      smallModel: 'anthropic/claude-haiku-test',
      defaultModel: 'anthropic/claude-sonnet-test',
      gateway: { aliases: { glm: 'zai/glm-5', mini: { openai: 'gpt-mini' } } },
    } as unknown as Partial<ConclaveConfig>,
  );
  keyA = (await hub.api('/api/gateway/keys', { method: 'POST', json: { name: 'claude code' } }).then((r) => r.json())).key;
});

afterAll(async () => {
  await hub.stop();
  upstream.stop(true);
});

const last = () => received.at(-1)!;

describe('gateway passthrough', () => {
  test('Anthropic SSE: bytes identical, streamed as they arrive, usage and limits captured', async () => {
    anthropicStreamDone = false;
    usage.length = 0;
    // odd spacing proves the body is not re-serialized
    const body = '{"model":  "claude-sonnet-test", "stream": true,\n "max_tokens": 64, "messages": [{"role":"user","content":"héllo"}]}';
    const res = await fetch(`${hub.url}/gw/anthropic/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-api-key': keyA, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.0' },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const parts: Uint8Array[] = [];
    const first = await reader.read();
    // first bytes arrive while the upstream is still streaming
    expect(anthropicStreamDone).toBe(false);
    parts.push(first.value!);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const got = Buffer.concat(parts).toString('utf8');
    expect(got).toBe(ANTHROPIC_SSE.join(''));

    const r = last();
    expect(r.path).toBe('/v1/messages');
    expect(r.search).toBe('?beta=true');
    expect(r.body).toBe(body);
    expect(r.headers['x-api-key']).toBe('sk-upstream-anthropic');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.stringify(r.headers)).not.toContain('cgw_');
    expect(r.headers['accept-encoding']).toBe('identity');

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      source: 'gateway',
      provider: 'anthropic',
      model: 'claude-sonnet-test',
      inputTokens: 120,
      outputTokens: 57,
      cacheReadTokens: 3000,
      cacheWriteTokens: 40,
      costUsd: 0,
      purpose: 'claude code',
    });
    const limit = hub.engine.repos.usage.limits().find((l) => l.provider === 'anthropic');
    expect(limit?.windows.find((w) => w.name === '5h')?.usedPercent).toBe(25);
  });

  test('Anthropic JSON response and request-rate headers', async () => {
    usage.length = 0;
    const res = await fetch(`${hub.url}/gw/anthropic/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keyA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-test', max_tokens: 5, messages: [] }),
    });
    expect(await res.json()).toEqual({ id: 'msg_2', model: 'claude-sonnet-test', usage: { input_tokens: 11, output_tokens: 22 } });
    expect(last().headers.authorization).toBeUndefined();
    expect(usage[0]).toMatchObject({ inputTokens: 11, outputTokens: 22, model: 'claude-sonnet-test' });
  });

  test('OpenAI chat and Responses streams, Gemini SSE', async () => {
    usage.length = 0;
    const chat = await fetch(`${hub.url}/gw/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keyA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, stream_options: { include_usage: true }, messages: [] }),
    });
    expect(await chat.text()).toBe(OPENAI_CHAT_SSE.join(''));
    expect(last().path).toBe('/v1/chat/completions');
    expect(last().headers.authorization).toBe('Bearer sk-upstream-openai');

    const resp = await fetch(`${hub.url}/gw/openai/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keyA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-resp', stream: true, input: 'x' }),
    });
    expect(await resp.text()).toBe(OPENAI_RESPONSES_SSE.join(''));
    expect(last().path).toBe('/v1/responses');

    const gem = await fetch(`${hub.url}/gw/gemini/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=${keyA}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [] }),
    });
    expect(await gem.text()).toBe(GEMINI_SSE.join(''));
    expect(last().search).toBe('?alt=sse');
    expect(last().headers['x-goog-api-key']).toBe('g-upstream');

    expect(usage.map((u) => [u.provider, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.reasoningTokens])).toEqual([
      ['openai', 'gpt-test', 200, 20, 800, 5],
      ['openai', 'gpt-resp', 40, 7, 10, 2],
      ['google', 'gemini-test', 20, 10, 10, 6],
    ]);
    expect(hub.engine.repos.usage.limits().find((l) => l.provider === 'openai')?.windows[0]).toMatchObject({ name: 'requests', limit: 100, remaining: 90, usedPercent: 10 });
  });

  test('relay mode passes a subscription login through untouched', async () => {
    usage.length = 0;
    const res = await fetch(`${hub.url}/gw/p/relay/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-ant-oat01-subscription', 'x-conclave-key': keyA, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-test', stream: true, messages: [] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(last().path).toBe('/relay/v1/messages');
    expect(last().headers.authorization).toBe('Bearer sk-ant-oat01-subscription');
    expect(last().headers['x-conclave-key']).toBeUndefined();
    expect(usage[0].provider).toBe('relay');
    expect(hub.engine.repos.usage.limits().some((l) => l.provider === 'claude-max')).toBe(true);

    // open relay works without a gateway key too, via the header picker
    const anon = await fetch(`${hub.url}/gw/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'sk-ant-api-own', 'x-conclave-provider': 'relay', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(anon.status).toBe(200);
    expect(last().headers['x-api-key']).toBe('sk-ant-api-own');
  });

  test('auth failures', async () => {
    const send = (headers: Record<string, string>, path = '/gw/anthropic/v1/messages') =>
      fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"model":"x"}' });
    const none = await send({});
    expect(none.status).toBe(401);
    expect((await none.json()).error.type).toBe('authentication_error');
    expect((await send({ 'x-api-key': 'cgw_not-a-real-key' })).status).toBe(401);
    // provider has a hub key: a foreign credential without a gateway key is refused
    expect((await send({ 'x-api-key': 'sk-ant-someone-else' })).status).toBe(401);
    // relay provider, no credential at all
    expect((await send({ 'x-conclave-key': keyA }, '/gw/p/relay/v1/messages')).status).toBe(401);
    // unknown provider, wrong wire type
    expect((await send({ 'x-api-key': keyA, 'x-conclave-provider': 'nope' })).status).toBe(404);
    expect((await send({ 'x-api-key': keyA, 'x-conclave-provider': 'openai' })).status).toBe(400);
    // revoked keys stop working
    const k = await hub.api('/api/gateway/keys', { method: 'POST', json: { name: 'tmp' } }).then((r) => r.json());
    expect((await send({ 'x-api-key': k.key })).status).toBe(200);
    await hub.api(`/api/gateway/keys/${k.id}`, { method: 'DELETE' });
    expect((await send({ 'x-api-key': k.key })).status).toBe(401);
  });

  test('relay "key" mode requires a gateway key', async () => {
    hub.engine.config.update({ gateway: { aliases: { glm: 'zai/glm-5', mini: { openai: 'gpt-mini' } }, relay: 'key' } } as never);
    const res = await fetch(`${hub.url}/gw/p/relay/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'sk-own', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    hub.engine.config.update({ gateway: { relay: 'open' } } as never);
  });

  test('model aliases rewrite the model and can switch provider', async () => {
    const post = (path: string, model: string) =>
      fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'x-api-key': keyA, authorization: `Bearer ${keyA}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1, messages: [] }) }).then((r) => r.text());
    await post('/gw/anthropic/v1/messages', 'fast');
    expect(JSON.parse(last().body).model).toBe('claude-haiku-test');
    await post('/gw/anthropic/v1/messages', 'smart');
    expect(JSON.parse(last().body).model).toBe('claude-sonnet-test');
    await post('/gw/anthropic/v1/messages', 'deep');
    expect(JSON.parse(last().body).model).toBe('claude-opus-test');
    await post('/gw/anthropic/v1/messages', 'glm');
    expect(last().path).toBe('/zai/v1/messages');
    expect(last().headers['x-api-key']).toBe('zai-key');
    expect(JSON.parse(last().body).model).toBe('glm-5');
    await post('/gw/openai/v1/chat/completions', 'mini');
    expect(JSON.parse(last().body).model).toBe('gpt-mini');
    // unknown names pass through byte for byte
    await post('/gw/anthropic/v1/messages', 'claude-other');
    expect(last().body).toBe(JSON.stringify({ model: 'claude-other', max_tokens: 1, messages: [] }));
  });

  test('per-upstream concurrency limit queues requests', async () => {
    hub.engine.config.update({ gateway: { concurrency: 2 } } as never);
    maxInflight = 0;
    const reqs = Array.from({ length: 6 }, () =>
      fetch(`${hub.url}/gw/p/slow/v1/messages`, { method: 'POST', headers: { 'x-api-key': keyA, 'content-type': 'application/json' }, body: '{"model":"slow"}' }).then((r) => r.text()),
    );
    await Promise.all(reqs);
    expect(maxInflight).toBe(2);
    hub.engine.config.update({ gateway: { concurrency: 8 } } as never);
  });

  test('a 429 starts a cooldown that the next request waits for', async () => {
    fail429 = 1;
    const send = () =>
      fetch(`${hub.url}/gw/p/limited/v1/messages`, { method: 'POST', headers: { 'x-api-key': keyA, 'content-type': 'application/json' }, body: '{"model":"m"}' });
    const first = await send();
    expect(first.status).toBe(429);
    expect(first.headers.get('retry-after')).toBe('1');
    const t429 = last().at;
    const second = await send();
    expect(second.status).toBe(200);
    expect(last().at - t429).toBeGreaterThanOrEqual(900);
    const lim = hub.engine.repos.usage.limits().find((l) => l.provider === 'limited');
    expect(lim?.blocked).toBe(true);
  });

  test('unknown gateway route', async () => {
    const res = await fetch(`${hub.url}/gw/nope/x`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('gateway helpers', () => {
  test('a request that gives up while queued leaves the queue and takes no slot', async () => {
    const l = new UpstreamLimiter(1);
    const release = await l.acquire();
    const gone = new AbortController();
    const waiting = l.acquire(gone.signal);
    const next = l.acquire();
    gone.abort();
    await expect(waiting).rejects.toThrow('aborted');
    let got = false;
    void next.then(() => (got = true));
    await Bun.sleep(5);
    expect(got).toBe(false);
    release();
    release(); // a second call is a no-op, not a second free slot
    (await next)();
    expect(got).toBe(true);
    // the slot is free again: one acquire goes through, a second one waits
    const a = await l.acquire();
    let second = false;
    void l.acquire().then(() => (second = true));
    await Bun.sleep(5);
    expect(second).toBe(false);
    a();
  });

  test('joinUpstream drops a repeated version segment', () => {
    expect(joinUpstream('https://api.openai.com/v1', '/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(joinUpstream('https://api.openai.com/v1/', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(joinUpstream('https://api.z.ai/api/anthropic', '/v1/messages')).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(joinUpstream('https://g.example/v1beta', '/v1beta/models/x')).toBe('https://g.example/v1beta/models/x');
  });

  test('UsageTap handles any chunk boundaries', () => {
    const all = new TextEncoder().encode(ANTHROPIC_SSE.join(''));
    for (const size of [1, 3, 7, 64, all.length]) {
      const tap = new UsageTap('anthropic', 'text/event-stream; charset=utf-8');
      for (let i = 0; i < all.length; i += size) tap.push(all.slice(i, i + size));
      expect(tap.finish()).toMatchObject({ inputTokens: 120, outputTokens: 57, cacheReadTokens: 3000, cacheWriteTokens: 40, model: 'claude-sonnet-test' });
    }
  });

  test('limit headers', () => {
    const now = 1_700_000_000_000;
    const l = limitFromHeaders('codex', 'Codex', new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-after-seconds': '60' }), 200, now)!;
    expect(l.windows[0]).toEqual({ name: '5h', usedPercent: 42, resetsAt: now + 60_000 });
    expect(limitFromHeaders('x', 'x', new Headers({}), 200)).toBeUndefined();
    const blocked = limitFromHeaders('x', 'x', new Headers({ 'retry-after': '30' }), 429, now)!;
    expect(blocked.blocked).toBe(true);
    expect(blocked.windows[0].resetsAt).toBe(now + 30_000);
  });
});
