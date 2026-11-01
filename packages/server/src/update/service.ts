/**
 * Updates on the hub (docs/DESIGN.md, Updates; routes in routes-update.ts).
 *
 * Checks the newest release once a day and when the owner opens Settings >
 * About. Update now downloads the archive for this system, checks its size,
 * SHA-256 and signature, writes <home>/updates/request.json and starts the
 * finisher outside the hub's own service (core/update/finish.ts), which swaps
 * the folders, restarts the service, waits for the new version and rolls back
 * when it does not come up. Docker, the desktop app's hub, a checkout and a
 * binary nobody supervises are told how to update instead.
 *
 * "Install updates automatically" (on unless the owner turned it off) runs
 * the same by itself. Window idle (default): the hub looks every hour and
 * installs once engine.busyWork() was empty on two ticks in a row; a device's
 * daemon updates when nothing runs on that device. Window night: 03:00 to
 * 05:00 on the hub's clock, when nothing runs. "Update when idle" is a
 * one-shot of the idle rule for one version. Update now refuses (409, with
 * what runs) while work runs, unless forced. The owner hears how it went.
 *
 * Devices: a daemon older than the hub gets the hub's version on Update (or
 * at night with the setting on): the selfUpdate RPC (protocol 4) carries the
 * hub's version and that release's manifest, and the daemon does the rest.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { Device } from '@conclave/core/types.ts';
import type { BusyWorkDto, DeviceUpdateDto, DeviceUpdatesDto, UpdateJobDto, UpdateStatusDto, UpdateWindow } from '@conclave/core/client/updates.ts';
import type { RemoteMachine } from '@conclave/core/machine/remote.ts';
import {
  detectHubInstall,
  downloadArtifact,
  fetchManifest,
  FINAL_PHASES,
  hasAvx2,
  hubArchive,
  hubTarget,
  isNewer,
  manifestUrl,
  readState,
  REQUEST_FILE,
  updateKey,
  UpdateError,
  verifyArtifact,
  type HubInstall,
  type KeyState,
  type UpdateManifest,
  type UpdateRequest,
} from '@conclave/core/update/index.ts';
import { logger } from '@conclave/core/util/log.ts';
import { HttpError } from '../http';

const log = logger('update');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "Update when idle": the version the owner asked for, kept over a restart. */
const WHEN_IDLE_KEY = 'update.whenIdle';
/** The night window, on the hub's clock. */
export const WINDOW = { from: 3, to: 5 };
/** A device that took its update and has not come back with the new version by then failed. */
const DEVICE_RETURN_MS = 10 * 60_000;

export interface UpdateOptions {
  fetch?: typeof fetch;
  /** How this hub was installed (tests describe one). */
  install?: HubInstall;
  key?: KeyState;
  now?: () => number;
  /** Daily checks and the night window. Default on, off under `bun test`. */
  background?: boolean;
  /** How often the background work looks. Default 10 minutes. */
  tickMs?: number;
  /** Start the finisher once request.json is written (tests run it in this process). */
  startFinisher?: (req: UpdateRequest, install: HubInstall, updatesDir: string) => Promise<void>;
  /** The manifest of the newest release, or of one version. */
  manifestUrl?: (version?: string) => string;
  /** <home>/updates. */
  updatesDir?: string;
  /** Poll state.json this often while the finisher runs. */
  pollMs?: number;
}

/** The hour of `now` on this machine's clock is in the night window. */
export function inWindow(now: number, w = WINDOW): boolean {
  const h = new Date(now).getHours();
  return h >= w.from && h < w.to;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const WINDOW_WORDS = `${pad(WINDOW.from)}:00 to ${pad(WINDOW.to)}:00`;

const KIND_WORDS: Record<BusyWorkDto['kind'], [string, string]> = {
  session: ['session', 'sessions'],
  task: ['background task', 'background tasks'],
  queued: ['queued message', 'queued messages'],
  workflow: ['workflow run', 'workflow runs'],
  routine: ['routine run', 'routine runs'],
};

/** "2 sessions, 1 workflow run running: A, B, W." */
export function busyWords(busy: BusyWorkDto[]): string {
  const counts = new Map<BusyWorkDto['kind'], number>();
  for (const b of busy) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`);
  const names = busy.slice(0, 5).map((b) => b.name || b.id);
  return `${parts.join(', ')} running: ${names.join(', ')}${busy.length > 5 ? `, and ${busy.length - 5} more` : ''}.`;
}

/** Update now while work runs: the route answers 409 with the list. */
export class BusyError extends HttpError {
  constructor(readonly busy: BusyWorkDto[]) {
    super(409, busyWords(busy));
  }
}

export class UpdateService {
  private latest?: UpdateManifest;
  private checkedAt?: number;
  private checkError?: string;
  private checking?: Promise<void>;
  private job?: UpdateJobDto;
  private localUrl = 'http://127.0.0.1:7717';
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private poller?: ReturnType<typeof setInterval>;
  private unsub?: () => void;
  private readonly install: HubInstall;
  private readonly now: () => number;
  readonly updatesDir: string;
  /** The last update each device got, by device id. */
  private devices = new Map<string, DeviceUpdateDto & { sentAt?: number }>();
  /** The manifest of the hub's own version, which devices update to. */
  private own?: { at: number; manifest: UpdateManifest };
  /** Versions the night window already tried, so a failed one is not tried every 10 minutes. */
  private triedAuto = new Set<string>();
  /** Ticks in a row that found nothing running. */
  private idleTicks = 0;

  constructor(
    private readonly engine: EngineApi,
    private readonly opts: UpdateOptions = {},
  ) {
    this.install = opts.install ?? detectHubInstall();
    this.now = opts.now ?? Date.now;
    this.updatesDir = opts.updatesDir ?? join(engine.config.paths.home, 'updates');
  }

  private get key(): KeyState {
    return this.opts.key ?? updateKey();
  }

  private get f(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private url(version?: string): string {
    return this.opts.manifestUrl ? this.opts.manifestUrl(version) : manifestUrl(version);
  }

  /** The hub listens here: the finisher waits for /api/health on it. */
  attach(opts: { url: string }): void {
    // a hub on every interface answers on loopback; a pinned address is asked where it listens
    this.localUrl = opts.url.replace(/\/+$/, '');
  }

  /** Read how the last update went, and start the daily check and the night window. */
  start(): void {
    this.followState();
    this.unsub = this.engine.bus.on((ev) => {
      if (ev.type === 'device.updated' && ev.device.online) this.deviceOnline(ev.device);
    });
    const background = this.opts.background ?? process.env.NODE_ENV !== 'test';
    if (!background) return;
    const tick = () => void this.tick().catch((err) => log.warn('update tick failed', err));
    this.first = setTimeout(tick, 60_000);
    this.timer = setInterval(tick, this.opts.tickMs ?? 10 * 60_000);
    (this.first as { unref?: () => void }).unref?.();
    (this.timer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    if (this.poller) clearInterval(this.poller);
    this.unsub?.();
  }

  private get auto(): boolean {
    return this.engine.config.get().updates?.auto === true;
  }

  private get window(): UpdateWindow {
    return this.engine.config.get().updates?.window === 'night' ? 'night' : 'idle';
  }

  private get whenIdle(): string {
    return this.engine.repos.kv.get<string>(WHEN_IDLE_KEY, '');
  }

  status(): UpdateStatusDto {
    const key = this.key;
    const latest = this.latest;
    const { unit: _u, scope: _s, helper: _h, ...install } = this.install;
    return {
      current: this.engine.version,
      ...(latest ? { latest: { version: latest.version, notes: latest.notes, pubDate: latest.pubDate || undefined, signed: latest.signed } } : {}),
      available: !!latest && isNewer(latest.version, this.engine.version),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      checking: !!this.checking,
      ...(this.checkError ? { checkError: this.checkError } : {}),
      install,
      keyMissing: !key.ok,
      auto: { on: this.auto, window: this.window, hours: WINDOW_WORDS },
      ...(this.whenIdle ? { whenIdle: this.whenIdle } : {}),
      ...(this.job ? { job: { ...this.job } } : {}),
    };
  }

  /** Ask for the newest release now (one check at a time). */
  async check(): Promise<UpdateStatusDto> {
    this.checking ??= (async () => {
      try {
        this.latest = await fetchManifest(this.url(), this.f);
        this.checkError = undefined;
      } catch (err) {
        this.checkError = (err as Error).message;
        log.info('update check failed', { error: this.checkError });
      } finally {
        this.checkedAt = this.now();
        this.checking = undefined;
      }
    })();
    await this.checking;
    return this.status();
  }

  setAuto(patch: { auto?: boolean; window?: UpdateWindow }): UpdateStatusDto {
    this.engine.config.update({ updates: { ...(this.engine.config.getUser().updates ?? {}), ...patch } });
    const when = this.window === 'night' ? `at night, ${WINDOW_WORDS}` : 'when nothing runs';
    this.audit('owner', 'update.auto', this.auto ? `install updates automatically, ${when}` : 'install updates by hand');
    return this.status();
  }

  /** "Update when idle": install `version` once nothing has run for two ticks, also with automatic updates off. */
  async applyWhenIdle(version: string, by: string): Promise<UpdateStatusDto> {
    if (!this.install.canUpdate) throw new HttpError(409, this.install.why ?? 'This hub cannot update itself.');
    if (!this.latest || this.latest.version !== version) await this.check();
    if (this.latest?.version !== version || !isNewer(version, this.engine.version)) throw new HttpError(409, `The newest release is ${this.latest?.version ?? 'unknown'}, not ${version}.`);
    this.engine.repos.kv.set(WHEN_IDLE_KEY, version);
    this.audit(by, 'update.when_idle', `${this.engine.version} -> ${version} once nothing runs`);
    return this.status();
  }

  private audit(actor: string, action: string, detail: string, device?: string): void {
    try {
      this.engine.repos.audit.add({ actor, action, detail, ...(device ? { device } : {}) });
    } catch {
      /* auditing never stops an update */
    }
  }

  private running(): boolean {
    return !!this.job && !FINAL_PHASES.includes(this.job.phase);
  }

  /**
   * Update now: check what can be checked here, download, and hand off to the
   * finisher. Returns at once with the job; status() follows it.
   */
  async apply(version: string, by: string, opts: { force?: boolean } = {}): Promise<UpdateStatusDto> {
    if (!this.install.canUpdate) throw new HttpError(409, this.install.why ?? 'This hub cannot update itself.');
    const key = this.key;
    if (!key.ok) throw new HttpError(409, key.why);
    if (this.running()) throw new HttpError(409, `An update to ${this.job!.version} is already running.`);
    if (!this.latest || this.latest.version !== version) await this.check();
    const m = this.latest;
    if (!m) throw new HttpError(502, this.checkError ?? 'Could not read the newest release.');
    if (m.version !== version) throw new HttpError(409, `The newest release is ${m.version}, not ${version}.`);
    if (!isNewer(m.version, this.engine.version)) throw new HttpError(409, `This hub already runs ${this.engine.version}.`);
    if (!m.signed) throw new HttpError(409, 'This release is unsigned, so it is not installed. Update by hand, or wait for a signed release.');
    const target = hubTarget(process.platform, process.arch, hasAvx2());
    const artifact = target ? m.hub[target] : undefined;
    if (!target || !artifact || artifact.file !== hubArchive(target)) throw new HttpError(409, `Release ${m.version} has no hub for this system.`);
    // the restart would cut running agents: the owner says "Update anyway" or "Update when idle"
    if (by !== 'auto' && !opts.force) {
      const busy = this.engine.busyWork();
      if (busy.length) throw new BusyError(busy);
    }
    const job: UpdateJobDto = { id: randomBytes(6).toString('hex'), version: m.version, from: this.engine.version, phase: 'downloading', startedAt: this.now(), by, done: 0, total: artifact.size };
    this.job = job;
    this.audit(by, 'update.start', `${job.from} -> ${job.version}`);
    void this.run(job, m, target, key).catch((err) => this.fail(job, err));
    return this.status();
  }

  private fail(job: UpdateJobDto, err: unknown): void {
    job.phase = 'failed';
    job.message = err instanceof UpdateError || err instanceof HttpError ? (err as Error).message : `The update stopped: ${(err as Error).message}`;
    job.finishedAt = this.now();
    this.audit(job.by, 'update.failed', `${job.from} -> ${job.version}: ${job.message}`);
    this.engine.repos.kv.set('update.audited', job.id);
    this.tell(job);
    log.warn('update failed', { version: job.version, error: job.message });
  }

  /** Tell the owner how an update ended (notifications.on.updates). */
  private tell(job: UpdateJobDto): void {
    const done = job.phase === 'done';
    const title = done ? `Conclave updated to ${job.version}` : job.phase === 'rolled-back' ? `Update to ${job.version} rolled back` : `Update to ${job.version} failed`;
    const body = done ? `Updated from ${job.from} to ${job.version}.` : `${job.message ?? job.phase} Still on ${job.from}.`;
    try {
      this.engine.notifyEvent('updates', { title, body, level: done ? 'success' : 'error', link: '/settings/about' });
    } catch (err) {
      log.warn('update notice failed', err);
    }
  }

  private async run(job: UpdateJobDto, m: UpdateManifest, target: string, key: KeyState): Promise<void> {
    const artifact = m.hub[target];
    mkdirSync(this.updatesDir, { recursive: true, mode: 0o755 });
    const final = join(this.updatesDir, artifact.file);
    const part = `${final}.part`;
    rmSync(final, { force: true });
    const hashes = await downloadArtifact(artifact, part, {
      fetch: this.f,
      onProgress: (done, total) => {
        job.done = done;
        job.total = total;
      },
    });
    job.phase = 'checking';
    // checked here so a bad file never reaches the finisher; the finisher checks its own copy again
    try {
      verifyArtifact(hashes, artifact, key);
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
    renameSync(part, final);
    const req: UpdateRequest = {
      id: job.id,
      version: m.version,
      from: job.from,
      target,
      artifact,
      healthUrl: this.localUrl,
      unit: this.install.unit ?? 'conclave-hub.service',
      scope: this.install.scope ?? 'user',
      by: job.by,
      at: job.startedAt,
    };
    const file = join(this.updatesDir, REQUEST_FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify(req, null, 2) + '\n', { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
    job.phase = 'installing';
    job.message = `Installing Conclave ${m.version}. The hub restarts in a moment.`;
    const start = this.opts.startFinisher ?? startFinisher;
    await start(req, this.install, this.updatesDir);
    this.followState();
  }

  /** Follow state.json until the finisher is done, then write the audit line once. */
  followState(): void {
    const settle = (): boolean => {
      const s = readState(this.updatesDir);
      // a job this process started (downloading, or waiting for the finisher's first word)
      const mine = this.job && !FINAL_PHASES.includes(this.job.phase) ? this.job : undefined;
      if (!s) return !mine;
      // state.json is still the last update's: the finisher has not written yet
      if (mine && mine.id !== s.id) return false;
      this.job = { ...s };
      if (!FINAL_PHASES.includes(s.phase)) return false;
      if (this.engine.repos.kv.get<string>('update.audited', '') !== s.id) {
        this.engine.repos.kv.set('update.audited', s.id);
        const action = s.phase === 'done' ? 'update.done' : s.phase === 'rolled-back' ? 'update.rolled_back' : 'update.failed';
        this.audit(s.by === 'auto' ? 'update' : s.by, action, `${s.from} -> ${s.version}: ${s.message ?? s.phase}`);
        this.tell(s);
        log.info('update finished', { phase: s.phase, from: s.from, to: s.version });
      }
      return true;
    };
    if (settle() || this.poller) return;
    const started = this.now();
    this.poller = setInterval(() => {
      if (settle()) {
        clearInterval(this.poller);
        this.poller = undefined;
        return;
      }
      // a finisher that never started, or died, is not coming back after 10 minutes
      if (this.now() - started > 10 * 60_000) {
        clearInterval(this.poller);
        this.poller = undefined;
        const job = this.job;
        if (job && !FINAL_PHASES.includes(job.phase)) {
          rmSync(join(this.updatesDir, REQUEST_FILE), { force: true });
          this.fail(job, new UpdateError(job.phase === 'installing' ? 'The updater did not start in 10 minutes. Nothing was changed.' : `The updater stopped while ${job.phase}. Check the hub's service.`));
        }
      }
    }, this.opts.pollMs ?? 2000);
    (this.poller as { unref?: () => void }).unref?.();
  }

  /** The check (hourly when idle, else daily), then the hub and devices in the window. */
  async tick(): Promise<void> {
    const now = this.now();
    const cfg = this.engine.config.get().updates;
    const idleMode = this.window === 'idle';
    let whenIdle = this.whenIdle;
    if (whenIdle && !isNewer(whenIdle, this.engine.version)) {
      this.engine.repos.kv.delete(WHEN_IDLE_KEY);
      whenIdle = '';
    }
    if (cfg?.check !== false && (!this.checkedAt || now - this.checkedAt > (idleMode && this.auto ? HOUR : DAY))) await this.check();
    // two ticks in a row: a session that rests a moment between turns is not cut
    const idle = this.engine.isIdle();
    this.idleTicks = idle ? this.idleTicks + 1 : 0;
    const autoNow = this.auto && (idleMode || inWindow(now));
    if (!autoNow && !whenIdle) return;
    // devices first: the hub's own restart would cut their connections
    if (autoNow) {
      for (const d of this.engine.devices.list('owner')) {
        if (!d.online || d.id === 'local') continue;
        const u = this.deviceView(d);
        const last = this.devices.get(d.id);
        if (u.mode !== 'self' || !u.behind || (last && last.target === u.target && last.at && now - last.at < DAY)) continue;
        // a daemon's restart would cut a session or task working on that device
        if (!this.engine.isIdle(d.id)) continue;
        void this.updateDevice(d.id, 'auto').catch(() => {});
      }
    }
    const latest = this.latest;
    if (!latest || !isNewer(latest.version, this.engine.version) || !this.install.canUpdate || this.running()) return;
    // a version that failed or was rolled back is not tried again by itself (state.json keeps it over the restart)
    const failed = this.triedAuto.has(latest.version) || (this.job?.version === latest.version && this.job.phase !== 'done');
    if (!whenIdle && failed) return;
    if (!(whenIdle || idleMode ? this.idleTicks >= 2 : idle)) return;
    this.engine.repos.kv.delete(WHEN_IDLE_KEY);
    this.triedAuto.add(latest.version);
    await this.apply(latest.version, 'auto').catch((err) => log.warn('automatic update did not start', { error: (err as Error).message }));
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  private deviceView(d: Device): DeviceUpdateDto {
    const daemon = d.info?.daemon;
    const target = this.engine.version;
    const current = daemon?.version;
    const behind = !!current && isNewer(target, current);
    const last = this.devices.get(d.id);
    let mode: DeviceUpdateDto['mode'] = 'manual';
    let why: string | undefined;
    const proto = (this.engine.devices.get(d.id) as { protocol?: number } | undefined)?.protocol ?? 0;
    if (daemon?.update === 'app') {
      mode = 'app';
      why = daemon.updateWhy ?? 'The desktop app updates this daemon with itself.';
    } else if (daemon?.update === 'self' && proto >= 4) mode = 'self';
    else why = daemon?.updateWhy ?? (current ? 'This daemon is too old to update itself. Update it by hand once.' : 'This device does not say its version. Update its daemon by hand.');
    const lu = daemon?.lastUpdate;
    return {
      deviceId: d.id,
      ...(current ? { current } : {}),
      target,
      mode,
      behind,
      ...(why ? { why } : {}),
      ...(last?.state ? { state: last.state, message: last.message, at: last.at } : lu && lu.to === current ? { state: lu.ok ? 'done' : 'failed', message: lu.message ?? (lu.ok ? `Updated from ${lu.from} to ${lu.to}.` : undefined), at: lu.at } : {}),
    } as DeviceUpdateDto;
  }

  deviceUpdates(): DeviceUpdatesDto {
    const list = this.engine.devices.list('owner').filter((d) => d.id !== 'local');
    return { hubVersion: this.engine.version, devices: list.map((d) => this.deviceView(d)) };
  }

  private async ownManifest(): Promise<UpdateManifest> {
    if (this.own && this.now() - this.own.at < 3_600_000) return this.own.manifest;
    const manifest = await fetchManifest(this.url(this.engine.version), this.f).catch((err) => {
      throw new HttpError(502, `Could not read release ${this.engine.version}: ${(err as Error).message}`);
    });
    if (manifest.version !== this.engine.version) throw new HttpError(502, `The release server sent ${manifest.version} for ${this.engine.version}.`);
    this.own = { at: this.now(), manifest };
    return manifest;
  }

  /** Send the device's daemon the hub's version. Returns at once; deviceUpdates() follows it. */
  async updateDevice(id: string, by: string): Promise<DeviceUpdateDto> {
    const d = this.engine.devices.list('owner').find((x) => x.id === id && x.id !== 'local');
    if (!d) throw new HttpError(404, 'No such device.');
    if (!d.online) throw new HttpError(409, `${d.name} is offline.`);
    const view = this.deviceView(d);
    if (view.mode !== 'self') throw new HttpError(409, view.why ?? 'This daemon cannot update itself.');
    if (!view.behind) throw new HttpError(409, `${d.name} already runs ${view.current ?? this.engine.version}.`);
    const last = this.devices.get(id);
    if (last && (last.state === 'sent' || last.state === 'updating') && last.target === view.target) throw new HttpError(409, `${d.name} is already updating.`);
    const machine = this.engine.devices.get(id) as RemoteMachine | undefined;
    if (!machine?.selfUpdate) throw new HttpError(409, 'This daemon is too old to update itself. Update it by hand once.');
    // the daemon checks with the same key; say it here before anything is sent
    const key = this.key;
    if (!key.ok) throw new HttpError(409, key.why);
    const manifest = await this.ownManifest();
    if (!manifest.signed) throw new HttpError(409, `Release ${manifest.version} is unsigned, so devices do not install it.`);
    const entry: DeviceUpdateDto & { sentAt?: number } = { ...view, state: 'sent', message: `Sent ${view.target}.`, at: this.now(), sentAt: this.now() };
    this.devices.set(id, entry);
    this.audit(by === 'auto' ? 'update' : by, 'device.update', `${d.name}: ${view.current ?? '?'} -> ${view.target}`, id);
    machine.selfUpdate({ version: view.target, manifest }).then(
      (r) => {
        const e = this.devices.get(id);
        if (e !== entry) return;
        entry.state = 'updating';
        entry.message = r.restarting ? `Restarting on ${r.to}.` : `${r.to} is in place. Restart the daemon to use it.`;
        entry.at = this.now();
        // the daemon is back with the new version: deviceOnline settles it; this catches one that is not
        setTimeout(() => {
          if (this.devices.get(id) === entry && entry.state === 'updating') {
            entry.state = 'failed';
            entry.message = `${d.name} did not come back on ${view.target}. Its previous version is kept next to the new one.`;
            entry.at = this.now();
            this.audit('update', 'device.update.failed', `${d.name}: ${entry.message}`, id);
          }
        }, DEVICE_RETURN_MS).unref?.();
      },
      (err: Error) => {
        if (this.devices.get(id) !== entry) return;
        entry.state = 'failed';
        entry.message = err.message;
        entry.at = this.now();
        this.audit('update', 'device.update.failed', `${d.name}: ${err.message}`, id);
      },
    );
    return { ...entry };
  }

  /** A device connected: an update it took is done when it says the new version. */
  private deviceOnline(d: Device): void {
    const e = this.devices.get(d.id);
    const v = d.info?.daemon?.version;
    if (!e || (e.state !== 'sent' && e.state !== 'updating') || !v) return;
    if (v === e.target) {
      e.state = 'done';
      e.message = `Updated to ${v}.`;
      e.at = this.now();
      this.audit('update', 'device.update.done', `${d.name}: ${e.current ?? '?'} -> ${v}`, d.id);
    }
  }
}

/**
 * Start the finisher outside the hub's service. systemd-run puts it in a unit
 * of its own, so the restart of the hub does not stop it. With the path unit
 * (a hub in a container, setup.sh) request.json alone starts it, as root.
 */
export async function startFinisher(req: UpdateRequest, install: HubInstall, updatesDir: string): Promise<void> {
  if (install.helper === 'path-unit') return;
  const home = join(updatesDir, '..');
  const argv = [
    'systemd-run',
    ...(install.scope === 'user' ? ['--user'] : []),
    '--collect',
    '--quiet',
    `--unit=conclave-update-${req.id}`,
    `--setenv=CONCLAVE_HOME=${home}`,
    `--setenv=PATH=${process.env.PATH ?? '/usr/bin:/bin'}`,
    '--',
    process.execPath,
    'update',
    'finish',
  ];
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      err = e.message;
      resolve(null);
    });
    child.on('close', (c) => {
      if (c !== 0) log.warn('systemd-run failed', { code: c, error: err.trim().slice(0, 300) });
      resolve(c);
    });
  });
  if (code !== 0) {
    rmSync(join(updatesDir, REQUEST_FILE), { force: true });
    throw new UpdateError('Could not start the updater (systemd-run). Nothing was changed. Run the install script again to update.');
  }
  if (!existsSync(updatesDir)) mkdirSync(updatesDir, { recursive: true });
}
