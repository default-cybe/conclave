/**
 * The web-studio library workflow against scripted agents and a stubbed
 * capture (no browser, no paid calls): the approve and ask gates, the pass
 * bar computed in code (average 8, nothing under 7, at most 3 rounds), round
 * B only after a clean round A, and the ledger read before the judges and
 * written after them.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, svcOf, noHarnesses } from './helpers';
import { tempDir, cleanup } from '../extensions/_helpers';
import * as captureModule from '../../src/browser/capture';

let t: TestEngine;
const answers: Array<[string, (body: RequestBody) => Step | number | undefined]> = [];
const so = (input: Record<string, unknown>) => (body: RequestBody): Step => (afterToolResult(body) ? [{ text: 'done' }] : [{ tool: 'StructuredOutput', input }]);
const done = (): Step => [{ text: 'done' }];
const RUBRIC = ['First glance', 'Signature', 'Typography', 'Composition', 'Colour', 'Media', 'Motion', 'Mobile', 'Copy', 'Polish'];
const scores = (list: number[]) => ({ scores: RUBRIC.map((area, i) => ({ area, score: list[i], why: area + ' reads ' + list[i], fix: 'set ' + area + ' to a value' })) });
let captures = 0;
let pickOption = 'Option 1';
let offAsk: () => void = () => {};

const fakeCapture = async (_b: unknown, _h: string, _o: string, url: string): Promise<captureModule.CaptureResult> => {
  captures++;
  const dir = '/tmp/web-studio-cap-' + captures;
  return {
    url,
    dir,
    skipped: [],
    results: [{ browser: 'chromium', ran: 'chromium', executable: 'chromium', shots: [{ width: 390, theme: 'light', png: dir + '/390-light.png', early: dir + '/390-light-early.png' }], sheets: { 390: [dir + '/sheet-390.png'] }, frames: {}, report: dir + '/report.json', summary: { consoleErrors: 0, failedRequests: 0, overflow: { 390: 0 }, fonts: 2, cls: {}, lcpMs: {}, axe: [] } }],
  };
};

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
  spyOn(captureModule, 'hubCapture').mockImplementation(fakeCapture as never);
  // the owner answers the prototype question with the option named in pickOption
  const engine = t.engine as unknown as { bus: { on: (fn: (e: { type: string; question?: { id: string; questions: Array<{ question: string; options: Array<{ label: string }> }> } }) => void) => () => void }; answerQuestion: (id: string, a: Record<string, string>) => boolean };
  offAsk = engine.bus.on((e) => {
    if (e.type !== 'question.asked' || !e.question) return;
    const q = e.question.questions[0];
    const label = q.options.find((o) => o.label.startsWith(pickOption))?.label ?? q.options[0].label;
    queueMicrotask(() => engine.answerQuestion(e.question!.id, { [q.question]: label }));
  });
});
afterAll(async () => {
  offAsk();
  (captureModule.hubCapture as unknown as { mockRestore?: () => void }).mockRestore?.();
  await t?.close();
});

function project() {
  const repo = tempDir('conclave-wf-studio-');
  const git = (cmd: string) => Bun.spawnSync(['bash', '-c', `git -c user.name=t -c user.email=t@t ${cmd}`], { cwd: repo });
  git('init -q -b main');
  mkdirSync(join(repo, 'research'));
  writeFileSync(join(repo, 'research', 'STYLE.md'), 'STYLE-MARKER accent oklch(0.62 0.19 35)\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'site', scripts: { typecheck: 'true', test: 'echo "Error: no test specified" && exit 1' } }));
  writeFileSync(join(repo, 'bun.lock'), '');
  writeFileSync(join(repo, 'index.html'), '<h1>hi</h1>\n');
  git('add -A');
  git('commit -q -m init');
  return repo;
}

/** The scripted agents; judge and lens answers come from the arguments. */
function script(opts: { judge: number[][]; roundA: Array<Record<string, unknown>>; roundB?: Array<Record<string, unknown>> }) {
  let judged = 0;
  answers.push(['Write the design read', so({ read: 'Reading this as: a portfolio for hiring managers, with a calm precise language', dials: { variance: 6, motion: 5, density: 4 }, signature: 'an ASCII koi that follows the pointer', supports: ['mono type'] })]);
  answers.push(['Find references for one lane', so({ sources: [{ url: 'https://ref.example/a', technique: 'a 12 column grid' }] })]);
  answers.push(['Write the spec for this site', so({ summary: 'One page, four sections.', modules: [{ name: 'koi', does: 'the ASCII koi', signature: true }, { name: 'work', does: 'the project list' }] })]);
  answers.push(['Build one prototype of the signature idea', so({ page: 'index.html', screenshots: ['/tmp/proto.png'] })]);
  answers.push(['Rank these prototypes', so({ ranking: [{ option: 2, score: 9, reason: 'most memorable' }, { option: 1, score: 7, reason: 'quiet' }, { option: 3, score: 5, reason: 'busy' }] })]);
  answers.push(['Build one module of the site', done]);
  answers.push(['Assemble the site from its modules', done]);
  answers.push(['Start this project so a browser can open it', so({ url: 'http://127.0.0.1:5173/', stop: 'kill 4242' })]);
  answers.push(['Score this site on the 10-point rubric', (body) => {
    if (afterToolResult(body)) return done();
    const list = opts.judge[Math.min(judged, opts.judge.length - 1)];
    judged++;
    return so(scores(list))(body);
  }]);
  answers.push(['Raise the 3 weakest rubric areas', done]);
  answers.push(['Review this site through one lens', (body) => {
    const text = firstUserText(body);
    const isB = /Your lens: (break-it|a persona|owner proxy)/.test(text);
    const lens = /Your lens: (\S+)/.exec(text)?.[1] ?? '';
    const list = isB ? (opts.roundB ?? []) : opts.roundA;
    return so({ findings: list.filter((f) => !f.lens || String(f.lens) === lens).map(({ lens: _l, ...f }) => f) })(body);
  }]);
}

test('web-studio: approve and pick gates, the pass bar in code, round B after a clean round A, the ledger read first and written last', async () => {
  const repo = project();
  try {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    // an earlier round rejected one idea
    const seed = await svc.wait((await svc.startRun({ sessionId: s.id, script: `export const meta = { name: 'seed', description: 'x', runtime: 'conclave' }
return await lib.ledger.write('.', [{ finding: 'Hero needs a gradient', severity: 'low', verdict: 'rejected', round: 1 }])` })).id);
    expect(seed.error).toBeUndefined();

    // round 1: average 8.7 but Mobile at 6, so it fails on the minimum; round 2: average exactly 8, lowest 7, so it passes
    script({
      judge: [[9, 9, 9, 9, 9, 9, 9, 6, 9, 9], [7, 7, 8, 8, 8, 8, 8, 8, 9, 9]],
      roundA: [{ title: 'Hero needs a gradient', severity: 'medium', evidence: '/tmp/x.png', lens: 'design:' }, { title: 'Footer link lacks a new tab hint', severity: 'low', evidence: 'footer a', lens: 'accessibility:' }],
      roundB: [{ title: 'Koi freezes after a fast resize', severity: 'medium', evidence: 'resize to 390 and back' }],
    });
    pickOption = 'Option 1';
    const before = t.requests.length;
    const approvalsBefore = t.approvals.length;
    const run = await svc.wait((await svc.startRun({ name: 'web-studio', sessionId: s.id, args: { brief: 'A portfolio for a security engineer.', dir: repo, references: ['https://owner.example/ref'] } })).id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('done');
    type R = { passed: boolean; picked: { option: number }; url: string; stopServer: string; look: { passed: boolean; rounds: Array<{ avg: number; min: number; passed: boolean; weakest: Array<{ area: string }> }> }; checks: Array<{ command: string; ok: boolean; tail: string }>; validation: { roundA: Array<{ title: string }>; cleanA: boolean; roundB: Array<{ title: string }> | null }; ledgerRound: number };
    const r = run.result as R;

    // the spec was approved before any prototype or module ran
    expect(t.approvals.slice(approvalsBefore).some((a) => a.includes('approve the plan') && a.includes('Modules:'))).toBe(true);
    const calls = svc.store.calls(run.id);
    const seqOf = (p: (l: string) => boolean) => calls.filter((c) => c.label && p(c.label)).map((c) => c.seq);
    const approveSeq = Math.min(...seqOf((l) => l === 'approve the plan'));
    expect(approveSeq).toBeLessThan(Math.min(...seqOf((l) => l.startsWith('prototype ') || l.startsWith('module '))));
    expect(seqOf((l) => l.startsWith('prototype ')).length).toBe(3);
    // the owner picked option 1 over the critic's option 2, and the signature module got it
    expect(r.picked.option).toBe(1);
    const modulePrompts = t.requests.slice(before).filter((x) => x.includes('Build one module of the site'));
    expect(modulePrompts.some((x) => x.includes('Your module: koi') && x.includes('picked prototype option 1'))).toBe(true);
    // the owner's link lane ran first, before the five fixed lanes
    expect(seqOf((l) => l.startsWith('refs ')).length).toBe(6);
    expect(calls.find((c) => c.label?.startsWith('refs '))?.label).toBe('refs owner links');

    // the pass bar: round 1 failed on the minimum, one fix on the 3 weakest, round 2 passed at exactly 8 and 7
    expect(r.look.rounds.map((x) => [x.avg, x.min, x.passed])).toEqual([[8.7, 6, false], [8, 7, true]]);
    expect(r.look.rounds[0].weakest[0].area).toBe('Mobile');
    expect(captures).toBe(2);
    expect(seqOf((l) => l.startsWith('fix r')).length).toBe(1);
    // the judge saw only the evidence, the brief and STYLE.md, with Read as its one tool
    const judgePrompts = t.requests.slice(before).filter((x) => x.includes('Score this site on the 10-point rubric'));
    expect(judgePrompts.every((x) => x.includes('STYLE-MARKER') && x.includes('sheet-390.png'))).toBe(true);
    expect(r.url).toBe('http://127.0.0.1:5173/');
    expect(r.stopServer).toBe('kill 4242');

    // the project's own check, found in package.json; the npm placeholder test is skipped
    expect(r.checks).toEqual([{ command: 'bun run typecheck', ok: true, tail: '' }]);

    // round A: the rejected idea is dropped by the ledger, a low finding keeps it clean, so round B ran
    expect(r.validation.roundA.map((f) => f.title)).toEqual(['Footer link lacks a new tab hint']);
    expect(r.validation.cleanA).toBe(true);
    expect(r.validation.roundB?.map((f) => f.title)).toEqual(['Koi freezes after a fast resize']);
    expect(r.passed).toBe(true);

    // ledger read before the first judge; every judge and lens saw it; written after them
    const readSeq = Math.min(...seqOf((l) => l.startsWith('ledger: read')));
    expect(readSeq).toBeLessThan(Math.min(...seqOf((l) => l.startsWith('judge r'))));
    const lensPrompts = t.requests.slice(before).filter((x) => x.includes('Review this site through one lens'));
    expect(seqOf((l) => l.startsWith('A ') || l.startsWith('B ')).length).toBe(7);
    expect([...judgePrompts, ...lensPrompts].every((x) => x.includes('<untrusted-ledger>') && x.includes('[rejected] low r1'))).toBe(true);
    // no lens saw this run's own findings in its ledger: they were written after the last lens
    expect(lensPrompts.some((x) => x.includes(' r2 '))).toBe(false);
    const ledger = svc.store.ledger('local', repo);
    expect(r.ledgerRound).toBe(2);
    expect(ledger.map((e) => [e.finding, e.verdict, e.round]).sort()).toEqual([
      ['Footer link lacks a new tab hint', 'open', 2],
      ['Hero needs a gradient', 'rejected', 1],
      ['Koi freezes after a fast resize', 'open', 2],
    ]);
  } finally {
    answers.length = 0;
    captures = 0;
    cleanup(repo);
  }
});

test('web-studio stops at 3 rounds under the bar and skips round B when round A is not clean', async () => {
  const repo = project();
  try {
    // an average of 7 with nothing under 7 still fails: the bar needs an average of 8
    script({ judge: [[7, 7, 7, 7, 7, 7, 7, 7, 7, 7]], roundA: [{ title: 'Contrast 3.1:1 on the hero', severity: 'high', evidence: '/tmp/a.png', lens: 'accessibility:' }] });
    pickOption = 'Option 2';
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const run = await svc.wait((await svc.startRun({ name: 'web-studio', sessionId: s.id, args: { brief: 'A landing page.', dir: repo, url: 'http://127.0.0.1:8080/' } })).id);
    expect(run.error).toBeUndefined();
    const r = run.result as { passed: boolean; look: { passed: boolean; rounds: Array<{ avg: number; passed: boolean }> }; validation: { cleanA: boolean; roundB: unknown } };
    expect(r.look.rounds.map((x) => [x.avg, x.passed])).toEqual([[7, false], [7, false], [7, false]]);
    expect(r.look.passed).toBe(false);
    const calls = svc.store.calls(run.id);
    expect(calls.filter((c) => c.label?.startsWith('judge r')).length).toBe(3);
    // no fix after the last round, and no serve agent when the owner gave a URL
    expect(calls.filter((c) => c.label?.startsWith('fix r')).length).toBe(2);
    expect(calls.some((c) => c.label === 'serve')).toBe(false);
    expect(captures).toBe(3);
    expect(r.validation.cleanA).toBe(false);
    expect(r.validation.roundB).toBeNull();
    expect(calls.filter((c) => c.label?.startsWith('B ')).length).toBe(0);
    expect(svc.store.logs(run.id).some((l) => l.text.includes('round B skipped'))).toBe(true);
    expect(r.passed).toBe(false);
  } finally {
    answers.length = 0;
    captures = 0;
    cleanup(repo);
  }
});

test('web-studio in an unattended run stops at the spec gate before any prototype or module', async () => {
  const repo = project();
  try {
    script({ judge: [[9, 9, 9, 9, 9, 9, 9, 9, 9, 9]], roundA: [] });
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: repo, permissionMode: 'acceptEdits' });
    const run = await svc.wait((await svc.startRun({ name: 'web-studio', sessionId: s.id, args: { brief: 'A landing page.', dir: repo } }, { unattended: true })).id);
    expect(run.status).toBe('done');
    expect(run.result).toMatchObject({ approved: false });
    expect(String((run.result as { plan: string }).plan)).toContain('Modules:');
    const calls = svc.store.calls(run.id);
    expect(calls.some((c) => c.label?.startsWith('prototype ') || c.label?.startsWith('module '))).toBe(false);
    expect(captures).toBe(0);
  } finally {
    answers.length = 0;
    cleanup(repo);
  }
});
