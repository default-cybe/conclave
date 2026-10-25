/**
 * Pause a workflow run: its running agent stops after its current tool call,
 * no new agent starts, and Resume goes on from where the agent stopped.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, until, type TestEngine } from '../engine/harness';
import { afterToolResult, lastUserText, noHarnesses, reopen, svcOf } from './helpers';

let t: TestEngine;

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      if (first.includes('slow one')) return afterToolResult(body) ? [{ text: 'one' }] : [{ tool: 'Bash', input: { command: 'sleep 0.6; echo SLEPT', description: 'wait' } }];
      const m = /say (\w+)/.exec(first);
      return m ? [{ text: m[1] }] : undefined;
    },
    approve: 'allow',
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const SCRIPT = `export const meta = { name: 'two', description: 'two calls' }
const a = await agent('slow one')
const b = await agent('say two')
return [a, b]`;

test('pause stops the running agent before its next model call and starts no new one; resume finishes the run', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.startRun({ script: SCRIPT, sessionId: s.id });
  const slow = () => t.requests.filter((x) => x.includes('slow one'));
  expect(await until(() => slow().length === 1, 10_000)).toBe(true);
  svc.pause(run.id);
  const child = () => svc.live.get(run.id)?.calls.get(1)?.childSessionId;
  expect(await until(() => !!child() && t.engine.getSession(child()!)?.status === 'paused', 10_000)).toBe(true);
  await Bun.sleep(400);
  expect(slow().length).toBe(1);
  expect(t.requests.some((x) => x.includes('say two'))).toBe(false);
  expect(svc.store.getRun(run.id)?.status).toBe('paused');
  // paused work does not hold up an update
  expect(t.engine.busyWork().some((w) => w.id === run.id || w.id === child())).toBe(false);

  await svc.resume(run.id);
  expect(await until(() => svc.store.getRun(run.id)?.status === 'done', 10_000)).toBe(true);
  expect(svc.store.getRun(run.id)?.result).toEqual(['one', 'two']);
  // the agent's next call came after its tool result, with no resume prompt
  expect(slow().length).toBe(2);
  const next = JSON.parse(slow()[1]);
  expect(afterToolResult(next)).toBe(true);
  expect(lastUserText(next)).toContain('slow one');
});

test('a run paused when the hub stops stays paused at boot and resumes from its journal', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.startRun({ script: SCRIPT, sessionId: s.id });
  const child = () => svc.live.get(run.id)?.calls.get(1)?.childSessionId;
  expect(await until(() => !!child(), 10_000)).toBe(true);
  svc.pause(run.id);
  const old = child()!;
  expect(await until(() => t.engine.getSession(old)?.status === 'paused', 10_000)).toBe(true);
  await t.engine.shutdown();
  t.engine = await reopen(t);
  noHarnesses(t.engine);
  // the harness answers approvals on its first engine only
  const e2 = t.engine;
  e2.bus.on((e: { type: string; approval?: { id: string } }) => {
    if (e.type === 'approval.requested' && e.approval) queueMicrotask(() => e2.resolveApproval(e.approval!.id, { decision: 'allow', scope: 'once' }));
  });
  const svc2 = svcOf(t.engine);
  await Bun.sleep(300);
  expect(svc2.store.getRun(run.id)?.status).toBe('paused');
  expect(svc2.live.has(run.id)).toBe(false);
  await svc2.resume(run.id);
  expect(await until(() => svc2.store.getRun(run.id)?.status === 'done', 10_000)).toBe(true);
  expect(svc2.store.getRun(run.id)?.result).toEqual(['one', 'two']);
  // the agent cut by the stop is let go, not left paused
  expect(t.engine.getSession(old)?.status).not.toBe('paused');
}, 30_000);
