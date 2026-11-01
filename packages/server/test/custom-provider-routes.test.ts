/**
 * A custom provider from Settings > Providers, on a real engine and server
 * against a fake OpenAI-compatible endpoint: the probes list its models and
 * test one without saving anything, PATCH /api/config refuses a bad new
 * entry and takes a good one (its models in GET /api/models), and null
 * removes it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import type { ModelGroup } from '@conclave/core/client/index.ts';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-custom-0123456789abcdef';
const KEY = 'sk-custom-secret-key-123';

let root: string;
let engine: Engine;
let running: RunningServer;
let fake: ReturnType<typeof Bun.serve>;
let base: string;

const call = (method: string, path: string, json?: unknown) =>
  fetch(running.url + path, {
    method,
    headers: {
      authorization: `Bearer ${OWNER}`,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

beforeAll(async () => {
  process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';
  fake = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return Response.json({ error: { message: 'bad key' } }, { status: 401 });
      if (url.pathname === '/v1/models')
        return Response.json({
          object: 'list',
          data: [{ id: 'glm-5.3-flash' }, { id: 'other-model' }],
        });
      if (url.pathname === '/v1/chat/completions') {
        const body = (await req.json()) as { model: string };
        if (body.model !== 'glm-5.3-flash') return Response.json({ error: { message: `model ${body.model} not found` } }, { status: 404 });
        const sse = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
        return new Response(sse, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${fake.port}/v1`;
  root = mkdtempSync(join(tmpdir(), 'conclave-custom-provider-'));
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  engine = await createEngine({
    home: join(root, 'home'),
    noBackground: true,
    version: 'test',
    overrides: {
      memory: {
        enabled: false,
        autoExtract: false,
        autoInject: false,
        injectLimit: 0,
      },
    } as never,
  });
  engine.config.update({
    server: { ...engine.config.get().server, token: OWNER },
  });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
}, 60_000);

afterAll(async () => {
  await running?.stop();
  await engine?.shutdown();
  fake?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('probes', () => {
  test('lists the endpoint models and tests one, saving nothing', async () => {
    const list = await (
      await call('POST', '/api/providers/probe', {
        type: 'openai',
        baseUrl: base,
        apiKey: KEY,
      })
    ).json();
    expect(list).toEqual({
      ok: true,
      models: ['glm-5.3-flash', 'other-model'],
    });
    expect(
      (
        await (
          await call('POST', '/api/providers/probe-model', {
            type: 'openai',
            baseUrl: base,
            apiKey: KEY,
            model: 'glm-5.3-flash',
          })
        ).json()
      ).ok,
    ).toBe(true);
    const bad = await (
      await call('POST', '/api/providers/probe-model', {
        type: 'openai',
        baseUrl: base,
        apiKey: KEY,
        model: 'nope',
      })
    ).json();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('not found');
    expect(Object.keys(engine.config.get().providers).some((id) => id.startsWith('custom'))).toBe(false);
  });

  test('says when the key is rejected, and never echoes it', async () => {
    const r = await (
      await call('POST', '/api/providers/probe', {
        type: 'openai',
        baseUrl: base,
        apiKey: 'sk-wrong',
      })
    ).json();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('rejected the key (401)');
    expect(JSON.stringify(r)).not.toContain('sk-wrong');
  });

  test('refuses a non-http URL and an unknown API style', async () => {
    expect(
      (
        await call('POST', '/api/providers/probe', {
          type: 'openai',
          baseUrl: 'file:///etc/passwd',
          apiKey: KEY,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/providers/probe', {
          type: 'acp',
          baseUrl: base,
          apiKey: KEY,
        })
      ).status,
    ).toBe(400);
  });
});

describe('PATCH /api/config providers', () => {
  test('refuses a new entry with a bad baseUrl, type or id', async () => {
    expect(
      (
        await call('PATCH', '/api/config', {
          providers: {
            exp: { type: 'openai', baseUrl: 'ftp://x/v1', models: ['m'] },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', '/api/config', {
          providers: { exp: { type: 'nope', baseUrl: base, models: ['m'] } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', '/api/config', {
          providers: { 'Bad Id': { type: 'openai', baseUrl: base } },
        })
      ).status,
    ).toBe(400);
    expect(engine.config.get().providers.exp).toBeUndefined();
  });

  test('takes a good entry, lists its models as <id>/<model>, and null removes it', async () => {
    expect(
      (
        await call('PATCH', '/api/config', {
          providers: {
            exp: {
              type: 'openai',
              name: 'Experiential Labs',
              baseUrl: base,
              models: ['glm-5.3-flash'],
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PUT', '/api/secrets', {
          kind: 'providers',
          key: 'exp',
          value: KEY,
        })
      ).status,
    ).toBe(200);
    const groups = (await (await call('GET', '/api/models')).json()) as ModelGroup[];
    const g = groups.find((x) => x.provider === 'exp');
    expect(g?.configured).toBe(true);
    expect(g?.models.map((m) => m.ref)).toEqual(['exp/glm-5.3-flash']);
    expect((await (await call('POST', '/api/providers/exp/test')).json()).ok).toBe(true);

    expect((await call('PATCH', '/api/config', { providers: { exp: null } })).status).toBe(200);
    expect(engine.config.get().providers.exp).toBeUndefined();
    expect(engine.config.getUser().providers?.exp).toBeUndefined();
  });
});
