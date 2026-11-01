/**
 * Adversarial checks of the default workflows (QA of section 3.10 and
 * 3.15): args that reach a shell command, and proofs that prove nothing (a
 * test command that does not exist, a test file that is not on the branch,
 * a fix that edits the reproduction test). Scripted agents only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, lastToolResult, svcOf, workingDir, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';

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

/** A repository with one commit and an uncommitted off-by-one in src/a.ts. */
function makeRepo(): { repo: string; home: string; git: (cmd: string) => ReturnType<typeof Bun.spawnSync> } {
  const repo = tempDir('conclave-wfqa-repo-');
  const home = tempDir('conclave-wfqa-home-');
  const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
  git('init -q -b main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function last(xs: number[]) {\n  return xs[xs.length - 1];\n}\n');
  writeFileSync(join(repo, 'src', 'lib.txt'), 'BAD\n');
  git('add -A');
  git('commit -q -m init');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function last(xs: number[]) {\n  return xs[xs.length];\n}\n');
  (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.set('local', home);
  return { repo, home, git };
}

function done(repo: string, home: string): void {
  (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.delete('local');
  answers.length = 0;
  cleanup(repo, home);
}

const FINDING = { file: 'src/a.ts', line: 2, quote: 'return xs[xs.length];', title: 'last() reads one past the end', class: 'off-by-one', scenario: 'last([1, 2]) returns undefined', priority: 'P1', introducedByChange: true };

test('review-changes refuses a base that is not a ref name, so it never reaches the shell', async () => {
  const { repo, home } = makeRepo();
  try {
    const svc = svcOf(t.engine);
    // bypass: the permission check would not stop an injected command here
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'bypass' });
    const run = await svc.wait((await svc.startRun({ name: 'review-changes', sessionId: s.id, args: { base: 'HEAD;touch PWNED' } })).id);
    expect(existsSync(join(repo, 'PWNED'))).toBe(false);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('args.base must be a branch, tag or commit');
  } finally {
    done(repo, home);
  }
});

test('bug-hunt quotes args.path as one shell word', async () => {
  const { repo, home } = makeRepo();
  answers.push(['Find real bugs in this code', so({ findings: [], read: [], notReached: [] })]);
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'bypass' });
    const run = await svc.wait((await svc.startRun({ name: 'bug-hunt', sessionId: s.id, args: { path: '$(touch PWNED2)', maxRounds: 2 } })).id);
    expect(existsSync(join(repo, 'PWNED2'))).toBe(false);
    expect(run.status).toBe('done');
    // in the default mode, its scoping commands are read-only and never ask
    const before = t.approvals.length;
    const s2 = await t.engine.createSession({ cwd: repo });
    const run2 = await svc.wait((await svc.startRun({ name: 'bug-hunt', sessionId: s2.id, args: { path: 'src', maxRounds: 2 } })).id);
    expect(run2.status).toBe('done');
    expect(t.approvals.slice(before).filter((a) => a.includes('lib.exec'))).toEqual([]);
  } finally {
    done(repo, home);
  }
});

/** review-changes with one real finding, a confirming panel and a scripted tester. */
async function reviewWithTester(tester: (body: RequestBody) => Step): Promise<{ findings: Array<{ proven: boolean }>; report: string; logs: string[] }> {
  const { repo, home } = makeRepo();
  answers.push(['finder mode', so({ findings: [FINDING], read: ['src/a.ts'], notReached: [] })]);
  answers.push(['Try to prove this finding wrong', so({ verdict: 'confirmed', severity: 'P1', evidence: ['src/a.ts:2'], note: 'xs[xs.length] is always undefined' })]);
  answers.push(['Write one test that fails on the current code', tester]);
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const run = await svc.wait((await svc.startRun({ name: 'review-changes', sessionId: s.id })).id);
    expect(run.status).toBe('done');
    const r = run.result as { findings: Array<{ proven: boolean }>; report: string };
    return { ...r, logs: svc.store.logs(run.id).map((l) => l.text) };
  } finally {
    done(repo, home);
  }
}

test('review-changes does not count a test command that does not exist as a proof', async () => {
  const r = await reviewWithTester((body) => {
    if (!afterToolResult(body)) return [{ tool: 'Write', input: { file_path: join(workingDir(body)!, 'test', 'last.test.ts'), content: 'expect(last([1, 2])).toBe(2)\n' } }];
    if (lastToolResult(body).includes('Recorded')) return [{ text: 'done' }];
    return [{ tool: 'StructuredOutput', input: { testFile: 'test/last.test.ts', command: 'definitely-not-a-test-runner-qa test/last.test.ts' } }];
  });
  expect(r.findings.length).toBe(1);
  expect(r.findings[0].proven).toBe(false);
  expect(r.report).not.toContain('Proven by a failing test');
  expect(r.logs.some((l) => l.includes('Not proven') && l.includes('did not start'))).toBe(true);
});

test('review-changes does not count a failing command when the named test file is not on the branch', async () => {
  const r = await reviewWithTester((body) => {
    // a test file, but not the one it names
    if (!afterToolResult(body)) return [{ tool: 'Write', input: { file_path: join(workingDir(body)!, 'test', 'other.test.ts'), content: 'test("x", () => {})\n' } }];
    if (lastToolResult(body).includes('Recorded')) return [{ text: 'done' }];
    return [{ tool: 'StructuredOutput', input: { testFile: 'test/last.test.ts', command: 'false' } }];
  });
  expect(r.findings[0].proven).toBe(false);
  expect(r.logs.some((l) => l.includes('not on the branch'))).toBe(true);
});

test('fix-issue does not accept a fix that edits the reproduction test', async () => {
  const { repo, home } = makeRepo();
  answers.push(['Localize a bug', () => [{ text: 'src/lib.txt:1 holds BAD' }]]);
  answers.push([
    'Write one test that reproduces this bug',
    (body) => {
      if (!afterToolResult(body)) return [{ tool: 'Write', input: { file_path: join(workingDir(body)!, 'test', 'repro.sh'), content: 'grep -q GOOD src/lib.txt\n' } }];
      if (lastToolResult(body).includes('Recorded')) return [{ text: 'done' }];
      return [{ tool: 'StructuredOutput', input: { testFile: 'test/repro.sh', command: 'bash test/repro.sh' } }];
    },
  ]);
  answers.push([
    'Your angle: the smallest change',
    // the builder makes the reproduction pass by rewriting it
    (body) => (afterToolResult(body) ? [{ text: 'fixed' }] : [{ tool: 'Bash', input: { command: "printf 'exit 0\\n' > test/repro.sh" } }]),
  ]);
  answers.push(['Fix this bug', () => [{ text: 'I could not find a fix' }]]);
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const run = await svc.wait((await svc.startRun({ name: 'fix-issue', sessionId: s.id, args: { issue: 'lib.txt says BAD', check: 'true' } })).id);
    expect(run.status).toBe('done');
    const r = run.result as { fixed: boolean; tried?: Array<{ tampered?: boolean }> };
    expect(r.fixed).toBe(false);
    expect(r.tried?.some((x) => x.tampered)).toBe(true);
  } finally {
    done(repo, home);
  }
});

test('security-audit applies the hard exclusions in code, before the panel spends votes', async () => {
  const repo = tempDir('conclave-wfqa-sec-');
  const home = tempDir('conclave-wfqa-shome-');
  const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
  git('init -q -b main');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'src', 'x.ts'), "const cmd = req.query.cmd;\nexec(cmd);\nwhile (true) {}\n");
  writeFileSync(join(repo, 'test', 'a.test.ts'), "exec('ls');\n");
  git('add -A');
  git('commit -q -m init');
  (t.engine as unknown as { homeCache: Map<string, string> }).homeCache.set('local', home);
  const real = { file: 'src/x.ts', line: 2, quote: 'exec(cmd);', title: 'command injection from the query string', class: 'injection', scenario: 'GET /?cmd=rm reaches exec', priority: 'P0' };
  const inTest = { file: 'test/a.test.ts', line: 1, quote: "exec('ls');", title: 'command execution in a test helper', class: 'command-exec', scenario: 'a test runs ls', priority: 'P2' };
  const dos = { file: 'src/x.ts', line: 3, quote: 'while (true) {}', title: 'denial of service by resource exhaustion', class: 'dos', scenario: 'any request spins', priority: 'P2' };
  answers.push(['Partition this repository', so({ components: [{ name: 'src', paths: ['src'] }], skipped: [{ path: 'test', reason: 'tests' }] })]);
  answers.push(['Write a short threat model', () => [{ text: 'src reads req.query and runs commands' }]]);
  answers.push(['Find security bugs in one component', so({ findings: [real, inTest, dos], read: ['src/x.ts', 'test/a.test.ts'], notReached: [] })]);
  answers.push(['Sweep source files', so({ findings: [] })]);
  answers.push(['Try to prove this finding wrong', so({ verdict: 'confirmed', severity: 'P1', evidence: ['src/x.ts:2'], note: 'reachable' })]);
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo });
    const run = await svc.wait((await svc.startRun({ name: 'security-audit', sessionId: s.id })).id);
    expect(run.status).toBe('done');
    const r = run.result as { findings: Array<{ file: string; line: number }>; report: string };
    expect(r.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['src/x.ts:2']);
    // only the real finding went to the panel
    expect(svc.store.calls(run.id).filter((c) => c.label?.startsWith('verify ')).length).toBe(3);
    expect(svc.store.logs(run.id).some((l) => l.text.includes('hard exclusions'))).toBe(true);
    // its inventory commands are read-only, so a run in the default mode never asks for them
    expect(t.approvals.filter((a) => a.includes('security-audit / lib.exec'))).toEqual([]);
  } finally {
    done(repo, home);
  }
});

test('research-sweep scopes the repository with read-only commands that never ask', async () => {
  const { repo, home } = makeRepo();
  answers.push(['Name the 2 to 4 types', so({ entities: ['last'] })]);
  answers.push(['Explore the code to answer part of a question', so({ entries: [{ file: 'src/a.ts', line: 1, what: 'last()' }], summary: 'one file', read: ['src/a.ts'], notReached: [] })]);
  answers.push(['Merge these code maps', () => [{ text: 'src/a.ts:1 holds last()' }]]);
  answers.push(['List the areas of the code a design', so({ unread: [] })]);
  try {
    const before = t.approvals.length;
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo });
    const run = await svc.wait((await svc.startRun({ name: 'research-sweep', sessionId: s.id, args: { question: 'how does last() work?' } })).id);
    expect(run.status).toBe('done');
    expect(t.approvals.slice(before).filter((a) => a.includes('lib.exec'))).toEqual([]);
    // the areas came from the file list: src is one of them
    expect(svc.store.calls(run.id).some((c) => c.label === 'area src')).toBe(true);
  } finally {
    done(repo, home);
  }
});
