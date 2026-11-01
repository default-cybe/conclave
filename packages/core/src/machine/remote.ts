import { posix, win32 } from 'node:path';
import type { MachineInfo } from '../types';
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  FileStat,
  GlobOptions,
  GrepOptions,
  GrepResult,
  Machine,
  MachineProcess,
  SpawnOptions,
} from './types';
import {
  MAX_READ_BYTES,
  RPC_TIMEOUT_MS,
  decodeBase64,
  encodeBase64,
  fromWireError,
  type DaemonMessage,
  type HubMessage,
  type RpcMethod,
  type RpcParams,
  type RpcResults,
} from './protocol';
import type { SyncthingFolder, SyncthingStatus } from './syncthing';
import type { ImportAppendParams, ImportAppendResult, ImportReadParams, ImportScanParams, ImportScanWire } from '../import/types';
import type { ConvertedSession } from '../importers/types';
import type { DaemonLogTail } from '../client/logs';

export interface RemoteMachineOptions {
  id: string;
  name: string;
  /** Info from the daemon hello. Used for resolve() and as a cache. */
  info: MachineInfo;
  /** Sends one message to the daemon. Should throw or no-op when the socket is gone. */
  send: (msg: HubMessage) => void;
  /** Default RPC timeout. 60s. */
  rpcTimeoutMs?: number;
  /** Extra time given to exec beyond its own timeoutMs before the hub gives up. 15s. */
  execGraceMs?: number;
  /** Protocol version from the daemon's hello. Defaults to 1. */
  protocol?: number;
}

interface Pending {
  method: RpcMethod;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onOutput?: ExecOptions['onOutput'];
  cleanup?: () => void;
}

/**
 * Hub-side Machine that forwards every call to a daemon over the device
 * WebSocket. The server creates one per connection, feeds it incoming frames
 * with handleMessage() and calls dispose() when the socket closes.
 */
export class RemoteMachine implements Machine {
  readonly id: string;
  readonly name: string;
  private cachedInfo: MachineInfo;
  private readonly sendRaw: (msg: HubMessage) => void;
  private readonly rpcTimeoutMs: number;
  private readonly execGraceMs: number;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private procs = new Map<number, RemoteProcess>();
  private closedReason: string | undefined;
  /** Protocol version the daemon speaks. RPCs added later exist only when it is new enough. */
  readonly protocol: number;
  readonly syncthingFolders?: () => Promise<SyncthingFolder[]>;
  readonly syncthingStatus?: (folderId: string) => Promise<SyncthingStatus>;
  readonly readRange?: (path: string, offset: number, length: number) => Promise<Uint8Array>;
  readonly importScan?: (params: ImportScanParams) => Promise<ImportScanWire>;
  readonly importRead?: (params: ImportReadParams) => Promise<ConvertedSession>;
  readonly logTail?: (lines?: number) => Promise<DaemonLogTail>;
  /** Version 4: the daemon replaces its own binary and restarts. */
  readonly selfUpdate?: (params: RpcParams['selfUpdate']) => Promise<RpcResults['selfUpdate']>;
  /** Version 5: Conclave's turns appended to a Claude Code chat on the device. */
  readonly importAppend?: (params: ImportAppendParams) => Promise<ImportAppendResult>;
  /** Version 6: a TCP stream to a loopback port on the device (the Preview pane). */
  readonly connect?: (port: number) => MachineProcess;

  constructor(opts: RemoteMachineOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.cachedInfo = opts.info;
    this.sendRaw = opts.send;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    this.execGraceMs = opts.execGraceMs ?? 15_000;
    this.protocol = opts.protocol ?? 1;
    // version 2 (folders across devices); an older daemon leaves them undefined, so callers skip Syncthing
    if (this.protocol >= 2) {
      this.syncthingFolders = () => this.call('syncthingFolders', {}, { timeoutMs: 10_000 });
      this.syncthingStatus = (folderId: string) => this.call('syncthingStatus', { folderId }, { timeoutMs: 10_000 });
      // chat import: a scan of a few thousand files can take minutes on a slow disk
      this.readRange = (path: string, offset: number, length: number) => this.readPieces(path, offset, length);
      this.importScan = (params: ImportScanParams) => this.call('importScan', params, { timeoutMs: 10 * 60_000 });
      this.importRead = (params: ImportReadParams) => this.call('importRead', params, { timeoutMs: 5 * 60_000 });
    }
    // version 3: the daemon's recent log for the logs export
    if (this.protocol >= 3) this.logTail = (lines = 500) => this.call('logTail', { lines }, { timeoutMs: 15_000 });
    // version 4: a download over a slow link takes a while; the answer comes once the new binary is checked
    if (this.protocol >= 4) this.selfUpdate = (params) => this.call('selfUpdate', params, { timeoutMs: 20 * 60_000 });
    // version 5: the busy check and the append run where the file is
    if (this.protocol >= 5) this.importAppend = (params: ImportAppendParams) => this.call('importAppend', params);
    // version 6: the bytes ride the proc.* frames, like a spawned process's
    if (this.protocol >= 6) this.connect = (port: number) => this.stream('connect', (handle) => ({ handle, port }));
  }

  /** True until dispose(). */
  get online(): boolean {
    return this.closedReason === undefined;
  }

  /** Last known info without a round trip. */
  get lastInfo(): MachineInfo {
    return this.cachedInfo;
  }

  /** Number of in-flight RPCs and live processes (for diagnostics). */
  get load(): { rpcs: number; procs: number } {
    return { rpcs: this.pending.size, procs: this.procs.size };
  }

  // -------------------------------------------------------------------------
  // Incoming frames
  // -------------------------------------------------------------------------

  handleMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.finish(msg.id, p);
        if ('error' in msg) p.reject(fromWireError(msg.error));
        else p.resolve(msg.result);
        return;
      }
      case 'exec.output': {
        const p = this.pending.get(msg.id);
        try {
          p?.onOutput?.(msg.data, msg.stream);
        } catch {
          /* a bad callback must not break the connection */
        }
        return;
      }
      case 'proc.stdout':
        this.procs.get(msg.pid)?.push('stdout', decodeBase64(msg.data));
        return;
      case 'proc.stderr':
        this.procs.get(msg.pid)?.push('stderr', decodeBase64(msg.data));
        return;
      case 'proc.exit': {
        const proc = this.procs.get(msg.pid);
        if (!proc) return;
        this.procs.delete(msg.pid);
        proc.exit(msg.code);
        return;
      }
      case 'hello':
        this.cachedInfo = msg.info;
        return;
      default:
        return;
    }
  }

  /** Fail everything in flight. Called when the socket closes. */
  dispose(reason = 'device disconnected'): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      this.finish(id, p);
      p.reject(new Error(`${this.name}: ${reason}`));
    }
    for (const proc of this.procs.values()) proc.fail(`${this.name}: ${reason}`);
    this.procs.clear();
  }

  // -------------------------------------------------------------------------
  // RPC plumbing
  // -------------------------------------------------------------------------

  private send(msg: HubMessage): boolean {
    if (this.closedReason !== undefined) return false;
    try {
      this.sendRaw(msg);
      return true;
    } catch {
      return false;
    }
  }

  private finish(id: number, p: Pending): void {
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.cleanup?.();
  }

  private call<M extends RpcMethod>(
    method: M,
    params: RpcParams[M],
    extra: { id?: number; timeoutMs?: number; onTimeout?: () => void; onOutput?: ExecOptions['onOutput']; cleanup?: () => void } = {},
  ): Promise<RpcResults[M]> {
    if (this.closedReason !== undefined) {
      extra.cleanup?.();
      return Promise.reject(new Error(`${this.name}: ${this.closedReason}`));
    }
    const id = extra.id ?? this.nextId++;
    return new Promise<RpcResults[M]>((resolve, reject) => {
      const p: Pending = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        onOutput: extra.onOutput,
        cleanup: extra.cleanup,
      };
      const timeoutMs = extra.timeoutMs ?? this.rpcTimeoutMs;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        p.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.finish(id, p);
          extra.onTimeout?.();
          reject(new Error(`${this.name}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      const ok = this.send({ type: 'rpc', id, method, params } as HubMessage);
      if (!ok) {
        this.finish(id, p);
        reject(new Error(`${this.name}: device not connected`));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Machine
  // -------------------------------------------------------------------------

  async info(): Promise<MachineInfo> {
    this.cachedInfo = await this.call('info', {});
    return this.cachedInfo;
  }

  stat(path: string): Promise<FileStat | null> {
    return this.call('stat', { path });
  }

  async readFile(path: string): Promise<Uint8Array> {
    return (await this.wholeInPieces(path)) ?? decodeBase64(await this.call('readFile', { path }));
  }

  async readText(path: string): Promise<string> {
    // the daemon's readText is the bytes decoded with U+FFFD for bad ones, as Buffer does
    const bytes = await this.wholeInPieces(path);
    return bytes ? Buffer.from(bytes).toString('utf8') : this.call('readText', { path });
  }

  /** The whole file through readRange, or undefined when the daemon has none and a one-reply read fits. */
  private async wholeInPieces(path: string): Promise<Uint8Array | undefined> {
    if (this.readRange) {
      try {
        return await this.readPieces(path, 0, Infinity);
      } catch (err) {
        // a daemon serving a machine without readRange (machine/daemon.ts notImplemented)
        if ((err as { code?: string }).code !== 'ENOSYS') throw err;
      }
    }
    await this.refuseLarge(path);
    return undefined;
  }

  /** readRange in replies of at most MAX_READ_BYTES: one reply over the hub's websocket limit closes the connection. */
  private async readPieces(path: string, offset: number, length: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < length) {
      const want = Math.min(MAX_READ_BYTES, length - got);
      const b = decodeBase64(await this.call('readRange', { path, offset: offset + got, length: want }));
      parts.push(b);
      got += b.byteLength;
      if (b.byteLength < want) break;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** A daemon without readRange sends a file in one reply: refuse one that would not fit. */
  private async refuseLarge(path: string): Promise<void> {
    const st = await this.stat(path);
    if (st && st.size > MAX_READ_BYTES) {
      throw Object.assign(new Error(`${path} is too large to read from ${this.name} (${Math.round(st.size / 1048576)} MB; this daemon sends at most ${MAX_READ_BYTES / 1048576} MB at once, update it)`), { code: 'E2BIG' });
    }
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.call('writeFile', typeof data === 'string' ? { path, text: data } : { path, base64: encodeBase64(data) });
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.call('readdir', { path });
  }

  async mkdir(path: string): Promise<void> {
    await this.call('mkdir', { path });
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.call('remove', { path, recursive: opts?.recursive });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call('rename', { from, to });
  }

  glob(pattern: string, opts: GlobOptions): Promise<string[]> {
    return this.call('glob', { pattern, opts });
  }

  grep(opts: GrepOptions): Promise<GrepResult> {
    return this.call('grep', { opts });
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    if (opts.signal?.aborted) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, durationMs: 0 };
    }
    const id = this.nextId++;
    const abort = () => this.send({ type: 'exec.abort', id });
    opts.signal?.addEventListener('abort', abort, { once: true });
    // the daemon enforces timeoutMs itself; the hub only waits a bit longer in case it went silent
    const timeoutMs = opts.timeoutMs ? opts.timeoutMs + this.execGraceMs : this.rpcTimeoutMs;
    return this.call(
      'exec',
      {
        command,
        opts: {
          cwd: opts.cwd,
          env: opts.env,
          timeoutMs: opts.timeoutMs,
          stdin: opts.stdin,
          maxOutputBytes: opts.maxOutputBytes,
          stream: !!opts.onOutput,
        },
      },
      {
        id,
        timeoutMs,
        onTimeout: abort,
        onOutput: opts.onOutput,
        cleanup: () => opts.signal?.removeEventListener('abort', abort),
      },
    );
  }

  spawn(command: string, args: string[], opts: SpawnOptions): MachineProcess {
    return this.stream('spawn', (handle) => ({ handle, command, args, opts }));
  }

  /** A process (spawn) or a socket (connect) whose bytes come in proc.* frames. */
  private stream<M extends 'spawn' | 'connect'>(method: M, params: (handle: number) => RpcParams[M]): MachineProcess {
    const handle = this.nextId++;
    const proc = new RemoteProcess(handle, (msg) => this.send(msg));
    if (this.closedReason !== undefined) {
      proc.fail(`${this.name}: ${this.closedReason}`);
      return proc;
    }
    this.procs.set(handle, proc);
    (this.call(method, params(handle)) as Promise<{ pid?: number } | null>).then(
      (r) => proc.setPid(r?.pid ?? undefined),
      (err: Error) => {
        // spawn failed or the result never came: end the process with the reason on stderr
        if (this.procs.get(handle) === proc) this.procs.delete(handle);
        proc.fail(err.message);
      },
    );
    return proc;
  }

  resolve(path: string, cwd: string): string {
    const P = this.cachedInfo.platform === 'win32' ? win32 : posix;
    const home = this.cachedInfo.home;
    const expand = (p: string) => {
      if (p === '~') return home;
      if (p.startsWith('~/') || p.startsWith('~\\')) return P.join(home, p.slice(2));
      return p;
    };
    const base = expand(cwd || home);
    const target = expand(path);
    if (P.isAbsolute(target)) return P.normalize(target);
    return P.isAbsolute(base) ? P.join(base, target) : P.join(home, base, target);
  }
}

/** MachineProcess fed by proc.* frames. */
class RemoteProcess implements MachineProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  private osPid: number | undefined;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private err!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number | null) => void;
  private done = false;

  constructor(
    readonly handle: number,
    private readonly send: (msg: HubMessage) => boolean,
  ) {
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.out = c) });
    this.stderr = new ReadableStream<Uint8Array>({ start: (c) => void (this.err = c) });
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  get pid(): number | undefined {
    return this.osPid;
  }

  setPid(pid: number | undefined): void {
    this.osPid = pid;
  }

  push(stream: 'stdout' | 'stderr', data: Uint8Array): void {
    if (this.done) return;
    try {
      (stream === 'stdout' ? this.out : this.err).enqueue(data);
    } catch {
      /* reader cancelled */
    }
  }

  exit(code: number | null): void {
    if (this.done) return;
    this.done = true;
    for (const c of [this.out, this.err]) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    this.resolveExit(code);
  }

  /** End the process locally with a message on stderr (spawn error, disconnect). */
  fail(message: string): void {
    if (this.done) return;
    this.push('stderr', new TextEncoder().encode(`${message}\n`));
    this.exit(null);
  }

  write(data: string | Uint8Array): void {
    if (this.done) return;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.send({ type: 'proc.stdin', pid: this.handle, data: encodeBase64(bytes) });
  }

  closeStdin(): void {
    if (this.done) return;
    this.send({ type: 'proc.stdin', pid: this.handle, end: true });
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' = 'SIGTERM'): void {
    if (this.done) return;
    this.send({ type: 'proc.kill', pid: this.handle, signal });
  }
}
