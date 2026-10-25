/**
 * Continue a capped Claude Code task in Conclave, end to end: import the chat,
 * run a real turn on a non-Claude Code model (the harness is off), hit that
 * model's usage limit, fail over to the next model, and find the turn written
 * back into the Claude Code .jsonl (import/writeback.ts) so `claude --resume`
 * shows it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, until, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { parseRows } from '../../src/import/writeback';
import type { TextBlock } from '../../src/types';
import { buildOwnerHome, OWNER, type OwnerHome } from '../importers/owner-home';

let t: TestEngine;
let svc: ImportService;
let h: OwnerHome;
/** Models the scripted provider was asked for, in order (tool requests only). */
const asked: string[] = [];

beforeAll(async () => {
  h = buildOwnerHome();
  t = await startTestEngine({
    script: [[{ text: 'Picked up on the second model.' }]],
    models: ['model-a', 'model-b'],
    // model-a is at its usage limit; model-b answers
    route: (body) => {
      asked.push(String(body.model));
      return body.model === 'model-a' ? { status: 429, error: 'usage limit reached', type: 'rate_limit_error' } : undefined;
    },
    overrides: { defaultModel: 'mock/model-a', limits: { maxRetries: 0, autoResume: false, fallbacks: { 'mock/model-a': ['mock/model-b'] } } } as never,
  });
  process.env.CLAUDE_CONFIG_DIR = join(h.home, '.claude');
  svc = importOf(t.engine)!;
});

afterAll(async () => {
  await t.close();
  rmSync(h.home, { recursive: true, force: true });
});

test('import, continue on another model, hit its limit: it fails over and the turn lands in the .jsonl', async () => {
  const page = await svc.scan({ device: 'local', refresh: true, sources: ['claude-code'] } as never);
  const a = page.items.find((x) => x.id === OWNER.claudeA && x.kind === 'main')!;
  const b = await svc.startBatch({ device: 'local', keys: [a.key], mode: 'chats' });
  await svc.runBatch(b.id);
  const sid = (await svc.scan({ device: 'local' })).items.find((x) => x.key === a.key)!.imported!.sessionId!;
  // Claude Code's own model is not served here, so the chat goes on with the owner's default
  expect(t.engine.repos.sessions.get(sid)!.model).toBe('mock/model-a');

  // the fixture's project folder is not on this machine; a real continuation has it
  t.engine.updateSession(sid, { cwd: t.cwd }, { quiet: true });
  const file = h.path('claudeA');
  const before = readFileSync(file, 'utf8');
  await t.run(sid, 'Carry on where the cap stopped us.');

  // the limit hit model-a, the turn ran on model-b
  expect(asked).toEqual(['model-a', 'model-b']);
  const msgs = t.engine.getMessages(sid);
  expect(msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text)).toContainEqual(expect.stringContaining('mock/model-a hit its limit. Falling back to mock/model-b'));
  expect(msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)).toMatchObject({ model: 'mock/model-b', content: [{ type: 'text', text: 'Picked up on the second model.' }] });

  // written back: the prompt and the reply, in Claude Code's format
  expect(await until(() => readFileSync(file, 'utf8').length > before.length)).toBe(true);
  await until(() => !!t.engine.repos.messages.list(sid).at(-1)?.meta?.external);
  const after = readFileSync(file, 'utf8');
  expect(after.startsWith(before)).toBe(true);
  const added = parseRows(after.slice(before.length), false);
  expect(added.map((r) => r.type)).toEqual(['user', 'assistant']);
  expect(added[0].message.content).toEqual([{ type: 'text', text: 'Carry on where the cap stopped us.' }]);
  expect(added[1].message.content).toEqual([{ type: 'text', text: 'Picked up on the second model.' }]);
  // and the next import sees it as present, not as divergence
  expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
}, 30_000);
