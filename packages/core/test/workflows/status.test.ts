/**
 * WorkflowStatus (tools/workflow-status.ts, service.status): a run as it
 * stands while it goes and after it ends, only for the run's own account,
 * and the live run events a session's card follows. No paid calls.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, until, type TestEngine } from '../engine/harness';
import { noHarnesses, svcOf } from './helpers';
import { WorkflowStatusTool, duration, statusText } from '../../src/tools/workflow-status';
import type { ToolContext } from '../../src/tools/types';
import type { EngineEventEnvelope } from '../../src/types';
import { OWNER_ID } from '../../src/people/context';

let t: TestEngine;

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      if (first.includes('slow-check')) return { blocks: [{ text: 'checked' }], delayMs: 1500 };
      if (first.includes('broken-check')) return 500;
      const m = /say (\w+)/.exec(first);
      if (m) return [{ text: m[1] }];
      return undefined;
    },
    overrides: { limits: { maxRetries: 0, autoResume: true, fallbacks: {} } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const SCRIPT = `export const meta = { name: 'status-run', description: 'status', phases: [{ title: 'Find' }, { title: 'Check' }, { title: 'Report' }] }
phase('Find')
await agent('say found', { label: 'finder' })
log('found one')
phase('Check')
const r = await parallel([() => agent('slow-check', { label: 'slow checker' }), () => agent('broken-check', { label: 'broken checker' })])
phase('Report')
return r`;

/** The tool as a session would call it. */
async function callTool(sessionId: string, input: Record<string, unknown> = {}) {
  const session = t.engine.requireSession(sessionId);
  const ctx = { sessionId, session, host: { workflows: svcOf(t.engine) }, depth: 0 } as unknown as ToolContext;
  return WorkflowStatusTool.run(input, ctx);
}

test('a live run: phases with their agents, counts, tokens, errors and the last log lines; then its end', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const events: EngineEventEnvelope[] = [];
  const off = t.engine.bus.on((e) => {
    if (e.type.startsWith('workflow.')) events.push(e);
  });
  try {
    const started = await svc.startRun({ script: SCRIPT, sessionId: s.id }, { toolUseId: 'toolu_status_1' });
    expect(started.toolUseId).toBe('toolu_status_1');
    // the broken checker failed while the slow one still runs
    expect(await until(() => [...(svc.live.get(started.id)?.calls.values() ?? [])].some((c) => c.label === 'broken checker' && c.state === 'failed'), 10_000)).toBe(true);

    // no runId: the newest run this session started
    const v = svc.status({ sessionId: s.id, accountId: OWNER_ID })!;
    expect(v.runId).toBe(started.id);
    expect(v.status).toBe('running');
    expect(v.live).toBe(true);
    expect(v.phaseIndex).toBe(1);
    expect(v.phases.map((p) => [p.title, p.state])).toEqual([
      ['Find', 'done'],
      ['Check', 'current'],
      ['Report', 'pending'],
    ]);
    expect(v.phases[0].agents).toEqual([expect.objectContaining({ seq: 1, label: 'finder', state: 'done' })]);
    expect(typeof v.phases[0].agents[0].elapsedMs).toBe('number');
    const check = v.phases[1].agents;
    expect(check.map((a) => [a.label, a.state])).toEqual([
      ['slow checker', 'running'],
      ['broken checker', 'failed'],
    ]);
    expect(check[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(check[1].error).toBeTruthy();
    expect(v.phases[2].agents).toEqual([]);
    expect(v.counts).toMatchObject({ agents: 3, running: 1, done: 1, failed: 1 });
    expect(v.tokens.output).toBeGreaterThan(0);
    expect(v.errorCount).toBe(1);
    expect(v.errors[0]).toMatchObject({ seq: 3, label: 'broken checker' });
    expect(v.logs.map((l) => l.text)).toContain('found one');
    expect(v.elapsedMs).toBeGreaterThanOrEqual(0);

    // the tool's text for the model
    const out = await callTool(s.id);
    expect(out.isError).toBeFalsy();
    expect(out.meta).toEqual({ workflowRunId: started.id });
    const text = out.content as string;
    expect(text).toStartWith(`Workflow status-run, run ${started.id}: running for `);
    expect(text).toContain('Phase 2 of 3: Check.');
    expect(text).toContain('Agents: 3 (1 running, 1 done, 1 failed).');
    expect(text).toContain('[done] Find\n  - #1 finder: done, ');
    expect(text).toContain('[current] Check\n  - #2 slow checker: running, ');
    expect(text).toMatch(/- #3 broken checker: failed, \d+s: /);
    expect(text).toContain('[pending] Report (no agents yet)');
    expect(text).toContain('Errors (1):\n- #3 broken checker: ');
    expect(text).toMatch(/\[\+\d+s\] found one/);

    const done = await svc.wait(started.id);
    expect(done.status).toBe('done');
    const after = svc.status({ runId: started.id, sessionId: s.id, accountId: OWNER_ID })!;
    expect(after.live).toBe(false);
    expect(after.status).toBe('done');
    expect(after.phases.map((p) => p.state)).toEqual(['done', 'done', 'current']);
    expect(after.phases[1].agents.map((a) => a.state)).toEqual(['done', 'failed']);
    expect(after.finishedAt).toBeGreaterThan(0);
    expect(statusText(after)).toContain(`run ${started.id}: done after `);
    expect(statusText(after)).toContain('The run is over');
  } finally {
    off();
  }

  // the live card's events: the run with the tool call that started it, each phase, each agent's start and end with label and state, the end
  const runEvents = events.filter((e) => e.type === 'workflow.run') as Array<Extract<EngineEventEnvelope, { type: 'workflow.run' }>>;
  expect(runEvents[0].run).toMatchObject({ toolUseId: 'toolu_status_1', sessionId: s.id, name: 'status-run' });
  expect(runEvents.at(-1)!.run).toMatchObject({ status: 'done', counts: { agents: 3, done: 2, failed: 1 } });
  expect(runEvents.at(-1)!.run.finishedAt).toBeGreaterThan(0);
  const phases = events.filter((e) => e.type === 'workflow.phase') as Array<Extract<EngineEventEnvelope, { type: 'workflow.phase' }>>;
  expect(phases.map((e) => [e.index, e.title])).toEqual([
    [0, 'Find'],
    [1, 'Check'],
    [2, 'Report'],
  ]);
  const agents = events.filter((e) => e.type === 'workflow.agent') as Array<Extract<EngineEventEnvelope, { type: 'workflow.agent' }>>;
  // a call's event repeats while it runs (its child session, its tokens): the states in order, each once
  const states = (label: string) => agents.filter((e) => e.call.label === label).map((e) => e.call.state).filter((st, i, all) => st !== all[i - 1]);
  expect(states('finder')).toEqual(['queued', 'running', 'done']);
  expect(states('slow checker')).toEqual(['queued', 'running', 'done']);
  expect(states('broken checker').at(-1)).toBe('failed');
  const finished = agents.find((e) => e.call.label === 'finder' && e.call.state === 'done')!.call;
  expect(finished).toMatchObject({ seq: 1, kind: 'agent', phase: 'Find' });
  expect(finished.finishedAt! - finished.startedAt!).toBeGreaterThanOrEqual(0);
  // every event names the run
  expect(agents.every((e) => e.runId === runEvents[0].run.id)).toBe(true);
});

test('only runs of the same account: a member sees their own, not the owner’s', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.startRun({ script: `export const meta = { name: 'owner-run', description: 'x' }\nreturn await agent('say mine')`, sessionId: s.id });
  await svc.wait(run.id);

  // another session of the owner reads it by id
  const other = await t.engine.createSession({ cwd: t.cwd });
  expect(((await callTool(other.id, { runId: run.id })).content as string)).toContain(`run ${run.id}: done`);
  // with no runId, a session that started nothing says so
  const none = await callTool(other.id);
  expect(none.isError).toBe(true);
  expect(none.content).toContain('This session has not started a workflow run');

  const alice = t.engine.people.create({ name: 'alice-status' });
  const mine = await t.engine.createSession({ cwd: t.cwd } as never, alice.id);
  // the owner's run reads as not found for a member, the same as an unknown id
  const hidden = await callTool(mine.id, { runId: run.id });
  expect(hidden.isError).toBe(true);
  expect(hidden.content).toBe(`No workflow run ${run.id} found.`);
  expect(svc.status({ runId: run.id, sessionId: mine.id, accountId: alice.id })).toBeUndefined();
  expect((await callTool(mine.id, { runId: 'wfr_nope' })).content).toBe('No workflow run wfr_nope found.');

  // a run of alice's own: she sees it, the owner does not
  const row = svc.store.getRun(run.id)!;
  svc.store.insertRun({ ...row, id: 'wfr_alice_status', sessionId: mine.id, name: 'alice-run', toolUseId: undefined });
  expect(((await callTool(mine.id)).content as string)).toStartWith('Workflow alice-run, run wfr_alice_status: done');
  expect((await callTool(s.id, { runId: 'wfr_alice_status' })).isError).toBe(true);

  // her run's live events are stamped with her account, so only her sockets get them (people/events.ts)
  const dto = svc.run('wfr_alice_status');
  expect(t.engine.bus.emit({ type: 'workflow.run', run: dto.run }).account).toBe(alice.id);
  expect(t.engine.bus.emit({ type: 'workflow.phase', runId: 'wfr_alice_status', index: 0, title: 'x' }).account).toBe(alice.id);
  expect(t.engine.bus.emit({ type: 'workflow.agent', runId: 'wfr_alice_status', call: svc.run(run.id).calls[0] }).account).toBe(alice.id);
  expect(t.engine.bus.emit({ type: 'workflow.progress', runId: 'wfr_alice_status', callSeq: 1, lastTool: 'Read' }).account).toBe(alice.id);
  expect(t.engine.bus.emit({ type: 'workflow.log', runId: run.id, ts: Date.now(), text: 'x' }).account).toBe(OWNER_ID);
});

test('durations read as seconds, minutes and hours', () => {
  expect(duration(0)).toBe('0s');
  expect(duration(42_400)).toBe('42s');
  expect(duration(185_000)).toBe('3m 05s');
  expect(duration(3_720_000)).toBe('1h 02m');
});
