import { ApiError, HubIdentityError, type ConclaveClient } from '@conclave/core/client/index.ts';
import { err, out, padEnd, width, type Painter } from '../ansi';
import { str, type ParsedArgs } from '../args';
import { connectHub, HubUnavailableError, type HubTarget } from '../hub';

export class CliError extends Error {
  constructor(
    message: string,
    public code = 1,
  ) {
    super(message);
  }
}

export function hubFlags(args: ParsedArgs): { hub?: string; token?: string } {
  return { hub: str(args, 'hub'), token: str(args, 'token') };
}

/** Connect to the hub (auto-starting the local one) or throw a CliError. */
export async function getClient(args: ParsedArgs, opts: { autostart?: boolean; quiet?: boolean } = {}): Promise<{ client: ConclaveClient; target: HubTarget }> {
  try {
    const { client, target } = await connectHub({
      flags: hubFlags(args),
      autostart: opts.autostart,
      log: opts.quiet ? undefined : (l) => process.stderr.write(err.dim(l) + '\n'),
    });
    return { client, target };
  } catch (e) {
    if (e instanceof HubUnavailableError) throw new CliError(e.message);
    throw e;
  }
}

export function describeError(e: unknown): string {
  if (e instanceof HubIdentityError) return `${e.message} Address: ${e.address}. If the hub was set up again, log in again with conclave login <hubUrl>.`;
  if (e instanceof ApiError) {
    if (e.status === 401) return `Unauthorized (401). The token is missing or wrong. Run \`conclave login <hub>\` or pass --token.`;
    if (e.status === 404 && /not found/i.test(e.message)) return `Not found (404): ${e.message}`;
    return `Hub error ${e.status}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function table(rows: string[][], opts: { header?: string[]; painter?: Painter; maxWidth?: number } = {}): string {
  const p = opts.painter ?? out;
  const all = opts.header ? [opts.header, ...rows] : rows;
  if (!all.length) return '';
  const cols = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...all.map((r) => width(r[c] ?? ''))));
  const lines = all.map((r, i) => {
    const cells = r.map((cell, c) => (c === cols - 1 ? cell : padEnd(cell ?? '', widths[c])));
    const line = cells.join('  ').replace(/\s+$/, '');
    return opts.header && i === 0 ? p.bold(line) : line;
  });
  return lines.join('\n');
}

export function print(line = ''): void {
  process.stdout.write(line + '\n');
}

export function json(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/** A bar like ▰▰▰▱▱ for percentages. */
export function bar(pct: number, cells = 10, p: Painter = out): string {
  const v = Math.max(0, Math.min(100, pct));
  const full = Math.round((v / 100) * cells);
  const color = v >= 90 ? p.red : v >= 70 ? p.yellow : p.green;
  return color('▰'.repeat(full)) + p.dim('▱'.repeat(cells - full));
}

/** Read one line from stdin (TTY prompt). Hidden input when `hidden`. */
export async function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
  }
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (v: string | Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (v instanceof Error) reject(v);
      else resolve(v);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003') return done(new CliError('Cancelled', 130));
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            if (!opts.hidden) process.stderr.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        process.stderr.write(opts.hidden ? '' : ch);
      }
    };
    stdin.on('data', onData);
  });
}

export function requireArg(v: string | undefined, usage: string): string {
  if (!v) throw new CliError(`Missing argument. Usage: ${usage}`);
  return v;
}

/** Open a URL in the default browser. */
export async function openUrl(url: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url];
  try {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
