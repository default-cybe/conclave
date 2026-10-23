#!/usr/bin/env bun
/**
 * Conclave vs Claude Code harness benchmark. See README.md and PROTOCOL.md.
 *
 *   bun bench/bench.ts <command> [flags]
 *
 * Commands: doctor, build, check, parity, validate, run, judge, report, all.
 * `bun bench/run.ts` is the same as `bench.ts all`.
 */
import { join, resolve } from 'node:path';
import { parseArm } from './lib/arms';
import { doctor, printDoctor } from './lib/doctor';
import { claudeConfig, proxyConfig, STATE_DIR } from './lib/env';
import { judgeEffortFor, judgeProviderFor, judgeSet } from './lib/judge';
import { writeReport } from './lib/report';
import { runSet, type RunOptions } from './lib/runset';
import { buildTasks, loadTasks } from './lib/tasks';
import { BENCH_DIR, log, parseCount, parseDuration, REPO_DIR } from './lib/util';
import { checkAll } from './lib/checks';
import { runParity } from './checks/parity';
import { validateTasks } from './lib/validate';

const BOOLEAN = new Set(['dry-run', 'resume', 'no-judge', 'judge-swap', 'no-judge-swap', 'skip-validate', 'keep-work', 'update', 'help', 'e2e']);

export function parseFlags(argv: string[]): { cmd: string | undefined; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  let cmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) flags[k] = a.slice(eq + 1);
      else if (BOOLEAN.has(k)) flags[k] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`--${k} needs a value`);
        flags[k] = v;
        i++;
      }
    } else if (!cmd) cmd = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return { cmd, flags };
}

const HELP = `Usage: bun bench/bench.ts <command> [flags]

Commands
  doctor     check toolchains, Claude Code flags, the proxy, served model ids, ports, work root
  build      write tasks/*/task.json and rebuild the seeded task repos (--polyglot <clone> re-vendors the public tasks)
  check      static task checks: prompts state what the hidden tests need, bug reports do not name the cause, task.json matches the catalog
  parity     fairness and isolation checks: same prompt, deny lists, fresh homes, sandbox, judge blinding, leak scan, tap counts
             (--e2e also runs the real Conclave hub and Claude Code against a fake model API through the tap)
  validate   check every task: hidden tests fail on the start code, pass with the reference and with every hidden/alt fix,
             naive fixes fail, visible tests pass with the reference (--repeat <n> scores each tree n times; --update stores counts)
  run        run a set (doctor, validate, runs, judge, report)
  judge      blind judge for a set (--set)
  report     write summary.md for a set (--set)
  all        run, then judge and report (the default for bench/run.ts)

Flags
  --model <id>            model id for both arms (default $BENCH_MODEL)
  --arms A,B              arms: A (Conclave, anthropic type), B (Claude Code), A2 (Conclave, openai type), C (Conclave over ACP), D (Codex),
                          A+skills (arm A with catalog items installed into its hub, see --skills)
  --skills <ids>          catalog items for A+skills (default plugin:ponytail,plugin:caveman, from their pinned commits)
  --tasks <ids|smoke|all> task ids, comma separated (default all)
  --repeats <n>           runs per task per arm (default 1)
  --seed <n>              plan order (default 1)
  --set <name>            set name (default <date>-<model>-<commit>)
  --out <dir>             results folder (default bench/results)
  --b-transport <mode>    proxy, login or auto (default proxy: both arms reach the model the same way)
  --budget-tokens <n>     stop before going over, all token types summed (default 150M)
  --budget-usd <x>        stop before going over, list price
  --budget-wall <t>       stop before going over, for example 12h (default 12h)
  --budget-minutes <n>    the same as --budget-wall in minutes
  --run-token-cap <n>     stop one runaway run (default 8M)
  --max-wait <t>          longest wait for a rate limit reset (default 45m)
  --match-effort <level>  same thinking level in both arms (low, medium, high), as a separate set
  --small-model <id>      model for side calls (default: a haiku id the proxy lists)
  --conclave-src <dir>    Conclave checkout to test (default the repo root)
  --hub-port <n>          port of the bench hub, one fresh hub per Conclave run (default 7799)
  --tap-port <n>          port of the tap that records every model call of both arms (default hub port - 1; 0 turns it off)
  --judge-model <id>      judge model (default --model); judging a set again with another model keeps the earlier results
  --judge-provider <p>    anthropic (Messages API) or openai (chat/completions); default from the model id (gpt-*, o* are openai)
  --judge-effort <level>  low, medium, high, xhigh or max (default high for a GPT judge, none sent for a Claude judge)
  --no-judge-swap         one judge pass only (default: two passes, the second with the order reversed)
  --no-judge              skip the judge
  --dry-run               fake agent and fake judge, no model calls: checks the whole pipeline
  --resume                continue a stopped set (needs --set)
  --skip-validate         use the last validate results
  --keep-work             keep dry run work copies

Environment
  CLIPROXY_BASE_URL (default http://127.0.0.1:8317), CLIPROXY_API_KEY, BENCH_CLAUDE_API_KEY (Claude calls go to the Anthropic API, BENCH_CLAUDE_BASE_URL to change it; GPT judges stay on the proxy), BENCH_MODEL,
  BENCH_WORK (default /tmp/conclave-bench), BENCH_CLAUDE_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN for B login.
`;

function runOptions(flags: Record<string, string | boolean>, argv: string[]): RunOptions {
  const s = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const model = s('model') ?? process.env.BENCH_MODEL;
  const dryRun = flags['dry-run'] === true;
  if (!model && !dryRun && flags.resume !== true) throw new Error('pass --model <id> or set BENCH_MODEL');
  const arms = (s('arms') ?? 'A,B').split(',').filter((x) => x.trim()).map(parseArm);
  const skills = s('skills') ? s('skills')!.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  const wall = s('budget-minutes') ? Number(s('budget-minutes')) * 60_000 : parseDuration(s('budget-wall') ?? '12h');
  const bt = (s('b-transport') ?? 'proxy') as RunOptions['bTransport'];
  if (!['auto', 'login', 'proxy'].includes(bt)) throw new Error('--b-transport is auto, login or proxy');
  const effort = s('match-effort') ?? null;
  if (effort && !['low', 'medium', 'high'].includes(effort)) throw new Error('--match-effort is low, medium or high');
  return {
    arms,
    skills,
    tasks: s('tasks') ?? 'all',
    repeats: Number(s('repeats') ?? 1),
    model: model ?? 'claude-sonnet-5-5',
    smallModel: s('small-model'),
    seed: Number(s('seed') ?? 1),
    set: s('set'),
    out: resolve(s('out') ?? `${BENCH_DIR}/results`),
    bTransport: bt,
    budgetTokens: parseCount(s('budget-tokens') ?? '150M'),
    budgetUsd: s('budget-usd') ? Number(s('budget-usd')) : null,
    budgetWallMs: wall,
    runTokenCap: parseCount(s('run-token-cap') ?? '8M'),
    maxWaitMs: parseDuration(s('max-wait') ?? '45m'),
    matchEffort: effort,
    conclaveSrc: resolve(s('conclave-src') ?? REPO_DIR),
    hubPort: Number(s('hub-port') ?? 7799),
    tapPort: s('tap-port') !== undefined ? Number(s('tap-port')) : undefined,
    dryRun,
    resume: flags.resume === true,
    noJudge: flags['no-judge'] === true,
    judgeModel: s('judge-model'),
    judgeProvider: s('judge-provider'),
    judgeEffort: s('judge-effort'),
    judgeSwap: flags['no-judge-swap'] !== true,
    skipValidate: flags['skip-validate'] === true,
    keepWork: flags['keep-work'] === true,
    command: `bun bench/bench.ts ${argv.map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' ')}`,
  };
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseFlags(argv);
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    return cmd || flags.help ? 0 : 2;
  }
  const s = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const workBase = process.env.BENCH_WORK ?? '/tmp/conclave-bench';
  switch (cmd) {
    case 'doctor': {
      const o = runOptions(flags, argv);
      const r = await doctor({ model: o.model, smallModel: o.smallModel, conclaveSrc: o.conclaveSrc, hubPort: o.hubPort, workRoot: `${workBase}/doctor`, bTransport: o.bTransport, arms: o.arms, dryRun: o.dryRun });
      printDoctor(r);
      return r.ok ? 0 : 1;
    }
    case 'build':
      buildTasks({ polyglot: s('polyglot') });
      log('build done');
      return 0;
    case 'check': {
      const { results, problems } = checkAll(loadTasks(s('tasks')).map((t) => t.id));
      for (const r of results) {
        log(`${r.id}: ${r.problems.length ? 'PROBLEMS' : 'ok'}`);
        for (const p of r.problems) log(`  - ${p}`);
        for (const n of r.notes) log(`  note: ${n}`);
      }
      for (const p of problems) log(`set: ${p}`);
      const bad = results.filter((r) => r.problems.length).length + problems.length;
      log(`${results.length - results.filter((r) => r.problems.length).length} of ${results.length} tasks pass the static checks`);
      return bad ? 1 : 0;
    }
    case 'parity':
      return runParity({ e2e: flags.e2e === true });
    case 'validate': {
      // validate scratch holds reference trees; keep it out of the agents' work base
      const res = await validateTasks(loadTasks(s('tasks')), { workRoot: join(STATE_DIR, 'scratch'), update: flags.update === true, repeat: Number(s('repeat') ?? 1) });
      const bad = res.filter((r) => !r.ok);
      log(`${res.length - bad.length} of ${res.length} tasks ok`);
      return bad.length ? 1 : 0;
    }
    case 'run':
      return runSet({ ...runOptions(flags, argv), noJudge: true });
    case 'all':
      return runSet(runOptions(flags, argv));
    case 'judge': {
      const set = s('set');
      if (!set) throw new Error('--set <name> is required');
      const out = resolve(s('out') ?? `${BENCH_DIR}/results`);
      const manifest = (await import('./lib/runset')).readManifest(`${out}/${set}`);
      const judgeModel = s('judge-model') ?? manifest.model;
      const provider = judgeProviderFor(judgeModel, s('judge-provider'));
      const p = provider === 'openai' ? proxyConfig() : claudeConfig();
      await judgeSet({ setDir: `${out}/${set}`, model: judgeModel, provider, effort: judgeEffortFor(provider, s('judge-effort')), baseUrl: p.baseUrl, apiKey: p.apiKey, swap: flags['no-judge-swap'] !== true, dryRun: !!manifest.dry_run, workRoot: manifest.work_root });
      writeReport(`${out}/${set}`);
      return 0;
    }
    case 'report': {
      const set = s('set');
      if (!set) throw new Error('--set <name> is required');
      const out = resolve(s('out') ?? `${BENCH_DIR}/results`);
      const { md } = writeReport(`${out}/${set}`);
      process.stdout.write(md);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`[bench] error: ${(e as Error).message}\n`);
      if (process.env.BENCH_DEBUG) process.stderr.write(String((e as Error).stack) + '\n');
      process.exit(1);
    });
}
