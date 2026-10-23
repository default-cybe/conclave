/**
 * Remote access: how phones and paired computers reach the hub, with nothing
 * else to install.
 *
 *   Same network  The hub listens on every interface and answers devices on
 *                 private networks (RFC 1918, link-local, 100.64/10). Off
 *                 means only this computer and the tunnel. server.host or
 *                 --host pins the address and turns the filter off.
 *   quick         cloudflared quick tunnel, no account. The hub downloads
 *                 cloudflared, runs it, reads the https address it prints,
 *                 restarts it when it dies and stops it with the hub. The
 *                 address changes on every restart; clients and daemons get
 *                 remote.updated / {type:'addresses'} before a planned switch.
 *   stable        a named tunnel on the owner's Cloudflare zone, made through
 *                 the API with a token kept in the secrets store.
 *   tailscale,    server.publicUrl, run by the owner.
 *   custom
 *
 * The best address (stable or quick tunnel, then the own URL, then the same
 * network) goes into the pairing QR and links: it is set as the runtime
 * server.publicUrl, so notifications and hub info use it too.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { ConclaveConfig } from '@conclave/core/config/index.ts';
import type { HubAddress, RemoteMode, RemoteState, RemoteStatus } from '@conclave/core/types.ts';
import type { CloudflareZoneDto, RemoteSettingsInput, StableTunnelInput, TailscaleInfo } from '@conclave/core/client/index.ts';
import { logger } from '@conclave/core/util/log.ts';
import { HttpError } from '../http';
import { CloudflaredError, ensureCloudflared, type BinaryInfo } from './cloudflared';
import { CloudflareApi, CloudflareError, validLabel } from './cloudflare-api';
import { hostUrl, ifaceWord, isLoopback, isLocalPeer, isPrivateV4, isWildcard, lanAddresses, type Interfaces, type LanAddress } from './lan';
import { tailscaleInfo, type StatusReader } from './tailscale';
import { TunnelError, TunnelRunner, type Spawner } from './tunnel';
import { PidFile } from './pids';

const log = logger('remote');

export const REMOTE_MODES: RemoteMode[] = ['off', 'quick', 'stable', 'tailscale', 'custom'];
/** Secrets store names (values). */
export const CF_TOKEN_SECRET = 'cloudflare.apiToken';
export const CF_TUNNEL_SECRET = 'cloudflare.tunnelToken';
const KV_QUICK = 'remote.quick';

type RemoteConfig = NonNullable<ConclaveConfig['server']['remote']>;
type TunnelKind = 'quick' | 'stable';

export interface RemoteOptions {
  engine: EngineApi;
  fetch?: typeof fetch;
  /** Starts cloudflared (tests pass a fake). */
  spawn?: Spawner;
  /** Finds or downloads cloudflared (tests pass a stub). */
  binary?: (onProgress: (done: number, total?: number) => void) => Promise<BinaryInfo>;
  interfaces?: () => Interfaces;
  container?: boolean;
  tailscale?: StatusReader;
  /** How long a replaced tunnel keeps serving so clients can move. Default 20s. */
  graceMs?: number;
  readyTimeoutMs?: number;
  /** Waits before starting a tunnel again after it stopped or failed. */
  backoffMs?: number[];
  /** Every address, best first, when the list changes (daemons get it). */
  onAddresses?: (urls: string[]) => void;
}

interface Live {
  kind: TunnelKind;
  runner: TunnelRunner;
  url: string;
  since: number;
}

class RetryableError extends Error {}

function cleanUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const u = v.trim().replace(/\/+$/, '');
  try {
    const p = new URL(u);
    // a base address: no query, fragment or login in it
    if (p.search || p.hash || p.username || p.password) return undefined;
    return p.protocol === 'http:' || p.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);

export class RemoteAccess {
  private port = 0;
  private host = '127.0.0.1';
  private pinned = false;
  private attached = false;
  private closing = false;

  private state: RemoteState = 'off';
  private since = Date.now();
  private detail?: string;
  private error?: string;
  private live?: Live;
  private starting?: { kind: TunnelKind; gen: number; runner?: TunnelRunner };
  private gen = 0;
  private applied?: RemoteMode;
  private previousUrl?: string;
  private lastQuick?: string;
  private binaryInfo?: BinaryInfo;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restartAttempt = 0;
  private retiring = new Set<TunnelRunner>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastEvent = '';
  private lastUrls = '';
  private lastProgress = 0;
  /** The last failure written to the audit log and the server log; a retry that fails the same way is not repeated. */
  private lastFailure?: string;
  private offConfig?: () => void;
  private poll?: ReturnType<typeof setInterval>;
  private configQueued = false;
  private pids?: PidFile;

  constructor(private readonly opts: RemoteOptions) {}

  private get engine(): EngineApi {
    return this.opts.engine;
  }

  private cfg(): RemoteConfig {
    return this.engine.config.get().server.remote ?? {};
  }

  /** The owner's own address (server.publicUrl as saved, not the runtime one). */
  ownUrl(): string | undefined {
    return cleanUrl(this.engine.config.getUser().server?.publicUrl);
  }

  /** Mode in effect: the config, then CONCLAVE_REMOTE, then custom or tailscale when publicUrl is set, else off. */
  mode(): RemoteMode {
    const m = this.cfg().mode;
    if (m && REMOTE_MODES.includes(m)) return m;
    const env = process.env.CONCLAVE_REMOTE as RemoteMode | undefined;
    if (env && REMOTE_MODES.includes(env)) return env;
    const own = this.ownUrl();
    if (own) return /\.ts\.net$/i.test(hostOf(own)) ? 'tailscale' : 'custom';
    return 'off';
  }

  private lanOn(): boolean {
    return this.cfg().lan !== false;
  }

  private secret(name: string): string | undefined {
    return this.engine.config.expand(`\${secret:${name}}`) || undefined;
  }

  private audit(action: string, detail: string): void {
    try {
      this.engine.repos.audit.add({ actor: 'hub', action, detail });
    } catch {
      /* auditing must not break remote access */
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Called once the server listens: start what the config asks for. */
  attach(opts: { port: number; host: string; pinned: boolean }): void {
    this.port = opts.port;
    this.host = opts.host;
    this.pinned = opts.pinned;
    this.attached = true;
    // a hub that was killed leaves its cloudflared running; stop it before starting a new one
    this.pids = new PidFile(join(this.engine.config.paths.home, 'cloudflared', 'pids'));
    const stale = this.pids.reap();
    if (stale.length) log.info(`stopped ${stale.length} cloudflared left by an earlier run (pid ${stale.join(', ')})`);
    try {
      this.lastQuick = this.engine.repos.kv.get<{ url?: string } | null>(KV_QUICK, null)?.url;
    } catch {
      /* no kv */
    }
    this.offConfig = this.engine.config.onChange(() => this.onConfig());
    // the network can change under a running hub (a new DHCP lease, Wi-Fi off)
    this.poll = setInterval(() => this.publish(), 60_000);
    (this.poll as { unref?: () => void }).unref?.();
    this.reconcile();
  }

  /** Stop every tunnel. The hub is shutting down. */
  async close(): Promise<void> {
    this.closing = true;
    this.offConfig?.();
    if (this.poll) clearInterval(this.poll);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.cancelStart();
    const runners = [...this.retiring, ...(this.live ? [this.live.runner] : [])];
    this.live = undefined;
    this.retiring.clear();
    await Promise.all(runners.map((r) => r.stop().catch(() => undefined)));
  }

  private onConfig(): void {
    if (this.configQueued || this.closing) return;
    this.configQueued = true;
    queueMicrotask(() => {
      this.configQueued = false;
      if (this.mode() !== this.applied) this.reconcile();
      else this.publish();
    });
  }

  /**
   * Make what runs match the mode. A mode change is audited here unless the
   * caller is an owner action, which the route audits with who did it.
   */
  private reconcile(fromRoute = false): void {
    if (!this.attached || this.closing) return;
    const mode = this.mode();
    const changed = this.applied !== undefined && mode !== this.applied;
    this.applied = mode;
    if (changed && !fromRoute) this.audit('remote.mode', mode);
    if (mode === 'quick' || mode === 'stable') {
      const busy = this.starting ? this.starting.kind === mode : this.live?.kind === mode;
      if (!busy) void this.startTunnel(mode);
      else this.publish();
      return;
    }
    // no tunnel in this mode: stop one that is starting, retire one that runs (after the grace period)
    this.cancelStart();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.live) this.retire(this.live);
    if (mode === 'off') this.setState('off');
    else if (this.ownUrl()) this.setState('on');
    else
      this.setState(
        'error',
        undefined,
        mode === 'tailscale'
          ? `Add the hub's Tailscale address. On the hub run \`tailscale serve --bg ${this.port || 7717}\`, then pick Find it.`
          : 'Add the address your proxy or domain gives the hub, for example https://hub.example.com.',
      );
  }

  private setState(state: RemoteState, detail?: string, error?: string): void {
    if (state !== this.state) this.since = Date.now();
    this.state = state;
    this.detail = detail;
    this.error = error;
    this.publish();
  }

  /** Push the status to clients (remote.updated), the address list to daemons, and the best address into server.publicUrl. */
  private publish(): void {
    if (this.closing) return;
    const st = this.status();
    const urls = st.addresses.map((a) => a.url);
    try {
      this.engine.config.setRuntime(urls[0] ? { server: { publicUrl: urls[0] } as ConclaveConfig['server'] } : {});
    } catch (err) {
      log.warn(`could not set the public address: ${(err as Error).message}`);
    }
    const { since: _since, ...rest } = st;
    const key = JSON.stringify(rest);
    if (key !== this.lastEvent) {
      this.lastEvent = key;
      this.engine.bus.emit({ type: 'remote.updated', remote: st });
    }
    const joined = urls.join('\n');
    if (joined !== this.lastUrls) {
      this.lastUrls = joined;
      try {
        this.opts.onAddresses?.(urls);
      } catch {
        /* a daemon socket went away */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Addresses and status
  // -------------------------------------------------------------------------

  private lan(): LanAddress[] {
    if (!this.attached) return [];
    if (this.pinned) {
      if (isWildcard(this.host)) return lanAddresses(this.opts.interfaces?.(), { container: this.opts.container });
      return isPrivateV4(this.host) ? [{ ip: this.host, iface: '' }] : [];
    }
    return this.lanOn() ? lanAddresses(this.opts.interfaces?.(), { container: this.opts.container }) : [];
  }

  /** The port the hub listens on (0 until it does). */
  listenPort(): number {
    return this.port;
  }

  /** Every address that reaches the hub, best first. */
  addresses(): HubAddress[] {
    const out: HubAddress[] = [];
    const add = (url: string, kind: HubAddress['kind'], label: string) => {
      if (!out.some((a) => a.url === url)) out.push({ url, kind, label });
    };
    if (this.live) add(this.live.url, this.live.kind, this.live.kind === 'stable' ? 'Cloudflare tunnel, your domain' : 'Cloudflare quick tunnel');
    const own = this.ownUrl();
    if (own && this.mode() !== 'off') add(own, 'own', /\.ts\.net$/i.test(hostOf(own)) ? 'Tailscale' : 'Your address');
    for (const l of this.lan()) add(hostUrl(l.ip, this.port), 'lan', l.iface ? `${ifaceWord(l.iface)} ${l.ip}` : `This network ${l.ip}`);
    return out;
  }

  status(): RemoteStatus {
    const mode = this.mode();
    const cfg = this.cfg();
    const own = this.ownUrl();
    const pinnedLan = isWildcard(this.host) || isPrivateV4(this.host);
    return {
      mode,
      state: this.state,
      url: this.live?.url ?? ((mode === 'tailscale' || mode === 'custom') && own ? own : undefined),
      addresses: this.addresses(),
      previousUrl: this.previousUrl,
      since: this.since,
      detail: this.detail,
      error: this.error,
      lan: {
        on: this.pinned ? pinnedLan : this.lanOn(),
        listening: this.attached && (this.pinned ? pinnedLan : this.lanOn()),
        fixedHost: this.pinned ? this.host : undefined,
      },
      stable: cfg.stable ? { hostname: cfg.stable.hostname, zone: cfg.stable.zone } : undefined,
      cloudflareToken: !!this.secret(CF_TOKEN_SECRET),
      cloudflared: this.binaryInfo ? { path: this.binaryInfo.path, version: this.binaryInfo.version, managed: this.binaryInfo.managed, verified: this.binaryInfo.verified } : undefined,
    };
  }

  /** Origins the web app may call the API from: every address, plus the tunnels that are going away. */
  knownOrigins(): Set<string> {
    const out = new Set<string>();
    const add = (u: string | undefined) => {
      if (!u) return;
      try {
        out.add(new URL(u).origin);
      } catch {
        /* not a URL */
      }
    };
    for (const a of this.addresses()) add(a.url);
    add(this.previousUrl);
    for (const r of this.retiring) add(r.url);
    return out;
  }

  /**
   * May this peer use the hub? Loopback always (the tunnel arrives that way),
   * private networks while same network access is on, nobody else unless
   * server.host pinned the address.
   */
  allowPeer(ip: string | undefined): boolean {
    if (!this.attached || this.pinned || !ip) return true;
    if (isLoopback(ip)) return true;
    return this.lanOn() && isLocalPeer(ip);
  }

  // -------------------------------------------------------------------------
  // Tunnels
  // -------------------------------------------------------------------------

  private async binary(): Promise<BinaryInfo> {
    const onProgress = (done: number, total?: number) => {
      const now = Date.now();
      if (now - this.lastProgress < 400 && done !== total) return;
      this.lastProgress = now;
      if (!this.live) this.setState('installing', total ? `Downloading cloudflared, ${mb(done)} of ${mb(total)} MB` : `Downloading cloudflared, ${mb(done)} MB`);
      else {
        this.detail = 'Downloading cloudflared';
        this.publish();
      }
    };
    const info = this.opts.binary
      ? await this.opts.binary(onProgress)
      : await ensureCloudflared({ home: this.engine.config.paths.home, override: this.cfg().cloudflared, fetch: this.opts.fetch, onProgress });
    this.binaryInfo = info;
    return info;
  }

  /** The address cloudflared should forward to. */
  private origin(): string {
    const h = isWildcard(this.host) || isLoopback(this.host) ? '127.0.0.1' : this.host;
    return hostUrl(h, this.port);
  }

  /** A config file of our own, so a ~/.cloudflared or /etc/cloudflared config cannot change what the hub runs. */
  private cloudflaredHome(): { dir: string; config: string } {
    const dir = join(this.engine.config.paths.home, 'cloudflared');
    const config = join(dir, 'config.yml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(config, '# Written by the Conclave hub. Keeps other cloudflared settings out of its tunnel.\nno-autoupdate: true\n');
    return { dir, config };
  }

  /** Forget a start in progress and stop its cloudflared. */
  private cancelStart(): void {
    this.gen++;
    const r = this.starting?.runner;
    this.starting = undefined;
    if (r) void r.stop();
  }

  private async startTunnel(kind: TunnelKind): Promise<void> {
    this.cancelStart();
    const gen = this.gen;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const starting: { kind: TunnelKind; gen: number; runner?: TunnelRunner } = { kind, gen };
    this.starting = starting;
    const switching = !!this.live;
    const step = (detail: string) => {
      if (gen !== this.gen) return;
      if (switching) {
        this.detail = detail;
        this.publish();
      } else this.setState('starting', detail);
    };
    try {
      step(this.binaryInfo ? 'Starting cloudflared' : 'Getting cloudflared ready');
      const bin = await this.binary();
      if (gen !== this.gen || this.closing) return;
      const home = this.cloudflaredHome();
      let args: string[];
      let env: Record<string, string> = { HOME: home.dir, USERPROFILE: home.dir };
      let fixedUrl: string | undefined;
      if (kind === 'quick') {
        args = ['tunnel', '--config', home.config, '--no-autoupdate', '--url', this.origin()];
        step('Asking Cloudflare for an address');
      } else {
        const { hostname, token } = await this.prepareStable();
        if (gen !== this.gen || this.closing) return;
        args = ['tunnel', '--config', home.config, '--no-autoupdate', 'run'];
        // the token rides in the environment so it stays out of ps
        env = { ...env, TUNNEL_TOKEN: token };
        fixedUrl = `https://${hostname}`;
        step(`Connecting ${hostname} to Cloudflare`);
      }
      const runner = new TunnelRunner({ bin: bin.path, args, env, spawn: this.opts.spawn, expectUrl: kind === 'quick', readyTimeoutMs: this.opts.readyTimeoutMs, pids: this.pids });
      starting.runner = runner;
      const got = await runner.start();
      if (gen !== this.gen || this.closing) {
        await runner.stop();
        return;
      }
      const url = got.url ?? fixedUrl!;
      const old = this.live;
      this.live = { kind, runner, url, since: Date.now() };
      this.starting = undefined;
      runner.events = {
        onExit: (_code, why) => this.onExit(runner, why),
        onLink: (up) => {
          if (this.live?.runner !== runner) return;
          this.detail = up ? undefined : 'Cloudflare dropped the connection. cloudflared is reconnecting.';
          this.publish();
        },
      };
      const prev = old?.url ?? (kind === 'quick' ? this.lastQuick : undefined);
      if (prev && prev !== url) {
        this.previousUrl = prev;
        this.audit('remote.address', `${prev} -> ${url}`);
      }
      if (kind === 'quick') {
        this.lastQuick = url;
        try {
          this.engine.repos.kv.set(KV_QUICK, { url, at: Date.now() });
        } catch {
          /* no kv */
        }
      }
      this.lastFailure = undefined;
      this.audit('remote.on', `${kind} ${url}`);
      log.info(`remote access on: ${url}`);
      // clients and daemons hear about the new address first; the old tunnel keeps serving for the grace period
      this.setState('on');
      if (old) this.retire(old);
    } catch (err) {
      if (gen !== this.gen || this.closing) return;
      this.starting = undefined;
      starting.runner = undefined;
      const msg = (err as Error).message || String(err);
      if (msg !== this.lastFailure) {
        this.lastFailure = msg;
        log.warn(`remote access (${kind}) failed: ${msg}`);
        this.audit('remote.error', `${kind}: ${msg}`);
      }
      if (this.live && this.live.kind === kind) {
        // a new address was asked for and could not be had; keep the one that works
        this.detail = `Could not get a new address. ${msg}`;
        this.publish();
        return;
      }
      if (this.live) this.retire(this.live);
      const retry = err instanceof TunnelError || err instanceof RetryableError || (err instanceof CloudflaredError && /download|GitHub|Try again/i.test(msg));
      if (retry) {
        const wait = this.nextBackoff();
        this.setState('error', `Trying again in ${Math.round(wait / 1000)} seconds.`, msg);
        this.scheduleStart(kind, wait);
      } else this.setState('error', undefined, msg);
    }
  }

  private nextBackoff(): number {
    const steps = this.opts.backoffMs ?? [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
    const ms = steps[Math.min(this.restartAttempt, steps.length - 1)];
    this.restartAttempt++;
    return ms;
  }

  private scheduleStart(kind: TunnelKind, ms: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closing || this.mode() !== kind || this.starting || this.live?.kind === kind) return;
      void this.startTunnel(kind);
    }, ms);
    (this.restartTimer as { unref?: () => void }).unref?.();
  }

  /** cloudflared died: say so, then start it again. A quick tunnel comes back with a new address. */
  private onExit(runner: TunnelRunner, why: string): void {
    if (this.live?.runner !== runner || this.closing) return;
    const { kind, url, since } = this.live;
    this.live = undefined;
    if (kind === 'quick') this.previousUrl = url;
    if (Date.now() - since > 120_000) this.restartAttempt = 0;
    this.audit('remote.stopped', `cloudflared stopped (${why})`);
    log.warn(`cloudflared stopped (${why}); starting it again`);
    const wait = this.restartAttempt === 0 ? 1_000 : this.nextBackoff();
    if (this.restartAttempt === 0) this.restartAttempt = 1;
    this.setState('starting', kind === 'quick' ? 'The tunnel stopped. Starting a new one; the address will change.' : 'The tunnel stopped. Starting it again.');
    this.scheduleStart(kind, wait);
  }

  /** Stop a tunnel after the grace period, so clients on it have time to move. */
  private retire(live: Live): void {
    if (this.live === live) this.live = undefined;
    const r = live.runner;
    r.url ??= live.url;
    this.retiring.add(r);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.retiring.delete(r);
      void r.stop();
    }, this.opts.graceMs ?? 20_000);
    this.timers.add(t);
  }

  // -------------------------------------------------------------------------
  // Owner actions (routes)
  // -------------------------------------------------------------------------

  /** Write a server block change to the user config, deleting keys set to undefined. */
  private updateServer(fn: (server: Record<string, any>) => void): void {
    const user = structuredClone(this.engine.config.getUser()) as Record<string, any>;
    const server = (user.server ??= {});
    fn(server);
    if (server.remote && !Object.keys(server.remote).length) delete server.remote;
    this.engine.config.replace(user);
  }

  async set(input: RemoteSettingsInput): Promise<RemoteStatus> {
    const mode = input.mode;
    if (mode !== undefined && !REMOTE_MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${REMOTE_MODES.join(', ')}`);
    if (input.lan !== undefined && typeof input.lan !== 'boolean') throw new HttpError(400, 'lan must be true or false');
    let url: string | null | undefined = input.url === null ? null : undefined;
    if (input.url !== undefined && input.url !== null) {
      url = cleanUrl(input.url);
      if (!url) throw new HttpError(400, 'The hub cannot use that address. Use the form https://hub.example.com, with no ? or # part.');
    }
    if (mode === 'stable' && !this.cfg().stable) throw new HttpError(409, 'Set up the stable address first: paste a Cloudflare API token and pick a domain.');
    if (mode === 'tailscale' && !url && !this.ownUrl()) {
      const ts = await this.tailscale();
      if (!ts.url) throw new HttpError(400, ts.installed ? `Tailscale is not connected on the hub. Run \`sudo tailscale up\`, then \`${ts.command}\`, and try again.` : 'Tailscale is not installed on the hub. Install it, run `sudo tailscale up`, or pick another option.');
      url = ts.url;
    }
    if (mode === 'custom' && !url && !this.ownUrl()) throw new HttpError(400, 'Type the address first, for example https://hub.example.com.');
    this.updateServer((server) => {
      if (url === null) delete server.publicUrl;
      else if (url) server.publicUrl = url;
      if (mode !== undefined || input.lan !== undefined) {
        server.remote = { ...(server.remote ?? {}) };
        if (mode !== undefined) server.remote.mode = mode;
        if (input.lan !== undefined) server.remote.lan = input.lan;
      }
    });
    // the route audits this with who did it
    this.reconcile(true);
    return this.status();
  }

  /** Quick mode: get a new address. The old one keeps working until clients had time to move. */
  restart(): RemoteStatus {
    const mode = this.mode();
    if (mode !== 'quick' && mode !== 'stable') throw new HttpError(409, 'Remote access is not using a Cloudflare tunnel. Pick Quick or Stable first.');
    if (!this.starting) {
      this.restartAttempt = 0;
      void this.startTunnel(mode);
    }
    return this.status();
  }

  private api(token?: string): CloudflareApi {
    const t = token ?? this.secret(CF_TOKEN_SECRET);
    if (!t) throw new HttpError(409, 'No Cloudflare token is saved. Paste one first.');
    return new CloudflareApi(t, this.opts.fetch);
  }

  private wrap<T>(p: Promise<T>): Promise<T> {
    return p.catch((err) => {
      if (err instanceof CloudflareError) throw new HttpError(err.status === 401 ? 400 : err.status >= 500 ? 502 : err.status, err.message);
      throw err;
    });
  }

  /** Check a token, keep it, and list the zones it can edit. */
  async saveToken(token: string): Promise<CloudflareZoneDto[]> {
    const t = token.trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw new HttpError(400, 'That does not look like a Cloudflare API token. Copy it again from My Profile, API Tokens.');
    const zones = await this.wrap(this.api(t).zones());
    if (!zones.length) throw new HttpError(400, 'This token cannot see any domain. Give it Zone, DNS, Edit on the domain you want to use, then paste it again.');
    this.engine.config.setSecret('values', CF_TOKEN_SECRET, t);
    this.publish();
    return zones;
  }

  zones(): Promise<CloudflareZoneDto[]> {
    return this.wrap(this.api().zones());
  }

  /** Make or reuse the named tunnel and its DNS name, keep the tunnel token, switch to stable mode. */
  async setupStable(input: StableTunnelInput): Promise<RemoteStatus> {
    if (!this.attached || !this.port) throw new HttpError(409, 'The hub is not listening yet. Try again in a moment.');
    const zoneId = typeof input.zoneId === 'string' ? input.zoneId.trim() : '';
    if (!zoneId) throw new HttpError(400, 'zoneId is required');
    const name = (typeof input.name === 'string' && input.name.trim() ? input.name : 'conclave').trim().toLowerCase().replace(/\.+$/, '');
    if (!name.split('.').every(validLabel)) throw new HttpError(400, 'Use letters, digits and dashes for the name, for example conclave or hub-home.');
    const api = this.api();
    const zone = await this.wrap(api.zone(zoneId));
    const hostname = `${name}.${zone.name}`;
    const tunnel = await this.wrap(api.ensureTunnel(zone.accountId, `conclave-${hostname.replace(/\./g, '-')}`));
    await this.wrap(api.routeTunnel(zone.accountId, tunnel.id, hostname, this.port));
    const dnsRecordId = await this.wrap(api.upsertCname(zone.id, hostname, tunnel.id));
    const token = await this.wrap(api.tunnelToken(zone.accountId, tunnel.id));
    this.engine.config.setSecret('values', CF_TUNNEL_SECRET, token);
    this.updateServer((server) => {
      server.remote = { ...(server.remote ?? {}), mode: 'stable', stable: { accountId: zone.accountId, zoneId: zone.id, zone: zone.name, hostname, tunnelId: tunnel.id, dnsRecordId, port: this.port } };
    });
    log.info(`stable address ${hostname} set up (tunnel ${tunnel.id})`);
    this.reconcile(true);
    return this.status();
  }

  /** The stable tunnel's hostname and token, fixing its ingress when the hub port changed. */
  private async prepareStable(): Promise<{ hostname: string; token: string }> {
    const s = this.cfg().stable;
    if (!s) throw new Error('Set up the stable address first: paste a Cloudflare API token and pick a domain.');
    let token = this.secret(CF_TUNNEL_SECRET);
    const apiToken = this.secret(CF_TOKEN_SECRET);
    if (apiToken && (s.port !== this.port || !token)) {
      try {
        const api = new CloudflareApi(apiToken, this.opts.fetch);
        if (s.port !== this.port) {
          await api.routeTunnel(s.accountId, s.tunnelId, s.hostname, this.port);
          this.updateServer((server) => {
            if (server.remote?.stable) server.remote.stable.port = this.port;
          });
        }
        if (!token) {
          token = await api.tunnelToken(s.accountId, s.tunnelId);
          this.engine.config.setSecret('values', CF_TUNNEL_SECRET, token);
        }
      } catch (err) {
        if (err instanceof CloudflareError && err.status === 401) throw err;
        throw new RetryableError(`Could not update the tunnel at Cloudflare. ${(err as Error).message}`);
      }
    }
    if (!token) throw new Error('The tunnel token is missing. Set up the stable address again in Settings, Remote access.');
    return { hostname: s.hostname, token };
  }

  /** Delete the named tunnel and DNS record at Cloudflare, forget both tokens. Remote access turns off when it was stable. */
  async removeStable(): Promise<RemoteStatus & { warning?: string }> {
    const s = this.cfg().stable;
    const wasStable = this.mode() === 'stable';
    if (wasStable && this.live?.kind === 'stable') {
      const r = this.live.runner;
      this.live = undefined;
      await r.stop();
    }
    let warning: string | undefined;
    const apiToken = this.secret(CF_TOKEN_SECRET);
    if (s && apiToken) {
      const api = new CloudflareApi(apiToken, this.opts.fetch);
      try {
        if (s.dnsRecordId) await api.deleteDns(s.zoneId, s.dnsRecordId);
        await api.deleteTunnel(s.accountId, s.tunnelId);
      } catch (err) {
        warning = `Removed it here, but Cloudflare did not delete everything: ${(err as Error).message} Remove the tunnel ${s.hostname} in the Cloudflare dashboard.`;
      }
    }
    this.engine.config.setSecret('values', CF_TUNNEL_SECRET, undefined);
    this.engine.config.setSecret('values', CF_TOKEN_SECRET, undefined);
    this.updateServer((server) => {
      if (!server.remote) return;
      delete server.remote.stable;
      if (wasStable) server.remote.mode = 'off';
    });
    this.reconcile(true);
    return { ...this.status(), warning };
  }

  tailscale(): Promise<TailscaleInfo> {
    return tailscaleInfo(this.port || this.engine.config.get().server.port, this.opts.tailscale);
  }
}
