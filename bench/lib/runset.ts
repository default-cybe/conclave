/** `bench run` (PROTOCOL 7, 11): plan a set, run it one agent at a time, score every run. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { armArgv, DEFAULT_SKILLS, forbiddenOffered, isHubArm, runArm, VERDICT_ARMS, type ArmId, type ClaudeFlags } from './arms';
import { baseEnv, benchPathsIn, claudeConfig, proxyConfig, STATE_DIR } from './env';
import { coderThinking, type HubOptions } from './hub';
import { buildCanaries, isLeak, leakEvidence, leakMarkers, type LeakProbe } from './leaks';
import { derive, listCost, listCostTap, totalTokens, type Prices } from './metrics';
import { ownTestsCheck, scoreTree } from './score';
import { summarizeTap, Tap } from './tap';
import { loadTasks, refreshFixtureTasks, taskPrompt, type Task } from './tasks';
import { appendJsonl, BENCH_DIR, isoNow, log, quantile, randomId, readJson, readJsonl, seedOf, shuffle, sleep, sum, writeJson, writeText } from './util';
import { lastValidation, validateTasks } from './validate';
import { killLive } from './proc';
import { computeDiff, foreignBenchProcesses, killStragglers, killStragglersNow, makeWorkCopy, retireWorkCopy, sandboxNeighbours } from './workcopy';
import { doctor, printDoctor, type DoctorReport } from './doctor';
import { judgeEffortFor, judgeProviderFor, judgeSet } from './judge';
import { writeReport } from './report';

export interface RunOptions {
  arms: ArmId[];
  /** Catalog items for the A+skills arm. */
  skills?: string[];
  tasks: string;
  repeats: number;
  model: string;
  smallModel?: string;
  seed: number;
  set?: string;
  out: string;
  bTransport: 'auto' | 'login' | 'proxy';
  budgetTokens: number;
  budgetUsd: number | null;
  budgetWallMs: number;
  runTokenCap: number;
  maxWaitMs: number;
  matchEffort: string | null;
  conclaveSrc: string;
  hubPort: number;
  /** Port of the tap (default hubPort - 1). 0 turns the tap off. */
  tapPort?: number;
  dryRun: boolean;
  resume: boolean;
  noJudge: boolean;
  judgeModel?: string;
  /** anthropic or openai; default from the judge model id. */
  judgeProvider?: string;
  judgeEffort?: string;
  judgeSwap: boolean;
  skipValidate: boolean;
  keepWork: boolean;
  command: string;
}

interface PlanItem {
  run_id: string;
  task_id: string;
  arm: ArmId;
  repeat: number;
  group: number;
  order_in_group: number;
}

/**
 * Tasks in a seeded order; within each group the arms take turns going first.
 * The arm order is a rotation of one seeded shuffle, so with N groups each arm
 * goes first N/arms times (give or take one), not just "about half" as a coin
 * flip per group would give. Going first or second can matter (prompt cache
 * warmth, time of day), so the balance is exact.
 */
export function makePlan(taskIds: string[], arms: ArmId[], repeats: number, seed: number): PlanItem[] {
  const plan: PlanItem[] = [];
  let group = 0;
  const base = shuffle(arms, seedOf(`arms#${seed}`));
  for (const t of shuffle(taskIds, seed)) {
    for (let rep = 1; rep <= repeats; rep++) {
      const k = group % base.length;
      group++;
      const order = [...base.slice(k), ...base.slice(0, k)];
      order.forEach((arm, i) => plan.push({ run_id: randomId(6), task_id: t, arm, repeat: rep, group, order_in_group: i + 1 }));
    }
  }
  return plan;
}

/** How often each arm went first in a plan. */
export function firstCounts(plan: PlanItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of plan) if (x.order_in_group === 1) out[x.arm] = (out[x.arm] ?? 0) + 1;
  return out;
}

function maxRepeat(calls: Array<{ name: string; input: unknown }> | null): number | null {
  if (!calls) return null;
  let best = 0;
  let cur = 0;
  let prev = '';
  for (const c of calls) {
    const k = c.name + JSON.stringify(c.input);
    cur = k === prev ? cur + 1 : 1;
    prev = k;
    best = Math.max(best, cur);
  }
  return best;
}

/** Fake outcomes for --dry-run: each task gets one good and one bad run across A and B. */
function fakeOutcome(taskId: string, arm: ArmId, repeat: number): { outcome: 'good' | 'bad'; claim: 'DONE' | 'NOT DONE' | 'none'; seed: number } {
  const h = seedOf(taskId);
  const armBit = arm === 'A' ? 0 : arm === 'B' ? 1 : 2;
  const good = (h + armBit + repeat) % 2 === 0;
  const s = seedOf(`${taskId}#${arm}#${repeat}`);
  const pick = s % 10;
  const claim = good ? (pick < 9 ? 'DONE' : 'none') : pick < 4 ? 'DONE' : pick < 8 ? 'NOT DONE' : 'none';
  return { outcome: good ? 'good' : 'bad', claim, seed: s };
}

/** The sandbox of the run in progress, for the second Ctrl-C. */
let currentSandbox: string | null = null;


/**
 * Dry runs only: a fault for the fake agent (bench/checks/faults.ts). BENCH_FAULTS
 * is JSON; keys are "task/arm/attempt", "task/arm", "task", "any/arm" or "any",
 * the most specific first; a value is a fault name or {"fault", "resetInS"}.
 */
export function dryFault(taskId: string, arm: ArmId, attempt: number): { fault?: string; canary?: string; resetInS?: number } {
  const raw = process.env.BENCH_FAULTS;
  if (!raw) return {};
  const map = JSON.parse(raw) as Record<string, string | { fault: string; resetInS?: number }>;
  const hit = [`${taskId}/${arm}/${attempt}`, `${taskId}/${arm}`, taskId, `any/${arm}`, 'any'].map((k) => map[k]).find((v) => v !== undefined);
  if (hit === undefined) return {};
  const v = typeof hit === 'string' ? { fault: hit } : hit;
  return { fault: v.fault, resetInS: v.resetInS, canary: process.env.BENCH_FAULT_CANARY };
}

/** Dry runs only: a shorter time limit and kill steps, so the fault checks run in seconds. */
function dryLimitS(o: RunOptions, t: Task): number {
  return o.dryRun && process.env.BENCH_DRY_LIMIT_S ? Number(process.env.BENCH_DRY_LIMIT_S) : t.time_limit_s;
}

/** Invalid reasons that say nothing about the agent; any other invalid run counts toward the breaker. */
const OUTSIDE_REASONS = new Set(['interrupted', 'rate_limit']);
/** Stop the set when one arm ends this many runs in a row invalid: its pairs are lost and the other arm's runs would be wasted. */
export const INVALID_STREAK_STOP = 3;

export function servedMatches(arm: ArmId, requested: string, served: string[]): boolean {
  if (arm === 'C' || arm === 'D') return true;
  const strip = (s: string) => s.replace(/^(bench-claude|cliproxy)\//, '').replace(/^neu\//, '');
  const want = strip(requested);
  // a proxy account prefix (neu/claude-...) may come back without the prefix; a dated id is the same model
  return served.every((s) => strip(s) === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-20\\d{6}$`).test(strip(s)));
}

export async function runSet(o: RunOptions, stopAfterGroup?: (results: any[]) => boolean): Promise<number> {
  const prices = readJson<Prices>(join(BENCH_DIR, 'prices.json'));
  const p = claudeConfig();
  const env = await baseEnv([p.host]);
  const date = new Date().toISOString().slice(0, 10);
  let manifest: any;
  let setName = o.set;
  let plan: PlanItem[];
  let tasks: Task[];
  let doc: DoctorReport;
  const workBase = process.env.BENCH_WORK ?? '/tmp/conclave-bench';

  if (o.resume) {
    if (!setName) throw new Error('--resume needs --set <name>');
    const setDir = join(o.out, setName);
    manifest = readJson(join(setDir, 'manifest.json'));
    plan = manifest.plan;
    tasks = loadTasks(manifest.tasks.join(','));
    o = { ...o, arms: manifest.arms, repeats: manifest.repeats, model: manifest.model, smallModel: manifest.small_model, seed: manifest.seed, matchEffort: manifest.match_effort, skills: manifest.skills ?? undefined, dryRun: manifest.dry_run, conclaveSrc: manifest.conclave?.src ?? o.conclaveSrc, budgetUsd: manifest.budgets?.usd ?? o.budgetUsd };
    doc = await doctor({ model: o.model, smallModel: o.smallModel, conclaveSrc: o.conclaveSrc, hubPort: o.hubPort, tapPort: o.tapPort, workRoot: join(workBase, setName), bTransport: manifest.b_transport.chosen, arms: o.arms, dryRun: o.dryRun });
    log(`resuming set ${setName}`);
  } else {
    const ci = await (await import('./doctor')).conclaveInfo(o.conclaveSrc);
    setName ??= `${o.dryRun ? 'dry-' : ''}${date}-${o.model.replace(/[^\w.-]+/g, '_')}-${ci.commit ?? 'nogit'}${o.matchEffort ? `-effort-${o.matchEffort}` : ''}`;
    const setDir = join(o.out, setName);
    if (existsSync(join(setDir, 'results.jsonl'))) {
      if (!o.dryRun) throw new Error(`set ${setName} already has results. Use --resume --set ${setName}, or pick a new --set.`);
      rmSync(setDir, { recursive: true, force: true });
    }
    doc = await doctor({ model: o.model, smallModel: o.smallModel, conclaveSrc: o.conclaveSrc, hubPort: o.hubPort, tapPort: o.tapPort, workRoot: join(workBase, setName), bTransport: o.bTransport, arms: o.arms, dryRun: o.dryRun });
    printDoctor(doc);
    if (!doc.ok && !o.dryRun) {
      log('doctor found problems (FAIL lines above). Fix them, then run again.');
      return 2;
    }
    tasks = loadTasks(o.tasks);
    // validate scratch (it holds reference solutions and hidden tests) stays out of the agents' work root
    if (!o.skipValidate) await validateTasks(tasks, { workRoot: join(STATE_DIR, 'scratch', setName), update: false });
    const val = lastValidation();
    const skipped: Array<{ id: string; reason: string }> = [];
    tasks = tasks.filter((t) => {
      const v = val.get(t.id);
      if (!v) {
        skipped.push({ id: t.id, reason: 'not validated' });
        return false;
      }
      if (!v.ok) {
        skipped.push({ id: t.id, reason: v.skipped_reason ?? v.problems.join('; ').slice(0, 200) });
        return false;
      }
      return true;
    });
    plan = makePlan(
      tasks.map((t) => t.id),
      o.arms,
      o.repeats,
      o.seed,
    );
    const sampleTask = tasks[0];
    const argvFor = (arm: ArmId) =>
      armArgv({ arm, model: o.model, prompt: '<prompt>', copy: '<copy>', limitS: sampleTask?.time_limit_s ?? 900, conclaveSrc: o.conclaveSrc, hub: null, claudeFlags: doc.claudeFlags, matchEffort: o.matchEffort });
    manifest = {
      schema: 1,
      protocol_version: 3,
      set: setName,
      created_at: isoNow(),
      dry_run: o.dryRun,
      model: o.model,
      small_model: doc.smallModel,
      arms: o.arms,
      verdict_arms: VERDICT_ARMS,
      seed: o.seed,
      repeats: o.repeats,
      match_effort: o.matchEffort,
      skills: o.arms.includes('A+skills') ? (o.skills ?? DEFAULT_SKILLS) : null,
      tasks: tasks.map((t) => t.id),
      skipped,
      b_transport: doc.transport,
      conclave: { src: o.conclaveSrc, commit: doc.conclave.commit, dirty: doc.conclave.dirty },
      claude_code: { version_before: doc.claudeFlags?.version ?? null, version_after: null, flags: doc.claudeFlags },
      proxy: { base_url: p.baseUrl, version: doc.proxy.version, account: doc.proxy.account, models_listed: doc.proxy.models?.length ?? null },
      served_check: { A: doc.servedA, B: doc.servedB },
      thinking: {
        A: o.matchEffort ? { mode: 'agent override', effort: o.matchEffort } : coderThinking(o.conclaveSrc) ? { mode: 'coder agent default', effort: coderThinking(o.conclaveSrc) } : { mode: 'Conclave default for coding agents (medium on Claude models that take effort)', effort: null },
        B: o.matchEffort && doc.claudeFlags?.effort ? { mode: 'effort flag', effort: o.matchEffort } : { mode: 'Claude Code default', effort: null },
      },
      versions: doc.versions,
      budgets: { tokens: o.budgetTokens, usd: o.budgetUsd, wall_ms: o.budgetWallMs, run_token_cap: o.runTokenCap, max_wait_ms: o.maxWaitMs },
      argv: Object.fromEntries(o.arms.map((a) => [a, argvFor(a)])),
      hub: o.arms.some(isHubArm)
        ? { per_run: true, port: o.hubPort, argv: ['bun', join(o.conclaveSrc, 'packages/cli/src/index.ts'), 'serve', '--host', '127.0.0.1', '--port', String(o.hubPort)] }
        : null,
      tap: o.dryRun || (o.tapPort ?? o.hubPort - 1) <= 0 ? null : { port: o.tapPort ?? o.hubPort - 1, upstream: p.baseUrl },
      isolation: {
        sandbox: 'one fresh <work>/<run_id>/{repo,home} per run, deleted after scoring; final repo kept in runs/<run_id>/final',
        homes: 'fresh HOME per run for both arms; B gets a fresh CLAUDE_CONFIG_DIR, A a fresh hub and CONCLAVE_HOME',
        denied_tools: { A: 'disallowedTools in bench copies of coder and every subagent, plus config deny', B: 'claude --disallowedTools' },
      },
      first_in_group: firstCounts(plan),
      prices: prices.date,
      work_root: join(workBase, setName),
      command: o.command,
      plan,
      doctor: doc.checks,
    };
    writeJson(join(setDir, 'manifest.json'), manifest);
    log(`set ${setName}: ${plan.length} runs (${tasks.length} tasks x ${o.arms.length} arms x ${o.repeats} repeats); skipped ${skipped.length}`);
    if (o.dryRun) {
      log('dry run: the exact argv per arm (prompt and copy shown as placeholders):');
      for (const a of o.arms) log(`  ${a}: ${manifest.argv[a].map((x: string) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
    }
  }

  const setDir = join(o.out, setName!);
  const resultsFile = join(setDir, 'results.jsonl');
  const workRoot = manifest.work_root as string;
  mkdirSync(workRoot, { recursive: true });
  refreshFixtureTasks(tasks);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const doneValid = new Set(readJsonl(resultsFile).filter((r) => r.valid).map((r) => r.run_id));
  const started = Date.now() - (o.resume ? sum(readJsonl(resultsFile).map((r) => r.wall_ms)) : 0);

  // The tap: every model call of every arm goes through it (PROTOCOL 4.5).
  const tapPort = o.tapPort ?? o.hubPort - 1;
  let tap: Tap | null = null;
  if (!o.dryRun && tapPort > 0) {
    tap = new Tap(p.baseUrl, tapPort, join(setDir, 'tap-all.jsonl'));
    tap.start();
    log(`tap on ${tap.url}, forwarding to ${p.baseUrl}`);
  }
  // One hub per Conclave run, started and stopped by the arm adapter with a fresh home.
  const ccEnv: Record<string, string> = {};
  if (doc.transport.chosen === 'proxy') {
    ccEnv.ANTHROPIC_BASE_URL = tap?.url ?? p.baseUrl;
    if (p.apiKey) ccEnv.ANTHROPIC_API_KEY = p.apiKey;
  } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) ccEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hubOptions: HubOptions = { src: o.conclaveSrc, port: o.hubPort, model: o.model, smallModel: doc.smallModel, proxyBaseUrl: tap?.url ?? p.baseUrl, arms: o.arms, thinking: o.matchEffort ?? undefined, claudeCodeEnv: ccEnv };
  // leak probes: the same markers and hidden test lines for both arms
  const prompts = new Map(tasks.map((t) => [t.id, taskPrompt(t)]));
  const canaries = buildCanaries(tasks, prompts);
  const markers = leakMarkers([o.out, STATE_DIR, join(workRoot, '_validate'), join(workRoot, '_judge')]);
  const probes = new Map<string, LeakProbe>(tasks.map((t) => [t.id, { markers, canaries: canaries.get(t.id) ?? [] }]));

  // a runner that died (kill -9, power, OOM) leaves its sandbox behind; the next agent must not see it
  const stale = existsSync(workRoot) ? readdirSync(workRoot) : [];
  for (const e of stale) {
    killStragglersNow(join(workRoot, e)); // its background processes may still run
    rmSync(join(workRoot, e), { recursive: true, force: true });
  }
  for (const x of plan) rmSync(join(STATE_DIR, 'private', x.run_id), { recursive: true, force: true });
  if (stale.length) log(`removed ${stale.length} sandbox folder(s) left by an earlier stop: ${stale.slice(0, 5).join(', ')}`);

  let interrupted = false;
  let stopCurrent: ((r: string) => void) | null = null;
  // a wait for a rate limit reset (up to --max-wait) or before a retry ends early on Ctrl-C
  let wake: (() => void) | null = null;
  const pause = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, Math.max(0, ms));
      wake = () => {
        clearTimeout(t);
        res();
      };
    }).finally(() => (wake = null));
  const onSigint = () => {
    if (interrupted) {
      // second Ctrl-C: the agent runs in its own session, so end it here or it keeps going
      const n = killLive();
      const left = currentSandbox ? killStragglersNow(currentSandbox).length : 0;
      log(`second SIGINT: killed ${n} agent process group(s) and ${left} leftover process(es); exiting now. Resume with --resume --set ${setName}`);
      process.exit(130);
    }
    interrupted = true;
    log('SIGINT: stopping the current run, then writing the summary');
    stopCurrent?.('interrupted');
    wake?.();
  };
  process.on('SIGINT', onSigint);

  let exitCode = 0;
  const groups = [...new Set(plan.map((x) => x.group))];
  const streak = new Map<string, { n: number; reason: string }>();
  try {
    for (const g of groups) {
      if (interrupted) break;
      const items = plan.filter((x) => x.group === g && !doneValid.has(x.run_id) && taskById.has(x.task_id));
      if (!items.length) continue;
      // budget check before the group
      const all = readJsonl(resultsFile);
      const spentTok = sum(all.map((r) => r.tokens?.total));
      const spentUsd = sum(all.map((r) => r.cost?.list_usd));
      const spentWall = Date.now() - started;
      const finished = all.filter((r) => r.valid);
      const p90 = (f: (r: any) => number | null) => quantile(finished.map(f).filter((x): x is number => typeof x === 'number'), 0.9);
      const estTok = (p90((r) => r.tokens?.total) ?? 0) * items.length;
      const estUsd = (p90((r) => r.cost?.list_usd) ?? 0) * items.length;
      const estWall = (p90((r) => r.wall_ms) ?? taskById.get(items[0].task_id)!.time_limit_s * 1000) * items.length;
      const over = spentTok + estTok > o.budgetTokens ? 'tokens' : o.budgetUsd !== null && spentUsd + estUsd > o.budgetUsd ? 'usd' : spentWall + estWall > o.budgetWallMs ? 'wall time' : null;
      if (over) {
        log(`budget: the next group would go over the ${over} budget (spent ${spentTok} tokens, $${spentUsd.toFixed(2)}, ${Math.round(spentWall / 60000)} min). Stopping cleanly.`);
        exitCode = 3;
        break;
      }
      for (const item of items) {
        if (interrupted) break;
        const t = taskById.get(item.task_id)!;
        let attempt = 1;
        let last: Record<string, any> | null = null;
        for (;;) {
          let line: Record<string, any>;
          try {
            line = await oneRun({ item, attempt, task: t, o, env, hubOptions, tap, probe: probes.get(t.id) ?? null, doc, setDir, workRoot, prices, setName: setName!, onStop: (s) => (stopCurrent = s), isInterrupted: () => interrupted });
          } catch (e) {
            // a bug or a full disk in the runner: stop cleanly, keep what is done, write the summary
            stopCurrent = null;
            killLive();
            log(`runner error in ${item.run_id} (${t.id}, ${item.arm}): ${(e as Error).stack ?? e}`);
            log(`stopping the set. Fix the cause, then continue with --resume --set ${setName}`);
            exitCode = 1;
            break;
          }
          last = line;
          stopCurrent = null;
          appendJsonl(resultsFile, line);
          log(`${item.run_id} ${t.id} ${item.arm} r${item.repeat}: ${line.valid ? (line.tests.pass ? 'PASS' : 'fail') : `invalid (${line.invalid_reason})`} ${line.tests ? `${line.tests.passed}/${line.tests.expected_total}` : ''} in ${Math.round(line.wall_ms / 1000)} s, claim ${line.claim ?? 'none'}`);
          if (line.valid || interrupted) break;
          if (line.invalid_reason === 'rate_limit') {
            const reset = line.rate_limit_reset_at as number | null;
            const wait = reset ? reset + (o.dryRun ? 1000 : 60_000) - Date.now() : null;
            if (attempt >= 2 || wait === null || wait > o.maxWaitMs) {
              log(`rate limit${reset ? ` until ${new Date(reset).toISOString()}` : ' with no known reset time'}; stopping cleanly. Continue later with --resume --set ${setName}`);
              exitCode = 3;
              interrupted = true;
              break;
            }
            log(`rate limit: waiting ${Math.round(wait / 60000)} min for the reset`);
            await pause(wait);
            if (interrupted) break;
            attempt++;
            continue;
          }
          if (['transient_error', 'no_model_calls', 'hub_start_failed'].includes(line.invalid_reason) && attempt < 2) {
            log(`${line.invalid_reason}: waiting 60 s, then one retry from a fresh copy`);
            await pause(o.dryRun ? 10 : 60_000);
            if (interrupted) break;
            attempt++;
            continue;
          }
          break;
        }
        if (exitCode === 1 || exitCode === 3) break;
        // breaker: one arm keeps ending invalid (agent missing, hub down, no model calls, wrong model)
        if (last && !last.valid && !OUTSIDE_REASONS.has(last.invalid_reason)) {
          const prev = streak.get(item.arm);
          const s = { n: (prev?.n ?? 0) + 1, reason: last.invalid_reason as string };
          streak.set(item.arm, s);
          if (s.n >= INVALID_STREAK_STOP) {
            log(`arm ${item.arm} ended ${s.n} runs in a row invalid (last: ${s.reason}); its tasks cannot pair, so the set stops here. Fix it, then continue with --resume --set ${setName}`);
            exitCode = 3;
            break;
          }
        } else if (last?.valid) streak.delete(item.arm);
      }
      if (exitCode === 1 || exitCode === 3) break;
      if (stopAfterGroup?.(readJsonl(resultsFile))) {
        log('candidate hidden-test regression: stopping before the next group');
        exitCode = 4;
        break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    killLive();
    if (tap) {
      if (tap.unattributed.length) writeText(join(setDir, 'tap-unattributed.jsonl'), tap.unattributed.map((r) => JSON.stringify(r)).join('\n') + '\n');
      tap.stop();
    }
  }
  if (interrupted && exitCode === 0) exitCode = 130;

  // Claude Code version after the last run
  if (o.arms.includes('B') && !o.dryRun) {
    const { detectClaudeFlags } = await import('./arms');
    const after = await detectClaudeFlags();
    manifest.claude_code.version_after = after?.version ?? null;
  } else manifest.claude_code.version_after = manifest.claude_code.version_before;
  writeJson(join(setDir, 'manifest.json'), manifest);

  if (!o.noJudge && readJsonl(resultsFile).some((r) => r.valid)) {
    try {
      const judgeModel = o.judgeModel ?? o.model;
      const provider = judgeProviderFor(judgeModel, o.judgeProvider);
      await judgeSet({ setDir, model: judgeModel, provider, effort: judgeEffortFor(provider, o.judgeEffort), ...(provider === 'openai' ? proxyConfig() : p), swap: o.judgeSwap, dryRun: o.dryRun, workRoot: join(STATE_DIR, 'scratch', setName!) });
    } catch (e) {
      log(`judge failed: ${(e as Error).message}. Run \`bench judge --set ${setName}\` later.`);
    }
  }
  writeReport(setDir);
  log(`summary: ${join(setDir, 'summary.md')}`);
  return exitCode;
}

interface OneRunArgs {
  item: PlanItem;
  attempt: number;
  task: Task;
  o: RunOptions;
  /** Scoring env (runner home, never seen by an agent). */
  env: Record<string, string>;
  hubOptions: HubOptions;
  tap: Tap | null;
  probe: LeakProbe | null;
  doc: DoctorReport;
  setDir: string;
  workRoot: string;
  prices: Prices;
  setName: string;
  onStop: (stop: (r: string) => void) => void;
  isInterrupted: () => boolean;
}

async function oneRun(a: OneRunArgs): Promise<Record<string, any>> {
  const { item, task: t, o } = a;
  const runDir = join(a.setDir, 'runs', item.run_id);
  if (existsSync(runDir)) {
    const prev = join(a.setDir, 'runs', `${item.run_id}.attempt-${a.attempt - 1 || 0}`);
    rmSync(prev, { recursive: true, force: true });
    renameSync(runDir, prev);
  }
  mkdirSync(runDir, { recursive: true });
  const prompt = taskPrompt(t);
  writeText(join(runDir, 'prompt.txt'), prompt);
  const startedAt = isoNow();
  // the sandbox holds repo/ and home/ only; pristine and scratch stay private to the runner
  const privateDir = join(STATE_DIR, 'private', item.run_id);
  const wc = await makeWorkCopy(t, a.workRoot, item.run_id, privateDir);
  currentSandbox = wc.root;
  const neighbours = sandboxNeighbours(wc);
  if (neighbours.length) log(`isolation: the sandbox of ${item.run_id} has neighbours an agent could read: ${neighbours.slice(0, 5).join(', ')}`);
  const foreign = o.dryRun ? [] : foreignBenchProcesses(a.probe?.markers ?? []);
  if (foreign.length) log(`isolation: other processes name hidden material in their command line (an agent running ps would see it); run nothing else from bench/ during a set: ${foreign.slice(0, 3).join(' | ')}`);
  const p = claudeConfig();
  const agentEnv = await baseEnv([p.host], wc.home);
  const isConclaveArm = isHubArm(item.arm);
  const out = await runArm({
    arm: item.arm,
    runId: item.run_id,
    model: o.model,
    smallModel: a.doc.smallModel,
    prompt,
    copy: wc.repo,
    home: wc.home,
    runDir,
    limitS: dryLimitS(o, t),
    env: agentEnv,
    conclaveSrc: o.conclaveSrc,
    hubOptions: isConclaveArm ? a.hubOptions : null,
    tap: a.tap,
    probe: a.probe,
    claudeFlags: a.doc.claudeFlags,
    transport: a.doc.transport.chosen,
    proxy: p,
    matchEffort: o.matchEffort,
    skills: item.arm === 'A+skills' ? (o.skills ?? DEFAULT_SKILLS) : undefined,
    tokenCap: o.runTokenCap,
    dryRun: o.dryRun,
    fake: o.dryRun ? { taskDir: t.dir, ...fakeOutcome(t.id, item.arm, item.repeat), ...dryFault(t.id, item.arm, a.attempt) } : undefined,
    killStepMs: o.dryRun && process.env.BENCH_DRY_KILL_STEP_MS ? Number(process.env.BENCH_DRY_KILL_STEP_MS) : undefined,
    onHandle: a.onStop,
  });
  const endedAt = isoNow();
  // nothing the agent started may still run (or write) while the run is scored
  const stragglers = await killStragglers(wc.root);
  const diff = await computeDiff(t, wc, runDir);
  const score = await scoreTree(t, wc.repo, wc.pristine, join(privateDir, 'score'), a.env, join(runDir, 'test-output.txt'));
  // the agent's own tests: do they fail on the start code (PROTOCOL 9 own_tests)
  const ownTests = await ownTestsCheck(t, wc.repo, wc.pristine, join(privateDir, 'own'), a.env, join(runDir, 'own-tests.txt')).catch((e) => {
    log(`own tests of ${item.run_id} could not be checked: ${(e as Error).message}`);
    return null;
  });
  const d = derive(out.norm, wc, a.workRoot, BENCH_DIR, out.tap ? null : a.probe);
  const n = out.norm;
  const tapSum = out.tap ? summarizeTap(out.tap, o.model) : null;
  const capped = out.proc.stoppedFor === 'token_cap';
  const wasInterrupted = out.proc.stoppedFor === 'interrupted' || a.isInterrupted();

  // tokens: the tap counts both arms with one parser; the tool's own numbers are kept beside them
  const toolTokTotal = n.tokens ? totalTokens(n.tokens) : null;
  const tapTok = tapSum?.tokens ?? null;
  const tokens = tapTok ? { input: tapTok.input, output: tapTok.output, cache_read: tapTok.cache_read, cache_write: tapTok.cache_write, by_model: tapTok.by_model } : n.tokens;
  const tokTotal = tokens ? totalTokens(tokens) : null;
  const tokensSource = tapTok ? 'tap' : n.tokens ? 'tool' : null;

  // served model: from what the API answered (the tap) for every arm; the tool's own report only without the tap
  const tapServed = tapSum ? [...new Set(Object.entries(tapSum.models_served).filter(([req]) => servedMatches('A', o.model, [req])).flatMap(([, v]) => v))] : [];
  const servedList = tapSum && tapSum.main_requests > 0 ? tapServed : n.modelServed;
  const servedSource = tapSum && tapSum.main_requests > 0 ? 'tap' : 'tool';
  const mismatch = servedList.length > 0 && !servedMatches(item.arm, o.model, servedList);
  const forbidden = tapSum ? forbiddenOffered(tapSum.tools_offered) : [];
  const tapLeak = tapSum && a.probe ? { markerInCalls: tapSum.leak.marker_in_calls, markerInResults: tapSum.leak.marker_in_results, canaryLines: tapSum.leak.canary_lines } : null;
  const leakSuspect = !!d.flags.leak_suspect || (tapLeak ? isLeak(tapLeak) : false);
  const leakEv = [...d.flags.leak_evidence, ...(tapLeak && isLeak(tapLeak) ? leakEvidence(tapLeak, 'tap') : [])].slice(0, 10);
  // model calls that ended after the time limit (the same clock for both arms)
  const lastEnd = out.tap?.length ? Math.max(...out.tap.map((r) => r.ts + (r.latency_ms ?? 0))) : null;
  const limitOverrunMs = lastEnd !== null ? Math.max(0, lastEnd - (out.proc.startedAt + dryLimitS(o, t) * 1000)) : null;
  const envBench = benchPathsIn(Object.values(agentEnv));
  const argvBench = benchPathsIn(out.argv.filter((x) => x !== prompt)).filter((x) => !(o.dryRun && x.includes('fake-agent')));

  let invalid: string | null = null;
  if (wasInterrupted) invalid = 'interrupted';
  else if (out.norm.status === 'hub_start_failed') invalid = 'hub_start_failed';
  else if (n.rateLimited || (tapSum && tapSum.status_429 > 0 && n.status !== 'completed' && n.status !== 'idle')) invalid = 'rate_limit';
  else if (mismatch) invalid = 'model_mismatch';
  else if (out.proc.exitCode === 127) invalid = 'agent_not_found';
  else if (n.transientError && !n.calls?.length) invalid = 'transient_error';
  else if (!tokTotal && !(n.turnsMain ?? 0) && !(n.calls?.length ?? 0)) invalid = 'no_model_calls';
  const mainModel = o.model;
  const byModel = tokens?.by_model ?? null;
  const side = byModel ? Object.keys(byModel).filter((m) => !servedMatches('A', mainModel, [m])) : [];
  const reqs = n.requests;
  const first = reqs?.find((r) => !r.sub && (r.purpose ?? 'turn') === 'turn') ?? reqs?.[0] ?? null;
  const toolByModel = n.tokens?.by_model ?? null;
  const listTool = listCost(toolByModel && Object.keys(toolByModel).length ? toolByModel : n.tokens ? { [mainModel]: n.tokens } : null, a.prices);
  const listTap = tapTok ? listCostTap(tapTok.by_model, a.prices) : null;
  const listUsd = tapTok ? listTap : listTool;
  const line: Record<string, any> = {
    schema: 1,
    set: a.setName,
    run_id: item.run_id,
    task_id: t.id,
    title: t.title,
    kind: t.kind,
    lang: t.lang,
    difficulty: t.difficulty,
    arm: item.arm,
    repeat: item.repeat,
    attempt: a.attempt,
    order_in_group: item.order_in_group,
    started_at: startedAt,
    ended_at: endedAt,
    model_requested: o.model,
    model_served: servedList,
    model_served_source: servedSource,
    model_served_tool: n.modelServed,
    proxy_account: o.model.includes('/') ? o.model.split('/')[0] : 'default',
    transport: out.transport,
    harness_version: item.arm === 'B' ? `claude-code ${a.doc.claudeFlags?.version ?? 'unknown'}` : item.arm === 'D' ? 'codex' : `conclave ${a.doc.conclave.commit ?? 'unknown'} (dirty: ${a.doc.conclave.dirty ?? '?'})`,
    thinking: out.thinking,
    sent: tapSum
      ? { thinking: tapSum.thinking, effort: tapSum.effort, max_tokens: tapSum.max_tokens, tools: tapSum.tools_offered, system_chars: tapSum.first_main?.system_chars ?? null, system_sha: tapSum.first_main?.system_sha ?? null, prompt_found: tapSum.prompt_found, forbidden_tools: forbidden }
      : null,
    status: n.status,
    error: n.error,
    stop_reason: n.stopReason,
    valid: invalid === null,
    invalid_reason: invalid,
    rate_limit_reset_at: n.resetAt,
    exit_code: out.proc.exitCode,
    timed_out: out.proc.timedOut,
    limit_overrun_ms: limitOverrunMs,
    capped,
    wall_ms: out.proc.wallMs,
    api_ms: tapSum ? tapSum.api_ms : n.apiMs,
    api_ms_tool: n.apiMs,
    ttft_ms: tapSum?.ttft_first_ms ?? n.ttftMs,
    // for the Conclave arms the loop and the tools run in the hub, so the CLI's own usage says little
    agent_cpu_ms: isHubArm(item.arm) ? null : out.proc.cpuMs,
    agent_max_rss_kb: isHubArm(item.arm) ? null : out.proc.maxRssKb,
    client_cpu_ms: out.proc.cpuMs,
    tests: {
      passed: score.passed,
      failed: score.failed,
      errored: score.errored,
      expected_total: score.expected_total,
      partial: score.partial,
      pass: score.pass,
      build_error: score.build_error,
      exit_codes: score.exit_codes,
      timed_out: score.timed_out,
      failing: score.failing,
      ms: score.ms,
      moved_aside: score.moved_aside,
      shadowed: score.shadowed,
      restored: score.restored,
      links_removed: score.links_removed,
      not_run: score.not_run,
    },
    tokens: tokens ? { input: tokens.input, output: tokens.output, cache_read: tokens.cache_read, cache_write: tokens.cache_write, cache_write_1h: tapTok?.cache_write_1h ?? null, total: tokTotal, by_model: tokens.by_model, side_models: side, source: tokensSource } : null,
    tokens_tool: n.tokens ? { input: n.tokens.input, output: n.tokens.output, cache_read: n.tokens.cache_read, cache_write: n.tokens.cache_write, total: toolTokTotal, by_model: n.tokens.by_model } : null,
    requests: reqs
      ? { count: tapSum ? tapSum.messages_requests : reqs.length, main: tapSum ? tapSum.main_requests : reqs.filter((r) => !r.sub && (r.purpose ?? 'turn') === 'turn').length, side: reqs.filter((r) => r.purpose && !['turn', 'subagent'].includes(r.purpose)).length, first_request_tokens: tapSum?.first_main?.tokens ?? (first ? totalTokens(first.tokens) : null), errors: tapSum?.errors ?? null, per_request: reqs }
      : tapSum
        ? { count: tapSum.messages_requests, main: tapSum.main_requests, side: null, first_request_tokens: tapSum.first_main?.tokens ?? null, errors: tapSum.errors, per_request: null }
        : null,
    cost: { reported_usd: n.costReportedUsd, list_usd: listUsd, list_usd_tool: listTool, list_usd_tap: listTap, prices: a.prices.date },
    turns: d.turns,
    tools: d.tools,
    edits: d.edits,
    verify: d.verify,
    own_tests: ownTests,
    regression_gate: n.regressionGate ?? null,
    repeated_calls: maxRepeat(n.calls),
    diff: {
      files_changed: diff.files_changed,
      files_written: d.files_written ? d.files_written.length : null,
      files_added: diff.files_added,
      files_deleted: diff.files_deleted,
      files_modified: diff.files_modified,
      lines_added: diff.lines_added,
      lines_removed: diff.lines_removed,
      modified_existing_tests: diff.modified_existing_tests,
      extended_existing_tests: diff.extended_existing_tests,
      protected_changed: diff.protected_changed,
      suspicious_files: diff.suspicious_files,
      harness_files: diff.harness_files,
    },
    files: { read: d.files_read, written: d.files_written },
    shell: d.shell,
    permission_denials: n.permissionDenials,
    claim: d.claim,
    false_success: d.claim === 'DONE' && !score.pass,
    no_claim: d.no_claim,
    flags: {
      network_attempt: d.flags.network_attempt,
      leak_suspect: leakSuspect,
      leak_evidence: leakEv,
      hidden_lines_seen: tapLeak ? tapLeak.canaryLines.length : null,
      wide_search: d.flags.wide_search,
      model_mismatch: mismatch,
      forbidden_tools_offered: forbidden,
      prompt_not_found: tapSum ? tapSum.prompt_found === false : null,
    },
    isolation: {
      neighbours,
      foreign_bench_processes: foreign,
      stragglers_killed: stragglers,
      env_bench_paths: envBench,
      argv_bench_paths: argvBench,
      hub: out.hub,
      tap: !!out.tap,
    },
    extra: { ...n.extra, compactions: n.extra.compactions ?? null },
    dry_run: o.dryRun,
    paths: { dir: `runs/${item.run_id}`, final: `runs/${item.run_id}/final` },
  };
  writeJson(join(runDir, 'meta.json'), { ...line, argv: out.argv.map((x) => (x === prompt ? '<prompt>' : x)) });
  // keep the final repo in the run folder, delete the sandbox: the next agent finds nothing of this run
  retireWorkCopy(wc, runDir, privateDir);
  currentSandbox = null;
  return line;
}

export function readManifest(setDir: string): any {
  return JSON.parse(readFileSync(join(setDir, 'manifest.json'), 'utf8'));
}
