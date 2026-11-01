/**
 * Hidden models on a real engine and server (core config/hidden.ts): the
 * owner saves models.hidden through PATCH /api/config, as Settings > Models
 * does, and GET /api/models (the list web and Android pickers get) leaves
 * the hidden refs out.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import type { ModelGroup } from '@conclave/core/client/index.ts';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-hidden-0123456789abcdef';

let root: string;
let engine: Engine;
let running: RunningServer;

const call = (method: string, path: string, json?: unknown) =>
  fetch(running.url + path, { method, headers: { authorization: `Bearer ${OWNER}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });

const refs = async () => ((await (await call('GET', '/api/models')).json()) as ModelGroup[]).flatMap((g) => g.models.map((m) => m.ref));

beforeAll(async () => {
  process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';
  root = mkdtempSync(join(tmpdir(), 'conclave-hidden-models-'));
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  engine = await createEngine({
    home: join(root, 'home'),
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'mock/claude-sonnet-5-5',
      smallModel: 'mock/claude-sonnet-5-5',
      providers: {
        mock: { type: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['claude-sonnet-5-5'] },
        proxy: { type: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['glm-5.3', 'glm-5.2', 'claude-opus-5-5'] },
      },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
    } as never,
  });
  engine.config.update({ server: { ...engine.config.get().server, token: OWNER } });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
}, 60_000);

afterAll(async () => {
  await running?.stop();
  await engine?.shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('GET /api/models', () => {
  test('leaves out the refs and globs saved in models.hidden', async () => {
    expect(await refs()).toEqual(expect.arrayContaining(['proxy/glm-5.3', 'proxy/glm-5.2', 'proxy/claude-opus-5-5']));
    expect((await call('PATCH', '/api/config', { models: { hidden: ['proxy/glm-*'] } })).status).toBe(200);
    const after = await refs();
    expect(after).not.toContain('proxy/glm-5.3');
    expect(after).not.toContain('proxy/glm-5.2');
    expect(after).toContain('proxy/claude-opus-5-5');
    expect(after).toContain('mock/claude-sonnet-5-5');
    // an empty list brings them back
    expect((await call('PATCH', '/api/config', { models: { hidden: [] } })).status).toBe(200);
    expect(await refs()).toContain('proxy/glm-5.3');
  }, 30_000);
});
