/**
 * Runs "Install on the hub" for the browser (setup-plan.ts has the steps and
 * the rules), and reads what the hub has: playwright-core, each engine and
 * its version, the system libraries the browsers cannot find.
 *
 * Downloads run in the hub itself (fetch, hashed while they stream, then
 * renamed into place only when the hash matches), so the hub needs no curl.
 * Commands run through the hub's own machine as its own user, in the browser
 * folder. Each run is audited before it starts and again when it ends.
 *
 * Also "Install system libraries" (installLibs): the root helper's one fixed
 * action, `sudo /usr/local/libexec/conclave-root-helper browser-deps`, when
 * the owner installed the helper (system/root-helper.ts), confirmed and
 * audited the same way, then ldd again.
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { TailLines } from '../catalog/hub-setup';
import type { ConfigStore } from '../config';
import type { ConclaveConfig } from '../config/schema';
import type { ExecOptions, ExecResult } from '../machine/types';
import { hubPlace, rootHelperStatus } from '../system/host';
import { BROWSER_DEPS_SAY, rootHelperLine, type HubPlaceDto, type RootHelperAction, type RootHelperDto } from '../system/root-helper';
import { ENGINE_LABEL, fileSha256 } from './engine';
import type { BrowserManager } from './manager';
import { aptCommand, aptPackages, binaryVersion, browserDir, forgetBinaryFacts, freeBytes, hasFonts, hubBrowsersPath, missingLibraries, playwrightInfo, readOsRelease } from './runtime';
import { browserSetupOffer, stepLine, type BrowserSetupFacts, type BrowserSetupOffer, type BrowserSetupStep, type BrowserSetupTarget } from './setup-plan';
import type { BrowserEngineDto, BrowserLibsDto, BrowserLibsResult, BrowserSetupResult } from './types';

/** The whole install may take this long (two downloads of a few hundred MB on a slow line). */
const SETUP_MS = 30 * 60_000;
const TAIL_LINES = 200;

/** Why nothing ran, with the status the route answers. */
export class BrowserSetupError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly setup?: BrowserSetupOffer,
  ) {
    super(message);
    this.name = 'BrowserSetupError';
  }
}

export interface BrowserSetupOptions {
  config: ConfigStore;
  manager: BrowserManager;
  /** The hub's own machine: commands run there as the hub's user. */
  shell: { exec(command: string, opts: ExecOptions): Promise<ExecResult> };
  /** Audit lines, when run() is not given its own. */
  audit?: (action: string, detail: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The program that runs Playwright's installer. Default process.execPath (the hub's binary, or bun). */
  runtime?: string;
  /** Facts a test sets: platform, arch, free bytes. */
  facts?: Partial<BrowserSetupFacts>;
  /** Where the hub runs and its root helper (system/host.ts). Tests pass their own. */
  host?: {
    place(): HubPlaceDto;
    helper(action: RootHelperAction): RootHelperDto;
    /** The libraries the browsers miss, for a test that has no browser binary. */
    missing?(): { missing: string[]; noFonts: boolean };
  };
}

/** apt-get update and about 150 MB of packages on a slow line, with apt's lock to wait for. */
const LIBS_MS = 20 * 60_000;

export class BrowserSetup {
  private running = false;

  constructor(private readonly o: BrowserSetupOptions) {}

  dir(): string {
    return browserDir(this.o.config.paths.home);
  }

  /** What the hub has now. */
  async facts(): Promise<BrowserSetupFacts> {
    const dir = this.dir();
    const cfg = this.o.config.get().browser;
    let user = 'the hub';
    try {
      user = userInfo().username;
    } catch {
      /* no passwd entry */
    }
    const pw = playwrightInfo(dir);
    const exe = this.o.manager.executable();
    let chromium: BrowserSetupFacts['chromium'];
    if (exe) {
      const hub = hubBrowsersPath(this.o.config.paths.home);
      const where = cfg?.executablePath ? 'config' : exe.startsWith(hub + sep) ? 'hub' : /ms-playwright|pw-browsers/.test(exe) ? 'playwright' : 'system';
      chromium = { path: exe, version: await binaryVersion(exe), where };
    }
    let cloak: BrowserSetupFacts['cloak'];
    const raw = cfg?.cloak?.executablePath?.trim();
    if (raw) {
      const path = resolve(raw.replace(/^~(?=$|[\\/])/, process.env.HOME ?? ''));
      if (await Bun.file(path).exists()) cloak = { path, version: await binaryVersion(path), ours: path.startsWith(dir + sep) };
    }
    return {
      platform: process.platform,
      arch: process.arch,
      user,
      dir,
      runtime: this.o.runtime ?? process.execPath,
      ...(pw ? { playwright: pw } : {}),
      ...(chromium ? { chromium } : {}),
      ...(cloak ? { cloak } : {}),
      ...(freeBytes(dir) !== undefined ? { free: freeBytes(dir) } : {}),
      ...this.o.facts,
    };
  }

  async offer(target: BrowserSetupTarget, facts?: BrowserSetupFacts): Promise<BrowserSetupOffer> {
    return browserSetupOffer(target, facts ?? (await this.facts()));
  }

  /** Both engines with their status and their install offer. */
  async engines(facts?: BrowserSetupFacts): Promise<BrowserEngineDto[]> {
    const f = facts ?? (await this.facts());
    return [
      {
        engine: 'cloak',
        label: ENGINE_LABEL.cloak,
        installed: !!f.cloak,
        ...(f.cloak ? { version: f.cloak.version, path: f.cloak.path, where: f.cloak.ours ? 'hub' : 'config' } : {}),
        setup: browserSetupOffer('cloak', f),
      },
      {
        engine: 'chromium',
        label: ENGINE_LABEL.chromium,
        installed: !!f.chromium,
        ...(f.chromium ? { version: f.chromium.version, path: f.chromium.path, where: f.chromium.where } : {}),
        setup: browserSetupOffer('chromium', f),
      },
    ];
  }

  /**
   * System libraries the installed browsers miss, the apt packages that have
   * them, where the hub runs, and whether its root helper can add them.
   */
  async libs(facts?: BrowserSetupFacts): Promise<BrowserLibsDto | undefined> {
    let missing: string[];
    let noFonts: boolean;
    if (this.o.host?.missing) ({ missing, noFonts } = this.o.host.missing());
    else {
      if (process.platform !== 'linux') return undefined;
      const f = facts ?? (await this.facts());
      const bins = [f.cloak?.path, f.chromium?.path].filter((x): x is string => !!x);
      if (!bins.length) return undefined;
      missing = [...new Set((await Promise.all(bins.map((b) => missingLibraries(b)))).flat())].sort();
      noFonts = !hasFonts();
    }
    if (!missing.length && !noFonts) return { missing: [], noFonts: false, packages: [] };
    const packages = aptPackages(missing, readOsRelease(), { fonts: noFonts });
    const command = aptCommand(packages);
    const place = (this.o.host?.place ?? hubPlace)();
    const base: BrowserLibsDto = { missing, noFonts, packages, ...(command ? { command } : {}), place };
    // in Docker the image is the fix, and it has no sudo
    if (place.kind === 'docker' || process.env.CONCLAVE_INSTALL === 'docker') return { ...base, docker: true };
    const helper = (this.o.host?.helper ?? ((a: RootHelperAction) => rootHelperStatus(a)))('browser-deps');
    return { ...base, helper, ...(helper.ready ? { setup: { say: BROWSER_DEPS_SAY, lines: [rootHelperLine('browser-deps', { asRoot: helper.asRoot })] } } : {}) };
  }

  /**
   * POST /api/browser/libs: run the root helper's browser-deps, the line the
   * owner confirmed, then look at the libraries again.
   */
  async installLibs(lines: string[] | undefined, audit = this.o.audit ?? (() => undefined)): Promise<BrowserLibsResult> {
    if (this.running) throw new BrowserSetupError(409, 'An install is already running on the hub.');
    this.running = true;
    try {
      const libs = await this.libs();
      if (!libs || (!libs.missing.length && !libs.noFonts)) throw new BrowserSetupError(409, 'Nothing is missing: the browser has every library it needs.');
      if (libs.docker) throw new BrowserSetupError(409, 'This hub runs in Docker. Build the image with --build-arg BROWSER=1 instead.');
      if (!libs.setup) throw new BrowserSetupError(409, libs.helper?.problem ?? `The root helper is not installed. Once, as root on the hub's machine: ${libs.helper?.install ?? 'conclave system-helper install'}`);
      const want = libs.setup.lines;
      if (!lines || lines.length !== want.length || lines.some((l, i) => l !== want[i])) throw new BrowserSetupError(409, 'What it would run changed since you looked. Check the step again.');
      let user = 'the hub';
      try {
        user = userInfo().username;
      } catch {
        /* no passwd entry */
      }
      audit('browser.libs', `as ${user}: ${want.join(' && ')} (missing ${[...libs.missing, ...(libs.noFonts ? ['fonts'] : [])].join(', ')})`);
      const tail = new TailLines(TAIL_LINES);
      const started = Date.now();
      let failed: string | undefined;
      const ran: string[] = [];
      for (const line of want) {
        ran.push(line);
        tail.line(`$ ${line}`);
        let streamed = false;
        const r = await this.o.shell
          .exec(line, {
            cwd: homedir(),
            timeoutMs: LIBS_MS,
            maxOutputBytes: 512 * 1024,
            onOutput: (chunk) => {
              streamed = true;
              tail.push(chunk);
            },
          })
          .catch((err: Error): ExecResult => ({ exitCode: 1, stdout: '', stderr: `${err.message}\n`, timedOut: false, aborted: false, durationMs: 0 }));
        if (!streamed) tail.push(`${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`);
        tail.flush();
        if (r.exitCode !== 0 || r.timedOut) {
          tail.line(r.timedOut ? 'Stopped: it ran too long.' : `Failed with exit code ${r.exitCode ?? 'none'}.`);
          failed = line;
          break;
        }
      }
      forgetBinaryFacts();
      const after = await this.libs();
      const ready = !after || (!after.missing.length && !after.noFonts);
      const ok = !failed;
      audit('browser.libs.result', `${ok ? 'ok' : 'failed'}${ready ? ', every library is there' : `, still missing ${[...(after?.missing ?? []), ...(after?.noFonts ? ['fonts'] : [])].join(', ')}`}`);
      return { ok, ran, tail: tail.text(), durationMs: Date.now() - started, ready, ...(failed ? { failed } : {}), ...(after && !ready ? { libs: after } : {}) };
    } finally {
      this.running = false;
    }
  }

  /**
   * POST /api/browser/setup: run the offer's steps, stopping at the first
   * that fails. `lines` is what the owner confirmed; it must match what would
   * run now, or nothing runs.
   */
  async run(target: BrowserSetupTarget, lines?: string[], audit = this.o.audit ?? (() => undefined)): Promise<BrowserSetupResult> {
    if (this.running) throw new BrowserSetupError(409, 'An install is already running on the hub.');
    this.running = true;
    try {
      const offer = await this.offer(target);
      if (!offer.steps.length || offer.refusal) throw new BrowserSetupError(offer.refusal === 'os' ? 501 : 409, offer.why ?? 'Nothing to install.', offer);
      if (!lines || lines.length !== offer.lines.length || lines.some((l, i) => l !== offer.lines[i]))
        throw new BrowserSetupError(409, 'What it would run changed since you looked. Check the steps again.', offer);
      audit('browser.setup', `${target} as ${offer.user} in ${offer.dir}: ${offer.lines.join(' && ')}`);
      mkdirSync(offer.dir, { recursive: true, mode: 0o755 });
      const tail = new TailLines(TAIL_LINES);
      const started = Date.now();
      const deadline = started + SETUP_MS;
      const ran: string[] = [];
      let failed: string | undefined;
      for (const step of offer.steps) {
        const line = stepLine(step);
        ran.push(line);
        tail.line(`$ ${line}`);
        try {
          await this.step(step, offer.dir, tail, deadline);
        } catch (err) {
          tail.line(String((err as Error)?.message ?? err));
          failed = line;
          break;
        }
      }
      const ok = !failed;
      audit('browser.setup.result', `${target}: ${ok ? 'ok' : 'failed'}, ran ${ran.length} of ${offer.steps.length}`);
      forgetBinaryFacts();
      return { ok, target, ran, tail: tail.text(), durationMs: Date.now() - started, ...(failed ? { failed } : {}) };
    } finally {
      this.running = false;
    }
  }

  private async step(step: BrowserSetupStep, dir: string, tail: TailLines, deadline: number): Promise<void> {
    const left = () => Math.max(1_000, deadline - Date.now());
    switch (step.kind) {
      case 'download':
        await this.download(step.url, join(dir, step.file), step.sha512 ? { algo: 'sha512', hex: step.sha512 } : { algo: 'sha256', hex: step.sha256! }, tail, left());
        return;
      case 'verify': {
        const got = await fileSha256(join(dir, step.file));
        if (got !== step.sha256) throw new Error(`${step.file} does not match: sha256 ${got}. Nothing was put in place.`);
        tail.line('sha256 matches');
        return;
      }
      case 'config':
        this.o.config.update({ browser: { cloak: { executablePath: step.executablePath, sha256: step.sha256 } } } as Partial<ConclaveConfig>);
        tail.line('browser.cloak is set');
        return;
      case 'run': {
        let streamed = false;
        const r = await this.o.shell
          .exec(step.run, {
            cwd: dir,
            timeoutMs: left(),
            maxOutputBytes: 512 * 1024,
            onOutput: (chunk) => {
              streamed = true;
              tail.push(chunk);
            },
          })
          .catch((err: Error): ExecResult => ({ exitCode: 1, stdout: '', stderr: `${err.message}\n`, timedOut: false, aborted: false, durationMs: 0 }));
        if (!streamed) tail.push(`${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`);
        tail.flush();
        if (r.timedOut) throw new Error('Stopped: the install ran too long.');
        if (r.exitCode !== 0) throw new Error(`Failed with exit code ${r.exitCode ?? 'none'}.`);
        return;
      }
    }
  }

  /** Stream a download to <file>.part, hashing it, and rename it into place only when the hash matches. */
  private async download(url: string, file: string, want: { algo: 'sha256' | 'sha512'; hex: string }, tail: TailLines, timeoutMs: number): Promise<void> {
    const f = this.o.fetch ?? fetch;
    const part = `${file}.part`;
    const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}.`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const h = createHash(want.algo);
    const fd = openSync(part, 'w', 0o644);
    let bytes = 0;
    let shown = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        h.update(chunk);
        writeSync(fd, chunk);
        bytes += chunk.length;
        if (total && bytes - shown >= total / 5) {
          shown = bytes;
          tail.line(`${Math.round((bytes / total) * 100)}% of ${Math.round(total / 1e6)} MB`);
        }
      }
    } catch (err) {
      closeSync(fd);
      rmSync(part, { force: true });
      throw err;
    }
    closeSync(fd);
    const got = h.digest('hex');
    if (got !== want.hex) {
      rmSync(part, { force: true });
      throw new Error(`The download does not match its pinned ${want.algo} (got ${got.slice(0, 16)}...). It was deleted and nothing was unpacked.`);
    }
    renameSync(part, file);
    tail.line(`${Math.round(bytes / 1e6)} MB, ${want.algo} matches`);
  }
}
