#!/usr/bin/env bun
/**
 * Fault injection, end to end (bench/lib/fake-agent.ts --fault). Each case runs
 * a real dry-run set through bench/run.ts with a fake agent that goes wrong in
 * one way, then checks results.jsonl, the summary and the process table:
 *
 *   timeout, a hard hang that ignores signals and leaves background processes,
 *   crashes (after work and before any model call), connection errors,
 *   tampering with the hidden test paths and test config, links out of the
 *   repo, deleting files or the whole repo, loops, runaway token use,
 *   rate limits (with and without a reset time), the token and wall budgets,
 *   one and two Ctrl-C, kill -9 of the runner, and --resume after each stop.
 *
 *   bun bench/checks/faults.ts            all cases (about two minutes)
 *   bun bench/checks/faults.ts --quick    Python and Bun tasks only (skips the Go and Rust builds)
 *
 * The knobs it uses work in dry runs only: BENCH_FAULTS (which fault for which
 * task, arm and attempt, see dryFault in lib/runset.ts), BENCH_FAULT_CANARY,
 * BENCH_DRY_LIMIT_S (time limit) and BENCH_DRY_KILL_STEP_MS (kill steps).
 *
 * No model is called. Work goes to a fresh folder under the system temp dir
 * (or BENCH_FAULTS_DIR); nothing under bench/ changes.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const BENCH = resolve(import.meta.dir, '..');
const REPO = dirname(BENCH);
const quick = process.argv.includes('--quick');
const root = process.env.BENCH_FAULTS_DIR ?? mkdtempSync(join(tmpdir(), 'bench-faults-'));
const state = join(root, 'state');
const work = join(root, 'work');
const out = join(root, 'out');
const canary = join(root, 'canary');
mkdirSync(state, { recursive: true });

type Row = Record<string, any>;
let failed = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (!ok) failed++;
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && d ? `\n     ${d.slice(0, 600)}` : ''}\n`);
}

const PY = 'feat-py-purge';
const PY2 = 'bug-py-utf8';
const TS = 'bug-ts-cents';
const SLOW = ['pg-py-bowling', 'pg-js-react', 'pg-go-word-search', 'pg-rs-luhn-from'];
const ALL = [PY, PY2, TS, ...(quick ? [] : SLOW)];

/** Reuse the kit's last validation when it covers these tasks; else validate them into the private state. */
async function ensureValidated(tasks: string[]): Promise<void> {
  const own = join(BENCH, '.state', 'validate.json');
  if (existsSync(own)) {
    const res = JSON.parse(readFileSync(own, 'utf8')).results as Row[];
    if (tasks.every((t) => res.find((r) => r.id === t)?.ok)) {
      copyFileSync(own, join(state, 'validate.json'));
      return;
    }
  }
  process.stdout.write(`validating ${tasks.join(', ')} ...\n`);
  const p = Bun.spawn(['bun', join(BENCH, 'bench.ts'), 'validate', '--tasks', tasks.join(',')], { cwd: REPO, env: { ...process.env, BENCH_STATE: state, BENCH_WORK: join(root, 'vwork') }, stdout: 'ignore', stderr: 'pipe' });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) {
    process.stdout.write(err);
    throw new Error('validate failed; fix the tasks first');
  }
}

interface SetRun {
  code: number | null;
  log: string;
  rows: Row[];
  ms: number;
  summary: string;
}

/** Processes whose command line holds `marker`. */
function alive(marker: string): string[] {
  const hits: string[] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll('\0', ' ');
      if (cmd.includes(marker)) hits.push(`${pid} ${cmd.slice(0, 120)}`);
    } catch {
      /* gone */
    }
  }
  return hits;
}

async function waitFor(f: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await Bun.sleep(100);
  }
  return f();
}

/**
 * One set through bench/run.ts. `signal` is sent to the runner once the first
 * fake agent of the set runs: INT, INT twice, or KILL.
 */
async function runSet(set: string, tasks: string[], faults: Record<string, unknown>, flags: string[] = [], o: { limitS?: number; stepMs?: number; signal?: 'INT' | 'INT2' | 'KILL'; signalOnLog?: RegExp } = {}): Promise<SetRun> {
  const t0 = Date.now();
  const argv = ['bun', join(BENCH, 'run.ts'), '--dry-run', '--tasks', tasks.join(','), '--skip-validate', '--no-judge', '--set', set, '--out', out, ...flags];
  const env = { ...process.env, BENCH_STATE: state, BENCH_WORK: work, BENCH_FAULTS: JSON.stringify(faults), BENCH_FAULT_CANARY: canary, BENCH_DRY_LIMIT_S: String(o.limitS ?? 2), BENCH_DRY_KILL_STEP_MS: String(o.stepMs ?? 300) };
  const p = Bun.spawn(argv, { cwd: REPO, env, stdout: 'ignore', stderr: 'pipe' });
  let logBuf = '';
  const logP = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of p.stderr as unknown as AsyncIterable<Uint8Array>) logBuf += dec.decode(chunk, { stream: true });
    return logBuf;
  })();
  if (o.signal) {
    const marker = `--cwd ${join(work, set)}/`;
    if (o.signalOnLog) await waitFor(() => o.signalOnLog!.test(logBuf), 20_000);
    else await waitFor(() => alive(marker).length > 0, 20_000);
    await Bun.sleep(300);
    if (o.signal === 'KILL') p.kill('SIGKILL');
    else {
      p.kill('SIGINT');
      if (o.signal === 'INT2') {
        await Bun.sleep(400);
        p.kill('SIGINT');
      }
    }
  }
  const code = await p.exited;
  const log = await logP;
  const file = join(out, set, 'results.jsonl');
  const rows = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const sf = join(out, set, 'summary.md');
  return { code, log, rows, ms: Date.now() - t0, summary: existsSync(sf) ? readFileSync(sf, 'utf8') : '' };
}

const rowsOf = (r: SetRun, task: string, arm: string) => r.rows.filter((x) => x.task_id === task && x.arm === arm);
const one = (r: SetRun, task: string, arm: string) => rowsOf(r, task, arm).at(-1) ?? {};
const brief = (x: Row) => ({ task: x.task_id, arm: x.arm, attempt: x.attempt, valid: x.valid, inv: x.invalid_reason, pass: x.tests?.pass, timed_out: x.timed_out, capped: x.capped, exit: x.exit_code });

async function main(): Promise<void> {
  process.stdout.write(`fault checks in ${root}${quick ? ' (quick)' : ''}\n`);
  await ensureValidated(ALL);

  // 1. time limit: a hang, and a hard hang that ignores SIGINT and SIGTERM and leaves background processes
  {
    const r = await runSet('timeout', [PY, PY2], { [`${PY}/A`]: 'hang', [`${PY}/B`]: 'hang', [`${PY2}/A`]: 'hang-hard', [`${PY2}/B`]: 'hang-hard' });
    check('timeout: the set finishes', r.code === 0, r.log.slice(-800));
    for (const arm of ['A', 'B']) {
      const h = one(r, PY, arm);
      check(`timeout ${arm}: a hang is a valid run, timed out, scored on the tree it left`, h.valid === true && h.timed_out === true && h.tests?.expected_total === 8, brief(h));
      const hh = one(r, PY2, arm);
      check(`timeout ${arm}: a hard hang ends with SIGKILL and is scored`, hh.valid === true && hh.timed_out === true && hh.exit_code === 137, brief(hh));
      const killed: string[] = hh.isolation?.stragglers_killed ?? [];
      check(`timeout ${arm}: both background processes are killed, the one that left for / too`, killed.some((k) => k.includes('straggler-cwd.log')) && killed.some((k) => k.includes('fake-straggler-home')), killed);
      check(`timeout ${arm}: a child holding stdout does not stall the run`, typeof hh.wall_ms === 'number' && hh.wall_ms < 8_000, hh.wall_ms);
    }
    check('timeout: nothing of the agents is left running', alive('fake-straggler-home').length === 0 && alive('straggler-cwd.log').length === 0, [...alive('fake-straggler-home'), ...alive('straggler-cwd.log')]);
  }

  // 2. crashes and connection errors
  {
    const r = await runSet('crash', [PY, PY2, TS], { [`${PY}/A`]: 'crash', [`${PY}/B`]: 'crash', [`${PY2}/A`]: 'crash-early', [`${TS}/B`]: 'transient' });
    check('crash: the set finishes', r.code === 0, r.log.slice(-800));
    for (const arm of ['A', 'B']) {
      const c = one(r, PY, arm);
      check(`crash ${arm}: a crash after work is a valid run, scored, exit 1`, c.valid === true && c.exit_code === 1 && c.tests?.expected_total === 8, brief(c));
    }
    const early = rowsOf(r, PY2, 'A');
    check('crash: a crash before any model call is invalid (no_model_calls), retried once', early.length === 2 && early.every((x) => x.invalid_reason === 'no_model_calls') && early[1].attempt === 2, early.map(brief));
    const tr = rowsOf(r, TS, 'B');
    check('crash: a connection error is invalid (transient_error), retried once', tr.length === 2 && tr.every((x) => x.invalid_reason === 'transient_error'), tr.map(brief));
    check('crash: the verdict names the tasks left out and the runs not counted', /left out of the comparison/.test(r.summary) && /Runs not counted: A 1 no_model_calls; B 1 transient_error/.test(r.summary), r.summary.split('## Setup')[0]);
    const cause = r.summary.split('### Where A failed and B passed')[1]?.split('\n## ')[0] ?? '';
    if (one(r, PY, 'B').tests?.pass && !one(r, PY, 'A').tests?.pass) check('crash: the causes list says the agent exited early', /exited with code 1/.test(cause), cause);
  }

  // 3. an arm that keeps ending invalid stops the set (its tasks cannot pair)
  {
    const r = await runSet('breaker', [PY, PY2, TS], { 'any/A': 'crash-early' });
    check('breaker: three invalid runs in a row of one arm stop the set with exit 3', r.code === 3 && /ended 3 runs in a row invalid/.test(r.log), { code: r.code, log: r.log.slice(-600) });
  }

  // 4. tampering with the hidden test paths, and links out of the repo
  {
    rmSync(canary, { recursive: true, force: true });
    const r = await runSet('tamper', ALL, { 'any/A': 'tamper', 'any/B': 'symlink' });
    check('tamper: the set finishes', r.code === 0, r.log.slice(-800));
    for (const t of ALL) {
      const a = one(r, t, 'A');
      check(`tamper ${t} A: fake tests at the hidden paths do not pass it`, a.valid === true && a.tests?.pass === false, brief(a));
      check(`tamper ${t} A: claimed DONE, counted as a false success`, a.claim === 'DONE' && a.false_success === true, { claim: a.claim, fs: a.false_success });
      const flagged = (a.diff?.modified_existing_tests?.length ?? 0) + (a.diff?.suspicious_files?.length ?? 0) + (a.tests?.moved_aside?.length ?? 0) + (a.tests?.not_run?.length ?? 0) + (a.tests?.restored?.filter((x: string) => x.endsWith('(deleted)')).length ?? 0);
      if (t !== 'pg-js-react' || a.diff?.suspicious_files?.length) check(`tamper ${t} A: the tampering is flagged`, flagged > 0, a.diff);
      const b = one(r, t, 'B');
      check(`symlink ${t} B: links out of the repo are removed before scoring`, b.valid === true && (b.tests?.links_removed?.length ?? 0) > 0, { links: b.tests?.links_removed, ...brief(b) });
    }
    if (!quick) {
      const rs = one(r, 'pg-rs-luhn-from', 'A').tests ?? {};
      check('tamper: a Cargo [[test]] redirect is caught (the hidden file did not run)', (rs.not_run ?? []).includes('tests/luhn-from.rs'), rs);
      check('tamper: a repo .cargo/config.toml test runner is removed before scoring', (rs.restored ?? []).includes('.cargo/config.toml (deleted)'), rs.restored);
      check('tamper: a go.work file is removed before scoring', (one(r, 'pg-go-word-search', 'A').tests?.restored ?? []).includes('go.work (deleted)'), one(r, 'pg-go-word-search', 'A').tests?.restored);
    }
    const files = existsSync(canary) ? readdirSync(canary, { recursive: true }).map(String).sort() : [];
    check('symlink: the scorer wrote and deleted nothing outside its copy', files.join() === ['dir', 'dir/keep.txt', 'file.txt'].join() && readFileSync(join(canary, 'file.txt'), 'utf8') === 'canary\n', files);
    const ts = one(r, TS, 'B');
    check('symlink: a linked tests/ folder still scores the real tree (the naive fix gets its 18 of 24)', ts.tests?.passed === 18, brief(ts));
  }

  // 5. deleting files, deleting the repo, broken output, loops, a bold RESULT line
  {
    const r = await runSet('misc', [PY, PY2, TS], { [`${PY}/A`]: 'garbage', [`${PY}/B`]: 'loop', [`${PY2}/A`]: 'delete', [`${PY2}/B`]: 'nuke', [`${TS}/A`]: 'claim-bold', [`${TS}/B`]: 'claim-bold' });
    check('misc: the set finishes', r.code === 0, r.log.slice(-800));
    check('misc: broken JSON and control bytes on stdout do not break the parsers', one(r, PY, 'A').valid === true && (one(r, PY, 'A').tools?.calls ?? 0) > 0, brief(one(r, PY, 'A')));
    check('misc: 40 identical calls are seen as a loop', one(r, PY, 'B').repeated_calls === 40, one(r, PY, 'B').repeated_calls);
    for (const [arm, what] of [
      ['A', 'deleting every file'],
      ['B', 'deleting the repo folder'],
    ]) {
      const d = one(r, PY2, arm);
      check(`misc: ${what} is a valid, failing run with the deletions listed`, d.valid === true && d.tests?.pass === false && (d.diff?.files_deleted?.length ?? 0) > 5, brief(d));
    }
    for (const arm of ['A', 'B']) check(`misc ${arm}: "RESULT: **DONE**" counts as a DONE claim`, one(r, TS, arm).claim === 'DONE' && one(r, TS, arm).tests?.pass === true, { claim: one(r, TS, arm).claim, ...brief(one(r, TS, arm)) });
  }

  // 6. runaway token use
  {
    const r = await runSet('runaway', [PY], { any: 'runaway' }, ['--run-token-cap', '1M'], { limitS: 60 });
    for (const arm of ['A', 'B']) {
      const x = one(r, PY, arm);
      check(`runaway ${arm}: the token cap stops the run; it is valid, capped and scored`, x.valid === true && x.capped === true && x.timed_out === false && x.wall_ms < 15_000 && x.tokens?.total > 1_000_000, { ...brief(x), tok: x.tokens?.total, wall: x.wall_ms });
    }
  }

  // 7. rate limits: no reset time stops the set; a near reset waits and retries; resume completes
  {
    let r = await runSet('ratelimit', [PY, PY2], { [`${PY2}/A`]: 'rate-limit' });
    check('rate limit: no reset time stops the set cleanly with exit 3', r.code === 3 && r.rows.length >= 1 && r.rows.at(-1)!.invalid_reason === 'rate_limit' && r.summary.length > 0, { code: r.code, rows: r.rows.map(brief) });
    r = await runSet('ratelimit', [PY, PY2], {}, ['--resume']);
    const plan = JSON.parse(readFileSync(join(out, 'ratelimit', 'manifest.json'), 'utf8')).plan as Row[];
    const valid = new Set(r.rows.filter((x) => x.valid).map((x) => x.run_id));
    check('rate limit: --resume finishes every planned run once', r.code === 0 && plan.every((x) => valid.has(x.run_id)) && r.rows.filter((x) => x.valid).length === plan.length, { code: r.code, rows: r.rows.map(brief) });
    r = await runSet('ratewait', [PY, PY2], { [`${PY2}/A/1`]: { fault: 'rate-limit', resetInS: 1 }, [`${PY2}/A/2`]: { fault: 'rate-limit', resetInS: 1 } });
    const w = rowsOf(r, PY2, 'A');
    check('rate limit: a known reset is waited for, then attempt 2; a second limit stops the set', r.code === 3 && w.length === 2 && w[1].attempt === 2 && /waiting/.test(r.log), w.map(brief));
    r = await runSet('ratewait', [PY, PY2], {}, ['--resume']);
    check('rate limit: after resume the summary counts the run (attempt numbers restart at 1)', r.code === 0 && /Runs in results.jsonl: 4, counted: 4/.test(r.summary), r.summary.split('## Isolation')[0].split('## Setup')[1]);
    r = await runSet('ratectrlc', [PY2], { [`${PY2}/A`]: { fault: 'rate-limit', resetInS: 600 }, [`${PY2}/B`]: { fault: 'rate-limit', resetInS: 600 } }, [], { signal: 'INT', signalOnLog: /rate limit: waiting/ });
    check('rate limit: Ctrl-C during the wait for a reset stops at once, with no second attempt', r.code === 130 && r.ms < 20_000 && r.rows.length === 1, { code: r.code, ms: r.ms, rows: r.rows.map(brief) });
  }

  // 8. budgets
  {
    let r = await runSet('budget', [PY, PY2, TS], {}, ['--budget-tokens', '1']);
    check('budget: the token budget stops after the first group with exit 3', r.code === 3 && r.rows.length === 2 && /over the tokens budget/.test(r.log), { code: r.code, n: r.rows.length });
    check('budget: the summary says the set is not finished', /The set is not finished: 2 of 6/.test(r.summary), r.summary.split('## Setup')[0]);
    r = await runSet('budget', [PY, PY2, TS], {}, ['--resume', '--budget-tokens', '100M']);
    check('budget: --resume with a bigger budget finishes', r.code === 0 && r.rows.filter((x) => x.valid).length === 6, { code: r.code, n: r.rows.length });
    r = await runSet('budget-wall', [PY], {}, ['--budget-minutes', '1']);
    check('budget: a wall budget below one time limit runs nothing, exit 3, no verdict', r.code === 3 && r.rows.length === 0 && /no verdict/.test(r.summary), { code: r.code, n: r.rows.length });
  }

  // 9. Ctrl-C once, Ctrl-C twice, kill -9; resume after each
  {
    let r = await runSet('sigint', [PY, PY2], { [`${PY}/A`]: 'hang', [`${PY}/B`]: 'hang' }, [], { limitS: 60, signal: 'INT' });
    check('SIGINT: the current run is stopped and stored as interrupted, exit 130, summary written', r.code === 130 && r.rows.length === 1 && r.rows[0].invalid_reason === 'interrupted' && r.summary.length > 0, { code: r.code, rows: r.rows.map(brief) });
    r = await runSet('sigint', [PY, PY2], {}, ['--resume']);
    check('SIGINT: --resume finishes the plan', r.code === 0 && r.rows.filter((x) => x.valid).length === 4, r.rows.map(brief));

    r = await runSet('sigint2', [PY], { any: 'hang-hard' }, [], { limitS: 60, stepMs: 20_000, signal: 'INT2' });
    check('SIGINT twice: exits at once with 130', r.code === 130 && r.ms < 15_000 && /second SIGINT/.test(r.log), { code: r.code, ms: r.ms });
    const left = await waitFor(() => alive(`--cwd ${join(work, 'sigint2')}/`).length === 0 && alive('fake-straggler-home').length === 0, 3_000);
    check('SIGINT twice: no agent or background process is left', left, [...alive(join(work, 'sigint2')), ...alive('fake-straggler-home')]);

    r = await runSet('kill9', [PY, PY2], { [`${PY}/A`]: 'hang', [`${PY}/B`]: 'hang' }, [], { limitS: 60, signal: 'KILL' });
    const orphan = await waitFor(() => alive(`--cwd ${join(work, 'kill9')}/`).length === 0, 5_000);
    check('kill -9: the watchdog ends the orphaned agent', r.code !== 0 && orphan, alive(join(work, 'kill9')));
    check('kill -9: the sandbox is left behind', existsSync(join(work, 'kill9')) && readdirSync(join(work, 'kill9')).length === 1, existsSync(join(work, 'kill9')) ? readdirSync(join(work, 'kill9')) : []);
    r = await runSet('kill9', [PY, PY2], {}, ['--resume']);
    check('kill -9: --resume removes the old sandbox, no run sees a neighbour, the plan finishes', r.code === 0 && /removed 1 sandbox folder/.test(r.log) && r.rows.every((x) => !(x.isolation?.neighbours ?? []).length) && r.rows.filter((x) => x.valid).length === 4, { code: r.code, rows: r.rows.map((x) => ({ ...brief(x), n: x.isolation?.neighbours })) });
  }

  if (!process.env.BENCH_FAULTS_DIR) rmSync(root, { recursive: true, force: true });
  process.stdout.write(failed ? `\n${failed} check(s) failed (work kept in ${root})\n` : '\nall fault checks passed\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
