#!/usr/bin/env bun
/** ledgerkit command line. `main` is exported so tests can run it with fake io. */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadConfig, type Config } from './config';
import { isMonth } from './dates';
import { toCsv, toMarkdown } from './export';
import { filterEntries, sortEntries } from './filter';
import { parseCsv } from './importers/csv';
import { buildReport, monthsWithEntries, renderEntryLine, renderReport } from './report';

export interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export const HELP = `ledgerkit: a small personal ledger

Usage:
  ledgerkit report [--month YYYY-MM] [--category NAME]
  ledgerkit list [--month YYYY-MM] [--category NAME] [--search TEXT]
  ledgerkit export [--month YYYY-MM] [--as csv|md]
  ledgerkit months

Options for every command:
  --data FILE       ledger CSV file (default ledger.csv)
  --currency CODE   currency for printing amounts: USD, EUR, GBP or JPY (default USD)
  --locale TAG      locale for printing amounts (default en-US)
  --help            show this help
`;

const VALUE_FLAGS = ['month', 'category', 'search', 'as', 'data', 'currency', 'locale'] as const;
type FlagName = (typeof VALUE_FLAGS)[number];
export type Flags = Record<FlagName, string | undefined> & { help: boolean };

export class UsageError extends Error {}

export function parseArgs(argv: string[]): { command?: string; flags: Flags; rest: string[] } {
  const flags = { help: false } as Flags;
  for (const k of VALUE_FLAGS) flags[k] = undefined;
  const rest: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      flags.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2)) as FlagName;
      if (!VALUE_FLAGS.includes(name)) throw new UsageError(`unknown option: --${name}`);
      const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
      continue;
    }
    if (!command) command = a;
    else rest.push(a);
  }
  return { command, flags, rest };
}

function loadEntries(cfg: Config, cwd: string) {
  const file = isAbsolute(cfg.data) ? cfg.data : join(cwd, cfg.data);
  if (!existsSync(file)) throw new Error(`no ledger file at ${cfg.data}`);
  return parseCsv(readFileSync(file, 'utf8'));
}

function checkMonth(month: string | undefined): void {
  if (month !== undefined && !isMonth(month)) throw new UsageError(`invalid month: ${month} (use YYYY-MM)`);
}

export async function main(argv: string[], io: IO): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n`);
    return 2;
  }
  const { command, flags } = parsed;
  if (flags.help || !command || command === 'help') {
    io.stdout(HELP);
    return command || flags.help ? 0 : 2;
  }
  try {
    const cfg = loadConfig({ cwd: io.cwd, env: io.env, flags: { currency: flags.currency, data: flags.data, locale: flags.locale } });
    checkMonth(flags.month);
    const entries = loadEntries(cfg, io.cwd);
    switch (command) {
      case 'report': {
        const month = flags.month ?? monthsWithEntries(entries).at(-1);
        if (!month) {
          io.stdout('No entries.\n');
          return 0;
        }
        io.stdout(renderReport(buildReport(entries, { month, currency: cfg.currency, category: flags.category })));
        return 0;
      }
      case 'list': {
        const picked = sortEntries(filterEntries(entries, { month: flags.month, category: flags.category, text: flags.search }));
        for (const e of picked) io.stdout(renderEntryLine(e, cfg.currency) + '\n');
        return 0;
      }
      case 'export': {
        const picked = sortEntries(filterEntries(entries, { month: flags.month }));
        const as = flags.as ?? 'csv';
        if (as === 'csv') io.stdout(toCsv(picked));
        else if (as === 'md') io.stdout(toMarkdown(picked, cfg.currency));
        else throw new UsageError(`unknown export type: ${as}`);
        return 0;
      }
      case 'months':
        for (const m of monthsWithEntries(entries)) io.stdout(m + '\n');
        return 0;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (e) {
    io.stderr(`${(e as Error).message}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
  });
  process.exit(code);
}
