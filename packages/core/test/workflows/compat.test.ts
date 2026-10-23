/**
 * Claude Code compatibility: Anthropic's plugin workflows load without edits
 * and run against scripted agents, and the Workflow tool behaves like Claude
 * Code's for a main agent (approval, foreground result, background result,
 * Ultra). uplift-migrate.js is vendored (Apache 2.0); scan.js is not
 * redistributable, so its test runs when CONCLAVE_SCAN_JS points at a copy.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, toolResults, until, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, hasTool, runScript, svcOf, systemText, noHarnesses } from './helpers';
import { loadMeta } from '../../src/workflows/registry';

let t: TestEngine;
const answers = new Map<string, (body: RequestBody) => Step | number | undefined>();
/** Replies for main sessions, keyed by the tag in the owner's first message ("OWNER-tag: ..."). */
const mains = new Map<string, (body: RequestBody) => Step | undefined>();

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      const tag = /OWNER-(\w+):/.exec(first)?.[1];
      if (tag && mains.has(tag)) return mains.get(tag)!(body);
      for (const [word, fn] of answers) if (first.includes(word)) return fn(body);
      const m = /say (\w+)/.exec(first);
      if (m) return [{ text: m[1] }];
      return undefined;
    },
    approve: 'allow',
    overrides: { limits: { maxRetries: 0 } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const UPLIFT = join(import.meta.dir, 'fixtures', 'anthropic-code-modernization', 'uplift-migrate.js');

test("Anthropic's uplift-migrate.js loads unchanged and runs its batches against scripted migrators", async () => {
  const script = readFileSync(UPLIFT, 'utf8');
  const { meta } = await loadMeta(script);
  expect(meta.name).toBe('modernize-uplift-migrate');
  answers.set('Migrate ONE unit', (body) => {
    if (afterToolResult(body)) return [{ text: 'done' }];
    const unit = /Your unit: `([^`]+)`/.exec(firstUserText(body))?.[1] ?? '?';
    return [{ tool: 'StructuredOutput', input: { unit, buildRan: true, built: true, buildCommand: 'dotnet build', filesChanged: [`${unit}/a.cs`], playbookGaps: [], sharedFileNeeds: [], injectionSuspects: [] } }];
  });
  const run = await runScript(t, script, {
    args: { system: 'billing', source: '.NET Framework 4.8', target: '.NET 8', units: [{ name: 'Core', path: 'src/Core' }, { name: 'Api', path: 'src/Api', deps: ['Core'] }] },
  });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe('done');
  const r = run.result as { totals: { built: number; failed: number }; abortedEarly: boolean };
  expect(r.totals.built).toBe(2);
  expect(r.totals.failed).toBe(0);
  expect(r.abortedEarly).toBe(false);
  const calls = svcOf(t.engine).store.calls(run.id);
  expect(calls.map((c) => c.label)).toEqual(['migrate:Core', 'migrate:Api']);
  expect(calls.every((c) => c.phase === 'Migrate')).toBe(true);
  // the plugin agent is not installed in tests: the step ran the default profile and said so
  expect(svcOf(t.engine).store.logs(run.id).some((l) => l.text.includes('code-modernization:uplift-migrator is not installed'))).toBe(true);
});

const SCAN = process.env.CONCLAVE_SCAN_JS;
test.skipIf(!SCAN || !existsSync(SCAN))("Anthropic's claude-security scan.js loads unchanged and runs its first phase", async () => {
  const script = readFileSync(SCAN!, 'utf8');
  expect((await loadMeta(script)).meta.name).toBe('scan');
  const svc = svcOf(t.engine);
  const sess = await t.engine.createSession({ cwd: t.cwd });
  const started = await svc.startRun({ script, sessionId: sess.id, args: { scanRoot: t.cwd, runDir: join(t.cwd, '.scan-run'), mode: 'scan', effort: 'low' } });
  // the first phase dispatches its first agent; then the run is stopped (scan.js backs off for minutes on failures)
  expect(await until(() => [...(svc.live.get(started.id)?.calls.values() ?? [])].some((c) => c.kind === 'agent' && c.state !== 'queued' && c.state !== 'running'), 30_000)).toBe(true);
  svc.stop(started.id);
  const run = await svc.wait(started.id);
  expect(run.status).toBe('stopped');
  const detail = svc.run(run.id);
  expect(detail.run.phaseIndex).toBeGreaterThanOrEqual(0);
  expect(detail.calls.some((c) => c.kind === 'agent' && c.label?.startsWith('research'))).toBe(true);
  expect(detail.logs.some((l) => l.text.includes('inventory'))).toBe(true);
}, 60_000);

test('the Workflow tool asks for approval, waits, and returns the result to the main agent', async () => {
  let step = 0;
  mains.set('tool', (body) => {
    if (!afterToolResult(body)) {
      step = 0;
      return [{ tool: 'Workflow', input: { script: `export const meta = { name: 'tool-run', description: 'from the tool', phases: [{ title: 'Ask' }] }\nphase('Ask')\nreturn await agent('say toolresult')`, estimate: { agents: 1, tokens: 1000 } } }];
    }
    step++;
    return [{ text: 'the workflow said toolresult' }];
  });
  const s = await t.engine.createSession({ cwd: t.cwd });
  const before = t.approvals.length;
  await t.run(s.id, 'OWNER-tool: run it');
  const res = toolResults(t.engine, s.id).find((r) => r.name === 'Workflow')!;
  expect(res.isError).toBe(false);
  expect(res.content).toContain('Workflow tool-run done');
  expect(res.content).toContain('toolresult');
  expect(t.approvals.length).toBe(before + 1);
  expect(t.approvals[t.approvals.length - 1]).toContain('Run workflow tool-run');
  expect(step).toBe(1);
});

test('with run_in_background the result arrives later as a workflow_result note', async () => {
  let gotResult = false;
  let offered = false;
  mains.set('bg', (body) => {
    const text = JSON.stringify(body.messages ?? []);
    offered ||= hasTool(body, 'WorkflowStatus');
    if (!text.includes('"name":"Workflow"')) return [{ tool: 'Workflow', input: { script: `export const meta = { name: 'bg-run', description: 'background' }\nreturn await agent('say background')`, run_in_background: true } }];
    // the model checks on the run once it started (the result may already be on its way)
    if (!text.includes('"name":"WorkflowStatus"')) return [{ tool: 'WorkflowStatus', input: {} }];
    if (text.includes('<workflow_result')) {
      gotResult = true;
      return [{ text: 'noted the background result' }];
    }
    return [{ text: 'started it' }];
  });
  const s = await t.engine.createSession({ cwd: t.cwd });
  t.engine.runnerFor(s.id).noteDelayMs = 10;
  await t.run(s.id, 'OWNER-bg: in the background please');
  const started = toolResults(t.engine, s.id).find((r) => r.name === 'Workflow')!;
  expect(started.content).toContain('started in the background');
  // the start says how to check on it
  expect(started.content).toContain('call WorkflowStatus with runId wfr_');
  expect(offered).toBe(true);
  const status = toolResults(t.engine, s.id).find((r) => r.name === 'WorkflowStatus')!;
  expect(status.isError).toBe(false);
  expect(status.content).toStartWith('Workflow bg-run, run wfr_');
  expect(status.content).toContain('(background)');
  expect(await until(() => gotResult, 10_000)).toBe(true);
  await t.engine.runnerFor(s.id).waitIdle();
});

test('in bypass mode the Workflow tool starts without the approval card; other modes still ask; the caps still hold', async () => {
  mains.set('bypass', (body) => {
    if (!afterToolResult(body)) {
      return [
        {
          tool: 'Workflow',
          input: {
            script: `export const meta = { name: 'bypass-run', description: 'bypass', phases: [{ title: 'Go' }] }
phase('Go')
const a = await agent('say bypassed')
let capped = null
try { await agent('say again') } catch (e) { capped = e.message }
return { a, capped }`,
            estimate: { agents: 2, tokens: 2000 },
          },
        },
      ];
    }
    return [{ text: 'ran it' }];
  });
  t.engine.config.update({ workflows: { maxAgents: 1 } });
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd, permissionMode: 'bypass' });
    const before = t.approvals.length;
    await t.run(s.id, 'OWNER-bypass: go');
    expect(t.approvals.length).toBe(before);
    const res = toolResults(t.engine, s.id).find((r) => r.name === 'Workflow')!;
    expect(res.isError).toBe(false);
    expect(res.content).toContain('Workflow bypass-run done');
    expect(res.content).toContain('bypassed');
    // bypass skips the card, not the run's caps
    expect(res.content).toContain('Workflow agent() call cap reached (1 agents in this run)');
    const run = svc.store.listRuns({ sessionId: s.id, limit: 1 })[0];
    expect(svc.store.logs(run.id).map((l) => l.text)).toContain('Started without an approval card: the session is in bypass mode.');
    // the run names the tool call that started it, for the session's live card
    const use = t.engine.getMessages(s.id).flatMap((m) => m.content).find((b) => b.type === 'tool_use' && b.name === 'Workflow') as { id: string };
    expect(run.toolUseId).toBe(use.id);
    expect(svc.run(run.id).run.toolUseId).toBe(use.id);

    // acceptEdits and default mode show the card as before
    for (const mode of ['acceptEdits', 'default'] as const) {
      const other = await t.engine.createSession({ cwd: t.cwd, permissionMode: mode });
      const n = t.approvals.length;
      await t.run(other.id, 'OWNER-bypass: go');
      expect(t.approvals.length).toBe(n + 1);
      expect(t.approvals.at(-1)).toContain('Run workflow bypass-run');
    }
  } finally {
    t.engine.config.update({ workflows: {} });
  }
});

test('Ultra adds the note and the tool; it auto-approves after the first approved run under the threshold', async () => {
  let body: RequestBody | undefined;
  let plain = false;
  mains.set('ultra', (b) => {
    body = b;
    if (plain) return [{ text: 'plain' }];
    if (!afterToolResult(b)) return [{ tool: 'Workflow', input: { script: `export const meta = { name: 'ultra-run', description: 'ultra' }\nreturn await agent('say ultra')`, estimate: { agents: 1, tokens: 5000 } } }];
    return [{ text: 'ok' }];
  });
  // an agent whose tool list leaves Workflow out still gets it in Ultra
  const s = await t.engine.createSession({ cwd: t.cwd, agent: 'explore' });
  t.engine.updateSession(s.id, { ultra: true });
  expect(t.engine.getSession(s.id)!.ultra).toBe(true);
  const before = t.approvals.length;
  await t.run(s.id, 'OWNER-ultra: first ultra task');
  expect(systemText(body!)).toContain('Ultra is on.');
  expect(hasTool(body!, 'Workflow')).toBe(true);
  expect(t.approvals.length).toBe(before + 1);
  await t.run(s.id, 'second ultra task');
  // the second run started without a card
  expect(t.approvals.length).toBe(before + 1);
  expect(toolResults(t.engine, s.id).filter((r) => r.name === 'Workflow' && r.content.includes('ultra-run done')).length).toBe(2);

  // Ultra off: the note goes
  t.engine.updateSession(s.id, { ultra: false });
  plain = true;
  await t.run(s.id, 'plain turn');
  expect(systemText(body!)).not.toContain('Ultra is on.');
});

test('chats never take Ultra; subagents never get the Workflow tool', async () => {
  const chat = await t.engine.createSession({ kind: 'chat' });
  expect(t.engine.updateSession(chat.id, { ultra: true }).ultra).toBe(false);
  let sub: RequestBody | undefined;
  answers.set('inspect the subagent', (b) => {
    sub = b;
    return [{ text: 'ok' }];
  });
  mains.set('task', (b) => (afterToolResult(b) ? [{ text: 'done' }] : [{ tool: 'Task', input: { description: 'look', prompt: 'inspect the subagent', subagent_type: 'general-purpose' } }]));
  const s = await t.engine.createSession({ cwd: t.cwd });
  await t.run(s.id, 'OWNER-task: delegate');
  expect(sub).toBeDefined();
  expect(hasTool(sub!, 'Workflow')).toBe(false);
  expect(hasTool(sub!, 'WorkflowStatus')).toBe(false);
});
