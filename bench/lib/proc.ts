/**
 * Runs one agent process in its own process group, streams its output to
 * files, hands each stdout line to a callback, and enforces the time limit
 * with the kill sequence from PROTOCOL 7.1.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { killGroup, which } from './util';

export type KillPlan = 'conclave' | 'claude';

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  wallMs: number;
  timedOut: boolean;
  stoppedFor: string | null;
  maxRssKb: number | null;
  cpuMs: number | null;
  /** Epoch ms when the agent process started (for work done after the time limit). */
  startedAt: number;
}

export interface ProcHandle {
  done: Promise<ProcResult>;
  /** Stop early (token cap, rate limit, SIGINT). */
  stop: (reason: string) => void;
  pid: number | undefined;
}

let setsidPath: string | null | undefined;

/**
 * Process groups of agents that are still running. setsid takes them out of
 * the terminal's group, so a second Ctrl-C or a crash of the runner would
 * leave them running (and spending tokens). killLive() ends them all; it runs
 * on process exit too.
 */
const live = new Set<number>();
/**
 * A watchdog for a runner that dies without running its exit hook (kill -9,
 * OOM): a small shell in its own session waits for this process to go away,
 * then kills the given process groups. Without it the agent (in its own
 * session) would run on and keep spending tokens. Returns a function that
 * ends the watchdog once the groups are gone.
 */
export function watchdog(pids: Array<number | undefined>): () => void {
  const groups = pids.filter((p): p is number => !!p);
  if (!groups.length) return () => {};
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; for g in ${groups.join(' ')}; do kill -KILL -$g 2>/dev/null; done`;
  const ss = setsidPath ?? Bun.which('setsid');
  const w = Bun.spawn(ss ? [ss, 'sh', '-c', script] : ['sh', '-c', script], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  w.unref();
  return () => killGroup(w.pid, 'SIGKILL');
}

/** Add or remove a process group that killLive() must end (the bench hub uses it too). */
export function trackGroup(pid: number | undefined, on: boolean): void {
  if (!pid) return;
  ensureExitHook();
  if (on) live.add(pid);
  else live.delete(pid);
}
export function killLive(): number {
  const n = live.size;
  for (const pid of live) killGroup(pid, 'SIGKILL');
  live.clear();
  return n;
}
let exitHook = false;
function ensureExitHook(): void {
  if (exitHook) return;
  exitHook = true;
  process.on('exit', () => killLive());
}

/** How long the output pipes may stay open after the agent exits (a background child can hold them). */
const DRAIN_MS = 5_000;

export async function startProc(opts: {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  stdoutFile: string;
  stderrFile: string;
  limitMs: number;
  plan: KillPlan;
  onLine?: (line: string) => void;
  /** Gap between the kill steps (default 15 s). Dry runs shorten it. */
  stepMs?: number;
}): Promise<ProcHandle> {
  if (setsidPath === undefined) setsidPath = await which('setsid');
  ensureExitHook();
  const step = opts.stepMs ?? 15_000;
  const argv = setsidPath ? [setsidPath, ...opts.cmd] : opts.cmd;
  const outFd = openSync(opts.stdoutFile, 'w');
  const errFd = openSync(opts.stderrFile, 'w');
  const started = Date.now();
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const pid = proc.pid;
  let timedOut = false;
  let stoppedFor: string | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const send = (sig: NodeJS.Signals) => (setsidPath ? killGroup(pid, sig) : proc.kill(sig));

  const escalate = (firstDelayMs: number) => {
    // SIGINT first (conclave run aborts its session, claude -p stops), then SIGTERM, then SIGKILL
    timers.push(setTimeout(() => send('SIGINT'), firstDelayMs));
    timers.push(setTimeout(() => send('SIGTERM'), firstDelayMs + step));
    timers.push(setTimeout(() => send('SIGKILL'), firstDelayMs + 2 * step));
  };
  timers.push(
    setTimeout(() => {
      timedOut = true;
      escalate(opts.plan === 'conclave' ? step : 0); // the Conclave CLI aborts by itself at --timeout; give it 15 s to exit
    }, opts.limitMs),
  );
  if (pid) live.add(pid);
  const stopWatch = watchdog([pid]);

  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
  const pump = async (stream: ReadableStream<Uint8Array>, fd: number, lines: boolean) => {
    const dec = new TextDecoder();
    let buf = '';
    const reader = stream.getReader();
    readers.push(reader);
    for (;;) {
      let res: Awaited<ReturnType<typeof reader.read>>;
      try {
        res = await reader.read();
      } catch {
        break; // cancelled after the drain time
      }
      if (res.done) break;
      const chunk = res.value;
      writeSync(fd, chunk);
      if (!lines || !opts.onLine) continue;
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          opts.onLine(line);
        } catch {
          /* a bad line must not stop the run */
        }
      }
    }
    if (lines && opts.onLine && buf.trim()) {
      try {
        opts.onLine(buf);
      } catch {
        /* as above */
      }
    }
  };

  const done = (async (): Promise<ProcResult> => {
    const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, outFd, true), pump(proc.stderr as ReadableStream<Uint8Array>, errFd, false)]);
    const exitCode = await proc.exited;
    const wallMs = Date.now() - started;
    for (const t of timers) clearTimeout(t);
    // anything the agent left running in its group goes too
    if (setsidPath) killGroup(pid, 'SIGKILL');
    if (pid) live.delete(pid);
    stopWatch();
    // a child that left the group can still hold stdout open; do not wait for it forever
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pumps, new Promise<void>((res) => (drainTimer = setTimeout(res, DRAIN_MS)))]);
    clearTimeout(drainTimer);
    for (const r of readers) r.cancel().catch(() => {});
    await pumps;
    closeSync(outFd);
    closeSync(errFd);
    let maxRssKb: number | null = null;
    let cpuMs: number | null = null;
    try {
      const ru = proc.resourceUsage();
      if (ru) {
        maxRssKb = Math.round(Number(ru.maxRSS) / 1024) || null;
        cpuMs = Math.round((Number(ru.cpuTime.user) + Number(ru.cpuTime.system)) / 1000);
      }
    } catch {
      /* not available */
    }
    return { exitCode, signal: proc.signalCode ? String(proc.signalCode) : null, wallMs, timedOut, stoppedFor, maxRssKb, cpuMs, startedAt: started };
  })();

  return {
    pid,
    done,
    stop: (reason: string) => {
      if (stoppedFor) return;
      stoppedFor = reason;
      escalate(0);
    },
  };
}
