/**
 * One CLIProxyAPI process: start it, wait until /healthz answers on its
 * port, keep the last log lines (with keys blanked out), say when it ends,
 * stop it. Restarts are the manager's job.
 */
import { pump } from '../remote/tunnel';

/** What the hub needs from a child process. Bun.spawn's result fits; tests pass their own. */
export interface CliProcess {
  pid?: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;
  kill(signal?: number | NodeJS.Signals): void;
}

export type CliSpawner = (cmd: string[], opts: { env: Record<string, string>; cwd: string }) => CliProcess;

export const defaultSpawn: CliSpawner = (cmd, opts) =>
  Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }) as unknown as CliProcess;

/** Run `<bin> -h` and return everything it printed (the version line comes first). */
export async function runHelp(spawn: CliSpawner, bin: string, env: Record<string, string>, cwd: string, timeoutMs = 10_000): Promise<{ code: number | null; out: string }> {
  const proc = spawn([bin, '-h'], { env, cwd });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err] = await Promise.all([proc.stdout ? new Response(proc.stdout).text() : '', proc.stderr ? new Response(proc.stderr).text() : '']);
    return { code: await proc.exited, out: `${out}\n${err}` };
  } finally {
    clearTimeout(timer);
  }
}

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly lines: string[] = [],
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface RunnerOptions {
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  port: number;
  spawn?: CliSpawner;
  fetch?: typeof fetch;
  readyTimeoutMs?: number;
  /** Values that must never show in a log line the hub keeps. */
  secrets: () => string[];
  pids?: { add(pid: number): void; remove(pid: number): void };
}

export interface RunnerEvents {
  /** The process ended after it was ready. */
  onExit?: (code: number | null, why: string) => void;
}

/**
 * A log line to its message. CLIProxyAPI 8 writes
 * `[2026-10-18 07:44:25] [--------] [error] [file.go:12] text`; logrus text
 * and JSON lines (`level=error msg="text"`) are read too.
 */
export function message(line: string): string {
  const bracket = /^\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?\[\s*[a-z]+\s*\]\s*(?:\[[^\]]*\.go:\d+\]\s*)?(.*)$/i.exec(line);
  if (bracket) return bracket[1].trim();
  const m = /msg="((?:[^"\\]|\\.)*)"/.exec(line) ?? /"msg":"((?:[^"\\]|\\.)*)"/.exec(line);
  return (m ? m[1].replace(/\\"/g, '"') : line).trim();
}

/** True for a line at error level or worse, in any of those formats. */
export function isProblem(line: string): boolean {
  return /level=(error|fatal|panic)|"level":"(error|fatal|panic)"|\[\s*(error|fatal|panic)\s*\]|^(panic|fatal)\b/i.test(line);
}

/** Blank out keys, bearer tokens and anything shaped like one. */
export function scrub(line: string, secrets: string[]): string {
  let out = line;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[key]');
  return out
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[key]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+|\$2[aby]\$\d\d\$[./A-Za-z0-9]{53})\b/g, '[key]')
    .replace(/((?:access|refresh|id)_token["':=\s]+)[^\s",}]+/gi, '$1[key]');
}

export class CliRunner {
  private proc?: CliProcess;
  private stopping = false;
  private ready = false;
  private tail: string[] = [];
  private lastProblem?: string;
  events: RunnerEvents = {};

  constructor(private readonly opts: RunnerOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get port(): number {
    return this.opts.port;
  }

  get lastLines(): string[] {
    return [...this.tail];
  }

  /** Spawn it and resolve once GET /healthz answers 200. */
  async start(): Promise<void> {
    const spawn = this.opts.spawn ?? defaultSpawn;
    const f = this.opts.fetch ?? fetch;
    let proc: CliProcess;
    try {
      proc = spawn([this.opts.bin, ...this.opts.args], { env: this.opts.env, cwd: this.opts.cwd });
    } catch (err) {
      throw new RunnerError(`Could not start CLIProxyAPI: ${(err as Error).message}.`);
    }
    this.proc = proc;
    const pid = proc.pid;
    if (pid) this.opts.pids?.add(pid);
    const onLine = (raw: string) => {
      const line = scrub(raw.trim(), this.opts.secrets());
      if (!line) return;
      const msg = message(line);
      this.tail.push(msg);
      if (this.tail.length > 20) this.tail.shift();
      if (isProblem(line)) this.lastProblem = msg;
    };
    void pump(proc.stdout, onLine);
    void pump(proc.stderr, onLine);
    let ended = false;
    let code: number | null = null;
    proc.exited.then(
      (c) => {
        ended = true;
        code = c;
        if (pid) this.opts.pids?.remove(pid);
        this.proc = undefined;
        if (this.ready && !this.stopping) this.events.onExit?.(c, this.lastProblem ?? `exit code ${c}`);
      },
      () => {
        ended = true;
        if (pid) this.opts.pids?.remove(pid);
      },
    );

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 30_000);
    for (;;) {
      if (ended) throw new RunnerError(`CLIProxyAPI stopped before it was ready (${this.lastProblem ?? this.tail.at(-1) ?? `exit code ${code}`}).`, this.lastLines);
      if (this.stopping) throw new RunnerError('CLIProxyAPI was stopped while it was starting.');
      try {
        const res = await f(`http://127.0.0.1:${this.opts.port}/healthz`, { signal: AbortSignal.timeout(2_000) });
        await res.body?.cancel().catch(() => undefined);
        if (res.ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new RunnerError(`CLIProxyAPI did not answer on port ${this.opts.port} in time (${this.lastProblem ?? this.tail.at(-1) ?? 'no output'}).`, this.lastLines);
      }
      await Bun.sleep(100);
    }
    this.ready = true;
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.proc?.kill(signal);
    } catch {
      /* already gone */
    }
  }

  /** Stop the process. Resolves when it has exited (SIGKILL after 5s). */
  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    this.kill('SIGTERM');
    const done = await Promise.race([proc.exited.then(() => true, () => true), Bun.sleep(5_000).then(() => false)]);
    if (!done) {
      this.kill('SIGKILL');
      await Promise.race([proc.exited.catch(() => null), Bun.sleep(2_000)]);
    }
    this.proc = undefined;
  }
}
