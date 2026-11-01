/**
 * Adversarial checks of the workflow runtime (QA of section 3): determinism
 * that a script can reach around, args that must arrive verbatim, scripts
 * that loop on host calls, phases or findings, timers that leak, citation
 * checks on files outside the run or too large to read, permissions a
 * script grants itself, budgets across a resume, the Ultra approval, and a
 * skipped call after a resume. Scripted engine only, no paid calls.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { firstUserText, startTestEngine, until, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { runScript, svcOf, noHarnesses } from './helpers';
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
    overrides: { limits: { maxRetries: 0, autoResume: true, fallbacks: {} } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const meta = (name: string, extra = '') => `export const meta = { name: '${name}', description: 'qa'${extra} }\n`;

test('Date.now and new Date() stay closed through the prototype chain', async () => {
  const run = await runScript(
    t,
    `${meta('date-proto')}
const probe = (f) => { try { f(); return 'open' } catch (e) { return 'threw' } }
return {
  viaProto: probe(() => Object.getPrototypeOf(Date).now()),
  viaCtor: probe(() => new (Object.getPrototypeOf(new Date(0)).constructor)()),
  viaProtoProto: probe(() => { const D = Object.getPrototypeOf(Date.prototype).constructor; return D === Object ? D.now() : new D() }),
  viaCtorNow: probe(() => Date.prototype.constructor.now()),
  call: probe(() => Date()),
  fixed: new Date(0).getTime(),
  utc: Date.UTC(2020, 0, 1),
  parse: Date.parse('2020-01-01T00:00:00Z'),
  isDate: new Date(5) instanceof Date,
  iso: new Date(0).toISOString(),
}`,
  );
  expect(run.status).toBe('done');
  expect(run.result).toEqual({ viaProto: 'threw', viaCtor: 'threw', viaProtoProto: 'threw', viaCtorNow: 'threw', call: 'threw', fixed: 0, utc: 1577836800000, parse: 1577836800000, isDate: true, iso: '1970-01-01T00:00:00.000Z' });
});

test('args arrive verbatim, a __proto__ key included', async () => {
  const args = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
  const run = await runScript(t, `${meta('args-proto')}return { keys: Object.keys(args), inherited: args.x === undefined, own: args.__proto__ && args.__proto__.x }`, { args });
  expect(run.status).toBe('done');
  expect(run.result).toEqual({ keys: ['__proto__', 'a'], inherited: true, own: 1 });
});

test('phase() with endless new titles stops adding phases and says so once', async () => {
  const run = await runScript(t, `${meta('phase-flood')}for (let i = 0; i < 400; i++) phase('p' + i)\nreturn 'ok'`);
  expect(run.status).toBe('done');
  expect(run.phases.length).toBeLessThanOrEqual(64);
  const logs = svcOf(t.engine).store.logs(run.id).map((l) => l.text);
  expect(logs.filter((l) => l.includes('phase cap')).length).toBe(1);
});

test('a phase title over 200 characters is one phase, however often it is set', async () => {
  const run = await runScript(t, `${meta('long-phase')}const long = 'x'.repeat(250)\nphase(long)\nphase('short')\nphase(long)\nreturn 'ok'`);
  expect(run.status).toBe('done');
  expect(run.phases.map((p) => p.title.length)).toEqual([200, 5]);
  expect(run.phaseIndex).toBe(0);
});

test('a loop over host calls stops at the host call cap', async () => {
  const svc = svcOf(t.engine);
  svc.caps = { hostCalls: 150 };
  try {
    const started = Date.now();
    const run = await runScript(t, `${meta('host-loop')}let n = 0\nfor (;;) { await lib.dropDismissed([]); n++ }`);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('host call cap reached');
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    svc.caps = {};
  }
});

test('a lib.exec polling loop stops at the check cap', async () => {
  const svc = svcOf(t.engine);
  svc.caps = { checks: 12 };
  try {
    const run = await runScript(t, `${meta('exec-loop', ", runtime: 'conclave'")}for (;;) { const r = await lib.exec('test -f never-there'); if (r.exitCode === 0) break }`);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('check cap reached');
    expect(svc.store.calls(run.id).filter((c) => c.kind === 'check').length).toBe(12);
  } finally {
    svc.caps = {};
  }
});

test('timers do not leave abort listeners on the run', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const started = await svc.startRun({
    sessionId: s.id,
    script: `${meta('timer-leak')}for (let i = 0; i < 300; i++) await new Promise((r) => setTimeout(r, 0))\nlog('slept')\nawait new Promise((r) => setTimeout(r, 1500))\nreturn 'ok'`,
  });
  expect(await until(() => svc.store.logs(started.id).some((l) => l.text === 'slept'), 15_000)).toBe(true);
  const live = svc.live.get(started.id)!;
  expect(getEventListeners(live.controller.signal, 'abort').length).toBeLessThan(10);
  const done = await svc.wait(started.id);
  expect(done.result).toBe('ok');
});

test('recordFindings keeps at most the findings cap per run', async () => {
  const svc = svcOf(t.engine);
  svc.caps = { findings: 40 };
  try {
    const run = await runScript(
      t,
      `${meta('finding-flood', ", runtime: 'conclave'")}for (let r = 0; r < 4; r++) await lib.recordFindings(Array.from({ length: 30 }, (_, i) => ({ title: 'f ' + r + ' ' + i, file: 'a.ts', line: i + 1 })))\nreturn 'ok'`,
    );
    expect(run.status).toBe('done');
    expect(svc.store.findings(run.id).length).toBe(40);
    expect(svc.store.logs(run.id).some((l) => l.text.includes('findings cap'))).toBe(true);
  } finally {
    svc.caps = {};
  }
});

test('lib.checkCitation reads only files inside the run folder, and not huge ones', async () => {
  const outside = tempDir('conclave-wfqa-outside-');
  try {
    writeFileSync(join(outside, 'secret.txt'), 'line one\nTOPSECRET value here\n');
    writeFileSync(join(t.cwd, 'ok.ts'), 'const a = 1;\nconst b = a + 1;\n');
    writeFileSync(join(t.cwd, 'huge.log'), `${'x'.repeat(100)}\n`.repeat(70_000));
    const rel = join('..', outside.split('/').pop()!, 'secret.txt');
    const run = await runScript(
      t,
      `${meta('cite-scope', ", runtime: 'conclave'")}return {
  inside: await lib.checkCitation({ file: 'ok.ts', line: 2, quote: 'const b = a + 1;' }),
  absolute: await lib.checkCitation({ file: ${JSON.stringify(join(outside, 'secret.txt'))}, line: 2, quote: 'TOPSECRET value here' }),
  dotdot: await lib.checkCitation({ file: ${JSON.stringify(rel)}, line: 2, quote: 'TOPSECRET value here' }),
  huge: await lib.checkCitation({ file: 'huge.log', line: 1, quote: 'xxxxxxxxxx' }),
}`,
    );
    expect(run.status).toBe('done');
    const r = run.result as Record<string, { ok: boolean; reason?: string }>;
    expect(r.inside.ok).toBe(true);
    expect(r.absolute).toMatchObject({ ok: false });
    expect(r.absolute.reason).toContain('outside');
    expect(r.dotdot).toMatchObject({ ok: false });
    expect(r.dotdot.reason).toContain('outside');
    expect(r.huge).toMatchObject({ ok: false });
    expect(r.huge.reason).toContain('too large');
  } finally {
    cleanup(outside);
    rmSync(join(t.cwd, 'huge.log'), { force: true });
  }
});

test('lib.checkCitation takes paths relative to the repository root when the run folder is a subfolder', async () => {
  const repo = tempDir('conclave-wfqa-sub-');
  try {
    const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
    git('init -q -b main');
    mkdirSync(join(repo, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'core', 'src', 'x.ts'), 'export const one = 1;\nexport const two = one + one;\n');
    git('add -A');
    git('commit -q -m init');
    const s = await t.engine.createSession({ cwd: join(repo, 'packages', 'core') });
    const run = await runScript(
      t,
      `${meta('cite-root', ", runtime: 'conclave'")}return {
  fromRoot: (await lib.checkCitation({ file: 'packages/core/src/x.ts', line: 2, quote: 'export const two = one + one;' })).ok,
  fromCwd: (await lib.checkCitation({ file: 'src/x.ts', line: 2, quote: 'export const two = one + one;' })).ok,
}`,
      { sessionId: s.id },
    );
    expect(run.status).toBe('done');
    expect(run.result).toEqual({ fromRoot: true, fromCwd: true });
  } finally {
    cleanup(repo);
  }
});

test('a library folder with a pipe, a device link or a huge file still lists, with the reasons', async () => {
  const svc = svcOf(t.engine);
  mkdirSync(svc.registry.userDir, { recursive: true });
  const fifo = join(svc.registry.userDir, 'pipe.js');
  const big = join(svc.registry.userDir, 'big.js');
  const dev = join(svc.registry.userDir, 'zero.js');
  try {
    Bun.spawnSync(['mkfifo', fifo]);
    Bun.spawnSync(['ln', '-s', '/dev/zero', dev]);
    writeFileSync(big, `export const meta = { name: 'big', description: 'big' }\n// ${'y'.repeat(300 * 1024)}\n`);
    const started = Date.now();
    const lib = await svc.library();
    expect(Date.now() - started).toBeLessThan(5000);
    const bigEntry = lib.find((w) => w.id === 'big' || w.path === big);
    expect(bigEntry?.runnable).toBe(false);
    expect(bigEntry?.error).toContain('larger than 256 KB');
    expect(lib.some((w) => w.path === fifo || w.path === dev)).toBe(false);
  } finally {
    rmSync(fifo, { force: true });
    rmSync(big, { force: true });
    rmSync(dev, { force: true });
  }
}, 15_000);

test('a script cannot grant its own agents permissions; a workflow the owner saved can', async () => {
  const svc = svcOf(t.engine);
  try {
    const s = await t.engine.createSession({ cwd: t.cwd });
    // Ultra with an approved first run and a small estimate: no approval card, as in a real Ultra session
    t.engine.updateSession(s.id, { ultra: true });
    t.engine.patchMeta(s.id, { ultraApproved: true });
    const out = await svc.runFromTool(
      {
        sessionId: s.id,
        script: `export const meta = { name: 'grant-self', description: 'qa', runtime: 'conclave', permissions: { allow: ['Bash'] } }\nconst r = await lib.exec('touch granted-by-script.txt')\nreturn r.exitCode`,
      },
      { toolUseId: 'tu_grant', signal: new AbortController().signal, estimate: { agents: 0, tokens: 1 } },
    );
    expect(existsSync(join(t.cwd, 'granted-by-script.txt'))).toBe(false);
    expect(out.isError).toBe(true);
    const logs = svc.store.logs(out.runId!).map((l) => l.text);
    expect(logs.some((l) => l.includes('meta.permissions.allow'))).toBe(true);

    mkdirSync(svc.registry.userDir, { recursive: true });
    writeFileSync(join(svc.registry.userDir, 'owner-grant.js'), `export const meta = { name: 'owner-grant', description: 'qa', runtime: 'conclave', permissions: { allow: ['Bash(touch owner-granted.txt)'] } }\nconst r = await lib.exec('touch owner-granted.txt')\nreturn r.exitCode`);
    const owner = await svc.wait((await svc.startRun({ name: 'owner-grant', sessionId: s.id })).id);
    expect(owner.result).toBe(0);
    expect(existsSync(join(t.cwd, 'owner-granted.txt'))).toBe(true);
  } finally {
    rmSync(join(t.cwd, 'owner-granted.txt'), { force: true });
    rmSync(join(t.cwd, 'granted-by-script.txt'), { force: true });
    rmSync(join(svc.registry.userDir, 'owner-grant.js'), { force: true });
  }
});

test('in Ultra, a Workflow call with no estimate still asks', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  t.engine.updateSession(s.id, { ultra: true });
  t.engine.patchMeta(s.id, { ultraApproved: true });
  const script = `${meta('ultra-ask')}return 1`;
  const before = t.approvals.length;
  const noEstimate = await svc.runFromTool({ sessionId: s.id, script }, { toolUseId: 'tu_u1', signal: new AbortController().signal });
  expect(t.approvals.length).toBe(before + 1);
  expect(noEstimate.isError).toBe(true);
  const small = await svc.runFromTool({ sessionId: s.id, script }, { toolUseId: 'tu_u2', signal: new AbortController().signal, estimate: { agents: 1, tokens: 10_000 } });
  expect(t.approvals.length).toBe(before + 1);
  expect(small.isError).toBeUndefined();
});

test('the budget counts what earlier attempts of the same run spent', async () => {
  let slow = true;
  answers.set('slow-budget', () => (slow ? { blocks: [{ text: 'q1' }], delayMs: 3000 } : [{ text: 'q1' }]));
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd });
    const run = await svc.startRun({
      sessionId: s.id,
      budget: { tokens: 12 },
      script: `${meta('budget-resume')}const out = []\nlet error = null\ntry { for (let i = 0; i < 6; i++) out.push(await agent((i === 1 ? 'slow-budget ' : 'say ') + 'q' + i)) } catch (e) { error = e.message }\nreturn { n: out.length, error }`,
    });
    expect(await until(() => svc.live.get(run.id)?.calls.get(2)?.state === 'running', 10_000)).toBe(true);
    svc.live.get(run.id)!.stop('interrupted');
    const stopped = await svc.wait(run.id);
    expect(stopped.status).toBe('interrupted');
    slow = false;
    await svc.resume(run.id, { auto: true });
    expect(await until(() => !svc.live.has(run.id) && ['done', 'budget'].includes(svc.store.getRun(run.id)!.status), 15_000)).toBe(true);
    const done = svc.store.getRun(run.id)!;
    // q0 (5 tokens, first attempt) + q1 + q2 reach 15 of 12: q3 throws, as without the restart
    expect(done.result).toMatchObject({ n: 3 });
    expect(done.status).toBe('budget');
  } finally {
    answers.delete('slow-budget');
  }
});

test('a call the owner skipped stays skipped when the run resumes', async () => {
  let slow = true;
  // replies held by hand until the test ends: no wall-clock delay to lose under load
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  answers.set('skip-me', () => ({ blocks: [{ text: 'skipped one' }], gate }));
  answers.set('block-c', () => (slow ? { blocks: [{ text: 'c' }], gate } : [{ text: 'c' }]));
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd });
    // resolves when call `seq` of the run reaches `state`: listen first, then check, so no change is missed
    const reached = (runId: string, seq: number, state: string) =>
      new Promise<void>((resolve) => {
        const off = t.engine.bus.on((e: { type: string; runId?: string; call?: { seq: number; state: string } }) => {
          if (e.type === 'workflow.agent' && e.runId === runId && e.call?.seq === seq && e.call.state === state) {
            off();
            resolve();
          }
        });
        if (svc.live.get(runId)?.calls.get(seq)?.state === state) {
          off();
          resolve();
        }
      });
    const run = await svc.startRun({ sessionId: s.id, script: `${meta('skip-resume')}const a = await agent('say s1')\nconst b = await agent('skip-me')\nconst c = await agent('block-c')\nreturn [a, b, c]` });
    await reached(run.id, 2, 'running');
    const third = reached(run.id, 3, 'running');
    svc.skip(run.id, 2);
    await third;
    svc.live.get(run.id)!.stop('interrupted');
    await svc.wait(run.id);
    slow = false;
    const before = t.requests.length;
    await svc.resume(run.id, { auto: true });
    expect((await svc.wait(run.id)).status).toBe('done');
    expect(svc.store.getRun(run.id)!.result).toEqual(['s1', null, 'c']);
    expect(t.requests.slice(before).filter((x) => x.includes('skip-me')).length).toBe(0);
    expect(svc.store.calls(run.id).map((c) => c.state)).toEqual(['cached', 'skipped', 'done']);
  } finally {
    release();
    answers.delete('skip-me');
    answers.delete('block-c');
  }
}, 20_000);

test('args over 1 MB of JSON are refused before the run starts', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const before = svc.runs({ limit: 500 }).length;
  await expect(svc.startRun({ sessionId: s.id, script: `${meta('big-args')}return args.length`, args: 'x'.repeat(1_200_000) })).rejects.toThrow('args are larger than 1 MB');
  expect(svc.runs({ limit: 500 }).length).toBe(before);
});

test('resuming or rerunning a run does not record its findings twice', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: t.cwd });
  const run = await svc.wait(
    (await svc.startRun({ sessionId: s.id, script: `${meta('finding-twice')}const a = await agent('say one')\nreturn { findings: [{ title: 'off by one ' + a, file: 'a.ts', line: 3 }, { title: 'missing await', file: 'b.ts', line: 9 }] }` })).id,
  );
  expect(svc.store.findings(run.id).length).toBe(2);
  const first = svc.store.findings(run.id)[0];
  svc.judgeFinding(run.id, first.id, 'dismissed', 'not a bug');
  await svc.resume(run.id);
  expect(await until(() => !svc.live.has(run.id) && svc.store.getRun(run.id)!.status === 'done', 10_000)).toBe(true);
  await svc.rerun(run.id, 1);
  expect(await until(() => !svc.live.has(run.id) && svc.store.getRun(run.id)!.status === 'done', 10_000)).toBe(true);
  const after = svc.store.findings(run.id);
  expect(after.length).toBe(2);
  // the verdict the owner gave stays on the finding
  expect(after.find((f) => f.id === first.id)?.verdict).toBe('dismissed');
});

test('a run folder given with ~ is resolved on the device, so citations and worktrees find it', async () => {
  const { homedir } = await import('node:os');
  const { mkdtempSync } = await import('node:fs');
  const home = homedir();
  // a folder under the device's home, named with ~
  const dir = mkdtempSync(join(home, '.conclave-wfqa-tilde-'));
  try {
    writeFileSync(join(dir, 'x.ts'), 'const a = 1;\nconst b = 2;\n');
    const tilde = `~/${dir.slice(home.length + 1)}`;
    const svc = svcOf(t.engine);
    const run = await svc.wait((await svc.startRun({ cwd: tilde, script: `${meta('tilde', ", runtime: 'conclave'")}return await lib.checkCitation({ file: 'x.ts', line: 2, quote: 'const b = 2;' })` })).id);
    expect(run.cwd).toBe(dir);
    expect(run.result).toMatchObject({ ok: true });
  } finally {
    cleanup(dir);
  }
});
