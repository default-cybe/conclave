/**
 * The retry loop (session/stream.ts) sleeps only on a short retry-after. A
 * 529 that says come back in 12 hours (CLIProxyAPI with the plan's credits
 * spent) ends at once as a limit with resetAt, so the runner's handleLimit
 * fails over or parks instead of the call sleeping for hours.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { streamCompletion } from '../../src/session/stream';
import { ProviderError } from '../../src/providers/types';

const hits = new Map<string, number>();
const overloaded = (retryAfterS: number) => Response.json({ error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529, headers: { 'retry-after': String(retryAfterS) } });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === '/v1/models') return Response.json({ object: 'list', data: [] });
    const body = (await req.json().catch(() => ({}))) as any;
    const n = (hits.get(body.model) ?? 0) + 1;
    hits.set(body.model, n);
    if (body.model === 'long') return overloaded(43_199);
    // past the 60s cap but under the 90s a classified limit needs: only the stream cap stops this one
    if (body.model === 'mid') return overloaded(75);
    if (body.model === 'short' && n === 1) return overloaded(1);
    const events = [{ id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'];
    return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
});

let engine: Engine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-stream-retry-'));
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'fake/short',
      smallModel: 'fake/short',
      providers: { fake: { type: 'openai', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'k', enabled: true, models: ['long', 'mid', 'short'] } },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      limits: { maxRetries: 4, autoResume: true, fallbacks: {}, resumePrompt: 'go on' },
    } as never,
  });
});

afterAll(async () => {
  await engine.shutdown();
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const call = (model: string) => streamCompletion(engine, `fake/${model}`, { system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 100 }, { purpose: 'chore' });

for (const [model, waitS] of [['long', 43_199], ['mid', 75]] as const) {
  test(`a ${waitS}s retry-after is not slept on: the call ends at once as a limit with resetAt`, async () => {
    const started = Date.now();
    const err = (await call(model).catch((e) => e)) as ProviderError;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
    expect(err.resetAt! - started).toBeGreaterThan((waitS - 5) * 1000);
    expect(hits.get(model)).toBe(1);
  }, 10_000);
}

test('a 1s retry-after still retries, then answers', async () => {
  const res = await call('short');
  expect(res.content).toEqual([expect.objectContaining({ type: 'text', text: 'ok' })]);
  expect(hits.get('short')).toBe(2);
}, 10_000);
