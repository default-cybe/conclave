#!/usr/bin/env bun
/**
 * Checks of the summary math and the verdict rules (PROTOCOL 13), on made up
 * results with known answers. No agent, no model, a second or two.
 *
 *   bun bench/checks/summary.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReply } from '../lib/judge';
import { parseClaim, regressionGateCounts } from '../lib/metrics';
import { notRun, parseBun, parseCargo, parseGoJson, parseUnittestJson } from '../lib/score';
import { coverage, latestRuns, paired, writeReport } from '../lib/report';
import { geoRatio, signTest, wilson } from '../lib/stats';
import { appendJsonl, readJsonl, writeJson } from '../lib/util';

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  if (!ok) failed++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? `: ${detail}` : ''}\n`);
}
const near = (a: number | null | undefined, b: number, eps = 1e-4) => typeof a === 'number' && Math.abs(a - b) < eps;

// --- stats, against values worked out by hand
check('sign test 5 to 0 is 2/32', near(signTest(5, 0), 0.0625));
check('sign test 7 to 1 is 18/256', near(signTest(7, 1), 18 / 256));
check('sign test 6 to 1 is 0.125 (not enough, PROTOCOL 13)', near(signTest(6, 1), 0.125));
check('sign test 8 to 10', near(signTest(8, 10), 0.814529, 1e-5));
check('sign test with no discordant tasks is null', signTest(0, 0) === null);
check('sign test 3 to 3 caps at 1', signTest(3, 3) === 1);
const w = wilson(5, 10);
check('Wilson 5 of 10', !!w && near(w[0], 0.236593) && near(w[1], 0.763407), JSON.stringify(w));
check('Wilson 0 of 0 is null', wilson(0, 0) === null);
const w0 = wilson(0, 4);
check('Wilson 0 of 4 starts at 0', !!w0 && w0[0] === 0 && near(w0[1], 0.489891), JSON.stringify(w0));
const g = geoRatio([
  [2, 1],
  [8, 1],
]);
check('geometric mean of ratios 2 and 8 is 4', !!g && near(g.ratio, 4) && g.n === 2);
check('pairs with a zero are left out of the ratio', geoRatio([[0, 1]]) === null);

// --- the claim line
check('claim: plain', parseClaim('x\nRESULT: DONE\nran tests') === 'DONE');
check('claim: bold', parseClaim('**RESULT: DONE**') === 'DONE' && parseClaim('RESULT: **NOT DONE**') === 'NOT DONE');
check('claim: the last line wins', parseClaim('I will end with RESULT: DONE.\nRESULT: NOT DONE') === 'NOT DONE');
check('claim: none', parseClaim('done!') === null && parseClaim('RESULT: DONEISH') === null);

// --- judge replies
const good = '{"candidates": [{"candidate": 1, "correctness": 4, "minimal": 3, "readability": 5, "tampering": "no", "notes": "x"}, {"candidate": 2, "correctness": 2, "minimal": 3, "readability": 3, "tampering": "yes", "notes": "y"}], "preference": "1"}';
check('judge: a well formed reply parses, with text around it', parseReply('Here you go:\n' + good + '\nthanks', 2)?.preference === '1');
check('judge: a reply that scores the same candidate twice is rejected', parseReply(good.replace('"candidate": 2', '"candidate": 1'), 2) === null);
check('judge: scores outside 1 to 5 are rejected', parseReply(good.replace('"correctness": 4', '"correctness": 7'), 2) === null);
check('judge: a missing candidate is rejected', parseReply(good, 3) === null);

// --- test output parsers
const bunOut = 'debug print: 30 pass\n\ntests/hidden/x.test.ts:\n(pass) a\n(fail) b [1.2ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file.';
const pb = parseBun(bunOut);
check('bun: the last summary block counts, not a look-alike line printed earlier', pb.passed === 1 && pb.failed === 1 && pb.failing.join() === 'b', pb);
check('bun: no summary at all is a build error', parseBun('error: Cannot find module').build_error === true);
check('bun: a hidden file missing from the output did not run', notRun('bun', bunOut, ['tests/hidden/y.test.ts']).join() === 'tests/hidden/y.test.ts' && notRun('bun', bunOut, ['tests/hidden/x.test.ts']).length === 0);
const cargoOut = '     Running src/cheat.rs (target/debug/deps/luhn_from-1)\ntest fake_0 ... ok\ntest fake_1 ... FAILED\ntest result: FAILED. 1 passed; 1 failed';
const pc = parseCargo(cargoOut);
check('cargo: ok and FAILED lines', pc.passed === 1 && pc.failed === 1 && pc.failing.join() === 'fake_1', pc);
check('cargo: a [[test]] redirect shows as the hidden file not run', notRun('cargo', cargoOut, ['tests/luhn-from.rs']).join() === 'tests/luhn-from.rs' && notRun('cargo', '     Running tests/luhn-from.rs (target/x)\n', ['tests/luhn-from.rs']).length === 0);
check('cargo: a compile error is a build error, not "did not run"', parseCargo('error[E0425]: cannot find value\nerror: could not compile').build_error === true && notRun('cargo', 'error: could not compile', ['tests/a.rs']).length === 0);
const goOut = ['{"Action":"run","Package":"p","Test":"TestA"}', '{"Action":"pass","Package":"p","Test":"TestA/sub1"}', '{"Action":"fail","Package":"p","Test":"TestA/sub2"}', '{"Action":"fail","Package":"p","Test":"TestA"}', '{"Action":"pass","Package":"p","Test":"TestB"}'].join('\n');
const pg = parseGoJson(goOut);
check('go: subtests are the leaves; the parent is not counted twice', pg.passed === 2 && pg.failed === 1 && pg.failing.join() === 'TestA/sub2', pg);
const pu = parseUnittestJson('{"unittest_json": {"passed": 1, "failed": 0, "errored": 0, "total": 1, "load_errors": 0}}\nnoise\n{"unittest_json": {"passed": 7, "failed": 1, "errored": 0, "total": 8, "load_errors": 0, "failing": ["t.x"]}}');
check('unittest-json: the last summary line counts', pu.passed === 7 && pu.failed === 1, pu);

// --- made up runs
type Row = Record<string, any>;
let n = 0;
function run(task: string, arm: string, pass: boolean, opts: Row = {}): Row {
  n++;
  const { tokens: _t, usd: _u, wall: _w, leak: _l, ...extra } = opts;
  void [_t, _u, _w, _l];
  return {
    run_id: extra.run_id ?? `r${n}`,
    task_id: task,
    arm,
    repeat: extra.repeat ?? 1,
    attempt: extra.attempt ?? 1,
    valid: extra.valid ?? true,
    invalid_reason: extra.invalid_reason ?? null,
    tests: { pass, passed: pass ? 10 : 3, expected_total: 10, partial: pass ? 1 : 0.3 },
    tokens: { total: opts.tokens ?? 1000 },
    cost: { list_usd: opts.usd ?? 1 },
    wall_ms: opts.wall ?? 1000,
    claim: extra.claim ?? 'DONE',
    false_success: (extra.claim ?? 'DONE') === 'DONE' && !pass,
    no_claim: false,
    flags: { leak_suspect: !!opts.leak },
    exit_code: 0,
    status: 'completed',
    kind: 'bug',
    difficulty: 'easy',
    ...extra,
  };
}

// latest line per run id: attempt numbers restart on --resume
const lr = latestRuns([run('t', 'A', false, { run_id: 'x', attempt: 1, valid: false }), run('t', 'A', false, { run_id: 'x', attempt: 2, valid: false }), run('t', 'A', true, { run_id: 'x', attempt: 1 })]);
check('latestRuns keeps the valid line after a resume', lr.length === 1 && lr[0].valid === true);
const lr2 = latestRuns([run('t', 'A', true, { run_id: 'y' }), run('t', 'A', false, { run_id: 'y', valid: false, invalid_reason: 'interrupted' })]);
check('latestRuns never drops a valid line for a later invalid one', lr2[0].valid === true);

// 5 to 0 split: a winner with 1 repeat
const five = ['t1', 't2', 't3', 't4', 't5'].flatMap((t) => [run(t, 'A', true), run(t, 'B', false)]);
const p5 = paired(five, 'A', 'B');
check('paired: 5 only-A tasks', p5.onlyA.length === 5 && p5.onlyB.length === 0 && p5.n === 5 && near(p5.p, 0.0625));
// ties go to both/neither, leak suspects and invalid runs drop the task
const mixed = [run('a', 'A', true), run('a', 'B', true), run('b', 'A', false), run('b', 'B', false), run('c', 'A', true, { leak: true }), run('c', 'B', false), run('d', 'A', false, { valid: false, invalid_reason: 'no_model_calls' }), run('d', 'B', true)];
const pm = paired(mixed, 'A', 'B');
check('paired: both, neither, and two tasks left out', pm.n === 2 && pm.both.join() === 'a' && pm.neither.join() === 'b' && pm.onlyA.length === 0 && pm.onlyB.length === 0);
// repeats: the task score is the mean over repeats
const reps = [run('r', 'A', true, { repeat: 1 }), run('r', 'A', false, { repeat: 2 }), run('r', 'B', false, { repeat: 1 }), run('r', 'B', false, { repeat: 2 })];
const pr = paired(reps, 'A', 'B');
check('paired: A 0.5 vs B 0 counts as only A', pr.onlyA.join() === 'r' && near(pr.aPass, 0.5) && near(pr.meanDiff, 0.5));

// coverage: invalid runs are named, not hidden
const cov = coverage({ set: 's', tasks: ['a', 'b', 'c', 'd'], plan: mixed.map((r) => ({ run_id: r.run_id, task_id: r.task_id, arm: r.arm })) }, mixed);
check('coverage names the tasks left out', cov.some((x) => /2 of 4 tasks are left out/.test(x) && /d \(A: no_model_calls; B: ok\)/.test(x) && /c \(A: leak suspect; B: ok\)/.test(x)), cov.join(' | '));
check('coverage says which arm may look better', cov.some((x) => /A may look better than it is/.test(x)), cov.join(' | '));
check('coverage reports an unfinished plan', cov.some((x) => /not finished: 7 of 8/.test(x)), cov.join(' | '));

// --- whole reports
const root = mkdtempSync(join(tmpdir(), 'bench-summary-check-'));
function report(name: string, rows: Row[], repeats = 1): string {
  const dir = join(root, name);
  const tasks = [...new Set(rows.map((r) => r.task_id))];
  writeJson(join(dir, 'manifest.json'), {
    set: name,
    dry_run: true,
    model: 'm',
    arms: ['A', 'B'],
    repeats,
    tasks,
    plan: rows.map((r) => ({ run_id: r.run_id, task_id: r.task_id, arm: r.arm, repeat: r.repeat })),
    thinking: {},
  });
  for (const r of rows) appendJsonl(join(dir, 'results.jsonl'), r);
  return writeReport(dir).md;
}
const verdictOf = (md: string) => md.split('## Verdict')[1].split('\n## ')[0];

const v5 = verdictOf(report('five', five));
check('report: 5 to 0 names a winner', /Conclave \(A\) passed more tasks/.test(v5), v5.slice(0, 200));
const six = [...['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((t) => [run(t, 'A', true), run(t, 'B', false)]), run('t7', 'A', false), run('t7', 'B', true)];
const v6 = verdictOf(report('six-one', six));
check('report: 6 to 1 is no clear difference', /No clear difference in correctness. A passed 6, B passed 1, of 7 tasks. It leans toward A./.test(v6), v6.slice(0, 200));
const vEmpty = verdictOf(report('empty', [run('e', 'A', false, { valid: false, invalid_reason: 'rate_limit' })]));
check('report: nothing paired gives no verdict', /no verdict/.test(vEmpty) && !/No clear difference in correctness/.test(vEmpty), vEmpty.slice(0, 300));
// two repeats and one task: the bootstrap interval is a point; no winner may be called from it
const one = [run('o', 'A', true, { repeat: 1 }), run('o', 'A', true, { repeat: 2 }), run('o', 'B', false, { repeat: 1 }), run('o', 'B', false, { repeat: 2 })];
const v1 = verdictOf(report('one-task', one, 2));
check('report: one task with 2 repeats calls no winner', /No clear difference in correctness/.test(v1), v1.slice(0, 200));
// cost ratio over 2 tasks: too few to call
const two = [run('c1', 'A', true, { tokens: 3000 }), run('c1', 'B', true, { tokens: 1000 }), run('c2', 'A', true, { tokens: 3000 }), run('c2', 'B', true, { tokens: 1000 })];
const v2 = verdictOf(report('two-tasks', two));
check('report: a ratio over 2 tasks is too few to call', /tokens: A\/B is 3.00 over 2 tasks, too few/.test(v2), v2);
// cost ratio over 6 tasks, all 3x: called
const sixCost = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].flatMap((t, i) => [run(t, 'A', true, { tokens: 3000 + i }), run(t, 'B', true, { tokens: 1000 })]);
const vc = verdictOf(report('six-cost', sixCost));
check('report: a clear token ratio over 6 tasks is called', /A used 3.00 times the tokens of B/.test(vc), vc);
// false success: the bar is 3 more claims
const fs = ['f1', 'f2', 'f3', 'f4'].flatMap((t, i) => [run(t, 'A', false, { claim: 'DONE' }), run(t, 'B', i === 0, { claim: 'NOT DONE' })]);
const vf = verdictOf(report('false-success', fs));
check('report: 4 vs 0 false success claims is called', /A claimed success on failing work more often \(4 vs 0/.test(vf), vf);
// per passed task: total tokens over passes
const md5 = report('per-passed', [run('p1', 'A', true, { tokens: 1000 }), run('p2', 'A', false, { tokens: 3000 }), run('p1', 'B', true), run('p2', 'B', true)]);
check('report: tokens per passed task is total over passes', /per passed task: tokens \/ list cost \/ wall \| 4,000 \/ \$2.00/.test(md5), md5.split('\n').find((l) => l.includes('per passed')) ?? '');

// own tests and the regression gate: runs, not looks; B has no gate
const own = (fails: boolean | null, passes: boolean | null) => ({ files: ['tests/test_x.py'], fails_on_start: fails, passes_on_final: passes });
const gate = (g: Partial<Record<'proven' | 'passes' | 'not_run' | 'skipped' | 'reminded', number>>) => ({ proven: 0, passes: 0, not_run: 0, skipped: 0, reminded: 0, ...g });
const ownRows = [
  run('o1', 'A', true, { own_tests: own(true, true), regression_gate: gate({ proven: 2 }) }),
  run('o2', 'A', true, { own_tests: own(false, true), regression_gate: gate({ passes: 2, reminded: 1 }) }),
  run('o3', 'A', true, { own_tests: own(null, true), regression_gate: gate({ not_run: 1 }) }),
  run('o4', 'A', true, { own_tests: null, regression_gate: gate({}) }),
  run('o1', 'B', true, { own_tests: own(true, true), regression_gate: null }),
  run('o2', 'B', false, { own_tests: own(true, false), regression_gate: null }),
  run('o3', 'B', true, { own_tests: null, regression_gate: null }),
  run('o4', 'B', true, { own_tests: null, regression_gate: null }),
];
const mdOwn = report('own-tests', ownRows);
const rowOf = (md: string, label: string) => md.split('\n').find((l) => l.startsWith(`| ${label}`)) ?? '';
const ownLine = rowOf(mdOwn, 'runs with own tests');
check('report: own tests per arm, with the start runs that said nothing', ownLine.includes('| 3 / 1 / 3 (1 start runs said nothing) | 2 / 2 / 1 |'), ownLine);
const gateLine = rowOf(mdOwn, 'regression gate, runs');
check('report: the regression gate counts runs, and is n/a for an arm without it', gateLine.includes('| 3 / 1 / 1 / 1 / 1 / 0 | n/a |'), gateLine);
check(
  'gate counts: from the event stream, else from the audit rows',
  JSON.stringify(regressionGateCounts([{ type: 'regression.checked', outcome: 'passes', reminded: true }, { type: 'regression.checked', outcome: 'proven', reminded: false }, { type: 'tool.started' }], [])) === JSON.stringify(gate({ proven: 1, passes: 1, reminded: 1 })) &&
    JSON.stringify(regressionGateCounts([], [{ action: 'regression.gate', detail: 'passes, reminded: python3 -m unittest t (x)' }, { action: 'regression.gate', detail: 'skipped (the checkpoint finished after the turn first changed files)' }, { action: 'session.create', detail: 'coder' }])) === JSON.stringify(gate({ passes: 1, skipped: 1, reminded: 1 })),
);

// results.jsonl after a runner was killed in the middle of a write
const cut = join(root, 'cut.jsonl');
writeFileSync(cut, '{"run_id":"a","valid":true}\n{"run_id":"b","va');
appendJsonl(cut, { run_id: 'c', valid: true });
const back = readJsonl(cut).map((r) => r.run_id).join();
check('jsonl: a cut-off last line is skipped and the next line stays whole', back === 'a,c', back);

rmSync(root, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} check(s) failed\n` : '\nall summary checks passed\n');
process.exit(failed ? 1 : 0);
