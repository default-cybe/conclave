/**
 * The workflow runtime on the scripted engine: the script API, structured
 * output, budgets and caps, events. No paid calls.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, countRequests, hasTool, lastToolResult, lastUserText, runScript, svcOf, systemText, noHarnesses } from './helpers';

let t: TestEngine;
/** Per-test answers keyed by a word in the child's prompt. */
const answers = new Map<string, (body: RequestBody) => Step | number | undefined>();

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      for (const [word, fn] of answers) if (first.includes(word)) return fn(body);
      const m = /say (\w+)/.exec(first);
      if (m) return [{ text: m[1] }];
      return undefined;
    },
    overrides: { limits: { maxRetries: 0, autoResume: true, fallbacks: {} } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

test('parallel turns a throwing thunk into null; pipeline drops an item that throws', async () => {
  const run = await runScript(
    t,
    `export const meta = { name: 'pp', description: 'parallel and pipeline' }
const p = await parallel([() => agent('say one'), () => { throw new Error('nope') }, () => agent('say two')])
const q = await pipeline(['a', 'b', 'c'], (x) => x.toUpperCase(), (prev, item, i) => { if (item === 'b') throw new Error('drop b'); return prev + i })
return { p, q }`,
  );
  expect(run.status).toBe('done');
  expect(run.result).toEqual({ p: ['one', null, 'two'], q: ['A0', null, 'C2'] });
  const logs = svcOf(t.engine).store.logs(run.id).map((l) => l.text);
  expect(logs.some((l) => l.includes('parallel item 1 failed: nope'))).toBe(true);
  expect(logs.some((l) => l.includes('pipeline item 1 dropped at stage 2'))).toBe(true);
});

test('agent() with a schema retries a bad StructuredOutput call and nudges a turn that ends without one', async () => {
  answers.set('structured-retry', (body) => {
    if (!hasTool(body, 'StructuredOutput')) return [{ text: 'no tool?' }];
    if (afterToolResult(body)) {
      const res = lastToolResult(body);
      if (res.includes('does not match')) return [{ tool: 'StructuredOutput', input: { count: 3, items: ['x'] } }];
      return [{ text: 'done' }];
    }
    // first try: count is a string and items is missing
    return [{ tool: 'StructuredOutput', input: { count: 'three' } }];
  });
  answers.set('structured-nudge', (body) => {
    if (afterToolResult(body)) return [{ text: 'done' }];
    if (lastUserText(body).includes('must go through the StructuredOutput tool')) return [{ tool: 'StructuredOutput', input: { count: 1, items: [] } }];
    return [{ text: 'I forgot the tool' }];
  });
  answers.set('structured-never', () => [{ text: 'never calling it' }]);
  const run = await runScript(
    t,
    `export const meta = { name: 'schema', description: 'structured output' }
const schema = { type: 'object', properties: { count: { type: 'integer' }, items: { type: 'array', items: { type: 'string' } } }, required: ['count', 'items'] }
const a = await agent('structured-retry', { schema })
const b = await agent('structured-nudge', { schema })
const c = await agent('structured-never', { schema })
let bad = null
try { await agent('x', { schema: { type: 'array' } }) } catch (e) { bad = e.message }
let bad2 = null
try { await agent('x', { schema: { type: 'object', properties: {}, required: ['missing'] } }) } catch (e) { bad2 = e.message }
return { a, b, c, bad, bad2 }`,
  );
  expect(run.status).toBe('done');
  const r = run.result as Record<string, unknown>;
  expect(r.a).toEqual({ count: 3, items: ["x"] });
  expect(r.b).toEqual({ count: 1, items: [] });
  expect(r.c).toBeNull();
  expect(String(r.bad)).toContain("schema root must be { type: 'object' }");
  expect(String(r.bad2)).toContain('required names properties it does not define: missing');
  // the rejected call listed each problem by path
  const retried = t.requests.find((x) => x.includes('structured-retry') && x.includes('$.count must be integer'));
  expect(retried).toBeDefined();
  expect(retried).toContain('$.items is required');
  const calls = svcOf(t.engine).store.calls(run.id);
  expect(calls.find((c) => c.prompt === 'structured-never')?.state).toBe('failed');
  expect(calls.find((c) => c.prompt === 'structured-never')?.error).toContain('no valid StructuredOutput');
});

test('the token budget is a hard ceiling: agent() throws once it is spent', async () => {
  const run = await runScript(
    t,
    `export const meta = { name: 'budget', description: 'budget stop' }
const got = []
let error = null
try {
  for (let i = 0; i < 20; i++) got.push(await agent('say b' + i))
} catch (e) { error = e.message }
return { n: got.length, error, total: budget.total, spent: budget.spent(), remaining: budget.remaining() }`,
    { budget: { tokens: 12 } },
  );
  const r = run.result as { n: number; error: string; total: number; spent: number; remaining: number };
  // each scripted reply spends 5 output tokens
  expect(r.n).toBe(3);
  expect(r.error).toStartWith('Workflow budget reached');
  expect(r.total).toBe(12);
  expect(r.spent).toBe(15);
  expect(r.remaining).toBe(0);
  expect(run.status).toBe('budget');
});

test('budget.total is null and remaining() Infinity without a target', async () => {
  const run = await runScript(t, `export const meta = { name: 'nobudget', description: 'x' }\nreturn { total: budget.total, inf: budget.remaining() === Infinity }`);
  expect(run.result).toEqual({ total: null, inf: true });
});

test('the agent cap error starts with the text scan.js matches', async () => {
  t.engine.config.update({ workflows: { maxAgents: 3 } });
  try {
    const run = await runScript(
      t,
      `export const meta = { name: 'cap', description: 'agent cap' }
let error = null
let n = 0
try { for (;;) { await agent('say c' + n); n++ } } catch (e) { error = e.message }
return { n, error }`,
    );
    const r = run.result as { n: number; error: string };
    expect(r.n).toBe(3);
    expect(r.error).toStartWith('Workflow agent() call cap reached');
  } finally {
    t.engine.config.update({ workflows: {} });
  }
});

test('phases, logs and call events reach the bus; progress stays out of the replay buffer', async () => {
  const seen: string[] = [];
  const off = t.engine.bus.on((e) => {
    if (e.type.startsWith('workflow.')) seen.push(e.type);
  });
  const from = t.engine.bus.currentSeq;
  answers.set('use-a-tool', (body) => (afterToolResult(body) ? [{ text: 'listed' }] : [{ tool: 'Glob', input: { pattern: '*.md' } }]));
  const run = await runScript(
    t,
    `export const meta = { name: 'events', description: 'events', phases: [{ title: 'Find' }, { title: 'Check' }] }
phase('Find')
await agent('use-a-tool')
phase('Check')
console.log('checked', 2)
return 'ok'`,
  );
  off();
  expect(run.status).toBe('done');
  for (const type of ['workflow.run', 'workflow.phase', 'workflow.agent', 'workflow.log', 'workflow.progress']) expect(seen).toContain(type);
  const replay = t.engine.bus.since(from) ?? [];
  expect(replay.some((e) => e.type === 'workflow.progress')).toBe(false);
  expect(replay.some((e) => e.type === 'workflow.agent')).toBe(true);
  const detail = svcOf(t.engine).run(run.id);
  expect(detail.run.phaseIndex).toBe(1);
  expect(detail.calls[0].phase).toBe('Find');
  expect(detail.calls[0].lastTool).toContain('Glob');
  expect(detail.logs.map((l) => l.text)).toContain('checked 2');
});

test('workflow agents get the step note, no AskUserQuestion and no Workflow; effort reaches the request', async () => {
  let body: RequestBody | undefined;
  answers.set('inspect-me', (b) => {
    body = b;
    return [{ text: 'ok' }];
  });
  const run = await runScript(t, `export const meta = { name: 'inspect', description: 'x' }\nreturn await agent('inspect-me', { effort: 'xhigh' })`);
  expect(run.result).toBe('ok');
  expect(body).toBeDefined();
  expect(systemText(body!)).toContain('You are one step of a workflow');
  expect(hasTool(body!, 'AskUserQuestion')).toBe(false);
  expect(hasTool(body!, 'Workflow')).toBe(false);
  expect(hasTool(body!, 'WorkflowStatus')).toBe(false);
  expect(hasTool(body!, 'Task')).toBe(false);
  const child = svcOf(t.engine).store.calls(run.id)[0].childSessionId!;
  const s = t.engine.getSession(child)!;
  expect(s.tags).toEqual(['subagent', 'workflow']);
  expect((s.meta?.workflow as { effort?: string }).effort).toBe('xhigh');
});

test('a missing agentType falls back to general-purpose and the log says so', async () => {
  const run = await runScript(t, `export const meta = { name: 'fallback', description: 'x' }\nreturn await agent('say fine', { agentType: 'no-such-agent' })`);
  expect(run.result).toBe('fine');
  const logs = svcOf(t.engine).store.logs(run.id).map((l) => l.text);
  expect(logs.some((l) => l.includes('agent no-such-agent is not installed here'))).toBe(true);
});

test('nested workflow() shares the run; a second level throws', async () => {
  const svc = svcOf(t.engine);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(svc.registry.userDir, { recursive: true });
  writeFileSync(join(svc.registry.userDir, 'child-wf.js'), `export const meta = { name: 'child-wf', description: 'child' }
const x = await agent('say nested' + args.n)
let deeper = null
try { await workflow('child-wf', { n: 2 }) } catch (e) { deeper = e.message }
return { x, deeper }`);
  const run = await runScript(t, `export const meta = { name: 'parent-wf', description: 'parent' }\nreturn await workflow('child-wf', { n: 1 })`);
  expect(run.status).toBe('done');
  expect(run.result).toEqual({ x: 'nested1', deeper: 'workflow() nesting is one level only' });
  const calls = svc.store.calls(run.id);
  const wf = calls.find((c) => c.kind === 'workflow')!;
  expect(calls.find((c) => c.kind === 'agent')?.parentSeq).toBe(wf.seq);
});

test('the result of an inline run reaches the run row and the saved script path', async () => {
  const { value: run, requests } = await countRequests(t, () => runScript(t, `export const meta = { name: 'saved', description: 'x' }\nreturn 42`));
  expect(requests).toBe(0);
  expect(run.result).toBe(42);
  expect(run.scriptPath).toContain('/workflows/runs/');
});

test('an agent waiting on a tool approval shows as waiting, and stops waiting once it is answered', async () => {
  answers.set('write a note', (body) => (afterToolResult(body) ? [{ text: 'done' }] : [{ tool: 'Write', input: { file_path: `${t.cwd}/note.txt`, content: 'x\n' } }]));
  const seen: Array<{ lastTool: string; waiting?: 'approval' | false; callSeq: number }> = [];
  const off = t.engine.bus.on((e) => {
    if (e.type === 'workflow.progress' && e.waiting !== undefined) seen.push({ lastTool: e.lastTool, waiting: e.waiting, callSeq: e.callSeq });
  });
  try {
    const run = await runScript(t, `export const meta = { name: 'wait-approval', description: 'x' }
return await agent('write a note', { label: 'writer' })`);
    expect(run.status).toBe('done');
    // the harness denies the approval at once: waiting, then not
    expect(seen.map((s) => s.waiting)).toEqual(['approval', false]);
    // the call's number survives the event envelope, whose own seq counts events
    expect(seen.map((s) => s.callSeq)).toEqual([1, 1]);
    expect(seen[0].lastTool).toStartWith('needs approval: ');
    expect(seen[1].lastTool).not.toStartWith('needs approval: ');
  } finally {
    off();
    answers.delete('write a note');
  }
});
