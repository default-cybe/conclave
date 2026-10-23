/**
 * Journal and resume: a hub restart mid-run, a 100% cache hit, an edited
 * call that reruns only itself and what depends on it, a worktree branch
 * deleted before replay, and a call parked on a usage limit.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, until, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, countRequests, lastUserText, reopen, runScript, svcOf, workingDir, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';

let t: TestEngine;
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
    approve: 'allow',
    overrides: { limits: { maxRetries: 0, autoResume: true, fallbacks: {}, resumePrompt: 'The usage limit has reset. Continue where you left off.' } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const THREE = `export const meta = { name: 'three', description: 'three calls' }
const a = await agent('say one')
const b = await agent('say two')
const c = await agent('slow three')
return [a, b, c]`;

test('a run the hub stopped mid-way resumes at the next boot from the journal, then replays 100% from cache', async () => {
  let slow = true;
  answers.set('slow three', () => (slow ? { blocks: [{ text: 'three' }], delayMs: 4000 } : [{ text: 'three' }]));
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.startRun({ script: THREE, sessionId: s.id });
  // wait until the third call is in flight: marked running and its request at the model, so it is not counted after the restart
  expect(await until(() => svc.live.get(run.id)?.calls.get(3)?.state === 'running', 10_000)).toBe(true);
  expect(await until(() => t.requests.some((x) => x.includes('slow three')), 10_000)).toBe(true);
  await t.engine.shutdown();
  // as after a crash: the row says running
  const row = svc.store.getRun(run.id)!;
  expect(row.status).toBe('interrupted');
  svc.store.updateRun({ ...row, status: 'running' });
  slow = false;

  const before = t.requests.length;
  const e2 = await reopen(t);
  try {
    const svc2 = svcOf(e2);
    expect(await until(() => svc2.store.getRun(run.id)?.status === 'done', 15_000)).toBe(true);
    const done = svc2.store.getRun(run.id)!;
    expect(done.result).toEqual(['one', 'two', 'three']);
    // only the interrupted call ran again
    const live = t.requests.slice(before);
    expect(live.filter((x) => x.includes('say one') || x.includes('say two')).length).toBe(0);
    expect(live.filter((x) => x.includes('slow three')).length).toBe(1);
    const states = svc2.store.calls(run.id).map((c) => c.state);
    expect(states).toEqual(['cached', 'cached', 'done']);
    expect(done.autoResumes).toBe(1);

    // the same script again: every call replays, no model requests
    const n = t.requests.length;
    await svc2.resume(run.id);
    expect(await until(() => svc2.store.getRun(run.id)?.status === 'done' && !svc2.live.has(run.id), 10_000)).toBe(true);
    expect(t.requests.length).toBe(n);
    expect(svc2.store.calls(run.id).every((c) => c.state === 'cached')).toBe(true);
    expect(svc2.store.getRun(run.id)!.result).toEqual(['one', 'two', 'three']);
  } finally {
    await e2.shutdown();
    // the harness engine was shut down above; give the harness a live one to close
    t.engine = await reopen(t);
  }
});

test('an edited call reruns only it and the calls that depend on its answer', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const v1 = `export const meta = { name: 'deps', description: 'deps' }
const a = await agent('say alpha')
const b = await agent('say beta')
const c = await agent('say ' + a + 'x')
return [a, b, c]`;
  const r1 = await svc.wait((await svc.startRun({ script: v1, sessionId: s.id })).id);
  expect(r1.result).toEqual(['alpha', 'beta', 'alphax']);

  // edit b: a and c replay
  const v2 = v1.replace("say beta'", "say gamma'");
  const step2 = await countRequests(t, async () => svc.wait((await svc.startRun({ script: v2, sessionId: s.id, resumeFromRunId: r1.id })).id));
  expect(step2.value.result).toEqual(['alpha', 'gamma', 'alphax']);
  expect(step2.requests).toBe(1);
  expect(svc.store.calls(step2.value.id).map((c) => c.state)).toEqual(['cached', 'done', 'cached']);

  // edit a: a and c (which uses a's answer) run, b replays
  const v3 = v2.replace("say alpha'", "say delta'");
  const step3 = await countRequests(t, async () => svc.wait((await svc.startRun({ script: v3, sessionId: s.id, resumeFromRunId: step2.value.id })).id));
  expect(step3.value.result).toEqual(['delta', 'gamma', 'deltax']);
  expect(step3.requests).toBe(2);
  expect(svc.store.calls(step3.value.id).map((c) => c.state)).toEqual(['done', 'cached', 'done']);

  // rerun from call 2 of the first run: call 1 replays, 2 and 3 run
  const step4 = await countRequests(t, async () => {
    await svc.rerun(r1.id, 2);
    await until(() => svc.store.getRun(r1.id)?.status === 'done' && !svc.live.has(r1.id), 10_000);
    return svc.store.getRun(r1.id)!;
  });
  expect(step4.requests).toBe(2);
  expect(svc.store.calls(r1.id).map((c) => c.state)).toEqual(['cached', 'done', 'done']);
});

test('a worktree call replays only while its branch still exists', async () => {
  const repo = tempDir('conclave-wf-repo-');
  const home = tempDir('conclave-wf-home-');
  try {
    const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
    git('init -q -b main');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add -A');
    git('commit -q -m init');
    // worktrees go under this home instead of the real one
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.set('local', home);
    answers.set('write a note', (body) => {
      if (afterToolResult(body)) return [{ text: 'wrote it' }];
      const cwd = workingDir(body)!;
      return [{ tool: 'Write', input: { file_path: join(cwd, 'note.txt'), content: 'from the worktree\n' } }];
    });
    const script = `export const meta = { name: 'wt', description: 'worktree' }
return await agent('write a note', { isolation: 'worktree' })`;
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const r1 = await svc.wait((await svc.startRun({ script, sessionId: s.id })).id);
    expect(r1.status).toBe('done');
    const call = svc.store.calls(r1.id)[0];
    expect(call.worktreeState).toBe('kept');
    expect(call.worktreeBranch).toBe(`conclave/wf/${r1.id}/1`);
    expect(call.worktreePath).toStartWith(join(home, '.conclave', 'worktrees'));
    expect(git(`show ${call.worktreeBranch}:note.txt`).stdout.toString()).toBe('from the worktree\n');
    // the worktree folder is gone, the branch stays; the owner's tree is untouched
    expect(Bun.file(join(repo, 'note.txt')).size).toBe(0);

    const replay = await countRequests(t, async () => svc.wait((await svc.startRun({ script, sessionId: s.id, resumeFromRunId: r1.id })).id));
    expect(replay.requests).toBe(0);

    git(`branch -D ${call.worktreeBranch}`);
    const live = await countRequests(t, async () => svc.wait((await svc.startRun({ script, sessionId: s.id, resumeFromRunId: r1.id })).id));
    expect(live.requests).toBeGreaterThan(0);
    expect(svc.store.logs(live.value.id).some((l) => l.text.includes('is gone or moved'))).toBe(true);

    // the owner's diff of the kept branch
    const d = await svc.worktree(live.value.id, 1, 'diff');
    expect(d.output).toContain('from the worktree');
    const discard = await svc.worktree(live.value.id, 1, 'discard');
    expect(discard.state).toBe('discarded');
  } finally {
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.delete('local');
    cleanup(repo, home);
  }
});

test('a usage limit parks the call; the run waits and goes on when the limit resets', async () => {
  let limited = true;
  answers.set('say limited', (body) => {
    if (limited) return 429;
    return lastUserText(body).includes('usage limit has reset') ? [{ text: 'limited-done' }] : [{ text: 'limited-done' }];
  });
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.startRun({ script: `export const meta = { name: 'park', description: 'park' }\nreturn await agent('say limited')`, sessionId: s.id });
  expect(await until(() => svc.live.get(run.id)?.row.status === 'waiting_reset', 10_000)).toBe(true);
  expect(svc.live.get(run.id)!.calls.get(1)!.state).toBe('parked');
  expect(t.engine.repos.jobs.pending('workflow.resume').length).toBeGreaterThan(0);
  limited = false;
  await svc.resume(run.id);
  const done = await svc.wait(run.id);
  expect(done.status).toBe('done');
  expect(done.result).toBe('limited-done');
});

test('stop aborts in-flight children; skip makes a call null', async () => {
  answers.set('very slow', () => ({ blocks: [{ text: 'late' }], delayMs: 5000 }));
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.startRun({ script: `export const meta = { name: 'skip', description: 'skip' }\nconst a = await agent('very slow')\nreturn { a, b: await agent('say after') }`, sessionId: s.id });
  expect(await until(() => svc.live.get(run.id)?.calls.get(1)?.state === 'running', 10_000)).toBe(true);
  svc.skip(run.id, 1);
  const done = await svc.wait(run.id);
  expect(done.result).toEqual({ a: null, b: 'after' });
  expect(svc.store.calls(run.id)[0].state).toBe('skipped');

  const run2 = await svc.startRun({ script: `export const meta = { name: 'stop', description: 'stop' }\nreturn await agent('very slow')`, sessionId: s.id });
  expect(await until(() => svc.live.get(run2.id)?.calls.get(1)?.state === 'running', 10_000)).toBe(true);
  svc.stop(run2.id);
  const stopped = await svc.wait(run2.id);
  expect(stopped.status).toBe('stopped');
});

test('lib.ask and lib.approve are journaled; an unattended plan stops with the plan', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  // nobody is watching: ask takes the first option, approve ends the run with the plan
  const run = await svc.startRun(
    { script: `export const meta = { name: 'askplan', description: 'x', runtime: 'conclave' }\nconst pick = await lib.ask('Which?', ['first', 'second'])\nconst ok = await lib.approve('the plan')\nreturn { pick, ok }`, sessionId: s.id },
    { unattended: true },
  );
  const done = await svc.wait(run.id);
  expect(done.status).toBe('done');
  expect(done.result).toMatchObject({ approved: false, plan: 'the plan' });
  const calls = svc.store.calls(run.id);
  expect(calls[0].kind).toBe('ask');
  expect(calls[0].result).toBe('first');
});

test('lib.exec runs read-only commands without asking and journals them by the code they ran on', async () => {
  const dir = tempDir('conclave-wf-exec-');
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\n');
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: dir });
    const script = `export const meta = { name: 'exec', description: 'x', runtime: 'conclave' }
const r = await lib.exec('ls src')
const c = await lib.checkCitations([{ file: 'src/a.ts', line: 2, quote: 'export const y = 2;', title: 't' }, { file: 'src/a.ts', line: 1, quote: 'not in the file', title: 'u' }])
return { out: r.stdout.trim(), kept: c.kept.length, dropped: c.dropped }`;
    const before = t.approvals.length;
    const r1 = await svc.wait((await svc.startRun({ script, sessionId: s.id })).id);
    expect(r1.result).toEqual({ out: 'a.ts', kept: 1, dropped: 1 });
    expect(t.approvals.length).toBe(before);
    expect(svc.store.logs(r1.id).some((l) => l.text.includes('citation check dropped 1 of 2'))).toBe(true);
  } finally {
    cleanup(dir);
  }
});
