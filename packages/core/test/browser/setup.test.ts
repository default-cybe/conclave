/**
 * Install on the hub for the browser (browser/setup-plan.ts, browser/setup.ts):
 * the pins match the lockfile and Playwright's own browsers.json, the steps
 * and their order, the refusals, and the runner with a fake shell and fetch:
 * a hash that does not match stops before anything is unpacked, steps that
 * changed since the owner looked do not run, and every run is audited.
 * Nothing here downloads; the real check is in docs/EXTENSIONS.md.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BrowserManager } from '../../src/browser/manager';
import { aptCommand, aptPackages, readOsRelease, usesT64 } from '../../src/browser/runtime';
import { BrowserSetup, BrowserSetupError } from '../../src/browser/setup';
import {
  CLOAK_ARCHIVE_SHA256,
  CLOAK_ARCHIVE_URL,
  CLOAK_CHROME_SHA256,
  CLOAK_VERSION,
  PLAYWRIGHT_CHROMIUM_REVISION,
  PLAYWRIGHT_CHROMIUM_VERSION,
  PLAYWRIGHT_CORE_INTEGRITY,
  PLAYWRIGHT_CORE_URL,
  PLAYWRIGHT_CORE_VERSION,
  browserSetupOffer,
  canRunBrowserSetup,
  integrityHex,
  stepLine,
  type BrowserSetupFacts,
} from '../../src/browser/setup-plan';
import type { ExecOptions, ExecResult } from '../../src/machine/types';
import type { HubPlaceDto, RootHelperDto } from '../../src/system/root-helper';

const root = join(import.meta.dir, '..', '..', '..', '..');
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const facts = (over: Partial<BrowserSetupFacts> = {}): BrowserSetupFacts => ({
  platform: 'linux',
  arch: 'x64',
  user: 'conclave',
  dir: '/var/lib/conclave/browser',
  runtime: '/opt/conclave/bin/conclave',
  free: 50e9,
  ...over,
});

describe('pins', () => {
  test('playwright-core: the version core/package.json allows and bun.lock resolves, with the lockfile sha512', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')) as { optionalDependencies: Record<string, string> };
    expect(pkg.optionalDependencies['playwright-core']).toBe(PLAYWRIGHT_CORE_VERSION);
    const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
    const m = /"playwright-core": \["playwright-core@([^"]+)", "",.*?"(sha512-[^"]+)"\]/.exec(lock);
    expect(m?.[1]).toBe(PLAYWRIGHT_CORE_VERSION);
    expect(m?.[2]).toBe(PLAYWRIGHT_CORE_INTEGRITY);
    expect(PLAYWRIGHT_CORE_URL).toBe(`https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz`);
    expect(integrityHex(PLAYWRIGHT_CORE_INTEGRITY)).toMatch(/^[0-9a-f]{128}$/);
  });

  test("the Chromium pin is the one that playwright-core's browsers.json names", async () => {
    let browsers: { browsers: Array<{ name: string; revision: string; browserVersion?: string }> } | undefined;
    try {
      const dir = join(root, 'packages/core/node_modules/playwright-core');
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === PLAYWRIGHT_CORE_VERSION) browsers = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8'));
    } catch {
      /* not installed here */
    }
    if (!browsers) return;
    const c = browsers.browsers.find((b) => b.name === 'chromium')!;
    expect(c.revision).toBe(PLAYWRIGHT_CHROMIUM_REVISION);
    expect(c.browserVersion).toBe(PLAYWRIGHT_CHROMIUM_VERSION);
  });

  test('CloakBrowser: one exact version from CloakHQ, with both hashes', () => {
    expect(CLOAK_VERSION).toMatch(/^146\.\d+\.\d+\.\d+\.\d+$/);
    expect(CLOAK_ARCHIVE_URL).toBe(`https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v${CLOAK_VERSION}/cloakbrowser-linux-x64.tar.gz`);
    expect(CLOAK_ARCHIVE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(CLOAK_CHROME_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('browserSetupOffer', () => {
  test('cloak on a bare hub: playwright-core first, then the checked download, unpack, check, move, config', () => {
    const o = browserSetupOffer('cloak', facts());
    expect(canRunBrowserSetup(o)).toBe(true);
    expect(o.steps.map((s) => s.kind)).toEqual(['download', 'run', 'download', 'run', 'verify', 'run', 'config']);
    expect(o.lines).toEqual(o.steps.map(stepLine));
    expect(o.lines[0]).toBe(`download ${PLAYWRIGHT_CORE_URL} to playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz, check sha512 ${integrityHex(PLAYWRIGHT_CORE_INTEGRITY)}`);
    expect(o.lines[1]).toBe(`rm -rf node_modules/playwright-core && mkdir -p node_modules/playwright-core && tar -xzf playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz -C node_modules/playwright-core --strip-components=1 && rm -f playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz`);
    expect(o.lines[2]).toBe(`download ${CLOAK_ARCHIVE_URL} to cloakbrowser-${CLOAK_VERSION}-linux-x64.tar.gz, check sha256 ${CLOAK_ARCHIVE_SHA256}`);
    expect(o.lines[4]).toBe(`check cloakbrowser/chromium-${CLOAK_VERSION}.partial/chrome sha256 ${CLOAK_CHROME_SHA256}`);
    expect(o.lines[6]).toBe(`set browser.cloak.executablePath /var/lib/conclave/browser/cloakbrowser/chromium-${CLOAK_VERSION}/chrome and browser.cloak.sha256 ${CLOAK_CHROME_SHA256}`);
    // never root
    for (const l of o.lines) expect(l).not.toMatch(/\bsudo\b|apt-get/);
  });

  test("chromium runs Playwright's installer with the hub's own binary as bun, into the browser folder", () => {
    const o = browserSetupOffer('chromium', facts());
    expect(o.lines.at(-1)).toBe(
      'env PLAYWRIGHT_BROWSERS_PATH=/var/lib/conclave/browser/ms-playwright BUN_BE_BUN=1 /opt/conclave/bin/conclave /var/lib/conclave/browser/node_modules/playwright-core/cli.js install --no-shell chromium',
    );
    expect(o.steps.at(-1)!.say).toContain(PLAYWRIGHT_CHROMIUM_VERSION);
    // with playwright-core from the app (Docker, a source install): no download, its cli
    const app = browserSetupOffer('chromium', facts({ playwright: { version: PLAYWRIGHT_CORE_VERSION, dir: '/app/node_modules/playwright-core', where: 'app' }, runtime: '/usr/local/bin/bun' }));
    expect(app.lines).toEqual(['env PLAYWRIGHT_BROWSERS_PATH=/var/lib/conclave/browser/ms-playwright BUN_BE_BUN=1 /usr/local/bin/bun /app/node_modules/playwright-core/cli.js install --no-shell chromium']);
  });

  test('paths with spaces are quoted', () => {
    const o = browserSetupOffer('chromium', facts({ dir: "/home/o'neil/My Data/browser" }));
    expect(o.lines.at(-1)).toContain(`PLAYWRIGHT_BROWSERS_PATH='/home/o'\\''neil/My Data/browser/ms-playwright'`);
  });

  test('refusals: installed, no build for this machine, Windows, no room', () => {
    expect(browserSetupOffer('cloak', facts({ cloak: { path: '/x/chrome', version: CLOAK_VERSION, ours: true } }))).toMatchObject({ refusal: 'done', steps: [] });
    expect(browserSetupOffer('chromium', facts({ chromium: { path: '/x', where: 'system' } })).refusal).toBe('done');
    expect(browserSetupOffer('cloak', facts({ arch: 'arm64' })).refusal).toBe('no-build');
    expect(browserSetupOffer('cloak', facts({ platform: 'darwin', arch: 'arm64' })).refusal).toBe('no-build');
    // Chromium works on an arm64 Linux hub
    expect(canRunBrowserSetup(browserSetupOffer('chromium', facts({ arch: 'arm64' })))).toBe(true);
    expect(browserSetupOffer('chromium', facts({ platform: 'win32' })).refusal).toBe('os');
    const full = browserSetupOffer('cloak', facts({ free: 300e6 }));
    expect(full.refusal).toBe('space');
    expect(full.why).toContain('300 MB free');
  });
});

describe('system libraries', () => {
  test('apt packages for what ldd cannot find, with t64 names on Debian 13 and Ubuntu 24.04', () => {
    const d12 = readOsRelease('ID=debian\nVERSION_ID="12"\n');
    const d13 = readOsRelease('ID=debian\nVERSION_ID="13"\n');
    expect(usesT64(d12)).toBe(false);
    expect(usesT64(d13)).toBe(true);
    expect(usesT64(readOsRelease('ID=ubuntu\nVERSION_ID="24.04"'))).toBe(true);
    expect(aptPackages(['libnss3.so', 'libnssutil3.so', 'libasound.so.2', 'libgbm.so.1'], d12)).toEqual(['libasound2', 'libgbm1', 'libnss3']);
    expect(aptPackages(['libasound.so.2', 'libglib-2.0.so.0'], d13)).toEqual(['libasound2t64', 'libglib2.0-0t64']);
    expect(aptPackages([], d12, { fonts: true })).toEqual(['fonts-liberation', 'fonts-noto-color-emoji']);
    // a library the table does not know: Playwright's whole list for Chromium
    expect(aptPackages(['libweird.so.9'], d12)).toContain('libxkbcommon0');
    expect(aptCommand(['libnss3', 'libgbm1'])).toBe('apt-get install -y --no-install-recommends libnss3 libgbm1');
    expect(aptCommand([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

function runnerFor(over: { fetch?: (url: string) => Promise<Response>; exec?: (cmd: string, o: ExecOptions) => Promise<ExecResult> } = {}) {
  const home = tmp('conclave-setup-');
  const config = new ConfigStore(home, { browser: { headless: true } });
  const manager = new BrowserManager({ config, launcher: { launchPersistentContext: async () => ({}) as never } });
  const ran: string[] = [];
  const audits: string[] = [];
  const fetched: string[] = [];
  const setup = new BrowserSetup({
    config,
    manager,
    runtime: '/usr/local/bin/bun',
    fetch: async (url) => {
      fetched.push(String(url));
      return over.fetch ? over.fetch(String(url)) : new Response('nope', { status: 404 });
    },
    shell: {
      exec: async (cmd, o) => {
        ran.push(cmd);
        return over.exec ? over.exec(cmd, o) : { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1 };
      },
    },
    // a bare Linux x64 hub, whatever this machine is
    facts: { platform: 'linux', arch: 'x64', free: 50e9, chromium: undefined, cloak: undefined, playwright: undefined },
  });
  return { home, config, setup, ran, audits, fetched, audit: (a: string, d: string) => audits.push(`${a}: ${d}`) };
}

describe('BrowserSetup.run', () => {
  test('refuses steps that differ from what would run, with the fresh offer', async () => {
    const { setup, ran } = runnerFor();
    const err = (await setup.run('cloak', ['something else']).catch((e) => e)) as BrowserSetupError;
    expect(err).toBeInstanceOf(BrowserSetupError);
    expect(err.status).toBe(409);
    expect(err.setup?.steps.length).toBeGreaterThan(0);
    expect(ran).toEqual([]);
  });

  test('a download whose hash does not match stops before anything is unpacked, and is deleted', async () => {
    const { setup, ran, audits, audit, home, fetched } = runnerFor({ fetch: async () => new Response('not the real tarball') });
    const offer = await setup.offer('cloak');
    // this machine may have playwright-core with the app: the first download is the one that runs
    const r = await setup.run('cloak', offer.lines, audit);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(offer.lines[0]);
    expect(r.ran).toEqual([offer.lines[0]]);
    expect(r.tail).toContain('does not match its pinned');
    expect(ran).toEqual([]);
    expect(fetched).toHaveLength(1);
    const dl = offer.steps[0] as { file: string };
    expect(existsSync(join(home, 'browser', dl.file))).toBe(false);
    expect(existsSync(join(home, 'browser', `${dl.file}.part`))).toBe(false);
    expect(audits[0]).toStartWith('browser.setup: cloak as ');
    expect(audits[1]).toBe(`browser.setup.result: cloak: failed, ran 1 of ${offer.steps.length}`);
  });

  test('all steps in order: downloads checked, commands in the browser folder, the binary checked, the config pinned', async () => {
    const tgz = Buffer.from('fake playwright tarball');
    const archive = Buffer.from('fake cloak archive');
    const chrome = Buffer.from('fake chrome binary');
    const sha = (b: Buffer, a: 'sha256' | 'sha512') => createHash(a).update(b).digest('hex');
    const { setup, ran, config, home, audit } = runnerFor({
      fetch: async (url) => new Response(url.includes('playwright-core') ? tgz : archive, { headers: { 'content-length': '18' } }),
      exec: async (cmd, o) => {
        // stand in for tar: put the chrome binary where the archive unpacks
        if (cmd.includes('tar -xzf cloakbrowser')) {
          const partial = join(o.cwd, `cloakbrowser/chromium-${CLOAK_VERSION}.partial`);
          mkdirSync(partial, { recursive: true });
          writeFileSync(join(partial, 'chrome'), chrome);
        }
        if (cmd.startsWith('rm -rf cloakbrowser/chromium-')) {
          mkdirSync(join(o.cwd, `cloakbrowser/chromium-${CLOAK_VERSION}`), { recursive: true });
          writeFileSync(join(o.cwd, `cloakbrowser/chromium-${CLOAK_VERSION}/chrome`), chrome);
        }
        return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, aborted: false, durationMs: 1 };
      },
    });
    // the fakes stand in for the real files: plan against their hashes
    const offer = await setup.offer('cloak');
    for (const s of offer.steps) {
      if (s.kind === 'download') {
        if (s.sha512) s.sha512 = sha(tgz, 'sha512');
        else s.sha256 = sha(archive, 'sha256');
      }
      if (s.kind === 'verify') s.sha256 = sha(chrome, 'sha256');
      if (s.kind === 'config') s.sha256 = sha(chrome, 'sha256');
    }
    (setup as unknown as { offer: () => Promise<typeof offer> }).offer = async () => ({ ...offer, lines: offer.steps.map(stepLine) });
    const r = await setup.run('cloak', offer.steps.map(stepLine), audit);
    expect(r.ok).toBe(true);
    expect(r.ran).toHaveLength(offer.steps.length);
    expect(ran.every((c) => !/sudo/.test(c))).toBe(true);
    expect(ran.at(-1)).toBe(`rm -rf cloakbrowser/chromium-${CLOAK_VERSION} && mv cloakbrowser/chromium-${CLOAK_VERSION}.partial cloakbrowser/chromium-${CLOAK_VERSION}`);
    expect(config.get().browser.cloak).toEqual({ executablePath: join(home, 'browser', `cloakbrowser/chromium-${CLOAK_VERSION}/chrome`), sha256: sha(chrome, 'sha256') });
    expect(existsSync(join(home, 'browser', `cloakbrowser-${CLOAK_VERSION}-linux-x64.tar.gz`))).toBe(true);
  });

  test('a failing command stops the run with its exit code', async () => {
    const { setup, audit } = runnerFor({ exec: async () => ({ exitCode: 2, stdout: '', stderr: 'tar: boom\n', timedOut: false, aborted: false, durationMs: 1 }) });
    const offer = await setup.offer('chromium');
    const runIdx = offer.steps.findIndex((s) => s.kind === 'run');
    // skip the download in this test: plan the chromium step alone
    const only = { ...offer, steps: [offer.steps[runIdx]], lines: [offer.lines[runIdx]] };
    (setup as unknown as { offer: () => Promise<typeof offer> }).offer = async () => only;
    const r = await setup.run('chromium', only.lines, audit);
    expect(r.ok).toBe(false);
    expect(r.tail).toContain('tar: boom');
    expect(r.tail).toContain('exit code 2');
  });

  test('one run at a time', async () => {
    let release!: () => void;
    const { setup } = runnerFor({ exec: () => new Promise((done) => (release = () => done({ exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1 }))) });
    const offer = await setup.offer('chromium');
    const idx = offer.steps.findIndex((s) => s.kind === 'run');
    const only = { ...offer, steps: [offer.steps[idx]], lines: [offer.lines[idx]] };
    (setup as unknown as { offer: () => Promise<typeof offer> }).offer = async () => only;
    const first = setup.run('chromium', only.lines);
    await new Promise((r) => setTimeout(r, 10));
    await expect(setup.run('chromium', only.lines)).rejects.toThrow('already running');
    release();
    expect((await first).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Install system libraries: the root helper's browser-deps
// ---------------------------------------------------------------------------

describe('BrowserSetup.libs and installLibs', () => {
  const HELPER_LINE = 'sudo /usr/local/libexec/conclave-root-helper browser-deps';
  /** A hub whose browsers miss two libraries until the helper ran, in a Proxmox CT. */
  function libsRig(o: { ready?: boolean; place?: HubPlaceDto; exit?: number; stillMissing?: boolean } = {}) {
    const home = tmp('conclave-libs-');
    const config = new ConfigStore(home, { browser: { headless: true } });
    const manager = new BrowserManager({ config, launcher: { launchPersistentContext: async () => ({}) as never } });
    let fixed = false;
    const ran: string[] = [];
    const audits: string[] = [];
    const helper: RootHelperDto = o.ready === false ? { installed: false, ready: false, install: 'conclave system-helper install' } : { installed: true, ready: true, install: 'conclave system-helper install' };
    const setup = new BrowserSetup({
      config,
      manager,
      shell: {
        exec: async (cmd) => {
          ran.push(cmd);
          if ((o.exit ?? 0) === 0 && !o.stillMissing) fixed = true;
          return { exitCode: o.exit ?? 0, stdout: 'Installing for the browser on Debian GNU/Linux 12 (bookworm): libgbm1 libnss3\nDone.\n', stderr: '', timedOut: false, aborted: false, durationMs: 5 };
        },
      },
      host: {
        place: () => o.place ?? { kind: 'lxc', ctid: '135' },
        helper: () => helper,
        missing: () => (fixed ? { missing: [], noFonts: false } : { missing: ['libgbm.so.1', 'libnss3.so'], noFonts: true }),
      },
    });
    return { setup, ran, audits, audit: (a: string, d: string) => audits.push(`${a}: ${d}`) };
  }

  test('with the helper ready: the one line to confirm, and where the hub runs', async () => {
    const { setup } = libsRig();
    const l = (await setup.libs())!;
    expect(l.missing).toEqual(['libgbm.so.1', 'libnss3.so']);
    expect(l.place).toEqual({ kind: 'lxc', ctid: '135' });
    expect(l.setup?.lines).toEqual([HELPER_LINE]);
    expect(l.command).toContain('fonts-liberation');
  });

  test('without the helper: no step, the command that installs it, and the apt-get line', async () => {
    const { setup, ran } = libsRig({ ready: false });
    const l = (await setup.libs())!;
    expect(l.setup).toBeUndefined();
    expect(l.helper).toEqual({ installed: false, ready: false, install: 'conclave system-helper install' });
    expect(l.command).toMatch(/^apt-get install -y --no-install-recommends /);
    const err = (await setup.installLibs([HELPER_LINE]).catch((e) => e)) as BrowserSetupError;
    expect(err.status).toBe(409);
    expect(err.message).toContain('conclave system-helper install');
    expect(ran).toEqual([]);
  });

  test('in Docker: the rebuild, never the helper', async () => {
    const { setup } = libsRig({ place: { kind: 'docker' } });
    const l = (await setup.libs())!;
    expect(l.docker).toBe(true);
    expect(l.helper).toBeUndefined();
    expect(l.setup).toBeUndefined();
  });

  test('runs exactly the confirmed line, audits it, and says Ready after looking again', async () => {
    const { setup, ran, audits, audit } = libsRig();
    await expect(setup.installLibs(['sudo apt-get install -y libevil'], audit)).rejects.toThrow('changed since you looked');
    await expect(setup.installLibs([HELPER_LINE, 'id'], audit)).rejects.toThrow('changed since you looked');
    expect(ran).toEqual([]);
    const r = await setup.installLibs([HELPER_LINE], audit);
    expect(ran).toEqual([HELPER_LINE]);
    expect(r).toMatchObject({ ok: true, ready: true, ran: [HELPER_LINE] });
    expect(r.tail).toContain(`$ ${HELPER_LINE}`);
    expect(audits[0]).toMatch(/^browser\.libs: as .+: sudo \/usr\/local\/libexec\/conclave-root-helper browser-deps \(missing libgbm\.so\.1, libnss3\.so, fonts\)$/);
    expect(audits[1]).toBe('browser.libs.result: ok, every library is there');
    // nothing is missing now: another run is refused
    await expect(setup.installLibs([HELPER_LINE], audit)).rejects.toThrow('Nothing is missing');
  });

  test('a failed run says where it stopped; a run that leaves libraries missing says which', async () => {
    const failed = libsRig({ exit: 1 });
    const r = await failed.setup.installLibs([HELPER_LINE], failed.audit);
    expect(r).toMatchObject({ ok: false, ready: false, failed: HELPER_LINE });
    expect(r.tail).toContain('exit code 1');
    expect(failed.audits[1]).toContain('failed, still missing libgbm.so.1, libnss3.so, fonts');
    const short = libsRig({ stillMissing: true });
    const s = await short.setup.installLibs([HELPER_LINE], short.audit);
    expect(s).toMatchObject({ ok: true, ready: false });
    expect(s.libs?.missing).toEqual(['libgbm.so.1', 'libnss3.so']);
  });
});
