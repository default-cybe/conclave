/**
 * Review pass of section 1: a learning import whose model does not answer.
 * The chats are copied, the batch says which model failed and that Resume
 * tries again, and Resume then learns them. Scripted model, no paid calls.
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
let modelDown = true;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  h = buildOwnerHome();
  t = await startTestEngine({
    script: [[{ text: 'ok' }]],
    chore: (body) => {
      const s = JSON.stringify(body.system ?? '');
      if (s.includes('You turn one past session into memory')) return modelDown ? 503 : [{ text: JSON.stringify({ episode: 'Worked on it.', items: [] }) }];
      if (s.includes('You tidy a memory store')) return modelDown ? 503 : [{ text: '{"operations": []}' }];
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

test('a model that does not answer stops only the learning, and the batch says what to do', async () => {
  await svc.scan({ device: 'local', refresh: true });
  const started = await svc.startBatch({ device: 'local', mode: 'chats-learn', query: {} });
  await svc.runBatch(started.id);
  const b = svc.batch(started.id);
  expect(b.status).toBe('failed');
  expect(b.imported).toBeGreaterThan(0);
  expect(b.error).toStartWith('Learning stopped: ');
  expect(b.error).toContain(t.engine.config.get().smallModel);
  expect(b.error).toContain('The chats copied so far stay imported.');
  expect(b.error).toContain('Resume tries the rest again');

  modelDown = false;
  await svc.resume(started.id);
  await svc.runBatch(started.id);
  const after = svc.batch(started.id);
  expect(after.status).toBe('done');
  expect(after.error).toBeUndefined();
  expect(after.learnedSessions).toBe(after.imported);
});

test("a coding tool's chat resumes with the coding agent, not the personal assistant", async () => {
  const sessions = t.engine.repos.sessions.list({ limit: 100 } as never) as Array<{ tags?: string[]; agent: string; kind?: string }>;
  const imported = sessions.filter((s) => s.tags?.includes('imported'));
  expect(imported.length).toBeGreaterThan(0);
  for (const s of imported) expect(s.agent).toBe(s.kind === 'chat' ? t.engine.config.get().defaultAgent : 'coder');
});
