#!/usr/bin/env bun
/** Offline harness comparison: one operator-provided edit, two isolated Conclave bench sets, human decision. */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFlags, runOptions } from './bench';
import { latestRuns } from './lib/report';
import { runSet, type RunOptions } from './lib/runset';
import { readJson, readJsonl } from './lib/util';

type Row = {
  task_id: string; repeat: number; valid: boolean; flags?: { leak_suspect?: boolean };
  tests?: { pass: boolean; passed: number }; cost?: { list_usd: number | null };
  own_tests?: { fails_on_start: boolean | null; passes_on_final: boolean | null } | null;
  regression_gate?: { proven: number; passes: number; not_run: number; skipped: number; reminded: number } | null;
};

/** No candidate can win on an unpaired run or a hidden-test regression. */
export function compare(baseline: Row[], candidate: Row[], repeats: number) {
  const pairs = new Map(candidate.filter((r) => r.valid && !r.flags?.leak_suspect).map((r) => [`${r.task_id}#${r.repeat}`, r]));
  const regressions: string[] = [];
  let improvements = 0;
  let paired = 0;
  const eligible = baseline.filter((r) => r.valid && !r.flags?.leak_suspect);
  for (const b of eligible) {
    const key = `${b.task_id}#${b.repeat}`;
    const c = pairs.get(key);
    if (!c) continue;
    paired++;
    if (c.tests!.passed < b.tests!.passed || (b.tests!.pass && !c.tests!.pass)) regressions.push(key);
    if (!b.tests!.pass && c.tests!.pass) improvements++;
  }
  const complete = eligible.length > 0 && eligible.every((r) => pairs.has(`${r.task_id}#${r.repeat}`)) &&
    eligible.length === new Set(eligible.map((r) => r.task_id)).size * repeats;
  const decision = regressions.length ? 'regression: stop' : !complete ? 'incomplete' : improvements ? 'candidate for human review' : 'keep baseline';
  return { decision, paired, expected: eligible.length, improvements, regressions };
}

export function remainingUsd(cap: number, results: Row[]): number {
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('cost cap must be a positive USD amount');
  const costs = results.map((r) => r.cost?.list_usd);
  if (costs.some((x) => x === null || x === undefined || !Number.isFinite(x))) throw new Error('unknown list-price cost; cannot enforce cost cap');
  const left = cap - costs.reduce<number>((n, x) => n + (x ?? 0), 0);
  return Math.max(0, left);
}

const HELP = 'Usage: bun bench/improve.ts --baseline-src <checkout> --candidate-src <checkout> --set <name> --model <id> --budget-usd <cap> [--tasks smoke|ids] [--repeats 2] [--dry-run]\nRuns arm A only, once per checkout. No merge or deploy.\n';

export async function main(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flags.help) { process.stdout.write(HELP); return 0; }
  const value = (key: string) => typeof flags[key] === 'string' ? flags[key] as string : undefined;
  const baselineSrc = value('baseline-src');
  const candidateSrc = value('candidate-src');
  const name = value('set');
  if (!baselineSrc || !candidateSrc || !name || !/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error('pass --baseline-src, --candidate-src and a safe --set name');
  if (!value('budget-usd')) throw new Error('pass an explicit --budget-usd cost cap');
  const baselinePath = realpathSync(resolve(baselineSrc));
  const candidatePath = realpathSync(resolve(candidateSrc));
  if (baselinePath === candidatePath) throw new Error('baseline and candidate checkouts must differ');
  for (const src of [baselinePath, candidatePath]) {
    if (!existsSync(join(src, 'packages/cli/src/index.ts'))) throw new Error(`not a Conclave checkout: ${src}`);
  }
  const o = runOptions({ ...flags, arms: 'A', 'no-judge': true }, argv);
  if (!Number.isInteger(o.repeats) || o.repeats < 1) throw new Error('--repeats must be a positive integer');
  if (o.resume) throw new Error('improvement runs cannot be resumed through this command; inspect the partial results');
  const baselineDir = join(o.out, `${name}-baseline`);
  const candidateDir = join(o.out, `${name}-candidate`);
  if (existsSync(baselineDir) || existsSync(candidateDir)) throw new Error('set already exists; choose a new --set name');
  const cap = Number(value('budget-usd'));
  remainingUsd(cap, []);
  const base: RunOptions = { ...o, arms: ['A'], noJudge: true, budgetUsd: cap };
  const bCode = await runSet({ ...base, set: `${name}-baseline`, conclaveSrc: baselinePath });
  if (!existsSync(join(baselineDir, 'manifest.json'))) return bCode || 3;
  const baseline = latestRuns(readJsonl<Row & { run_id: string }>(join(baselineDir, 'results.jsonl')));
  const manifest = readJson(join(baselineDir, 'manifest.json'));
  if (bCode || manifest.skipped.length || baseline.length !== manifest.plan.length || baseline.some((r: Row) => !r.valid || r.flags?.leak_suspect)) {
    process.stderr.write('Baseline incomplete or invalid. Candidate not run.\n');
    return bCode || 3;
  }
  const candidateBudget = remainingUsd(cap, readJsonl(join(baselineDir, 'results.jsonl')));
  if (candidateBudget === 0) {
    process.stderr.write('Baseline cost cap reached; candidate not run.\n');
    return 3;
  }
  const cCode = await runSet({ ...base, set: `${name}-candidate`, conclaveSrc: candidatePath, budgetUsd: candidateBudget },
    (rows) => compare(baseline, latestRuns(rows), o.repeats).regressions.length > 0);
  if (!existsSync(join(candidateDir, 'manifest.json'))) return cCode || 3;
  const candidate = latestRuns(readJsonl<Row & { run_id: string }>(join(candidateDir, 'results.jsonl')));
  const result = compare(baseline, candidate, o.repeats);
  const total = readJsonl<Row>(join(baselineDir, 'results.jsonl')).concat(readJsonl<Row>(join(candidateDir, 'results.jsonl')));
  const knownCosts = total.every((r) => typeof r.cost?.list_usd === 'number' && Number.isFinite(r.cost.list_usd));
  const spend = total.reduce((n, r) => n + (r.cost?.list_usd ?? 0), 0);
  const decision = knownCosts && spend <= cap ? result.decision : 'incomplete: cost cap or unknown cost';
  const metrics = (rows: Row[]) => `own tests (fail start/pass final): ${rows.filter((r) => r.own_tests?.fails_on_start && r.own_tests?.passes_on_final).length}/${rows.length}; regression gate proven: ${rows.filter((r) => (r.regression_gate?.proven ?? 0) > 0).length}/${rows.length}`;
  const text = `# Harness improvement: ${name}\n\n- Baseline: ${baselinePath} (${manifest.conclave.commit}); candidate: ${candidatePath} (${readJson(join(candidateDir, 'manifest.json')).conclave.commit}).\n- Model: ${o.model}; tasks: ${manifest.tasks.join(', ')}; repeats: ${o.repeats}; seed: ${o.seed}.\n- Decision: **${decision}**. Human review only; no merge or deploy.\n- Hidden tests: ${result.paired}/${result.expected} paired; ${result.improvements} improved; ${result.regressions.length} regressed${result.regressions.length ? ` (${result.regressions.join(', ')})` : ''}.\n- Baseline ${metrics(baseline)}.\n- Candidate ${metrics(candidate)}.\n- Recorded run list cost: $${spend.toFixed(2)} / $${cap.toFixed(2)} cap. The cap and reported spend exclude doctor preflight model requests (one per started set); doctor exposes no usage or cost.\n- Details: [baseline](../${name}-baseline/summary.md), [candidate](../${name}-candidate/summary.md).\n`;
  writeFileSync(join(candidateDir, 'comparison.md'), text);
  process.stdout.write(text);
  return cCode || (result.regressions.length ? 4 : decision.startsWith('incomplete') ? 3 : 0);
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`[improve] error: ${(e as Error).message}\n`);
  process.exit(1);
});
