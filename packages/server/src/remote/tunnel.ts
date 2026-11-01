/**
 * One cloudflared process. It reads cloudflared's log lines, finds the quick
 * tunnel address, says when Cloudflare has registered a connection, and
 * reports when the process ends. Restarts are the caller's job.
 */

/** What cloudflared needs from a child process. Bun.spawn's result fits; tests pass a fake. */
export interface TunnelProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;
  kill(signal?: number | NodeJS.Signals): void;
  pid?: number;
}

export type Spawner = (cmd: string[], env: Record<string, string>) => TunnelProcess;

/** cloudflared settings from the environment that may stay: they only pick how it reaches Cloudflare. */
const KEEP_TUNNEL_ENV = new Set(['TUNNEL_TRANSPORT_PROTOCOL', 'TUNNEL_EDGE_IP_VERSION', 'TUNNEL_EDGE_BIND_ADDRESS', 'TUNNEL_REGION']);

/**
 * The environment cloudflared runs with: the hub's, minus Conclave's own
 * values and anything named like a key or token, and minus the TUNNEL_ and
 * CLOUDFLARED_ settings that would change what it runs (a TUNNEL_TOKEN makes
 * `tunnel --url` run someone's named tunnel; TUNNEL_LOGLEVEL=warn hides the
 * lines the hub waits for). `extra` is added last.
 */
export function cloudflaredEnv(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    if ((key.startsWith('TUNNEL_') || key.startsWith('CLOUDFLARED_')) && !KEEP_TUNNEL_ENV.has(key)) continue;
    if (key.startsWith('CONCLAVE_') || key === 'NO_AUTOUPDATE') continue;
    if (/(API_?KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

export const defaultSpawn: Spawner = (cmd, env) =>
  Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: cloudflaredEnv(process.env, env) }) as unknown as TunnelProcess;

/** A quick tunnel address. api.trycloudflare.com is where cloudflared asks for one; its errors name it. */
const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
const REGISTERED = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;
const LOST = /Unregistered tunnel connection|Lost connection with the edge|Connection terminated/i;
const QUICK_FAILED = /failed to (request|create) quick tunnel|error unmarshaling QuickTunnel response|429 Too Many Requests/i;
const BAD_TOKEN = /Unauthorized|Invalid tunnel secret|provided tunnel token is not valid|Tunnel credentials file .* doesn't exist/i;

/** The trycloudflare.com address in a cloudflared log line. */
export function quickUrlIn(line: string): string | undefined {
  return QUICK_URL.exec(line)?.[0]?.toLowerCase();
}

/** cloudflared's log line without the timestamp and level ("2025-01-01T00:00:00Z ERR msg"). */
function message(line: string): string {
  return line.replace(/^\S+\s+(INF|WRN|ERR|DBG|FTL)\s+/, '').trim();
}

export interface RunnerOptions {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  spawn?: Spawner;
  /** Quick tunnels print their address; wait for it. */
  expectUrl: boolean;
  /** Give up when no connection is registered in this time. */
  readyTimeoutMs?: number;
  /** Told the process id after the spawn and again when it ended, so a hub that died can clean up after itself (see pids.ts). */
  pids?: { add(pid: number): void; remove(pid: number): void };
}

export interface RunnerEvents {
  /** Cloudflare dropped (false) or restored (true) the connection while running. */
  onLink?: (up: boolean) => void;
  /** The process ended after it was ready. */
  onExit?: (code: number | null, why: string) => void;
}

export class TunnelError extends Error {
  constructor(
    message: string,
    readonly lines: string[] = [],
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export class TunnelRunner {
  url?: string;
  private proc?: TunnelProcess;
  private stopping = false;
  private ready = false;
  private tail: string[] = [];
  /** The last ERR or WRN line: what to show when the process ends. */
  private lastProblem?: string;
  private connections = 0;
  events: RunnerEvents = {};

  constructor(private readonly opts: RunnerOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get lastLines(): string[] {
    return [...this.tail];
  }

  /** Spawn cloudflared and resolve once Cloudflare registered a connection (and, for quick tunnels, the address is known). */
  start(): Promise<{ url?: string }> {
    const spawn = this.opts.spawn ?? defaultSpawn;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill();
        reject(new TunnelError(msg, this.lastLines));
      };
      const maybeReady = () => {
        if (settled || this.connections < 1 || (this.opts.expectUrl && !this.url)) return;
        settled = true;
        this.ready = true;
        clearTimeout(timer);
        resolve({ url: this.url });
      };
      const timer = setTimeout(
        () => fail(this.url ? 'cloudflared got an address but could not connect to Cloudflare. Check that this machine can reach Cloudflare on port 7844 (TCP or UDP).' : 'cloudflared did not get an address from Cloudflare in time. Check the hub can reach the internet, then try again.'),
        this.opts.readyTimeoutMs ?? 45_000,
      );

      let proc: TunnelProcess;
      try {
        proc = spawn([this.opts.bin, ...this.opts.args], this.opts.env ?? {});
      } catch (err) {
        clearTimeout(timer);
        settled = true;
        reject(new TunnelError(`Could not start cloudflared: ${(err as Error).message}.`));
        return;
      }
      this.proc = proc;
      const pid = proc.pid;
      if (pid) this.opts.pids?.add(pid);

      const onLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        this.tail.push(message(line));
        if (this.tail.length > 12) this.tail.shift();
        if (/\s(ERR|WRN|FTL)\s/.test(` ${line} `)) this.lastProblem = message(line);
        if (this.opts.expectUrl && !this.url) {
          const u = quickUrlIn(line);
          if (u) this.url = u;
        }
        if (REGISTERED.test(line)) {
          this.connections++;
          if (this.ready && this.connections === 1) this.events.onLink?.(true);
          maybeReady();
          return;
        }
        if (LOST.test(line) && this.connections > 0) {
          this.connections = Math.max(0, this.connections - 1);
          if (this.ready && this.connections === 0) this.events.onLink?.(false);
          return;
        }
        if (!this.ready && QUICK_FAILED.test(line)) {
          const text = message(line);
          fail(
            /429/.test(line)
              ? 'Cloudflare is limiting new quick tunnels from this address right now. Wait a few minutes and turn it on again.'
              : /no such host|dial tcp|i\/o timeout|connection refused|network is unreachable/i.test(line)
                ? `cloudflared could not reach Cloudflare (${text.replace(/^.*?: (?=dial tcp|lookup)/, '')}). Check that the hub has internet access and working DNS.`
                : `Cloudflare did not give out a quick tunnel: ${text}. Try again in a minute.`,
          );
          return;
        }
        if (!this.ready && BAD_TOKEN.test(line)) fail('Cloudflare refused the tunnel token. Set up the stable address again in Settings, Remote access.');
      };
      void pump(proc.stdout, onLine);
      void pump(proc.stderr, onLine);

      const gone = () => {
        if (pid) this.opts.pids?.remove(pid);
      };
      proc.exited.then(
        (code) => {
          gone();
          const why = this.lastProblem ?? `exit code ${code}`;
          this.proc = undefined;
          if (!settled) {
            fail(`cloudflared stopped before the tunnel was up (${why}).`);
            return;
          }
          if (this.ready && !this.stopping) this.events.onExit?.(code, why);
        },
        () => {
          gone();
          if (!settled) fail('cloudflared stopped before the tunnel was up.');
        },
      );
    });
  }

  private kill(signal: NodeJS.Signals = 'SIGTERM') {
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
    const done = await Promise.race([proc.exited.then(() => true, () => true), new Promise<false>((r) => setTimeout(() => r(false), 5_000))]);
    if (!done) this.kill('SIGKILL');
    this.proc = undefined;
  }
}

/** Feed each line a child process writes to onLine. */
export async function pump(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 64 * 1024) buf = buf.slice(-4096);
    }
    if (buf) onLine(buf);
  } catch {
    /* the process went away */
  }
}
