#!/usr/bin/env bun
/**
 * One entry point for the whole benchmark: `bun bench/run.ts [flags]` runs
 * doctor, validate, every run, the blind judge and the summary, the same as
 * `bun bench/bench.ts all`. A first argument that names a command
 * (doctor, build, check, parity, validate, run, judge, report, all) runs that command instead.
 *
 *   bun bench/run.ts --dry-run
 *   bun bench/run.ts --model claude-sonnet-5-5 --tasks smoke --set smoke
 *   bun bench/run.ts --model claude-sonnet-5-5 --arms A,B --repeats 1 --budget-tokens 150M --budget-minutes 720 --out bench/results
 */
import { main } from './bench';

const COMMANDS = new Set(['doctor', 'build', 'check', 'parity', 'validate', 'run', 'judge', 'report', 'all', 'help']);
const argv = process.argv.slice(2);
const args = argv.length && COMMANDS.has(argv[0]) ? argv : ['all', ...argv];

main(args)
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`[bench] error: ${(e as Error).message}\n`);
    if (process.env.BENCH_DEBUG) process.stderr.write(String((e as Error).stack) + '\n');
    process.exit(1);
  });
