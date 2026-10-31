/**
 * The default workflow library: every script loads and compiles in the
 * sandbox, and review-changes and deep-research run end to end against
 * scripted agents (finders, refuters, a tester in a worktree, searchers,
 * fact-checkers, a writer). No paid calls.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, lastToolResult, svcOf, workingDir, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';
import { DEFAULT_WORKFLOWS } from '../../src/workflows/defaults';
import { loadMeta } from '../../src/workflows/registry';
import { Sandbox } from '../../src/workflows/sandbox';
import { preludeSource } from '../../src/workflows/prelude';

let t: TestEngine;
const answers: Array<[string, (body: RequestBody) => Step | number | undefined]> = [];
const so = (input: Record<string, unknown>) => (body: RequestBody): Step => (afterToolResult(body) ? [{ text: 'done' }] : [{ tool: 'StructuredOutput', input }]);

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      for (const [word, fn] of answers) if (first.includes(word)) return fn(body);
      return undefined;
    },
    approve: 'allow',
    overrides: { limits: { maxRetries: 0 } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

test('all fourteen default workflows load, are Conclave scripts, and compile in the sandbox', async () => {
  expect(DEFAULT_WORKFLOWS.map((d) => d.file.replace(/\.js$/, ''))).toEqual([
    'review-changes',
    'deep-research',
    'research-sweep',
    'plan-implement-verify',
    'fix-until-green',
    'fix-issue',
    'bug-hunt',
    'security-audit',
    'design-panel',
    'ui-pass',
    'migrate',
    'compare-harnesses',
    'race',
    'web-studio',
  ]);
  for (const d of DEFAULT_WORKFLOWS) {
    const { meta, body } = await loadMeta(d.script);
    expect(meta.name).toBe(d.file.replace(/\.js$/, ''));
    expect(meta.runtime).toBe('conclave');
    expect(meta.phases?.length).toBeGreaterThan(2);
    // the body as a function expression: parsed and compiled, not run
    const sb = await Sandbox.create({ sync: {}, async: {} });
    try {
      sb.evalGlobal(preludeSource({ argsJson: 'undefined', nested: false }), 'prelude.js');
      expect(() => sb.evalGlobal(body.replace(/\(\)$/, ''), d.file)).not.toThrow();
    } finally {
      sb.dispose();
    }
    // the owner's writing rules hold for the prompts too
    expect(d.script).not.toMatch(/[–—]/);
  }
  const library = await svcOf(t.engine).library();
  expect(library.filter((w) => w.source === 'builtin').length).toBe(14);
  expect(library.every((w) => w.runnable)).toBe(true);
});

test('review-changes finds, cites, refutes and proves a bug in an uncommitted change', async () => {
  const repo = tempDir('conclave-wf-review-');
  const home = tempDir('conclave-wf-rhome-');
  try {
    const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
    git('init -q -b main');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export function last(xs: number[]) {\n  return xs[xs.length - 1];\n}\n');
    git('add -A');
    git('commit -q -m init');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export function last(xs: number[]) {\n  return xs[xs.length];\n}\n');
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.set('local', home);

    const finding = { file: 'src/a.ts', line: 2, quote: 'return xs[xs.length];', title: 'last() reads one past the end', class: 'off-by-one', scenario: 'last([1, 2]) returns undefined', priority: 'P1', introducedByChange: true };
    answers.push(['finder mode', so({ findings: [finding, { ...finding, line: 40, quote: 'not in the file at all', title: 'a made up line', class: 'invented' }], read: ['src/a.ts'], notReached: [] })]);
    answers.push(['Try to prove this finding wrong', so({ verdict: 'confirmed', severity: 'P1', evidence: ['src/a.ts:2'], note: 'xs[xs.length] is always undefined' })]);
    answers.push([
      'Write one test that fails on the current code',
      (body) => {
        const res = lastToolResult(body);
        if (!afterToolResult(body)) return [{ tool: 'Write', input: { file_path: join(workingDir(body)!, 'test', 'last.test.ts'), content: 'expect(last([1, 2])).toBe(2)\n' } }];
        if (res.includes('Recorded')) return [{ text: 'done' }];
        return [{ tool: 'StructuredOutput', input: { testFile: 'test/last.test.ts', command: 'grep -q this-never-matches test/last.test.ts' } }];
      },
    ]);
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const run = await svc.wait((await svc.startRun({ name: 'review-changes', sessionId: s.id })).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    const r = run.result as { verdict: string; findings: Array<{ file: string; line: number; proven: boolean; priority: string; confidence: string }>; dropped: Record<string, number>; report: string };
    expect(r.verdict).toBe('changes needed');
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]).toMatchObject({ file: 'src/a.ts', line: 2, proven: true, priority: 'P1', confidence: 'high' });
    // the invented line failed the citation check before any refuter saw it
    expect(r.dropped.citation).toBe(1);
    expect(r.report).toContain('Proven by a failing test');
    const calls = svc.store.calls(run.id);
    expect(calls.filter((c) => c.label?.startsWith('find ')).length).toBe(10);
    expect(calls.filter((c) => c.label?.startsWith('verify ')).length).toBe(3);
    const prove = calls.find((c) => c.label?.startsWith('prove '))!;
    expect(prove.worktreeState).toBe('kept');
    // the result's findings are recorded for verdicts
    expect(svc.store.findings(run.id).map((f) => f.file)).toEqual(['src/a.ts']);
    // nothing ran in the owner's tree
    expect(git('status --porcelain').stdout.toString().trim()).toBe('M src/a.ts');
  } finally {
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.delete('local');
    answers.length = 0;
    cleanup(repo, home);
  }
});

test('bug-hunt keeps a findings ledger: round 2 does not report what round 1 rejected or the owner marked fixed, unless it regressed', async () => {
  const repo = tempDir('conclave-wf-ledger-');
  try {
    const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
    git('init -q -b main');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export function last(xs: number[]) {\n  return xs[xs.length];\n}\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    git('add -A');
    git('commit -q -m init');
    const bugA = { file: 'src/a.ts', line: 2, quote: 'return xs[xs.length];', title: 'last() reads one past the end', class: 'off-by-one', scenario: 'last([1, 2])', priority: 'P2' };
    const bugB = { file: 'src/b.ts', line: 1, quote: 'export const add = (a: number, b: number) => a + b;', title: 'add() may overflow', class: 'overflow', scenario: 'add(MAX, 1)', priority: 'P3' };
    let regressed = false;
    answers.push(['Find real bugs in this code from one angle', (body) => so({ findings: [regressed ? { ...bugA, regressed: true } : bugA, bugB], read: ['src/a.ts', 'src/b.ts'] })(body)]);
    answers.push(['Try to prove this finding wrong', (body) => (firstUserText(body).includes('src/a.ts') ? so({ verdict: 'confirmed', severity: 'P2', evidence: ['src/a.ts:2'], note: 'real' }) : so({ verdict: 'refuted', evidence: ['src/b.ts:1'], note: 'numbers do not overflow here' }))(body)]);
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const hunt = async () => svc.wait((await svc.startRun({ name: 'bug-hunt', sessionId: s.id, args: { maxRounds: 2 } })).id);
    const ledgerOf = () => svc.store.ledger('local', repo);
    type Result = { findings: Array<{ file: string }> };

    const r1 = await hunt();
    expect(r1.error).toBeUndefined();
    expect((r1.result as Result).findings.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(r1.device).toBe('local');
    expect(ledgerOf().map((e) => [e.finding, e.verdict, e.severity, e.round]).sort()).toEqual([
      ['src/a.ts: last() reads one past the end', 'open', 'medium', 1],
      ['src/b.ts: add() may overflow', 'rejected', 'low', 1],
    ]);

    // the owner's fix lands; a script marks it fixed
    const mark = await svc.wait((await svc.startRun({ sessionId: s.id, script: `export const meta = { name: 'mark-fixed', description: 'x', runtime: 'conclave' }
return await lib.ledger.write('.', [{ finding: 'src/a.ts: last() reads one past the end', severity: 'medium', verdict: 'fixed', round: 1, evidence: 'https://example.test/pr/1' }])` })).id);
    expect(mark.error).toBeUndefined();

    const before = t.requests.length;
    const r2 = await hunt();
    expect(r2.error).toBeUndefined();
    expect((r2.result as Result).findings).toEqual([]);
    // nothing went to the refuters, and every finder read the ledger
    expect(svc.store.calls(r2.id).filter((c) => c.label?.startsWith('verify ')).length).toBe(0);
    const finders = t.requests.slice(before).filter((x) => x.includes('Find real bugs in this code from one angle'));
    expect(finders.length).toBeGreaterThan(0);
    expect(finders.every((x) => x.includes('<untrusted-ledger>') && x.includes('[fixed] medium r1') && x.includes('[rejected] low r1'))).toBe(true);
    expect(svc.store.logs(r2.id).some((l) => l.text.includes('ledger: dropped 2 findings marked fixed, rejected or wontfix'))).toBe(true);
    expect(ledgerOf().find((e) => e.finding.startsWith('src/a.ts'))).toMatchObject({ verdict: 'fixed', round: 1, evidence: 'https://example.test/pr/1' });

    // a finder whose evidence shows the fixed bug came back reports it again; the rejected one stays out
    regressed = true;
    const r3 = await hunt();
    expect((r3.result as Result).findings.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(ledgerOf().find((e) => e.finding.startsWith('src/a.ts'))).toMatchObject({ verdict: 'open', round: 2 });
    expect(ledgerOf().find((e) => e.finding.startsWith('src/b.ts'))).toMatchObject({ verdict: 'rejected', round: 1 });
  } finally {
    answers.length = 0;
    cleanup(repo);
  }
});

test('race checks each racer, judges the passing ones, and keeps the winner only when the owner asks', async () => {
  const repo = tempDir('conclave-wf-race-');
  const home = tempDir('conclave-wf-racehome-');
  try {
    const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
    git('init -q -b main');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add -A');
    git('commit -q -m init');
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.set('local', home);
    // racer 1 and 2 write an answer (the check passes), racer 3 writes the wrong file (it fails)
    const order = new Map<string, number>();
    answers.push([
      'Do this task in the repository',
      (body) => {
        const cwd = workingDir(body)!;
        if (!order.has(cwd)) order.set(cwd, order.size + 1);
        if (afterToolResult(body)) return [{ text: 'done' }];
        const i = order.get(cwd)!;
        return [{ tool: 'Write', input: { file_path: join(cwd, i === 3 ? 'wrong.txt' : 'answer.txt'), content: i === 1 ? 'short answer\n' : 'long winded answer\n' } }];
      },
    ]);
    // the judges prefer the short answer in either order
    answers.push([
      'Score each candidate',
      (body) => {
        const text = firstUserText(body);
        const best = text.indexOf('short answer') < text.indexOf('long winded') ? 'A' : 'B';
        const other = best === 'A' ? 'B' : 'A';
        return so({ scores: [{ id: best, score: 9, reason: 'Smallest change that does the task.' }, { id: other, score: 5, reason: 'Wordy.' }], best })(body);
      },
    ]);
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const run = await svc.wait((await svc.startRun({ name: 'race', sessionId: s.id, args: { task: 'write answer.txt', check: 'test -f answer.txt' } })).id);
    expect(run.error).toBeUndefined();
    const r = run.result as { race: { winner: number; reasons: string[]; arms: Array<{ seq: number; passed: boolean }> } };
    const winner = svc.store.getCall(run.id, r.race.winner)!;
    expect(git(`show ${winner.worktreeBranch}:answer.txt`).stdout.toString()).toBe('short answer\n');
    expect(r.race.reasons).toContain('Smallest change that does the task.');
    expect(r.race.arms.filter((a) => a.passed).length).toBe(2);
    // nothing merged and every branch kept until the owner chooses
    expect(Bun.file(join(repo, 'answer.txt')).size).toBe(0);
    const racers = r.race.arms.map((a) => a.seq);
    expect(racers.every((q) => svc.store.getCall(run.id, q)?.worktreeState === 'kept')).toBe(true);

    await expect(svc.keepWinner(run.id, 'pr')).rejects.toThrow(/repo session/);
    const kept = await svc.keepWinner(run.id, 'apply');
    expect(kept).toMatchObject({ ok: true, discarded: 2 });
    expect(await Bun.file(join(repo, 'answer.txt')).text()).toBe('short answer\n');
    expect(svc.store.getCall(run.id, r.race.winner)?.worktreeState).toBe('merged');
    for (const q of racers.filter((q) => q !== r.race.winner)) {
      expect(svc.store.getCall(run.id, q)?.worktreeState).toBe('discarded');
      expect(git(`rev-parse --verify --quiet conclave/wf/${run.id}/${q}`).exitCode).not.toBe(0);
    }
  } finally {
    (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.delete('local');
    answers.length = 0;
    cleanup(repo, home);
  }
});

test('deep-research frames, searches, checks each claim twice, and writes from verified claims only', async () => {
  answers.push(['Plan research for this question', so({ kind: 'comparison', subQuestions: [{ q: 'Caddy memory use', angle: 'official docs and release notes' }, { q: 'Traefik memory use', angle: 'community reports' }], ownerContext: '' })]);
  answers.push([
    'Answer one research sub-question',
    (body) => {
      const caddy = firstUserText(body).includes('Caddy memory');
      return so({
        claims: [
          caddy ? { claim: 'Caddy idles at about 20 MB', url: 'https://caddy.example/docs/memory', quote: 'idles at about 20 MB', date: '2026-09-01', primary: true, opened: true } : { claim: 'Traefik idles at about 60 MB', url: 'https://forum.example/traefik', quote: 'about 60 MB idle', date: '2026-05-02', primary: false, opened: true },
          { claim: 'A snippet-only claim', url: 'https://snippet.example', quote: 'x', opened: false },
          ...(caddy ? [{ claim: 'Caddy needs 2 GB of memory', url: 'https://blog.example/caddy', quote: 'needs 2 GB', date: '2019-01-01', primary: false, opened: true }] : []),
        ],
        missing: [],
      })(body);
    },
  ]);
  answers.push(['Check one claim against its source', (body) => (firstUserText(body).includes('2 GB') ? so({ verdict: 'not supported', reason: 'the page says 20 MB' })(body) : so({ verdict: 'supported', quote: 'match', reason: 'the page says so' })(body))]);
  answers.push(['Write the research report', () => [{ text: 'Use Caddy. It idles at about 20 MB [1].' }]]);
  answers.push(['list what is missing', so({ missingAngles: [], singleSource: [] })]);
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd });
    const run = await svc.wait((await svc.startRun({ name: 'deep-research', sessionId: s.id, args: { question: 'Caddy or Traefik?', depth: 'normal' } })).id);
    expect(run.error).toBeUndefined();
    const r = run.result as { report: string; verified: number; sources: string[]; leads: string[]; memoryCandidates: unknown[]; rejected: Array<{ claim: string }> };
    expect(r.report).toContain('Use Caddy');
    expect(r.verified).toBe(2);
    expect(r.sources.length).toBe(2);
    expect(r.leads).toContain('A snippet-only claim');
    expect(r.memoryCandidates.length).toBe(1);
    expect(r.rejected.map((x) => x.claim)).toEqual(['Caddy needs 2 GB of memory']);
    const calls = svc.store.calls(run.id);
    expect(calls.filter((c) => c.label?.startsWith('check ')).length).toBe(6);
    // the fact-checkers saw the claim and its URL, never the draft
    const checkPrompts = t.requests.filter((x) => x.includes('Check one claim against its source'));
    expect(checkPrompts.length).toBeGreaterThan(0);
    expect(checkPrompts.some((x) => x.includes('Use Caddy.'))).toBe(false);
  } finally {
    answers.length = 0;
  }
});
