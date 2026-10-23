/**
 * One ACP connection to one harness process.
 *
 * The process runs on a Machine (local hub or a paired device) and speaks
 * newline-delimited JSON-RPC over stdio. We are the "client" side: we answer
 * the agent's fs/*, terminal/* and session/request_permission calls, and we
 * receive its session/update stream.
 *
 * session/update notifications are tapped off the raw message stream before
 * the SDK sees them. That keeps unknown or newer update kinds (and extra
 * fields) intact instead of being dropped by the SDK's strict schema parse.
 */
import * as acp from '@agentclientprotocol/sdk';
import type { Machine, MachineProcess } from '../machine/types';
import { logger } from '../util/log';
import { sleep } from '../util/text';

const log = logger('acp');

export const CLIENT_INFO = { name: 'conclave', title: 'Conclave', version: '0.1.0' };
const STDERR_TAIL_BYTES = 4096;
const DEFAULT_TERMINAL_LIMIT = 1_000_000;

export type TurnPermission = 'ask' | 'readonly' | 'auto';

/** Loosely typed session update. Agents may send kinds this SDK version does not know. */
export type RawSessionUpdate = { sessionUpdate: string; _meta?: Record<string, unknown> | null; [key: string]: unknown };

/** Per-session callbacks for the turn currently running on that session. */
export interface SessionHandler {
  permission: TurnPermission;
  cwd: string;
  onUpdate(update: RawSessionUpdate): void;
  requestPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
}

/** What we remember about a session opened on this connection. */
export interface OpenSession {
  id: string;
  cwd: string;
  configOptions?: acp.SessionConfigOption[] | null;
  /** Legacy (pre config options) model list some adapters still return. */
  legacyModels?: { availableModels?: Array<{ modelId: string; name?: string }>; currentModelId?: string } | null;
  /** Model value we last applied, so we do not set it every turn. */
  appliedModel?: string;
  /** Effort value we last applied (the harness's own value id), the same way. */
  appliedEffort?: string;
  /** Last permission mode used, applied to requests that arrive between turns. */
  permission: TurnPermission;
  /** The agent's session modes, from agents that list them outside config options (session/set_mode). */
  modes?: acp.SessionModeState | null;
  /** The harness mode a bypass turn set (claude-agent-acp's bypassPermissions), so a later turn that asks puts back modeBefore. */
  bypassMode?: string;
  /** The harness mode before a bypass turn changed it. */
  modeBefore?: string;
  /** Model the agent reported for its latest usage (claude-agent-acp puts it in _meta). */
  reportedModel?: string;
}

export interface ConnectionSpec {
  harness: string;
  machine: Machine;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** The account the process serves: a pooled process is never handed to another account (docs/design/ACCOUNTS.md 5). */
  owner?: string;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/** Run a promise with a timeout. Rejects with a clear message on timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new AcpError(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Normalize SDK / JSON-RPC errors into AcpError with code and message. */
export function toAcpError(err: unknown): AcpError {
  if (err instanceof AcpError) return err;
  const e = err as { message?: string; code?: number; data?: unknown } | undefined;
  let message = e?.message ?? String(err);
  const data = e?.data as { details?: string; message?: string } | string | undefined;
  if (data && typeof data === 'object' && (data.details || data.message)) message += `: ${data.details ?? data.message}`;
  else if (typeof data === 'string' && data && !message.includes(data)) message += `: ${data}`;
  return new AcpError(message, typeof e?.code === 'number' ? e.code : undefined, e?.data);
}

export class HarnessConnection {
  readonly spec: ConnectionSpec;
  readonly sessions = new Map<string, OpenSession>();
  init?: acp.InitializeResponse;
  busy = false;
  lastUsed = Date.now();
  dead = false;
  deadReason?: string;
  readonly exited: Promise<number | null>;

  private proc: MachineProcess;
  private conn: acp.ClientConnection;
  private handlers = new Map<string, SessionHandler>();
  /** Sessions currently replaying history during session/load; their updates are dropped. */
  private replaying = new Set<string>();
  private stderrBuf = '';
  private stderrDone: Promise<void>;
  private terminals: TerminalManager;

  constructor(spec: ConnectionSpec) {
    this.spec = spec;
    this.terminals = new TerminalManager(spec.machine);
    this.proc = spec.machine.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
    this.exited = this.proc.exited.then(
      (code) => {
        this.markDead(`harness exited with code ${code}`);
        return code;
      },
      (err) => {
        this.markDead(`harness failed: ${String(err)}`);
        return null;
      },
    );
    this.stderrDone = this.pumpStderr();

    const proc = this.proc;
    const toAgent = new WritableStream<Uint8Array>({
      write(chunk) {
        proc.write(chunk);
      },
      close() {
        proc.closeStdin();
      },
      abort() {
        proc.closeStdin();
      },
    });
    const raw = acp.ndJsonStream(toAgent, proc.stdout);
    const tap = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform: (msg, ctl) => {
        const m = msg as { method?: string; id?: unknown; params?: unknown };
        if (m && m.method === 'session/update' && !('id' in m)) {
          this.routeUpdate(m.params);
          return;
        }
        ctl.enqueue(msg);
      },
    });
    const stream: acp.Stream = { writable: raw.writable, readable: raw.readable.pipeThrough(tap) };

    this.conn = acp
      .client({ name: CLIENT_INFO.name })
      .onRequest('session/request_permission', (ctx) => this.onPermission(ctx.params, ctx.signal))
      .onRequest('fs/read_text_file', (ctx) => this.onReadFile(ctx.params))
      .onRequest('fs/write_text_file', (ctx) => this.onWriteFile(ctx.params))
      .onRequest('terminal/create', (ctx) => this.onTerminalCreate(ctx.params))
      .onRequest('terminal/output', (ctx) => this.terminals.output(ctx.params.terminalId))
      .onRequest('terminal/wait_for_exit', (ctx) => this.terminals.waitForExit(ctx.params.terminalId))
      .onRequest('terminal/kill', (ctx) => (this.terminals.kill(ctx.params.terminalId), {}))
      .onRequest('terminal/release', (ctx) => (this.terminals.release(ctx.params.terminalId), {}))
      .connect(stream);
    void this.conn.closed.then(
      () => this.markDead(this.deadReason ?? 'connection closed'),
      (err) => this.markDead(`connection closed: ${String(err)}`),
    );
  }

  /** Last 4KB of the harness's stderr, for error messages. */
  stderrTail(): string {
    return this.stderrBuf.trim();
  }

  get agentName(): string | undefined {
    const i = this.init?.agentInfo;
    return i ? `${i.title || i.name}${i.version ? ' ' + i.version : ''}` : undefined;
  }

  get capabilities(): acp.AgentCapabilities {
    return this.init?.agentCapabilities ?? {};
  }

  async initialize(timeoutMs: number): Promise<acp.InitializeResponse> {
    const res = await this.request<acp.InitializeResponse>(
      'initialize',
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: CLIENT_INFO,
      },
      timeoutMs,
    );
    this.init = res;
    return res;
  }

  /** Send a request, failing fast if the process dies or the timeout passes. */
  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.dead) throw new AcpError(this.deathMessage());
    const call = (this.conn.agent.request(method, params) as Promise<T>).catch(async (err) => {
      const e = toAcpError(err);
      if (this.dead || this.conn.signal.aborted || /closed/i.test(e.message)) {
        // the stream closed: let the exit code and last stderr land so the error says why
        await this.settleExit(1000);
        if (this.dead) throw new AcpError(this.deathMessage());
      }
      throw e;
    });
    const died = this.exited.then(async () => {
      await this.settleExit(500);
      // give in-flight responses a moment to land before calling it a crash
      await sleep(50);
      throw new AcpError(this.deathMessage());
    });
    const raced = Promise.race([call, died]);
    return timeoutMs ? withTimeout(raced, timeoutMs, method) : raced;
  }

  /** Wait (bounded) for the process to exit and its stderr to be fully read. */
  private settleExit(ms: number): Promise<unknown> {
    return Promise.race([Promise.all([this.exited, this.stderrDone]), sleep(ms)]);
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.dead) return;
    try {
      await this.conn.agent.notify(method, params);
    } catch (err) {
      log.debug(`notify ${method} failed: ${String(err)}`);
    }
  }

  attach(sessionId: string, handler: SessionHandler): void {
    this.handlers.set(sessionId, handler);
    const s = this.sessions.get(sessionId);
    if (s) s.permission = handler.permission;
  }

  detach(sessionId: string, handler?: SessionHandler): void {
    if (!handler || this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
  }

  setReplaying(sessionId: string, on: boolean): void {
    if (on) this.replaying.add(sessionId);
    else this.replaying.delete(sessionId);
  }

  kill(reason = 'closed'): void {
    this.markDead(reason);
    this.terminals.killAll();
    try {
      this.conn.close();
    } catch {
      // already closed
    }
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // already gone
    }
    const proc = this.proc;
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // gone
      }
    }, 3000);
    void this.exited.then(() => clearTimeout(t));
    (t as { unref?: () => void }).unref?.();
  }

  // -------------------------------------------------------------------------

  private deathMessage(): string {
    const tail = this.stderrTail();
    return `${this.deadReason ?? 'harness is not running'}${tail ? `\n--- stderr ---\n${tail}` : ''}`;
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    this.terminals.killAll();
  }

  private async pumpStderr(): Promise<void> {
    const dec = new TextDecoder();
    try {
      const reader = this.proc.stderr.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrBuf += dec.decode(value, { stream: true });
        if (this.stderrBuf.length > STDERR_TAIL_BYTES * 2) this.stderrBuf = this.stderrBuf.slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // stream closed
    }
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) this.stderrBuf = this.stderrBuf.slice(-STDERR_TAIL_BYTES);
  }

  private routeUpdate(params: unknown): void {
    const p = params as { sessionId?: string; update?: RawSessionUpdate } | undefined;
    if (!p?.sessionId || !p.update || typeof p.update.sessionUpdate !== 'string') return;
    const s = this.sessions.get(p.sessionId);
    if (s) {
      if (p.update.sessionUpdate === 'config_option_update' && Array.isArray(p.update.configOptions)) {
        s.configOptions = p.update.configOptions as acp.SessionConfigOption[];
      }
      const model = p.update._meta?.['_claude/model'];
      if (typeof model === 'string') s.reportedModel = model;
    }
    if (this.replaying.has(p.sessionId)) return;
    const h = this.handlers.get(p.sessionId);
    if (!h) return;
    try {
      h.onUpdate(p.update);
    } catch (err) {
      log.warn(`session update handler failed: ${String(err)}`);
    }
  }

  private permissionFor(sessionId: string): TurnPermission | undefined {
    return this.handlers.get(sessionId)?.permission ?? this.sessions.get(sessionId)?.permission;
  }

  private async onPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const h = this.handlers.get(req.sessionId);
    if (!h) return { outcome: { outcome: 'cancelled' } };
    return h.requestPermission(req, signal);
  }

  private resolvePath(sessionId: string, path: string): string {
    const cwd = this.handlers.get(sessionId)?.cwd ?? this.sessions.get(sessionId)?.cwd ?? this.spec.cwd;
    return this.spec.machine.resolve(path, cwd);
  }

  private async onReadFile(p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const path = this.resolvePath(p.sessionId, p.path);
    let text: string;
    try {
      text = await this.spec.machine.readText(path);
    } catch (err) {
      throw acp.RequestError.resourceNotFound(path);
    }
    return { content: sliceLines(text, p.line ?? undefined, p.limit ?? undefined) };
  }

  private async onWriteFile(p: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    if (this.permissionFor(p.sessionId) === 'readonly') {
      throw acp.RequestError.invalidRequest(undefined, 'Writes are not allowed: this turn is read-only.');
    }
    await this.spec.machine.writeFile(this.resolvePath(p.sessionId, p.path), p.content);
    return {};
  }

  private async onTerminalCreate(p: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    if (this.permissionFor(p.sessionId) === 'readonly') {
      throw acp.RequestError.invalidRequest(undefined, 'Commands are not allowed: this turn is read-only.');
    }
    const cwd = p.cwd ? this.resolvePath(p.sessionId, p.cwd) : this.resolvePath(p.sessionId, '.');
    const env: Record<string, string> = { ...(this.spec.env ?? {}) };
    for (const v of p.env ?? []) env[v.name] = v.value;
    const terminalId = this.terminals.create(p.command, p.args ?? [], cwd, env, p.outputByteLimit ?? undefined);
    return { terminalId };
  }

  /** Current output of a terminal, used to fill tool updates that embed one. */
  terminalText(terminalId: string): string | undefined {
    return this.terminals.peek(terminalId);
  }
}

/** Apply ACP's 1-based line and limit to a text. */
export function sliceLines(text: string, line?: number, limit?: number): string {
  if (!line && !limit) return text;
  const lines = text.split('\n');
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit ? start + limit : lines.length;
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// Terminals (terminal/* requests), backed by machine.spawn
// ---------------------------------------------------------------------------

interface Term {
  proc: MachineProcess;
  output: string;
  limit: number;
  truncated: boolean;
  killed: boolean;
  exit?: { exitCode: number | null; signal: string | null };
  done: Promise<{ exitCode: number | null; signal: string | null }>;
}

const SHELL_CHARS = /[\s|&;<>()$`\\"'*?[\]#~=%!{}]/;

class TerminalManager {
  private terms = new Map<string, Term>();
  private seq = 0;

  constructor(private machine: Machine) {}

  create(command: string, args: string[], cwd: string, env: Record<string, string>, limit = DEFAULT_TERMINAL_LIMIT): string {
    // A bare command line with no args is run through the shell, like editors do.
    const viaShell = args.length === 0 && SHELL_CHARS.test(command.trim());
    const proc = viaShell ? this.machine.spawn('sh', ['-c', command], { cwd, env }) : this.machine.spawn(command, args, { cwd, env });
    const id = `term_${++this.seq}`;
    const term: Term = {
      proc,
      output: '',
      limit,
      truncated: false,
      killed: false,
      done: undefined as unknown as Term['done'],
    };
    const append = (s: string) => {
      term.output += s;
      if (term.output.length > term.limit / 3) {
        const excess = Buffer.byteLength(term.output) - term.limit;
        // every char is at least one byte, so dropping `excess` chars from the front is enough
        if (excess > 0) {
          term.output = term.output.slice(excess);
          term.truncated = true;
        }
      }
    };
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      try {
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          append(dec.decode(value, { stream: true }));
        }
      } catch {
        // closed
      }
    };
    const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    term.done = proc.exited
      .then(async (code) => {
        await Promise.race([pumps, new Promise((r) => setTimeout(r, 200))]);
        return { exitCode: code, signal: term.killed ? 'SIGTERM' : null };
      })
      .catch(() => ({ exitCode: null, signal: null }))
      .then((exit) => {
        term.exit = exit;
        return exit;
      });
    this.terms.set(id, term);
    return id;
  }

  private get(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw acp.RequestError.invalidParams(undefined, `Unknown terminal ${id}`);
    return t;
  }

  peek(id: string): string | undefined {
    return this.terms.get(id)?.output;
  }

  output(id: string): acp.TerminalOutputResponse {
    const t = this.get(id);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit ?? null };
  }

  async waitForExit(id: string): Promise<acp.WaitForTerminalExitResponse> {
    const exit = await this.get(id).done;
    return { exitCode: exit.exitCode, signal: exit.signal };
  }

  kill(id: string): void {
    const t = this.get(id);
    if (t.exit) return;
    t.killed = true;
    try {
      t.proc.kill('SIGTERM');
    } catch {
      // gone
    }
  }

  release(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (!t.exit) {
      t.killed = true;
      try {
        t.proc.kill('SIGKILL');
      } catch {
        // gone
      }
    }
    this.terms.delete(id);
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.release(id);
  }
}
