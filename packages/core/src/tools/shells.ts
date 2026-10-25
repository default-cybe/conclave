import type { Machine, MachineProcess } from '../machine/types';

/**
 * Background shells started by Bash with run_in_background, keyed by session.
 * Output is kept in a rolling buffer; BashOutput returns what is new since the
 * last read.
 */

const MAX_BUFFER_CHARS = 2 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;

export type ShellStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ShellInfo {
  id: string;
  sessionId: string;
  command: string;
  description?: string;
  cwd: string;
  pid?: number;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
}

/** Rolling text buffer with a read cursor that survives trimming. */
class OutputLog {
  private buf = '';
  /** Absolute offset of buf[0]. */
  private base = 0;
  /** Absolute offset already returned to the model. */
  private cursor = 0;

  append(s: string): void {
    this.buf += s;
    if (this.buf.length > MAX_BUFFER_CHARS) {
      const cut = this.buf.length - MAX_BUFFER_CHARS;
      this.buf = this.buf.slice(cut);
      this.base += cut;
    }
  }

  /** New text since the last call, and how many chars were lost to trimming. */
  takeNew(): { text: string; dropped: number } {
    const start = Math.max(this.cursor, this.base);
    const dropped = start - this.cursor;
    const text = this.buf.slice(start - this.base);
    this.cursor = this.base + this.buf.length;
    return { text, dropped };
  }

  all(): string {
    return this.buf;
  }
}

export class BackgroundShell {
  readonly info: ShellInfo;
  readonly stdout = new OutputLog();
  readonly stderr = new OutputLog();
  readonly done: Promise<void>;
  private killed = false;

  constructor(
    info: Omit<ShellInfo, 'status' | 'exitCode' | 'startedAt'>,
    private readonly proc: MachineProcess,
  ) {
    this.info = { ...info, pid: proc.pid, status: 'running', exitCode: null, startedAt: Date.now() };
    const pumps = Promise.all([this.pump(proc.stdout, this.stdout), this.pump(proc.stderr, this.stderr)]);
    this.done = proc.exited
      .then(async (code) => {
        // Give the pipes a moment to flush after exit.
        await Promise.race([pumps, Bun.sleep(500)]);
        this.info.exitCode = code;
        this.info.endedAt = Date.now();
        this.info.status = this.killed ? 'killed' : code === 0 ? 'completed' : 'failed';
      })
      .catch(() => {
        this.info.endedAt = Date.now();
        this.info.status = this.killed ? 'killed' : 'failed';
      });
  }

  private async pump(stream: ReadableStream<Uint8Array>, log: OutputLog): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        log.append(dec.decode(value, { stream: true }));
      }
      log.append(dec.decode());
    } catch {
      /* stream closed */
    }
  }

  get running(): boolean {
    return this.info.status === 'running';
  }

  async kill(): Promise<void> {
    if (!this.running) return;
    this.killed = true;
    this.proc.kill('SIGTERM');
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), KILL_GRACE_MS);
    await this.done;
    clearTimeout(timer);
  }
}

export class ShellRegistry {
  private sessions = new Map<string, Map<string, BackgroundShell>>();
  private counter = 0;

  start(opts: {
    sessionId: string;
    machine: Machine;
    command: string;
    cwd: string;
    description?: string;
    env?: Record<string, string>;
    shell?: string;
    /** Kill the shell after this long. */
    timeoutMs?: number;
    /** Called once when the shell ends on its own or at its timeout; not after KillShell or a dispose. */
    onEnd?: (shell: BackgroundShell) => void;
  }): BackgroundShell {
    const id = `bash_${++this.counter}`;
    let proc: MachineProcess;
    try {
      proc = opts.machine.spawn(opts.shell ?? 'bash', ['-c', opts.command], { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      if (opts.shell) throw err;
      proc = opts.machine.spawn('sh', ['-c', opts.command], { cwd: opts.cwd, env: opts.env });
    }
    proc.closeStdin();
    const shell = new BackgroundShell({ id, sessionId: opts.sessionId, command: opts.command, description: opts.description, cwd: opts.cwd }, proc);
    let map = this.sessions.get(opts.sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(opts.sessionId, map);
    }
    map.set(id, shell);
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void shell.kill();
        }, opts.timeoutMs)
      : undefined;
    void shell.done.then(() => {
      if (timer) clearTimeout(timer);
      if (opts.onEnd && (timedOut || shell.info.status !== 'killed')) opts.onEnd(shell);
    });
    return shell;
  }

  get(sessionId: string, id: string): BackgroundShell | undefined {
    return this.sessions.get(sessionId)?.get(id);
  }

  list(sessionId: string): ShellInfo[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].map((s) => ({ ...s.info }));
  }

  async kill(sessionId: string, id: string): Promise<boolean> {
    const s = this.get(sessionId, id);
    if (!s) return false;
    await s.kill();
    return true;
  }

  /** Kill and forget every shell of a session. Call when a session is deleted or the hub stops. */
  async disposeSession(sessionId: string): Promise<void> {
    const map = this.sessions.get(sessionId);
    if (!map) return;
    await Promise.all([...map.values()].map((s) => s.kill()));
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disposeSession(id)));
  }
}

/** Process-wide registry used by Bash, BashOutput and KillShell. */
export const shellRegistry = new ShellRegistry();
