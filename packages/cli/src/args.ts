/**
 * Small argv parser. Supports --flag value, --flag=value, --no-flag,
 * short aliases (-m gpt), grouped short booleans (-cy) and "--" to stop.
 */

export type FlagValue = string | boolean;

export interface ParsedArgs {
  /** Positional arguments in order. */
  _: string[];
  flags: Record<string, FlagValue>;
  /** Everything after "--". */
  rest: string[];
}

export interface ArgSpec {
  /** Flags that never take a value. */
  boolean?: string[];
  /** Flags that always take a value. */
  string?: string[];
  /** Short or alternate name to canonical name. */
  alias?: Record<string, string>;
}

/** Flags known to every command. Unknown flags still parse (value if one follows). */
export const GLOBAL_SPEC: ArgSpec = {
  boolean: ['help', 'version', 'json', 'yes', 'continue', 'detach', 'delete', 'verbose', 'print', 'no-open', 'all', 'files', 'start', 'dry-run', 'login-path', 'app-token-stdin', 'keep-pairing', 'password', 'raw', 'thinking', 'lan', 'draft', 'force', 'refresh', 'share-new', 'forget'],
  string: [
    'hub',
    'token',
    'agent',
    'model',
    'mode',
    'device',
    'cwd',
    'resume',
    'host',
    'port',
    'code',
    'name',
    'days',
    'timeout',
    'format',
    'out',
    'permission-mode',
    'value',
    'limit',
    'rounds',
    'log',
    'repo',
    'base',
    'title',
    'body',
    'message',
    'account',
    'email',
    'providers',
  ],
  alias: {
    h: 'help',
    v: 'version',
    V: 'version',
    y: 'yes',
    c: 'continue',
    r: 'resume',
    m: 'model',
    a: 'agent',
    d: 'device',
    p: 'print',
    o: 'out',
    t: 'timeout',
    n: 'name',
    'dangerously-skip-permissions': 'yes',
  },
};

export function parseArgs(argv: string[], spec: ArgSpec = GLOBAL_SPEC): ParsedArgs {
  const bools = new Set(spec.boolean ?? []);
  const strings = new Set(spec.string ?? []);
  const alias = spec.alias ?? {};
  const out: ParsedArgs = { _: [], flags: {}, rest: [] };
  const canon = (k: string) => alias[k] ?? k;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        const key = canon(body.slice(0, eq));
        const val = body.slice(eq + 1);
        out.flags[key] = bools.has(key) ? parseBool(val) : val;
        continue;
      }
      if (body.startsWith('no-') && !strings.has(body) && !bools.has(body)) {
        out.flags[canon(body.slice(3))] = false;
        continue;
      }
      const key = canon(body);
      if (bools.has(key)) {
        out.flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (strings.has(key)) {
        if (next === undefined) out.flags[key] = '';
        else {
          out.flags[key] = next;
          i++;
        }
        continue;
      }
      // Unknown flag: take the next token as its value unless it looks like a flag.
      if (next !== undefined && !next.startsWith('-')) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const letters = arg.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const key = canon(letters[j]);
        if (strings.has(key)) {
          const inline = letters.slice(j + 1);
          if (inline) out.flags[key] = inline.replace(/^=/, '');
          else if (argv[i + 1] !== undefined) out.flags[key] = argv[++i];
          else out.flags[key] = '';
          break;
        }
        out.flags[key] = true;
      }
      continue;
    }
    out._.push(arg);
  }
  return out;
}

function parseBool(v: string): boolean {
  return !/^(false|0|no|off)$/i.test(v);
}

/** Read a string flag. Booleans (flag given without value) return undefined. */
export function str(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function bool(args: ParsedArgs, key: string): boolean {
  const v = args.flags[key];
  return v === true || (typeof v === 'string' && parseBool(v));
}

export function num(args: ParsedArgs, key: string): number | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** "90", "90s", "10m", "1h30m" to ms. Bare numbers are seconds. */
export function parseTimeout(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(re)) {
    matched = true;
    total += Number(m[1]) * ({ ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 } as Record<string, number>)[m[2]];
  }
  return matched ? total : undefined;
}
