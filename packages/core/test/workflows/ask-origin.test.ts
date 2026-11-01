/**
 * A workflow agent that needs an approval asks in the chat that started the
 * run (engine/ask-origin.ts): the request names the run's session as
 * rootSessionId and says which workflow and which agent asks. No paid calls.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, type TestEngine } from '../engine/harness';
import { afterToolResult, noHarnesses, runScript, svcOf } from './helpers';
import type { ApprovalRequest } from '../../src/types';

let t: TestEngine;

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      if (!firstUserText(body).includes('PUSH-IT')) return undefined;
      return afterToolResult(body) ? [{ text: 'pushed or not' }] : [{ tool: 'Bash', input: { command: 'git push origin main' } }];
    },
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const SCRIPT = `export const meta = { name: 'deep-research', description: 'asks once' }
return await agent('PUSH-IT now', { label: 'search r1 3' })`;

test("a workflow agent's approval names the run's session, the workflow and the agent's label", async () => {
  const seen: ApprovalRequest[] = [];
  const off = t.engine.bus.on((e) => {
    if (e.type === 'approval.requested') seen.push(structuredClone(e.approval));
  });
  try {
    const s = await t.engine.createSession({ title: 'Research chat', cwd: t.cwd });
    const run = await runScript(t, SCRIPT, { sessionId: s.id });
    expect(run.status).toBe('done');
    const agentSession = svcOf(t.engine).store.calls(run.id)[0]?.childSessionId;
    expect(agentSession).toBeDefined();
    expect(seen.length).toBe(1);
    const a = seen[0];
    expect(a.sessionId).toBe(agentSession!);
    expect(a.rootSessionId).toBe(s.id);
    expect(a.from).toMatchObject({ sessionId: agentSession, label: 'search r1 3', workflow: { runId: run.id, name: 'deep-research' }, chain: [agentSession] });
    expect(a.from!.agent).toBe(t.engine.getSession(agentSession!)!.agent);
  } finally {
    off();
  }
}, 60_000);

test('a run started without a session asks in the session the hub made for it', async () => {
  const seen: ApprovalRequest[] = [];
  const off = t.engine.bus.on((e) => {
    if (e.type === 'approval.requested') seen.push(structuredClone(e.approval));
  });
  try {
    const svc = svcOf(t.engine);
    const started = await svc.startRun({ script: SCRIPT, cwd: t.cwd });
    const run = await svc.wait(started.id);
    expect(run.hostSession).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0].rootSessionId).toBe(run.sessionId!);
    expect(seen[0].from?.workflow?.name).toBe('deep-research');
  } finally {
    off();
  }
}, 60_000);
