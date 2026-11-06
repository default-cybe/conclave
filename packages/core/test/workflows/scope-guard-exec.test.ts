/**
 * The scope guard on a workflow's own host calls: lib.exec and lib.capture do
 * not go through PreToolUse, so a script started from a Security mode session
 * must be checked in workflows/run.ts (docs/design/SECURITY-MODE.md 4.4).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { svcOf, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';
import type { Session } from '../../src/types';

let t: TestEngine;
let dir: string;
const guarded = new Set<string>();

beforeAll(async () => {
  // nobody approves: an "ask" from the guard ends the call
  t = await startTestEngine({ script: [[{ text: 'fallback' }]], approve: 'deny' });
  noHarnesses(t.engine);
  const base = t.engine.agentFor.bind(t.engine);
  t.engine.agentFor = (s: Session) => (guarded.has(s.id) ? { ...base(s), recipes: ['scope-guard'] } : base(s));
  dir = tempDir('conclave-wf-scope-');
  writeFileSync(join(dir, 'scope.yaml'), 'program: acme\nin_scope: ["app.acme.invalid"]\nout_of_scope: ["admin.acme.invalid"]\nlab: ["sec-lab-acme"]\n');
});
afterAll(async () => {
  await t?.close();
  cleanup(dir);
});

const SCRIPT = `export const meta = { name: 'scope', description: 'x', runtime: 'conclave' }
const out = []
for (const f of [() => lib.exec('curl -sS --max-time 2 https://admin.acme.invalid/'), () => lib.exec('curl -sS --max-time 2 https://app.acme.invalid/api'), () => lib.capture('https://app.acme.invalid/'), () => lib.exec('echo lab')]) {
  try { const r = await f(); out.push('ran ' + String(r && r.stdout || '').trim()) } catch (e) { out.push(String(e.message)) }
}
return out`;

test('lib.exec and lib.capture from a guarded session: out of scope denied, in scope without a grant asks, local passes', async () => {
  const svc = svcOf(t.engine);
  // bypass mode: the normal rules would run every command without asking
  const s = await t.engine.createSession({ cwd: dir, permissionMode: 'bypass' });
  guarded.add(s.id);
  const done = await svc.wait((await svc.startRun({ script: SCRIPT, sessionId: s.id })).id);
  const [out, inScope, capture, local] = done.result as string[];
  expect(out).toMatch(/lib\.exec denied: Scope guard: admin\.acme\.invalid\/? is out of scope/);
  expect(inScope).toMatch(/lib\.exec was not approved/);
  expect(capture).toMatch(/lib\.capture denied: Scope guard: app\.acme\.invalid is a live in-scope target/);
  expect(local).toBe('ran lab');
});

test('an unguarded session is left alone', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: dir, permissionMode: 'bypass' });
  const script = `export const meta = { name: 'plain', description: 'x', runtime: 'conclave' }
const r = await lib.exec('echo https://admin.acme.invalid/')
return r.stdout.trim()`;
  const done = await svc.wait((await svc.startRun({ script, sessionId: s.id })).id);
  expect(done.result).toBe('https://admin.acme.invalid/');
});
