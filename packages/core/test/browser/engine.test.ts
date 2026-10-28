/**
 * Browser engines per profile (browser.profiles.<name>.engine): the config
 * shape, the launch options each engine gets (with a fake launcher), the
 * sha256 pin on the CloakBrowser binary, and one fingerprint seed per profile.
 * No browser runs here; browser-cloak.test.ts launches the real binary when
 * CONCLAVE_CLOAK_BINARY points at one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import { ConfigStore } from '../../src/config';
import { DEFAULT_CONFIG, type ConclaveConfig } from '../../src/config/schema';
import {
  BrowserManager,
  CLOAK_HEADLESS_VIEWPORT,
  CLOAK_SANDBOX_HELP,
  CLOAK_SEED_FILE,
  browserConfigProblems,
  browserTools,
  cloakLaunchOptions,
  engineFor,
  fileSha256,
  profileSeed,
} from '../../src/browser';
import type { ToolContext } from '../../src/tools/types';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type LaunchOpts = NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>;

/** Records each launch and hands back a context with no pages. */
function fakeLauncher(fail?: (opts: LaunchOpts) => Error | undefined) {
  const calls: Array<{ dir: string; opts: LaunchOpts }> = [];
  const launcher = {
    async launchPersistentContext(dir: string, opts: LaunchOpts = {}) {
      calls.push({ dir, opts });
      const err = fail?.(opts);
      if (err) throw err;
      const listeners: Array<() => void> = [];
      const ctx = {
        pages: () => [],
        on: (ev: string, fn: () => void) => void (ev === 'close' && listeners.push(fn)),
        setDefaultTimeout: () => {},
        setDefaultNavigationTimeout: () => {},
        close: async () => listeners.forEach((fn) => fn()),
        // a preview's fence
        route: async () => {},
        routeWebSocket: async () => {},
      };
      return ctx as unknown as BrowserContext;
    },
  };
  return { launcher, calls };
}

/** A stand-in for the CloakBrowser chrome binary, and its sha256. */
function fakeBinary(): { path: string; sha: string } {
  const dir = tmp('conclave-cloak-bin-');
  const path = join(dir, 'chrome');
  const body = 'not really chromium\n';
  writeFileSync(path, body, { mode: 0o755 });
  return { path, sha: createHash('sha256').update(body).digest('hex') };
}

function setup(browser: Partial<ConclaveConfig['browser']>, fail?: (opts: LaunchOpts) => Error | undefined, stockBrowser?: () => string | undefined) {
  const home = tmp('conclave-engine-');
  const config = new ConfigStore(home, { browser: { headless: true, ...browser } as ConclaveConfig['browser'] });
  const { launcher, calls } = fakeLauncher(fail);
  const manager = new BrowserManager({ config, launcher, stockBrowser });
  return { home, config, manager, calls, profiles: config.paths.browserProfile };
}

const ctx = (sessionId: string) => ({ sessionId, signal: new AbortController().signal }) as unknown as ToolContext;

describe('config', () => {
  test('profiles default to Chromium, and engine names are checked', () => {
    expect(DEFAULT_CONFIG.browser.profiles).toBeUndefined();
    expect(engineFor(DEFAULT_CONFIG.browser, 'default')).toBe('chromium');
    const b = { headless: true, profiles: { stealth: { engine: 'cloak' as const }, plain: { engine: 'chromium' as const }, empty: {} } };
    expect(engineFor(b, 'stealth')).toBe('cloak');
    expect(engineFor(b, 'plain')).toBe('chromium');
    expect(engineFor(b, 'empty')).toBe('chromium');
    expect(engineFor(b, 'unlisted')).toBe('chromium');
    expect(() => engineFor({ headless: true, profiles: { x: { engine: 'firefox' as never } } }, 'x')).toThrow('browser.profiles.x.engine is "firefox". Use chromium or cloak.');
  });

  test('browserConfigProblems names each mistake in a sentence', () => {
    expect(browserConfigProblems(DEFAULT_CONFIG.browser)).toEqual([]);
    expect(browserConfigProblems({ headless: true, profiles: { work: { engine: 'cloak' } }, cloak: { executablePath: '~/.cloakbrowser/chrome', sha256: 'A'.repeat(64) } })).toEqual([]);
    expect(browserConfigProblems({ profiles: { work: { engine: 'firefox' } } })).toEqual(['browser.profiles.work.engine must be chromium or cloak.']);
    expect(browserConfigProblems({ profiles: { '../x': { engine: 'cloak' } } })[0]).toContain('is not a valid profile name');
    expect(browserConfigProblems({ profiles: [] })).toEqual(['browser.profiles must be an object keyed by profile name.']);
    expect(browserConfigProblems({ cloak: { sha256: 'abc' } })).toEqual(['browser.cloak.sha256 must be 64 hex characters, as sha256sum prints it.']);
    expect(browserConfigProblems({ cloak: { executablePath: 5 } })).toEqual(['browser.cloak.executablePath must be a path.']);
    expect(browserConfigProblems({ cloak: 'yes' })).toEqual(['browser.cloak must be an object.']);
  });

  test('config files carry the new keys through the store', () => {
    const { config } = setup({ profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: '/opt/cloak/chrome', sha256: 'b'.repeat(64) } });
    expect(config.get().browser.profiles?.stealth?.engine).toBe('cloak');
    expect(config.get().browser.cloak).toEqual({ executablePath: '/opt/cloak/chrome', sha256: 'b'.repeat(64) });
    config.update({ browser: { profiles: { work: { engine: 'cloak' } } } } as unknown as Partial<ConclaveConfig>);
    expect(Object.keys(config.get().browser.profiles ?? {}).sort()).toEqual(['stealth', 'work']);
  });
});

describe('launch options per engine', () => {
  test('Chromium profiles launch as before: no seed, no sandbox change, Playwright defaults', async () => {
    const bin = fakeBinary();
    const { manager, calls, profiles } = setup({ executablePath: bin.path });
    await manager.tabs('s1');
    expect(calls.length).toBe(1);
    expect(calls[0].dir).toBe(join(profiles, 'default'));
    expect(calls[0].opts).toEqual({ timeout: 60_000, executablePath: bin.path, viewport: { width: 1280, height: 800 }, headless: true });
    expect(existsSync(join(profiles, 'default', CLOAK_SEED_FILE))).toBe(false);
    expect(manager.profileInfo('default')).toEqual({ name: 'default', engine: 'chromium', label: 'Chromium', open: true });
    await manager.close();
  });

  test('CloakBrowser profiles get the wrapper flags, keep the sandbox, drop automation flags and never update', async () => {
    const bin = fakeBinary();
    const { manager, calls, profiles } = setup({ executablePath: '/nowhere/chrome', profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: bin.path, sha256: bin.sha } });
    manager.setProfile('s1', 'stealth');
    await manager.tabs('s1');
    const { dir, opts } = calls[0];
    expect(dir).toBe(join(profiles, 'stealth'));
    // the CloakBrowser binary, not browser.executablePath
    expect(opts.executablePath).toBe(bin.path);
    const seed = Number(readFileSync(join(dir, CLOAK_SEED_FILE), 'utf8'));
    expect(opts.args).toEqual([`--fingerprint=${seed}`, `--fingerprint-platform=${process.platform === 'darwin' ? 'macos' : 'windows'}`, ...(process.platform === 'win32' ? ['--ignore-gpu-blocklist'] : [])]);
    expect(opts.args!.some((a) => /no-sandbox/.test(a))).toBe(false);
    expect(opts.chromiumSandbox).toBe(true);
    expect(opts.ignoreDefaultArgs).toEqual(['--enable-automation', '--enable-unsafe-swiftshader']);
    expect(opts.env?.CLOAKBROWSER_AUTO_UPDATE).toBe('false');
    expect(opts.viewport).toEqual(CLOAK_HEADLESS_VIEWPORT);
    expect(opts.headless).toBe(true);
    expect(manager.profileInfo('stealth')).toEqual({ name: 'stealth', engine: 'cloak', label: 'CloakBrowser', open: true });
    await manager.close();
  });

  test('a preview runs on stock Chromium even when every profile is CloakBrowser; CloakBrowser only when there is none, with a note', async () => {
    const cloak = fakeBinary();
    const stock = fakeBinary();
    const browser = { executablePath: cloak.path, profiles: { default: { engine: 'cloak' as const }, marketplace: { engine: 'cloak' as const } }, cloak: { executablePath: cloak.path, sha256: cloak.sha } };
    const notes: string[] = [];
    const guard = { allows: () => false, file: async () => undefined, log: (e: { text: string }) => void notes.push(e.text) };

    const { manager, calls } = setup(browser, undefined, () => stock.path);
    await manager.startPreview('s1', guard);
    await manager.tabs('s1');
    expect(calls.length).toBe(1);
    // Playwright's own Chromium: no fingerprint flags, the preview fence flags, not browser.executablePath
    expect(calls[0].opts.executablePath).toBe(stock.path);
    expect(calls[0].opts.args!.some((a) => a.startsWith('--fingerprint'))).toBe(false);
    expect(calls[0].opts.args).toContain('--disable-quic');
    expect(notes).toEqual([]);
    await manager.close();

    const none = setup(browser, undefined, () => undefined);
    await none.manager.startPreview('s1', guard);
    await none.manager.tabs('s1');
    expect(none.calls[0].opts.executablePath).toBe(cloak.path);
    expect(notes).toEqual(['No stock Chromium on the hub, so the preview runs on CloakBrowser: console messages may be missing and fonts, scale and theme may be off. Install Chromium in Settings, Browser, Engines.']);
    await none.manager.close();
  });

  test('a headed CloakBrowser gets no emulated viewport and the GPU flag; no display falls back to headless', async () => {
    const o = cloakLaunchOptions({ executablePath: '/x/chrome', seed: 12345, headless: false, platform: 'linux', env: { PATH: '/bin', CLOAKBROWSER_AUTO_UPDATE: 'true' } });
    expect(o.viewport).toBeNull();
    expect(o.args).toEqual(['--fingerprint=12345', '--fingerprint-platform=windows', '--ignore-gpu-blocklist']);
    expect(o.env).toEqual({ PATH: '/bin', CLOAKBROWSER_AUTO_UPDATE: 'false' });
    expect(cloakLaunchOptions({ executablePath: '/x/chrome', seed: 12345, headless: true, platform: 'darwin' }).args).toEqual(['--fingerprint=12345', '--fingerprint-platform=macos']);

    const bin = fakeBinary();
    let first = true;
    const { manager, calls } = setup({ headless: false, profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: bin.path } }, () => {
      if (!first) return undefined;
      first = false;
      return new Error('Missing X server or $DISPLAY');
    });
    manager.setProfile('s1', 'stealth');
    await manager.tabs('s1');
    expect(calls.map((c) => [c.opts.headless, c.opts.chromiumSandbox, c.opts.viewport])).toEqual([
      [false, true, null],
      [true, true, CLOAK_HEADLESS_VIEWPORT],
    ]);
    // the same identity on the retry
    expect(calls[1].opts.args![0]).toBe(calls[0].opts.args![0]);
    await manager.close();
  });

  test('a sandbox Chromium cannot start is an error that says so, never a retry without it', async () => {
    const bin = fakeBinary();
    const { manager, calls } = setup({ profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: bin.path } }, () => new Error('Chromium sandboxing failed!\n================================'));
    manager.setProfile('s1', 'stealth');
    await expect(manager.tabs('s1')).rejects.toThrow(CLOAK_SANDBOX_HELP);
    expect(calls.length).toBe(1);
    await manager.close();
  });

  test('a CloakBrowser profile without a binary says what to set', async () => {
    const { manager, calls } = setup({ profiles: { stealth: { engine: 'cloak' } } });
    manager.setProfile('s1', 'stealth');
    await expect(manager.tabs('s1')).rejects.toThrow('browser.cloak.executablePath is not set');
    const missing = setup({ profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: '/nowhere/chrome' } });
    missing.manager.setProfile('s1', 'stealth');
    await expect(missing.manager.tabs('s1')).rejects.toThrow('browser.cloak.executablePath not found: /nowhere/chrome');
    expect(calls.length + missing.calls.length).toBe(0);
  });

  test('an unknown engine in the config stops the launch', async () => {
    const { manager, calls } = setup({ profiles: { odd: { engine: 'gecko' as never } } });
    manager.setProfile('s1', 'odd');
    await expect(manager.tabs('s1')).rejects.toThrow('Use chromium or cloak.');
    expect(calls.length).toBe(0);
  });
});

describe('sha256 pin', () => {
  test('a binary that does not match is refused before it runs', async () => {
    const bin = fakeBinary();
    const { manager, calls } = setup({ profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: bin.path, sha256: 'f'.repeat(64) } });
    manager.setProfile('s1', 'stealth');
    await expect(manager.tabs('s1')).rejects.toThrow(`CloakBrowser at ${bin.path} does not match browser.cloak.sha256 (expected ffffffffffff..., found ${bin.sha.slice(0, 12)}...). Conclave did not start it.`);
    expect(calls.length).toBe(0);
  });

  test('a match passes, in either case, and a changed file is hashed again', async () => {
    const bin = fakeBinary();
    expect(await fileSha256(bin.path)).toBe(bin.sha);
    const { manager, calls } = setup({ profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: bin.path, sha256: bin.sha.toUpperCase() } });
    manager.setProfile('s1', 'stealth');
    await manager.tabs('s1');
    expect(calls.length).toBe(1);
    await manager.close();
    // swap the binary: the next launch sees the new hash
    writeFileSync(bin.path, 'a different build, a little longer\n');
    await expect(manager.tabs('s1')).rejects.toThrow('does not match browser.cloak.sha256');
    expect(calls.length).toBe(1);
  });
});

describe('one fingerprint seed per profile', () => {
  test('the seed is made once, kept with the profile, and reused after a restart', async () => {
    const bin = fakeBinary();
    const browser = { profiles: { work: { engine: 'cloak' as const }, shop: { engine: 'cloak' as const } }, cloak: { executablePath: bin.path } };
    const first = setup(browser);
    first.manager.setProfile('s1', 'work');
    await first.manager.tabs('s1');
    const file = join(first.profiles, 'work', CLOAK_SEED_FILE);
    const seed = readFileSync(file, 'utf8');
    expect(seed).toMatch(/^\d{5}\n$/);
    expect(first.calls[0].opts.args![0]).toBe(`--fingerprint=${seed.trim()}`);
    await first.manager.close();

    // a new manager on the same folder: same seed, same identity
    const relaunch = fakeLauncher();
    const second = new BrowserManager({ config: first.config, launcher: relaunch.launcher });
    second.setProfile('s1', 'work');
    await second.tabs('s1');
    expect(relaunch.calls[0].opts.args![0]).toBe(`--fingerprint=${seed.trim()}`);
    expect(readFileSync(file, 'utf8')).toBe(seed);

    // another profile keeps its own seed file
    second.setProfile('s2', 'shop');
    await second.tabs('s2');
    expect(existsSync(join(first.profiles, 'shop', CLOAK_SEED_FILE))).toBe(true);
    expect(relaunch.calls[1].opts.args![0]).toBe(`--fingerprint=${readFileSync(join(first.profiles, 'shop', CLOAK_SEED_FILE), 'utf8').trim()}`);
    await second.close();
  });

  test('profileSeed writes the wrapper format and refuses a damaged file', () => {
    const dir = tmp('conclave-seed-');
    expect(profileSeed(dir, () => 42424)).toBe(42424);
    expect(readFileSync(join(dir, CLOAK_SEED_FILE), 'utf8')).toBe('42424\n');
    // later calls never draw a new one
    expect(profileSeed(dir, () => 11111)).toBe(42424);
    const bad = tmp('conclave-seed-');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, CLOAK_SEED_FILE), 'not a seed\n');
    expect(() => profileSeed(bad)).toThrow('is not a number from 10000 to 99999. Fix it, or delete it to give this profile a new identity.');
    expect(readFileSync(join(bad, CLOAK_SEED_FILE), 'utf8')).toBe('not a seed\n');
  });
});

describe('the engine shows where the owner and the agent look', () => {
  test('browser_profile names the engine in its profile line, and listProfiles includes configured ones', async () => {
    const bin = fakeBinary();
    const { manager, profiles } = setup({ profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: bin.path } });
    // default ran before (Chromium wrote its Local State) with no engine set: it stays on Chromium
    mkdirSync(join(profiles, 'default'), { recursive: true });
    writeFileSync(join(profiles, 'default', 'Local State'), '{}');
    const profile = browserTools(manager).find((t) => t.name === 'browser_profile')!;
    const cloak = await profile.run({ name: 'stealth' }, ctx('s1'));
    expect(cloak.content).toContain('This session now uses browser profile "stealth" (CloakBrowser).');
    expect(cloak.meta).toMatchObject({ profile: 'stealth', engine: 'cloak' });
    const plain = await profile.run({ name: 'default' }, ctx('s2'));
    expect(plain.content).toContain('browser profile "default" (Chromium).');
    // a new profile gets CloakBrowser while it is installed
    const fresh = await profile.run({ name: 'fresh' }, ctx('s3'));
    expect(fresh.content).toContain('browser profile "fresh" (CloakBrowser).');
    expect(manager.listProfiles()).toEqual(['default', 'stealth']);
    expect(manager.profileInfo('stealth')).toMatchObject({ label: 'CloakBrowser', open: false });
  });

  test('a profile with a bad engine is not picked', async () => {
    const { manager } = setup({ profiles: { odd: { engine: 'gecko' as never } } });
    const profile = browserTools(manager).find((t) => t.name === 'browser_profile')!;
    const out = await profile.run({ name: 'odd' }, ctx('s1'));
    expect(out.isError).toBe(true);
    expect(manager.profileFor('s1')).toBe('default');
  });
});

describe('new profiles default to CloakBrowser when it is installed', () => {
  test('a new profile gets cloak and keeps it; one Chromium has run in stays on Chromium', async () => {
    const bin = fakeBinary();
    const { manager, calls, config, profiles } = setup({ cloak: { executablePath: bin.path } });
    mkdirSync(join(profiles, 'old'), { recursive: true });
    writeFileSync(join(profiles, 'old', 'Local State'), '{}');
    expect(manager.newProfileEngine()).toBe('cloak');
    expect(manager.engineOf('fresh')).toBe('cloak');
    expect(manager.engineOf('old')).toBe('chromium');
    manager.setProfile('s1', 'fresh');
    await manager.tabs('s1');
    expect(calls[0].opts.executablePath).toBe(bin.path);
    expect(config.getUser().browser?.profiles?.fresh?.engine).toBe('cloak');
    await manager.close();
  });

  test('a first launch that fails still leaves the profile on CloakBrowser', async () => {
    const bin = fakeBinary();
    const { manager, config, profiles } = setup({ cloak: { executablePath: bin.path } }, () => new Error('No usable sandbox! crbug.com/638180'));
    manager.setProfile('s1', 'first');
    await expect(manager.tabs('s1')).rejects.toThrow(CLOAK_SANDBOX_HELP);
    // the folder is there now (with its seed), but no browser ran in it
    expect(existsSync(join(profiles, 'first', CLOAK_SEED_FILE))).toBe(true);
    expect(manager.hasRun('first')).toBe(false);
    expect(config.getUser().browser?.profiles?.first?.engine).toBe('cloak');
    expect(manager.engineOf('first')).toBe('cloak');
  });

  test('without CloakBrowser a new profile is Chromium and nothing is written', async () => {
    const { config, manager } = setup({});
    expect(manager.newProfileEngine()).toBe('chromium');
    manager.setProfile('s1', 'fresh');
    await manager.tabs('s1');
    expect(config.getUser().browser?.profiles?.fresh).toBeUndefined();
    await manager.close();
  });
});
