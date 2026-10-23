/** summary.md and summary.json (PROTOCOL 12.2, 13; METRICS.md summary list). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJudges, type JudgeResults } from './judge';
import { parityLines, settingsNote } from './parity-report';
import { bootstrapMean, geoRatio, mean, signTest, wilson } from './stats';
import { median, quantile, readJson, readJsonl, sum, writeJson, writeText } from './util';

type Row = any;

const fmtPct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const fmtNum = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmtUsd = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `$${x.toFixed(x < 1 ? 3 : 2)}`);
const fmtS = (ms: number | null | undefined) => (ms === null || ms === undefined ? 'n/a' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const fmtCount = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const fmtCi = (ci: [number, number] | null | undefined, f: (x: number) => string) => (ci ? `${f(ci[0])} to ${f(ci[1])}` : 'n/a');
const ratio = (x: number) => x.toFixed(2);
const tokTotal = (r: Row) => (r.tokens ? r.tokens.total : null);

function table(header: string[], rows: Array<Array<string | number>>): string {
  const esc = (v: string | number) => String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [`| ${header.map(esc).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

/** Runs that count: valid and not flagged as a possible hidden test leak. */
export function eligible(r: Row): boolean {
  return r.valid === true && !r.flags?.leak_suspect;
}

/**
 * One line per run id: the last valid line, else the last line. results.jsonl
 * is in time order. The attempt number restarts at 1 on --resume, so it cannot
 * order lines (attempt 2 rate limited, then attempt 1 valid after a resume).
 * The runner skips a run id once it has a valid line; this matches that.
 */
export function latestRuns(results: Row[]): Row[] {
  const m = new Map<string, Row>();
  for (const r of results) {
    const prev = m.get(r.run_id);
    if (!prev || r.valid || !prev.valid) m.set(r.run_id, r);
  }
  return [...m.values()];
}

interface ArmStats {
  arm: string;
  runs: number;
  eligible: number;
  passed: number;
  passRate: number | null;
  passCi: [number, number] | null;
  meanPartial: number | null;
  falseSuccess: number;
  noClaim: number;
  judge: { correctness: number | null; minimal: number | null; readability: number | null; tampering: number; n: number };
  wall: { median: number | null; p90: number | null; total: number };
  tokens: { median: number | null; total: number; input: number; output: number; cache_read: number; cache_write: number; meanInput: number | null; meanOutput: number | null; meanCacheRead: number | null; meanCacheWrite: number | null };
  cost: { reportedMedian: number | null; reportedTotal: number | null; listMedian: number | null; listTotal: number | null };
  turns: { main: number | null; sub: number | null };
  tools: { median: number | null; failedRate: number | null; editMisses: number; pathSlips: number; reverted: number; bashNonzero: number };
  files: { touched: number | null; diffLines: number | null };
  /** Runs that stashed, ran a test and popped (a check without the fix), runs where that test failed, runs that added tests to an existing test file. */
  checks: { stash: number; failedWithoutFix: number; extendedTests: number };
  /** Runs with own tests (a changed test file and a visible test command); of those, runs whose tests fail on the start code, runs whose visible tests pass on the final code, and runs where the start run said nothing. */
  ownTests: { runs: number; failsOnStart: number; passesOnFinal: number; startNotRun: number };
  /** Conclave's regression gate, as runs with at least one look of each kind; null when no run of the arm reports it. */
  gate: { runs: number; proven: number; passes: number; reminded: number; notRun: number; skipped: number } | null;
  problems: { timeouts: number; caps: number; invalid: number; network: number; leaks: number; tamper: number };
  perPassed: { tokens: number | null; listUsd: number | null; wallMs: number | null };
  firstRequest: number | null;
}

function armStats(arm: string, runs: Row[], judge: Map<string, Row>): ArmStats {
  const el = runs.filter(eligible);
  const own = el.map((r) => r.own_tests).filter((o) => o && o.files?.length);
  const gates = el.map((r) => r.regression_gate).filter(Boolean);
  const gateRuns = (k: string) => gates.filter((g) => (g[k] ?? 0) > 0).length;
  const passed = el.filter((r) => r.tests?.pass).length;
  const js = el.map((r) => judge.get(r.run_id)).filter((j) => j && !j.judge_error);
  const vals = (f: (r: Row) => number | null | undefined) => el.map(f).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  const listCosts = vals((r) => r.cost?.list_usd);
  const reported = vals((r) => r.cost?.reported_usd);
  const toolCalls = vals((r) => r.tools?.calls);
  const failedCalls = sum(vals((r) => r.tools?.failed));
  const totalTokens = sum(vals(tokTotal));
  const totalWall = sum(vals((r) => r.wall_ms));
  const listTotal = listCosts.length ? sum(listCosts) : null;
  return {
    arm,
    runs: runs.length,
    eligible: el.length,
    passed,
    passRate: el.length ? passed / el.length : null,
    passCi: wilson(passed, el.length),
    meanPartial: mean(vals((r) => r.tests?.partial)),
    falseSuccess: el.filter((r) => r.false_success).length,
    noClaim: el.filter((r) => r.no_claim).length,
    judge: {
      correctness: mean(js.map((j) => j.correctness).filter((x) => x !== null)),
      minimal: mean(js.map((j) => j.minimal).filter((x) => x !== null)),
      readability: mean(js.map((j) => j.readability).filter((x) => x !== null)),
      tampering: js.filter((j) => j.tampering).length,
      n: js.length,
    },
    wall: { median: median(vals((r) => r.wall_ms)), p90: quantile(vals((r) => r.wall_ms), 0.9), total: totalWall },
    tokens: {
      median: median(vals(tokTotal)),
      total: totalTokens,
      input: sum(vals((r) => r.tokens?.input)),
      output: sum(vals((r) => r.tokens?.output)),
      cache_read: sum(vals((r) => r.tokens?.cache_read)),
      cache_write: sum(vals((r) => r.tokens?.cache_write)),
      meanInput: mean(vals((r) => r.tokens?.input)),
      meanOutput: mean(vals((r) => r.tokens?.output)),
      meanCacheRead: mean(vals((r) => r.tokens?.cache_read)),
      meanCacheWrite: mean(vals((r) => r.tokens?.cache_write)),
    },
    cost: { reportedMedian: median(reported), reportedTotal: reported.length ? sum(reported) : null, listMedian: median(listCosts), listTotal },
    turns: { main: median(vals((r) => r.turns?.main)), sub: median(vals((r) => r.turns?.sub)) },
    tools: { median: median(toolCalls), failedRate: toolCalls.length ? failedCalls / Math.max(1, sum(toolCalls)) : null, editMisses: sum(vals((r) => r.tools?.edit_misses)), pathSlips: sum(vals((r) => r.tools?.path_slips)), reverted: sum(vals((r) => r.edits?.reverted)), bashNonzero: sum(vals((r) => r.tools?.bash_nonzero)) },
    files: { touched: median(vals((r) => r.diff?.files_changed)), diffLines: median(vals((r) => (r.diff ? r.diff.lines_added + r.diff.lines_removed : null))) },
    checks: {
      stash: el.filter((r) => (r.verify?.stash_checks ?? 0) > 0).length,
      failedWithoutFix: el.filter((r) => r.verify?.failed_without_fix).length,
      extendedTests: el.filter((r) => r.diff?.extended_existing_tests?.length).length,
    },
    ownTests: {
      runs: own.length,
      failsOnStart: own.filter((o) => o.fails_on_start === true).length,
      passesOnFinal: own.filter((o) => o.passes_on_final === true).length,
      startNotRun: own.filter((o) => o.fails_on_start === null).length,
    },
    gate: gates.length
      ? { runs: gates.filter((g) => g.proven + g.passes + g.not_run + g.skipped > 0).length, proven: gateRuns('proven'), passes: gateRuns('passes'), reminded: gateRuns('reminded'), notRun: gateRuns('not_run'), skipped: gateRuns('skipped') }
      : null,
    problems: {
      timeouts: runs.filter((r) => r.timed_out).length,
      caps: runs.filter((r) => r.capped).length,
      invalid: runs.filter((r) => !r.valid).length,
      network: runs.filter((r) => r.flags?.network_attempt).length,
      leaks: runs.filter((r) => r.flags?.leak_suspect).length,
      tamper: runs.filter((r) => r.diff?.modified_existing_tests?.length || r.diff?.suspicious_files?.length || r.tests?.links_removed?.length || r.tests?.not_run?.length).length,
    },
    perPassed: { tokens: passed ? totalTokens / passed : null, listUsd: passed && listTotal !== null ? listTotal / passed : null, wallMs: passed ? totalWall / passed : null },
    firstRequest: median(vals((r) => r.requests?.first_request_tokens)),
  };
}

export interface Paired {
  a: string;
  b: string;
  n: number;
  both: string[];
  onlyA: string[];
  onlyB: string[];
  neither: string[];
  p: number | null;
  meanDiff: number | null;
  diffCi: [number, number] | null;
  cost: ReturnType<typeof geoRatio>;
  tokens: ReturnType<typeof geoRatio>;
  wall: ReturnType<typeof geoRatio>;
  aPass: number;
  bPass: number;
}

export function paired(runs: Row[], a: string, b: string): Paired {
  const byTask = new Map<string, { a: Row[]; b: Row[] }>();
  for (const r of runs.filter(eligible)) {
    if (r.arm !== a && r.arm !== b) continue;
    const e = byTask.get(r.task_id) ?? { a: [], b: [] };
    (r.arm === a ? e.a : e.b).push(r);
    byTask.set(r.task_id, e);
  }
  const out: Paired = { a, b, n: 0, both: [], onlyA: [], onlyB: [], neither: [], p: null, meanDiff: null, diffCi: null, cost: null, tokens: null, wall: null, aPass: 0, bPass: 0 };
  const diffs: number[] = [];
  const costPairs: Array<[number, number]> = [];
  const tokPairs: Array<[number, number]> = [];
  const wallPairs: Array<[number, number]> = [];
  for (const [task, e] of [...byTask.entries()].sort()) {
    if (!e.a.length || !e.b.length) continue;
    out.n++;
    const sa = mean(e.a.map((r) => (r.tests?.pass ? 1 : 0)))!;
    const sb = mean(e.b.map((r) => (r.tests?.pass ? 1 : 0)))!;
    out.aPass += sa;
    out.bPass += sb;
    diffs.push(sa - sb);
    if (sa > sb) out.onlyA.push(task);
    else if (sb > sa) out.onlyB.push(task);
    else if (sa > 0) out.both.push(task);
    else out.neither.push(task);
    const m = (rows: Row[], f: (r: Row) => number | null) => mean(rows.map(f).filter((x): x is number => typeof x === 'number'));
    const ca = m(e.a, (r) => r.cost?.list_usd ?? null);
    const cb = m(e.b, (r) => r.cost?.list_usd ?? null);
    if (ca !== null && cb !== null) costPairs.push([ca, cb]);
    const ta = m(e.a, tokTotal);
    const tb = m(e.b, tokTotal);
    if (ta !== null && tb !== null) tokPairs.push([ta, tb]);
    const wa = m(e.a, (r) => r.wall_ms);
    const wb = m(e.b, (r) => r.wall_ms);
    if (wa !== null && wb !== null) wallPairs.push([wa, wb]);
  }
  out.p = signTest(out.onlyA.length, out.onlyB.length);
  out.meanDiff = mean(diffs);
  out.diffCi = bootstrapMean(diffs, 0.9, 10_000, 1);
  out.cost = geoRatio(costPairs);
  out.tokens = geoRatio(tokPairs);
  out.wall = geoRatio(wallPairs);
  return out;
}

/**
 * Fewest tasks for a call from a bootstrap interval. With one or two pairs the
 * interval shrinks to a point and always "excludes" 1 (or 0), which is not evidence.
 */
export const MIN_CI_PAIRS = 5;

function ratioSentence(label: string, g: ReturnType<typeof geoRatio>, a: string, b: string): string {
  if (!g) return `${label}: no pairs with data.`;
  if (g.n < MIN_CI_PAIRS) return `${label}: ${a}/${b} is ${ratio(g.ratio)} over ${g.n} task${g.n === 1 ? '' : 's'}, too few to call a difference.`;
  const excl = g.ci && (g.ci[0] > 1 || g.ci[1] < 1);
  const ci = g.ci ? ` (90% interval ${ratio(g.ci[0])} to ${ratio(g.ci[1])}, ${g.n} tasks)` : '';
  return excl ? `${a} used ${ratio(g.ratio)} times the ${label} of ${b}${ci}.` : `No clear difference in ${label}: ${a}/${b} is ${ratio(g.ratio)}${ci}.`;
}

/**
 * What the comparison leaves out, said up front: an unfinished plan, and tasks
 * without a counted run in both arms. Invalid runs are not failures, so an arm
 * that crashes before any model call would otherwise look no worse.
 */
export function coverage(manifest: Row, results: Row[]): string[] {
  const out: string[] = [];
  const latest = new Map(results.map((r) => [r.run_id, r]));
  const plan: Row[] = (manifest.plan ?? []).filter((x: Row) => x.arm === 'A' || x.arm === 'B');
  const doneValid = plan.filter((x) => latest.get(x.run_id)?.valid).length;
  if (plan.length && doneValid < plan.length) out.push(`The set is not finished: ${doneValid} of ${plan.length} planned A and B runs have a valid result. Continue with \`bun bench/run.ts --resume --set ${manifest.set}\`.`);
  const tasks: string[] = manifest.tasks ?? [];
  const left: string[] = [];
  const invalid: Record<string, Record<string, number>> = { A: {}, B: {} };
  for (const r of results) if ((r.arm === 'A' || r.arm === 'B') && !eligible(r)) {
    const why = r.valid ? 'leak suspect' : r.invalid_reason ?? 'invalid';
    invalid[r.arm][why] = (invalid[r.arm][why] ?? 0) + 1;
  }
  for (const t of tasks) {
    const why = (arm: string): string | null => {
      const rs = results.filter((r) => r.task_id === t && r.arm === arm);
      if (rs.some(eligible)) return null;
      if (!rs.length) return 'not run yet';
      return [...new Set(rs.map((r) => (r.valid ? 'leak suspect' : r.invalid_reason ?? 'invalid')))].join(', ');
    };
    const a = why('A');
    const b = why('B');
    if (a || b) left.push(`${t} (A: ${a ?? 'ok'}; B: ${b ?? 'ok'})`);
  }
  if (left.length) out.push(`${left.length} of ${tasks.length} tasks are left out of the comparison: ${left.slice(0, 8).join('; ')}${left.length > 8 ? '; and more' : ''}.`);
  const fmt = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  const na = Object.values(invalid.A).reduce((x, y) => x + y, 0);
  const nb = Object.values(invalid.B).reduce((x, y) => x + y, 0);
  if (na || nb) out.push(`Runs not counted: A ${fmt(invalid.A)}; B ${fmt(invalid.B)}. They are not counted as failures${na > nb ? ', so A may look better than it is' : nb > na ? ', so B may look better than it is' : ''}.`);
  return out;
}

/** One line per run id, an error line only when there is nothing better. */
function judgeMap(lines: Row[]): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const j of lines) if (!j.judge_error || !m.has(j.run_id)) m.set(j.run_id, j);
  return m;
}

const isTie = (p: string | null | undefined) => !!p && p.startsWith('tie');

export interface JudgeSummary {
  model: string;
  file: string;
  provider: string | null;
  effort: string | null;
  judged: number;
  perArm: Record<string, { correctness: number | null; minimal: number | null; readability: number | null; tampering: number; n: number }>;
  /** Task groups (task and repeat) by preference: an arm, "tie", or "tie (order sensitive)". */
  preferences: Record<string, number>;
  reasoningTokens: number | null;
}

export interface JudgeAgreement {
  a: string;
  b: string;
  groups: number;
  sameArm: number;
  bothTie: number;
  oneTie: number;
  opposite: number;
}

/** Each judge's scores and preferences over counted runs, and how often each pair of judges agrees. */
export function judgeSummaries(results: Row[], judges: JudgeResults[], arms: string[]): { judges: JudgeSummary[]; agreement: JudgeAgreement[] } {
  const counted = results.filter(eligible);
  const groupPrefs = (m: Map<string, Row>) => {
    const out = new Map<string, string>();
    for (const r of counted) {
      const j = m.get(r.run_id);
      if (j && !j.judge_error && j.task_preference) out.set(`${r.task_id}#${r.repeat}`, j.task_preference);
    }
    return out;
  };
  const maps = judges.map((j) => judgeMap(j.lines));
  const prefs = maps.map(groupPrefs);
  const summaries: JudgeSummary[] = judges.map((j, i) => {
    const perArm: JudgeSummary['perArm'] = {};
    for (const a of arms) {
      const js = counted.filter((r) => r.arm === a).map((r) => maps[i].get(r.run_id)).filter((x) => x && !x.judge_error);
      perArm[a] = {
        correctness: mean(js.map((x) => x.correctness).filter((x) => x !== null)),
        minimal: mean(js.map((x) => x.minimal).filter((x) => x !== null)),
        readability: mean(js.map((x) => x.readability).filter((x) => x !== null)),
        tampering: js.filter((x) => x.tampering).length,
        n: js.length,
      };
    }
    const preferences: Record<string, number> = {};
    for (const p of prefs[i].values()) preferences[p] = (preferences[p] ?? 0) + 1;
    // reasoning tokens are per call and shared by a group's lines: count each group once
    const seen = new Set<string>();
    let reasoning: number | null = null;
    for (const l of j.lines) {
      const k = `${l.task_id}#${l.repeat}`;
      if (seen.has(k) || !Array.isArray(l.judge_usage)) continue;
      seen.add(k);
      for (const u of l.judge_usage) if (typeof u?.reasoning === 'number') reasoning = (reasoning ?? 0) + u.reasoning;
    }
    const first = j.lines[0] ?? {};
    return { model: j.model, file: j.file, provider: first.judge_provider ?? null, effort: first.judge_effort ?? null, judged: maps[i].size, perArm, preferences, reasoningTokens: reasoning };
  });
  const agreement: JudgeAgreement[] = [];
  for (let x = 0; x < judges.length; x++) {
    for (let y = x + 1; y < judges.length; y++) {
      const g: JudgeAgreement = { a: judges[x].model, b: judges[y].model, groups: 0, sameArm: 0, bothTie: 0, oneTie: 0, opposite: 0 };
      for (const [k, p] of prefs[x]) {
        const q = prefs[y].get(k);
        if (!q) continue;
        g.groups++;
        if (isTie(p) && isTie(q)) g.bothTie++;
        else if (isTie(p) || isTie(q)) g.oneTie++;
        else if (p === q) g.sameArm++;
        else g.opposite++;
      }
      agreement.push(g);
    }
  }
  return { judges: summaries, agreement };
}

export function writeReport(setDir: string): { md: string; json: Record<string, unknown> } {
  const manifest = readJson(join(setDir, 'manifest.json'));
  const results = latestRuns(readJsonl(join(setDir, 'results.jsonl')));
  // the first judge of the set drives the main tables; every judge is shown side by side below
  const judges = readJudges(setDir, manifest.model);
  const judgeLines = judges.flatMap((j) => j.lines);
  const judge = judgeMap(judges[0]?.lines ?? []);
  const arms: string[] = manifest.arms;
  const repeats: number = manifest.repeats;
  const stats = arms.map((a) => armStats(a, results.filter((r) => r.arm === a), judge));
  const st = (a: string) => stats.find((s) => s.arm === a)!;
  const hasAB = arms.includes('A') && arms.includes('B');
  const pr = hasAB ? paired(results, 'A', 'B') : null;
  const lines: string[] = [];
  const dry = manifest.dry_run;

  // 1. verdict
  lines.push(`# Harness benchmark: ${manifest.set}`);
  if (dry) lines.push('\n> Dry run. A fake agent made these changes and a fake judge scored them. No model was called. The numbers only show that the pipeline works.');
  lines.push('\n## Verdict\n');
  const verdict: string[] = [];
  let confidence = 'low';
  if (pr) {
    const validPairs = pr.n;
    confidence = repeats >= 2 && validPairs >= 15 ? 'medium' : 'low';
    const winner = (() => {
      if (repeats >= 2) return pr.n >= MIN_CI_PAIRS && pr.diffCi && (pr.diffCi[0] > 0 || pr.diffCi[1] < 0) ? (pr.diffCi[0] > 0 ? 'A' : 'B') : null;
      return pr.p !== null && pr.p < 0.1 ? (pr.onlyA.length > pr.onlyB.length ? 'A' : 'B') : null;
    })();
    const name = (a: string) => (a === 'A' ? 'Conclave (A)' : 'Claude Code (B)');
    for (const x of coverage(manifest, results)) verdict.push(x);
    if (validPairs === 0) {
      verdict.push('No task has valid runs in both arms yet, so there is no verdict.');
    } else {
      if (winner) {
        verdict.push(`${name(winner)} passed more tasks. A passed ${fmtCount(pr.aPass)}, B passed ${fmtCount(pr.bPass)}, of ${validPairs} tasks with valid runs in both arms. Only A passed ${pr.onlyA.length}, only B passed ${pr.onlyB.length} (sign test p = ${fmtNum(pr.p, 3)}).`);
      } else {
        const lean = pr.onlyA.length > pr.onlyB.length ? ' It leans toward A.' : pr.onlyB.length > pr.onlyA.length ? ' It leans toward B.' : ' It does not lean either way.';
        verdict.push(`No clear difference in correctness. A passed ${fmtCount(pr.aPass)}, B passed ${fmtCount(pr.bPass)}, of ${validPairs} tasks.${lean} Only A passed ${pr.onlyA.length}, only B passed ${pr.onlyB.length} (sign test p = ${fmtNum(pr.p, 3)}).`);
      }
      verdict.push(`With this many tasks a winner needs about a 5 to 0 or 7 to 1 split of the tasks only one arm passed; a gap of one or two tasks is noise.`);
      const fa = st('A').falseSuccess;
      const fb = st('B').falseSuccess;
      verdict.push(Math.abs(fa - fb) >= 3 ? `${fa > fb ? 'A' : 'B'} claimed success on failing work more often (${Math.max(fa, fb)} vs ${Math.min(fa, fb)} false success claims).` : `False success claims: A ${fa}, B ${fb}, not a clear difference.`);
      const ja = st('A').judge;
      const jb = st('B').judge;
      if (ja.n && jb.n) {
        const gap = (x: number | null, y: number | null) => (x !== null && y !== null ? x - y : null);
        const g = [gap(ja.correctness, jb.correctness), gap(ja.minimal, jb.minimal), gap(ja.readability, jb.readability)];
        const big = ['correctness', 'minimal change', 'readability'].filter((_, i) => g[i] !== null && Math.abs(g[i]!) >= 0.5);
        verdict.push(big.length ? `The judge scored them apart on ${big.join(', ')} (gaps of 0.5 points or more).` : 'The blind judge saw no difference of 0.5 points or more.');
      }
      verdict.push(ratioSentence('tokens', pr.tokens, 'A', 'B') + ' ' + ratioSentence('list cost', pr.cost, 'A', 'B') + ' ' + ratioSentence('wall time', pr.wall, 'A', 'B'));
    }
    verdict.push(`Confidence: ${confidence}.`);
  } else {
    verdict.push('Arms A and B were not both run, so there is no verdict.');
  }
  lines.push(verdict.join(' '));
  const th = manifest.thinking ?? {};
  const sentNote = settingsNote(results);
  if (sentNote) lines.push(`\n${sentNote}`);
  else if (th.A && th.B && (th.A.mode !== th.B.mode || th.A.effort !== th.B.effort)) lines.push(`\nNote: thinking defaults differ. A: ${th.A.mode}${th.A.effort ? ` (${th.A.effort})` : ''}. B: ${th.B.mode}${th.B.effort ? ` (${th.B.effort})` : ''}. A gap may come from this default, not the whole harness.`);

  // 2. setup
  lines.push('\n## Setup\n');
  const served = new Set(results.flatMap((r) => r.model_served ?? []));
  lines.push(
    [
      `- Model requested: \`${manifest.model}\`. Served: ${served.size ? [...served].map((s) => `\`${s}\``).join(', ') : 'n/a'}.`,
      `- Small model for side calls (titles, summaries), set to \`${manifest.small_model}\` for every arm. Seen in the tap: ${arms
        .map((a) => {
          const seen = [...new Set(results.filter((r) => r.arm === a).flatMap((r) => r.tokens?.side_models ?? []))];
          return `${a} ${seen.length ? seen.map((m) => `\`${m}\``).join(', ') : 'none'}`;
        })
        .join('; ')}.`,
      `- Arm B transport: ${manifest.b_transport?.chosen ?? 'n/a'} (${manifest.b_transport?.why ?? ''}).`,
      `- Conclave: ${manifest.conclave?.src} at ${manifest.conclave?.commit ?? 'n/a'}, dirty files in packages/: ${manifest.conclave?.dirty ?? 'n/a'}${manifest.conclave?.dirty ? ' (the code under test was being edited)' : ''}.`,
      `- Claude Code: ${manifest.claude_code?.version_before ?? 'n/a'} before, ${manifest.claude_code?.version_after ?? 'n/a'} after${manifest.claude_code?.version_before && manifest.claude_code?.version_after && manifest.claude_code.version_before !== manifest.claude_code.version_after ? ' (it changed during the set)' : ''}.`,
      `- Model API: ${manifest.proxy?.base_url ?? 'n/a'}, version ${manifest.proxy?.version ?? 'unknown'}, account ${manifest.proxy?.account ?? 'n/a'}.`,
      `- Thinking: A ${th.A ? `${th.A.mode}${th.A.effort ? ` (${th.A.effort})` : ''}` : 'n/a'}; B ${th.B ? `${th.B.mode}${th.B.effort ? ` (${th.B.effort})` : ''}` : 'n/a'}.`,
      `- Seed ${manifest.seed}, repeats ${repeats}, arms ${arms.join(', ')}, started ${manifest.created_at}, last update ${new Date().toISOString().slice(0, 19)}Z.`,
      `- Tools: ${Object.entries(manifest.versions ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      `- Skipped tasks: ${(manifest.skipped ?? []).length ? manifest.skipped.map((s: Row) => `${s.id} (${s.reason})`).join('; ') : 'none'}.`,
      `- Runs in results.jsonl: ${results.length}, counted: ${results.filter(eligible).length}.`,
      `- Arm order: first in group ${Object.entries(manifest.first_in_group ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'} times.`,
    ].join('\n'),
  );

  // 2b. isolation and parity, from the tap and the sandbox checks
  lines.push('\n## Isolation and parity\n');
  lines.push(parityLines(results, arms).join('\n'));

  // 3. per arm
  lines.push('\n## Per arm\n');
  const col = (f: (s: ArmStats) => string) => stats.map(f);
  lines.push(
    table(
      ['', ...arms],
      [
        ['pass rate (95% Wilson)', ...col((s) => `${fmtPct(s.passRate)} (${fmtCi(s.passCi, fmtPct)}), ${s.passed}/${s.eligible}`)],
        ['mean partial', ...col((s) => fmtPct(s.meanPartial))],
        ['false success claims / no claim', ...col((s) => `${s.falseSuccess} / ${s.noClaim}`)],
        ['judge correctness / minimal / readability', ...col((s) => (s.judge.n ? `${fmtNum(s.judge.correctness, 2)} / ${fmtNum(s.judge.minimal, 2)} / ${fmtNum(s.judge.readability, 2)}` : 'n/a'))],
        ['judge tampering yes', ...col((s) => String(s.judge.tampering))],
        ['wall time median / p90 / total', ...col((s) => `${fmtS(s.wall.median)} / ${fmtS(s.wall.p90)} / ${fmtS(s.wall.total)}`)],
        ['tokens median / total', ...col((s) => `${fmtNum(s.tokens.median)} / ${fmtNum(s.tokens.total)}`)],
        ['mean input / output / cache read / cache write', ...col((s) => `${fmtNum(s.tokens.meanInput)} / ${fmtNum(s.tokens.meanOutput)} / ${fmtNum(s.tokens.meanCacheRead)} / ${fmtNum(s.tokens.meanCacheWrite)}`)],
        ['first request tokens (median)', ...col((s) => fmtNum(s.firstRequest))],
        ['cost reported median / total', ...col((s) => `${fmtUsd(s.cost.reportedMedian)} / ${fmtUsd(s.cost.reportedTotal)}`)],
        ['cost at list price median / total', ...col((s) => `${fmtUsd(s.cost.listMedian)} / ${fmtUsd(s.cost.listTotal)}`)],
        ['per passed task: tokens / list cost / wall', ...col((s) => `${fmtNum(s.perPassed.tokens)} / ${fmtUsd(s.perPassed.listUsd)} / ${fmtS(s.perPassed.wallMs)}`)],
        ['median turns main / sub', ...col((s) => `${fmtNum(s.turns.main)} / ${fmtNum(s.turns.sub)}`)],
        ['median tool calls, failed rate', ...col((s) => `${fmtNum(s.tools.median)}, ${fmtPct(s.tools.failedRate)}`)],
        ['edit misses / reverted edits / Bash non-zero', ...col((s) => `${s.tools.editMisses} / ${s.tools.reverted} / ${s.tools.bashNonzero}`)],
        ['path slips (file calls on a wrong path that does not exist)', ...col((s) => String(s.tools.pathSlips))],
        ['median files touched / diff lines', ...col((s) => `${fmtNum(s.files.touched)} / ${fmtNum(s.files.diffLines)}`)],
        ['runs that checked a test without the fix (stash, test, pop) / saw it fail', ...col((s) => `${s.checks.stash} / ${s.checks.failedWithoutFix}`)],
        ['runs with own tests / they fail on the start code / visible tests pass on the final code', ...col((s) => `${s.ownTests.runs} / ${s.ownTests.failsOnStart} / ${s.ownTests.passesOnFinal}${s.ownTests.startNotRun ? ` (${s.ownTests.startNotRun} start runs said nothing)` : ''}`)],
        ['regression gate, runs: looked / proven / passed on old code / reminded / not run / skipped', ...col((s) => (s.gate ? `${s.gate.runs} / ${s.gate.proven} / ${s.gate.passes} / ${s.gate.reminded} / ${s.gate.notRun} / ${s.gate.skipped}` : 'n/a'))],
        ['runs that added tests to an existing test file', ...col((s) => String(s.checks.extendedTests))],
        ['timeouts / caps / invalid', ...col((s) => `${s.problems.timeouts} / ${s.problems.caps} / ${s.problems.invalid}`)],
        ['network attempts / leak suspects / tamper flags', ...col((s) => `${s.problems.network} / ${s.problems.leaks} / ${s.problems.tamper}`)],
      ],
    ),
  );

  // the skills arm: arm A plus catalog items, and what they add to every first request
  if (arms.includes('A+skills') && arms.includes('A')) {
    const fa = st('A').firstRequest;
    const fs = st('A+skills').firstRequest;
    const size = fa !== null && fs !== null ? `${fmtNum(fs - fa)} tokens larger than arm A's (median ${fmtNum(fs)} against ${fmtNum(fa)})` : 'not measured (no tap data)';
    const items = (manifest.skills ?? []).map((x: string) => `\`${x}\``).join(', ') || 'catalog items';
    lines.push(`\nA+skills is arm A with ${items} installed into its hub. Its first request is ${size}.`);
  }

  // 4. paired
  if (pr) {
    lines.push('\n## Paired results (A vs B)\n');
    lines.push(
      [
        `- Tasks with valid runs in both arms: ${pr.n}.`,
        `- Both pass${repeats > 1 ? ' (or the same share of repeats)' : ''}: ${pr.both.length}${pr.both.length ? ` (${pr.both.join(', ')})` : ''}.`,
        `- Only A passes: ${pr.onlyA.length}${pr.onlyA.length ? ` (${pr.onlyA.join(', ')})` : ''}.`,
        `- Only B passes: ${pr.onlyB.length}${pr.onlyB.length ? ` (${pr.onlyB.join(', ')})` : ''}.`,
        `- Neither: ${pr.neither.length}${pr.neither.length ? ` (${pr.neither.join(', ')})` : ''}.`,
        `- Sign test on the discordant tasks: p = ${fmtNum(pr.p, 3)}.`,
        `- Mean pass difference A minus B: ${fmtNum(pr.meanDiff, 2)}, 90% bootstrap interval ${fmtCi(pr.diffCi, (x) => x.toFixed(2))}.`,
        `- Geometric mean A/B ratios: list cost ${pr.cost ? `${ratio(pr.cost.ratio)} (${fmtCi(pr.cost.ci, ratio)})` : 'n/a'}, total tokens ${pr.tokens ? `${ratio(pr.tokens.ratio)} (${fmtCi(pr.tokens.ci, ratio)})` : 'n/a'}, wall time ${pr.wall ? `${ratio(pr.wall.ratio)} (${fmtCi(pr.wall.ci, ratio)})` : 'n/a'}.`,
      ].join('\n'),
    );
    // harness causes where A failed and B passed
    lines.push('\n### Where A failed and B passed\n');
    if (!pr.onlyB.length) lines.push('None.');
    for (const task of pr.onlyB) {
      const a = results.filter((r) => r.task_id === task && r.arm === 'A' && eligible(r));
      const b = results.filter((r) => r.task_id === task && r.arm === 'B' && eligible(r));
      const causes = new Set<string>();
      for (const r of a) {
        if (r.timed_out) causes.add('hit the time limit');
        if (r.capped) causes.add('hit the token cap');
        if (r.status === 'error') causes.add(`ended with an error: ${String(r.error ?? '').slice(0, 120)}`);
        if (r.tools?.edit_misses) causes.add(`${r.tools.edit_misses} edit misses`);
        if (r.tools?.failed) causes.add(`${r.tools.failed} failed tool calls${r.tools.failed_examples?.length ? ` (${r.tools.failed_examples[0].slice(0, 100)})` : ''}`);
        if (r.no_claim) causes.add('no RESULT line');
        if (r.claim === 'DONE') causes.add('claimed DONE on failing work');
        if (r.shell?.ran_tests === false) causes.add('never ran the tests');
        const bt = mean(b.map((x) => x.turns?.main).filter((x) => typeof x === 'number'));
        if (bt && r.turns?.main !== null && r.turns?.main < bt / 2) causes.add(`stopped early (${r.turns.main} turns vs ${Math.round(bt)} for B)`);
        if (r.tests?.build_error) causes.add('the hidden tests did not build');
        if (r.extra?.compactions) causes.add(`context was compacted ${r.extra.compactions} times`);
        if (r.repeated_calls >= 3) causes.add(`stuck loop: the same call ${r.repeated_calls} times in a row`);
        if (typeof r.exit_code === 'number' && r.exit_code !== 0 && !r.timed_out && !r.capped) causes.add(`the agent exited with code ${r.exit_code}`);
        if (r.status && !['completed', 'idle', 'error'].includes(r.status)) causes.add(`the session ended in status ${r.status}`);
      }
      lines.push(`- ${task}: ${[...causes].join('; ') || 'no harness problem visible in the metrics; read the run folders'} (runs ${a.map((r) => r.run_id).join(', ')} vs ${b.map((r) => r.run_id).join(', ')})`);
    }
  }

  // 5. per task
  lines.push('\n## Per task\n');
  const tasks = [...new Set(results.map((r) => r.task_id))].sort();
  const header = ['task', 'kind', 'diff.'];
  for (const a of arms) header.push(`${a} pass`, `${a} partial`, `${a} wall`, `${a} list $`, `${a} tokens`, `${a} turns`, `${a} claim`);
  header.push('judge prefers');
  const rows: Array<Array<string | number>> = [];
  for (const t of tasks) {
    const rs = results.filter((r) => r.task_id === t);
    const row: Array<string | number> = [t, rs[0]?.kind ?? '', rs[0]?.difficulty ?? ''];
    for (const a of arms) {
      const ar = rs.filter((r) => r.arm === a && eligible(r));
      if (!ar.length) {
        row.push(rs.some((r) => r.arm === a) ? 'invalid' : 'n/a', '', '', '', '', '', '');
        continue;
      }
      row.push(
        ar.map((r) => (r.tests?.pass ? 'yes' : 'no')).join('/'),
        ar.map((r) => fmtPct(r.tests?.partial)).join('/'),
        ar.map((r) => fmtS(r.wall_ms)).join('/'),
        ar.map((r) => fmtUsd(r.cost?.list_usd)).join('/'),
        ar.map((r) => fmtNum(tokTotal(r))).join('/'),
        ar.map((r) => fmtNum(r.turns?.main)).join('/'),
        ar.map((r) => r.claim ?? 'none').join('/'),
      );
    }
    const prefs = [...new Set(rs.map((r) => judge.get(r.run_id)?.task_preference).filter(Boolean))];
    row.push(prefs.join(', ') || 'n/a');
    rows.push(row);
  }
  lines.push(table(header, rows));

  // 5b. every judge side by side
  const js = judgeSummaries(results, judges, arms);
  if (js.judges.length) {
    lines.push('\n## Judges\n');
    lines.push(`The main tables use the first judge of the set, \`${js.judges[0].model}\`.${js.judges.length > 1 ? ' Scores are means over counted runs; preferences count task groups (task and repeat).' : ''}\n`);
    const prefCell = (p: Record<string, number>) => [...arms, 'tie', 'tie (order sensitive)'].filter((k) => p[k]).map((k) => `${k} ${p[k]}`).join(', ') || 'none';
    lines.push(
      table(
        ['judge', 'effort', 'runs judged', ...arms.map((a) => `${a} correctness / minimal / readability`), 'tampering yes', 'preferences', 'reasoning tokens'],
        js.judges.map((j) => [
          `${j.model}${j.provider ? ` (${j.provider})` : ''}`,
          j.effort ?? 'default',
          j.judged,
          ...arms.map((a) => (j.perArm[a].n ? `${fmtNum(j.perArm[a].correctness, 2)} / ${fmtNum(j.perArm[a].minimal, 2)} / ${fmtNum(j.perArm[a].readability, 2)}` : 'n/a')),
          arms.map((a) => `${a} ${j.perArm[a].tampering}`).join(', '),
          prefCell(j.preferences),
          fmtNum(j.reasoningTokens),
        ]),
      ),
    );
    if (js.agreement.length) {
      lines.push('\nAgreement on the preferred arm, over task groups both judges scored:\n');
      lines.push(
        table(
          ['judges', 'groups', 'same arm', 'both tie', 'one tie', 'opposite arms'],
          js.agreement.map((g) => [`${g.a} vs ${g.b}`, g.groups, g.sameArm, g.bothTie, g.oneTie, g.opposite]),
        ),
      );
    }
  }

  // 6. judge notes
  lines.push('\n## Judge notes\n');
  if (judges.length > 1) lines.push(`From \`${judges[0].model}\`.\n`);
  const notes = tasks.flatMap((t) =>
    results
      .filter((r) => r.task_id === t && judge.get(r.run_id)?.notes)
      .sort((x, y) => x.arm.localeCompare(y.arm))
      .map((r) => `- ${t} r${r.repeat} ${r.arm}: ${judge.get(r.run_id)!.notes}`),
  );
  lines.push(notes.length ? notes.join('\n') : 'No judge results yet. Run `bench judge --set <name>`.');
  const jerr = judgeLines.filter((j) => j.judge_error);
  if (jerr.length) lines.push(`\nJudge errors: ${jerr.map((j) => `${j.run_id} (${j.judge_model}: ${j.judge_error})`).join('; ')}.`);

  // 7. problems
  lines.push('\n## Run problems\n');
  const probs: string[] = [];
  for (const r of results.sort((x, y) => x.task_id.localeCompare(y.task_id))) {
    const p: string[] = [];
    if (!r.valid) p.push(`invalid: ${r.invalid_reason}`);
    if (r.timed_out) p.push('timed out');
    if (r.capped) p.push('token cap');
    if (r.flags?.leak_suspect) p.push(`leak suspect (${(r.flags.leak_evidence ?? []).slice(0, 2).join('; ')})`);
    if (r.flags?.network_attempt) p.push('network attempt');
    if (r.diff?.modified_existing_tests?.length) p.push(`changed existing tests: ${r.diff.modified_existing_tests.join(', ')}`);
    if (r.diff?.suspicious_files?.length) p.push(`suspicious files: ${r.diff.suspicious_files.join(', ')}`);
    if (r.tests?.moved_aside?.length) p.push(`moved aside before scoring: ${r.tests.moved_aside.join(', ')}`);
    if (r.tests?.shadowed?.length) p.push(`its own file at a hidden test path was kept in .bench-moved/ (not run): ${r.tests.shadowed.join(', ')}`);
    if (r.tests?.links_removed?.length) p.push(`links out of the repo removed before scoring: ${r.tests.links_removed.join(', ')}`);
    if (r.tests?.not_run?.length) p.push(`hidden test files did not run (target pointed elsewhere): ${r.tests.not_run.join(', ')}`);
    if (r.flags?.forbidden_tools_offered?.length) p.push(`denied tools offered to the model: ${r.flags.forbidden_tools_offered.join(', ')}`);
    if (r.flags?.prompt_not_found) p.push('the task prompt was not found in the first model request');
    if (r.flags?.hidden_lines_seen && !r.flags?.leak_suspect) p.push(`shown ${r.flags.hidden_lines_seen} hidden test line(s) it did not write (below the leak bar)`);
    if (r.isolation?.neighbours?.length) p.push(`sandbox neighbours: ${r.isolation.neighbours.slice(0, 3).join(', ')}`);
    if (r.isolation?.env_bench_paths?.length || r.isolation?.argv_bench_paths?.length) p.push('a bench path was in the agent env or argv');
    if (r.isolation?.stragglers_killed?.length) p.push(`killed ${r.isolation.stragglers_killed.length} leftover process(es)`);
    if (r.isolation?.foreign_bench_processes?.length) p.push(`other processes named hidden paths during the run: ${r.isolation.foreign_bench_processes.length}`);
    if (p.length) probs.push(`- ${r.run_id} (${r.task_id}, ${r.arm}, repeat ${r.repeat}): ${p.join('; ')}`);
  }
  lines.push(probs.length ? probs.join('\n') : 'None.');

  // 8. noise
  lines.push('\n## Noise floor\n');
  if (repeats >= 2) {
    for (const a of arms) {
      let pairs = 0;
      let disagree = 0;
      for (const t of tasks) {
        const rr = results.filter((r) => r.task_id === t && r.arm === a && eligible(r));
        if (rr.length >= 2) {
          pairs++;
          if (new Set(rr.map((r) => !!r.tests?.pass)).size > 1) disagree++;
        }
      }
      lines.push(`- ${a}: the two repeats disagree on pass in ${disagree} of ${pairs} tasks (${fmtPct(pairs ? disagree / pairs : null)}).`);
    }
  } else lines.push('Only one repeat, so run to run noise is not measured. Treat single task gaps as noise.');
  lines.push(`\nThe proxy adds a few input tokens of its own to every request; both arms pay it. Other load on the server during the set is not controlled.`);

  // 9. reproduce
  lines.push('\n## Reproduce\n');
  lines.push('```\n' + (manifest.command ?? '') + '\n```');

  const md = lines.join('\n') + '\n';
  const json = { set: manifest.set, dry_run: !!dry, confidence, arms: stats, paired: pr, judges: js, runs: results.length, eligible: results.filter(eligible).length };
  writeText(join(setDir, 'summary.md'), md);
  writeJson(join(setDir, 'summary.json'), json);
  return { md, json };
}

export function hasResults(setDir: string): boolean {
  return existsSync(join(setDir, 'results.jsonl'));
}
