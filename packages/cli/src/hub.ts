/**
 * Finding and reaching the hub.
 *
 * Order: --hub/--token flags, CONCLAVE_HUB/CONCLAVE_TOKEN, ~/.conclave/client.json
 * (from `conclave login`), else the local hub in ~/.conclave/config.json.
 * Only the local hub is auto-started.
 */
import { openSync, mkdirSync, existsSync, readFileSync, closeSync, renameSync, statSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { parseJsonc } from '@conclave/core/config/index.ts';
import { cliPaths, normalizeHubUrl, readClientFile, writePrivateJson, type ClientFile } from './files';

export interface HubTarget {
  url: string;
  token?: string;
  source: 'flag' | 'env' | 'client' | 'local';
  /** True for the hub from config.json: we may start it. */
  local: boolean;
  /** The saved login's hub key, when the URL is that hub's (ClientOptions.hubKey). */
  hubKey?: string;
}

export interface LocalHub {
  url: string;
  token?: string;
  host: string;
  port: number;
}

export interface ResolveInput {
  flags: { hub?: string; token?: string };
  env: Record<string, string | undefined>;
  client?: ClientFile;
  local: LocalHub;
}

/** Pure resolution so it can be tested. */
export function resolveHub(input: ResolveInput): HubTarget {
  const { flags, env, client, local } = input;
  const tokenFor = (url: string): string | undefined => {
    if (flags.token) return flags.token;
    if (env.CONCLAVE_TOKEN) return env.CONCLAVE_TOKEN;
    if (client && normalizeHubUrl(client.hub) === url) return client.token;
    if (sameHub(url, local.url)) return local.token;
    return undefined;
  };
  // the key belongs to the hub, whichever of its addresses is used
  const keyFor = (url: string): { hubKey?: string } => {
    const saved = client?.hubKey && [client.hub, ...(client.addresses ?? [])].some((a) => normalizeHubUrl(a) === url);
    return saved ? { hubKey: client!.hubKey } : {};
  };
  if (flags.hub) {
    const url = normalizeHubUrl(flags.hub);
    return { url, token: tokenFor(url), source: 'flag', local: false, ...keyFor(url) };
  }
  if (env.CONCLAVE_HUB) {
    const url = normalizeHubUrl(env.CONCLAVE_HUB);
    return { url, token: tokenFor(url), source: 'env', local: false, ...keyFor(url) };
  }
  if (client) {
    const url = normalizeHubUrl(client.hub);
    return { url, token: flags.token ?? env.CONCLAVE_TOKEN ?? client.token, source: 'client', local: false, ...(client.hubKey ? { hubKey: client.hubKey } : {}) };
  }
  return { url: local.url, token: flags.token ?? env.CONCLAVE_TOKEN ?? local.token, source: 'local', local: true };
}

function sameHub(a: string, b: string): boolean {
  const norm = (u: string) => u.replace('://localhost', '://127.0.0.1');
  return norm(a) === norm(b);
}

/** Read server.host/port/token from ~/.conclave/config.json (env overrides like ConfigStore). */
export function readLocalHub(home?: string, env: Record<string, string | undefined> = process.env): LocalHub {
  const file = cliPaths(home).config;
  let server: { host?: string; port?: number; token?: string } = {};
  if (existsSync(file)) {
    try {
      const cfg = parseJsonc<{ server?: typeof server }>(readFileSync(file, 'utf8'));
      server = cfg.server ?? {};
    } catch {
      /* broken config: fall back to defaults, doctor reports it */
    }
  }
  const host = reachable(env.CONCLAVE_HOST || server.host || '127.0.0.1');
  const port = Number(env.CONCLAVE_PORT || server.port || 7717);
  return { url: localUrl(host, port), token: server.token, host, port };
}

/** A listen address as this machine reaches it: a wildcard one on 127.0.0.1. */
function reachable(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
}

/** The URL of a hub listening on host:port on this machine, with brackets for IPv6. */
export function localUrl(host: string, port: number): string {
  const h = reachable(host);
  return `http://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${port}`;
}

export function currentHub(flags: { hub?: string; token?: string }, home?: string): HubTarget {
  return resolveHub({ flags, env: process.env, client: readClientFile(home), local: readLocalHub(home) });
}

export type Health = { ok: true; status: number } | { ok: false; reason: 'refused' | 'timeout' | 'http'; status?: number; detail?: string };

/** GET /api/health. Any HTTP answer means something listens; ok only for 2xx. */
export async function checkHealth(url: string, timeoutMs = 1500): Promise<Health> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/health`, { signal: ac.signal });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, reason: 'http', status: res.status };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (ac.signal.aborted) return { ok: false, reason: 'timeout', detail: msg };
    return { ok: false, reason: 'refused', detail: msg };
  } finally {
    clearTimeout(t);
  }
}

/** argv prefix that re-runs this CLI: [bun, script] from source or [binary] when compiled. */
export function selfCommand(): string[] {
  const exe = process.execPath;
  const isBun = /(^|[\\/])bun(-debug)?(\.exe)?$/i.test(exe);
  if (!isBun) return [exe];
  const main = typeof Bun !== 'undefined' ? Bun.main : process.argv[1];
  return [exe, main];
}

export interface DetachedHub {
  pid?: number;
  /** Set when the process died (exit code or signal). */
  exited: () => string | undefined;
}

function chmodQuietly(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows, or not ours: the folder's own rights hold */
  }
}

/**
 * logs/hub.log for a detached hub's output, opened for appending: this
 * user's only (the folder 0700, the file 0600, also when they were made
 * before), started over past 10 MB with one old copy kept.
 */
export function openHubLog(home?: string): number {
  const p = cliPaths(home);
  mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  chmodQuietly(p.logs, 0o700);
  // hub.log is only stdout; the hub keeps its own daily files
  try {
    if (statSync(p.hubLog).size > 10 * 1024 * 1024) renameSync(p.hubLog, `${p.hubLog}.1`);
  } catch {
    /* no file yet */
  }
  const fd = openSync(p.hubLog, 'a', 0o600);
  chmodQuietly(p.hubLog, 0o600);
  return fd;
}

/** Start `conclave serve` in the background with output in logs/hub.log. */
export function spawnDetachedHub(extraArgs: string[] = [], home?: string): DetachedHub {
  const fd = openHubLog(home);
  const [cmd, ...pre] = selfCommand();
  const child = spawn(cmd, [...pre, 'serve', ...extraArgs], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, CONCLAVE_DETACHED: '1' },
  });
  let exit: string | undefined;
  child.on('exit', (code, signal) => (exit = signal ? `signal ${signal}` : `exit code ${code}`));
  child.on('error', (e) => (exit = e.message));
  child.unref();
  closeSync(fd);
  return { pid: child.pid, exited: () => exit };
}

/** Last lines of the hub log, for error messages. */
export function hubLogTail(home?: string, lines = 12): string {
  try {
    const text = readFileSync(cliPaths(home).hubLog, 'utf8');
    return text.trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Poll /api/health until it answers, the started process dies, or time runs out. */
export async function waitForHealth(url: string, timeoutMs = 20_000, intervalMs = 200, proc?: DetachedHub): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h = await checkHealth(url, 1000);
    if (h.ok) return true;
    if (proc?.exited()) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export interface ConnectOptions {
  flags: { hub?: string; token?: string };
  /** Start the local hub when it is down. Default true. */
  autostart?: boolean;
  /** Progress lines (e.g. "Starting hub..."). */
  log?: (line: string) => void;
  home?: string;
}

export class HubUnavailableError extends Error {
  constructor(
    message: string,
    public target: HubTarget,
  ) {
    super(message);
  }
}

/** Resolve the hub, start the local one if needed, and return a client. */
export async function connectHub(opts: ConnectOptions): Promise<{ client: ConclaveClient; target: HubTarget; started: boolean }> {
  let target = currentHub(opts.flags, opts.home);
  let health = await checkHealth(target.url);
  let started = false;
  if (!health.ok && health.reason === 'refused' && target.local && opts.autostart !== false) {
    opts.log?.(`Starting local hub at ${target.url} (logs: ${cliPaths(opts.home).hubLog})`);
    const proc = spawnDetachedHub([], opts.home);
    const up = await waitForHealth(target.url, 20_000, 200, proc);
    if (!up) {
      const why = proc.exited() ? ` (it stopped: ${proc.exited()})` : '';
      const tail = hubLogTail(opts.home);
      throw new HubUnavailableError(`Hub did not start${why}. Log ${cliPaths(opts.home).hubLog}:${tail ? '\n' + tail : ' (empty)'}`, target);
    }
    started = true;
    // The hub writes a token into config.json on first run; read it again.
    target = currentHub(opts.flags, opts.home);
    health = { ok: true, status: 200 };
  }
  // a saved login whose address stopped answering: try the hub's other addresses (a quick tunnel changes on restart)
  if (!health.ok && health.reason !== 'http' && target.source === 'client') {
    const saved = readClientFile(opts.home);
    for (const alt of saved?.addresses ?? []) {
      const url = normalizeHubUrl(alt);
      if (url === target.url) continue;
      const h = await checkHealth(url, 2500);
      if (!h.ok) continue;
      opts.log?.(`${target.url} did not answer; using ${url}`);
      writePrivateJson(cliPaths(opts.home).client, { ...saved!, hub: url });
      target = { ...target, url };
      health = h;
      break;
    }
  }
  if (target.source === 'client' && health.ok) void refreshAddresses(target, opts.home).then(() => (target.hubKey ? undefined : pinOnFirstUse(target, opts.home)));
  if (!health.ok) {
    if (health.reason === 'http' && health.status !== 404) {
      throw new HubUnavailableError(`Hub at ${target.url} answered ${health.status} on /api/health`, target);
    }
    if (health.reason !== 'http') {
      const hint = target.local ? 'Run `conclave serve`.' : `Check the URL or run \`conclave login <url>\` (source: ${target.source}).`;
      throw new HubUnavailableError(`Cannot reach hub at ${target.url}. ${hint}`, target);
    }
  }
  return { client: new ConclaveClient({ baseUrl: target.url, token: target.token, hubKey: target.hubKey }), target, started };
}

/** Keep the saved login's address list current, so the next start can fall back. Best effort. */
async function refreshAddresses(target: HubTarget, home?: string): Promise<void> {
  try {
    const s = await new ConclaveClient({ baseUrl: target.url, token: target.token, hubKey: target.hubKey }).remote();
    const urls = s.addresses.map((a) => a.url);
    const saved = readClientFile(home);
    if (!saved || !urls.length || JSON.stringify(saved.addresses) === JSON.stringify(urls)) return;
    writePrivateJson(cliPaths(home).client, { ...saved, addresses: urls });
  } catch {
    /* an older hub without /api/remote */
  }
}

/** A login saved before hubs had a key keeps the key the hub proves now (trust on first use). Best effort. */
async function pinOnFirstUse(target: HubTarget, home?: string): Promise<void> {
  try {
    const id = await new ConclaveClient({ baseUrl: target.url }).checkIdentity();
    const saved = readClientFile(home);
    if (!saved || saved.hubKey || normalizeHubUrl(saved.hub) !== target.url) return;
    writePrivateJson(cliPaths(home).client, { ...saved, hubKey: id.publicKey, fingerprint: id.fingerprint });
  } catch {
    /* an older hub without /api/identity */
  }
}

/** Browser login link. The token rides in the fragment so it never hits server logs. */
export function loginLink(url: string, token?: string): string {
  return token ? `${url}/#token=${encodeURIComponent(token)}` : url;
}
