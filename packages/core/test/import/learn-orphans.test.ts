/**
 * A learning batch that fails stops only after every call of its chunk has
 * ended. A call left running after the batch failed would learn its chat
 * later, and Resume would learn it again.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { buildOwnerHome, type OwnerHome } from '../importers/owner-home';

let t: TestEngine;
let svc: ImportService;
let h: OwnerHome;
let calls = 0;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  h = buildOwnerHome();
  t = await startTestEngine({
    script: [[{ text: 'ok' }]],
    chore: (body) => {
      const s = JSON.stringify(body.system ?? '');
      // the first chat fails at once; the others answer a little later
      if (s.includes('You turn one past session into memory')) return ++calls === 1 ? 503 : { blocks: [{ text: JSON.stringify({ episode: 'Worked on it.', items: [] }) }], delayMs: 200 };
      if (s.includes('You tidy a memory store')) return [{ text: '{"operations": []}' }];
      return undefined;
    },
    overrides: { memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 5 }, limits: { maxRetries: 0 } } as never,
  });
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = join(h.home, '.claude');
  process.env.CODEX_HOME = join(h.home, '.codex');
  process.env.GEMINI_DIR = join(h.home, '.gemini');
  svc = importOf(t.engine)!;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t.close();
  rmSync(h.home, { recursive: true, force: true });
});

test('a failed learning batch learns nothing more after it says it stopped', async () => {
  await svc.scan({ device: 'local', refresh: true });
  const started = await svc.startBatch({ device: 'local', mode: 'chats-learn', query: {} });
  await svc.runBatch(started.id);
  const b = svc.batch(started.id);
  expect(b.status).toBe('failed');
  const learned = b.learnedSessions;
  await Bun.sleep(500);
  expect(svc.batch(started.id).learnedSessions).toBe(learned);
});
