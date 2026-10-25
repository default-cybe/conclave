/**
 * Daemon side of the device protocol. `conclave daemon` runs this on a PC or
 * Mac: it dials out to the hub, says hello with its MachineInfo and then
 * serves the hub's RPCs with a local Machine. It reconnects forever.
 */
import type { Machine, MachineProcess } from './types';
import {
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  daemonUrl,
  decodeBase64,
  encodeBase64,
  parseFrame,
  toWireError,
  type DaemonMessage,
  type HubMessage,
  type RpcParams,
  type RpcRequest,
  type SelfUpdateResult,
} from './protocol';
import type { DaemonLogTail } from '../client/logs';

function notImplemented(method: string): never {
  throw Object.assign(new Error(`${method} is not implemented on this device`), { code: 'ENOSYS' });
}

/**
 * Serves hub RPCs with a Machine. Transport agnostic: give it a send function
 * and feed it parsed hub messages. One instance per connection.
 */
export class MachineServer {
  private procs = new Map<number, MachineProcess>();
  private execs = new Map<number, AbortController>();
  private closed = false;

  constructor(
    private readonly machine: Machine,
    private readonly sendRaw: (msg: DaemonMessage) => void,
    /** The daemon's recent log for the logTail RPC (logs/ring.ts daemonLogTail). */
    private readonly logTail?: (lines: number) => DaemonLogTail,
    /** The selfUpdate RPC: replace this daemon with the hub's version (cli/src/daemon-update.ts). */
    private readonly selfUpdate?: (params: RpcParams['selfUpdate']) => Promise<SelfUpdateResult>,
  ) {}

  private send(msg: DaemonMessage): void {
    if (this.closed) return;
    try {
      this.sendRaw(msg);
    } catch {
      /* socket gone; the connection loop handles reconnect */
    }
  }

  handle(msg: HubMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'rpc':
        this.rpc(msg);
        return;
      case 'proc.stdin': {
        const p = this.procs.get(msg.pid);
        if (!p) return;
        try {
          if (msg.data) p.write(decodeBase64(msg.data));
          if (msg.end) p.closeStdin();
        } catch {
          /* process already gone */
        }
        return;
      }
      case 'proc.kill':
        try {
          this.procs.get(msg.pid)?.kill(msg.signal ?? 'SIGTERM');
        } catch {
          /* ignore */
        }
        return;
      case 'exec.abort':
        this.execs.get(msg.id)?.abort();
        return;
      case 'ping':
        this.send({ type: 'pong', ts: msg.ts });
        return;
      default:
        return;
    }
  }

  private reply(id: number, fn: () => Promise<unknown>): void {
    fn().then(
      (result) => this.send({ type: 'result', id, result: result === undefined ? null : result }),
      (err) => this.send({ type: 'result', id, error: toWireError(err) }),
    );
  }

  private rpc(req: RpcRequest): void {
    const m = this.machine;
    const { id } = req;
    switch (req.method) {
      case 'info':
        return this.reply(id, () => m.info());
      case 'stat':
        return this.reply(id, () => m.stat(req.params.path));
      case 'readFile':
        return this.reply(id, async () => encodeBase64(await m.readFile(req.params.path)));
      case 'readText':
        return this.reply(id, () => m.readText(req.params.path));
      case 'writeFile': {
        const p = req.params;
        return this.reply(id, () => m.writeFile(p.path, p.base64 !== undefined ? decodeBase64(p.base64) : (p.text ?? '')));
      }
      case 'readdir':
        return this.reply(id, () => m.readdir(req.params.path));
      case 'mkdir':
        return this.reply(id, () => m.mkdir(req.params.path));
      case 'remove':
        return this.reply(id, () => m.remove(req.params.path, { recursive: req.params.recursive }));
      case 'rename':
        return this.reply(id, () => m.rename(req.params.from, req.params.to));
      case 'glob':
        return this.reply(id, () => m.glob(req.params.pattern, req.params.opts));
      case 'grep':
        return this.reply(id, () => m.grep(req.params.opts));
      case 'resolve':
        return this.reply(id, async () => m.resolve(req.params.path, req.params.cwd));
      case 'exec': {
        const { command, opts } = req.params;
        const ac = new AbortController();
        this.execs.set(id, ac);
        return this.reply(id, () =>
          m
            .exec(command, {
              cwd: opts.cwd,
              env: opts.env,
              timeoutMs: opts.timeoutMs,
              stdin: opts.stdin,
              maxOutputBytes: opts.maxOutputBytes,
              signal: ac.signal,
              onOutput: opts.stream ? (data, stream) => this.send({ type: 'exec.output', id, stream, data }) : undefined,
            })
            .finally(() => this.execs.delete(id)),
        );
      }
      case 'spawn':
        return this.spawn(req.id, req.params);
      // version 2: folders across devices. The API key in config.xml never leaves this device.
      case 'syncthingFolders':
        return this.reply(id, async () => (m.syncthingFolders ? m.syncthingFolders() : notImplemented('syncthingFolders')));
      case 'syncthingStatus': {
        const folderId = req.params.folderId;
        return this.reply(id, async () => (m.syncthingStatus ? m.syncthingStatus(folderId) : notImplemented('syncthingStatus')));
      }
      // version 2: chat import. The device reads its own transcripts and sends converted rows.
      case 'readRange': {
        const { path, offset, length } = req.params;
        return this.reply(id, async () => encodeBase64(m.readRange ? await m.readRange(path, offset, length) : notImplemented('readRange')));
      }
      case 'importScan': {
        const params = req.params;
        return this.reply(id, async () => (m.importScan ? m.importScan(params) : notImplemented('importScan')));
      }
      case 'importRead': {
        const params = req.params;
        return this.reply(id, async () => (m.importRead ? m.importRead(params) : notImplemented('importRead')));
      }
      // version 5: Conclave's turns appended to a Claude Code chat on this device
      case 'importAppend': {
        const params = req.params;
        return this.reply(id, async () => (m.importAppend ? m.importAppend(params) : notImplemented('importAppend')));
      }
      // version 3: the daemon's recent log, for the hub's logs export
      case 'logTail': {
        const lines = typeof req.params?.lines === 'number' ? req.params.lines : 500;
        return this.reply(id, async () => (this.logTail ? this.logTail(lines) : notImplemented('logTail')));
      }
      // version 4: the daemon updates itself to the hub's version
      case 'selfUpdate': {
        const params = req.params;
        return this.reply(id, async () => (this.selfUpdate ? this.selfUpdate(params) : notImplemented('selfUpdate')));
      }
      default:
        this.send({ type: 'result', id, error: { message: `unknown method ${(req as { method: string }).method}` } });
    }
  }

  /** Spawn synchronously so stdin frames that follow the request find the process. */
  private spawn(id: number, params: Extract<RpcRequest, { method: 'spawn' }>['params']): void {
    const { handle } = params;
    let proc: MachineProcess;
    try {
      proc = this.machine.spawn(params.command, params.args ?? [], params.opts);
    } catch (err) {
      this.send({ type: 'result', id, error: toWireError(err) });
      return;
    }
    this.procs.set(handle, proc);
    this.send({ type: 'result', id, result: { pid: proc.pid } });
    const pump = async (stream: ReadableStream<Uint8Array>, type: 'proc.stdout' | 'proc.stderr') => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) this.send({ type, pid: handle, data: encodeBase64(value) });
        }
      } catch {
        /* stream errored; exit still gets reported */
      }
    };
    // all output goes out before proc.exit so the hub never drops a tail
    Promise.all([pump(proc.stdout, 'proc.stdout'), pump(proc.stderr, 'proc.stderr'), proc.exited.catch(() => null)]).then(
      ([, , code]) => {
        this.procs.delete(handle);
        this.send({ type: 'proc.exit', pid: handle, code: code ?? null });
      },
    );
  }

  /** Kill processes and abort execs started by this connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const ac of this.execs.values()) ac.abort();
    this.execs.clear();
    for (const p of this.procs.values()) {
      try {
        p.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.procs.clear();
  }
}

// ---------------------------------------------------------------------------
// Connection loop
// ---------------------------------------------------------------------------

export type DaemonState = 'connecting' | 'online' | 'offline' | 'stopped';

export interface DaemonStatus {
  state: DaemonState;
  /** The hub address this attempt uses. */
  url?: string;
  /** Why we went offline (close reason, error). */
  detail?: string;
  /** When offline: ms until the next attempt. */
  retryInMs?: number;
  attempt?: number;
}

export interface DaemonOptions {
  /** http(s)://hub:7717 (ws:// also works). */
  hubUrl: string;
  /** Other addresses of the same hub, tried in turn when hubUrl stops answering. */
  fallbackUrls?: string[];
  /** The hub sent its addresses (best first). Save them so the next start knows them. */
  onAddresses?: (urls: string[]) => void;
  deviceId: string;
  token: string;
  machine: Machine;
  /** Name sent in hello. The hub keeps its own stored name. */
  name?: string;
  onStatus?: (status: DaemonStatus) => void;
  heartbeatMs?: number;
  /** Backoff cap. 30s. */
  maxBackoffMs?: number;
  /** For tests or non-Bun runtimes. Must accept (url, { headers }) or (url). */
  WebSocketImpl?: unknown;
  /** Answers the hub's logTail RPC: this daemon's recent lines. Without it the RPC says not implemented. */
  logTail?: (lines: number) => DaemonLogTail;
  /** Answers the hub's selfUpdate RPC. Without it the RPC says not implemented. */
  selfUpdate?: (params: RpcParams['selfUpdate']) => Promise<SelfUpdateResult>;
}

export interface DaemonHandle {
  /** Disconnect and stop reconnecting. */
  stop(): void;
  /** Resolves after stop(). */
  readonly closed: Promise<void>;
  readonly state: DaemonState;
}

/** Connect to the hub and serve it until stop(). Never gives up on its own. */
export function runDaemon(opts: DaemonOptions): DaemonHandle {
  const WS = (opts.WebSocketImpl ?? (globalThis as { WebSocket?: unknown }).WebSocket) as
    | (new (url: string, init?: unknown) => WebSocket)
    | undefined;
  if (!WS) throw new Error('WebSocket not available');
  const heartbeat = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  // every address of the hub; `current` is the one in use, failures move to the next
  let urls = hubUrls([opts.hubUrl, ...(opts.fallbackUrls ?? [])]);
  let current = 0;
  let moving = false;

  let state: DaemonState = 'connecting';
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let server: MachineServer | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let lastHeard = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const status = (s: DaemonStatus) => {
    state = s.state;
    try {
      opts.onStatus?.(s);
    } catch {
      /* ignore */
    }
  };

  const connect = () => {
    if (stopped) return;
    const hubUrl = urls[current] ?? opts.hubUrl;
    const url = daemonUrl(hubUrl);
    status({ state: 'connecting', attempt, url: hubUrl });
    let sock: WebSocket;
    try {
      // Bun accepts headers here, which keeps the token out of URLs and logs.
      // The query string is a fallback for runtimes that drop the headers.
      const q = `?deviceId=${encodeURIComponent(opts.deviceId)}`;
      sock = new WS(url + q, { headers: { authorization: `Bearer ${opts.token}`, 'x-conclave-device': opts.deviceId } });
    } catch (err) {
      scheduleRetry(String((err as Error)?.message ?? err));
      return;
    }
    ws = sock;
    let reason = '';
    sock.onopen = async () => {
      lastHeard = Date.now();
      let info;
      try {
        info = await opts.machine.info();
      } catch (err) {
        reason = `machine info failed: ${(err as Error).message}`;
        sock.close(1011, 'info failed');
        return;
      }
      if (ws !== sock) return;
      server = new MachineServer(opts.machine, (msg) => sock.send(JSON.stringify(msg)), opts.logTail, opts.selfUpdate);
      sock.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, deviceId: opts.deviceId, name: opts.name, info } satisfies DaemonMessage));
      beat = setInterval(() => {
        if (Date.now() - lastHeard > heartbeat * 3) {
          reason = 'heartbeat timeout';
          sock.close(4008, 'heartbeat timeout');
          return;
        }
        try {
          sock.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {
          /* closing */
        }
      }, heartbeat);
    };
    sock.onmessage = (ev: MessageEvent) => {
      lastHeard = Date.now();
      const msg = parseFrame(ev.data) as HubMessage | undefined;
      if (!msg) return;
      if (msg.type === 'welcome') {
        attempt = 0;
        status({ state: 'online', url: hubUrl });
        return;
      }
      if (msg.type === 'addresses') {
        const next = hubUrls(Array.isArray(msg.urls) ? msg.urls : []);
        if (!next.length) return;
        try {
          opts.onAddresses?.(next);
        } catch {
          /* saving is best effort */
        }
        // keep the address in use while it is listed (or is this machine); move when the hub drops it (a quick tunnel that changed)
        if (next.includes(hubUrl) || isLoopbackUrl(hubUrl)) {
          urls = next.includes(hubUrl) ? next : [hubUrl, ...next];
          current = urls.indexOf(hubUrl);
          return;
        }
        // a quick tunnel address the hub dropped is gone for good; any other may come back, so keep it last
        urls = isQuickTunnelUrl(hubUrl) ? next : [...next, hubUrl];
        current = 0;
        moving = true;
        reason = 'moving to a new hub address';
        sock.close(1000, 'moving to a new hub address');
        return;
      }
      if (msg.type === 'error') {
        reason = msg.message;
        return;
      }
      if (msg.type === 'pong') return;
      server?.handle(msg);
    };
    sock.onerror = () => {
      if (!reason) reason = 'connection error';
    };
    sock.onclose = (ev: CloseEvent) => {
      if (beat) clearInterval(beat);
      beat = undefined;
      server?.close();
      server = undefined;
      if (ws === sock) ws = undefined;
      if (stopped) return;
      if (moving) {
        // the hub announced a new address: go there now, not after a backoff
        moving = false;
        attempt = 0;
        status({ state: 'offline', detail: reason, retryInMs: 0, attempt, url: urls[current] });
        retryTimer = setTimeout(connect, 0);
        return;
      }
      // 4000: another daemon with the same device id took over; do not fight it
      if (ev.code === 4000) attempt = Math.max(attempt, 16);
      scheduleRetry(reason || ev.reason || `closed (${ev.code})`);
    };
  };

  const scheduleRetry = (detail: string) => {
    if (stopped) return;
    // try the hub's other addresses in turn (the same network, an own URL, a new tunnel)
    if (urls.length > 1) current = (current + 1) % urls.length;
    const base = Math.min(maxBackoff, 1000 * 2 ** attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    attempt++;
    status({ state: 'offline', detail, retryInMs: delay, attempt, url: urls[current] });
    retryTimer = setTimeout(connect, delay);
  };

  connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (beat) clearInterval(beat);
      server?.close();
      server = undefined;
      try {
        ws?.close(1000, 'daemon stopped');
      } catch {
        /* ignore */
      }
      ws = undefined;
      status({ state: 'stopped' });
      resolveClosed();
    },
    closed,
    get state() {
      return state;
    },
  };
}

/** http(s) hub addresses without trailing slashes, duplicates or junk. */
export function hubUrls(list: unknown[]): string[] {
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const u = v.trim().replace(/\/+$/, '');
    if (!/^(https?|wss?):\/\/[^\s/]+/i.test(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= 8) break;
  }
  return out;
}

/** https://<words>.trycloudflare.com: a quick tunnel address, which never comes back once the hub drops it. */
export function isQuickTunnelUrl(url: string): boolean {
  return /^(https?|wss?):\/\/[a-z0-9-]+\.trycloudflare\.com(:\d+)?(\/|$)/i.test(url);
}

/** localhost, 127.x and [::1]: the hub on this same machine. */
export function isLoopbackUrl(url: string): boolean {
  return /^(https?|wss?):\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(url);
}
