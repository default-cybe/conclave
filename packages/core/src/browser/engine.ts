/**
 * Browser engines for named profiles (browser.profiles.<name>.engine).
 *
 * chromium: Playwright's Chromium or a system Chrome, as before.
 * cloak: CloakBrowser, a closed source Chromium build with fingerprint
 * patches. Conclave starts the binary the owner installed straight through
 * Playwright with the flags its MIT wrapper (the cloakbrowser npm package)
 * uses, so there is no runtime dependency on the wrapper and nothing is ever
 * downloaded or updated. Two flags differ on purpose: the wrapper adds
 * --no-sandbox, and Playwright adds it too unless asked not to; Conclave keeps
 * the renderer sandbox on, because an agent opens untrusted pages.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createReadStream, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConclaveConfig } from '../config/schema';
import { browserProxyProblems } from './proxy-provider';

export type BrowserEngine = 'chromium' | 'cloak';
export const BROWSER_ENGINES: readonly BrowserEngine[] = ['chromium', 'cloak'];
/** Names shown in the takeover header and the browser tools' profile line. */
export const ENGINE_LABEL: Record<BrowserEngine, string> = { chromium: 'Chromium', cloak: 'CloakBrowser' };

export interface BrowserProfileInfo {
  name: string;
  engine: BrowserEngine;
  label: string;
  open: boolean;
}

type BrowserConfig = ConclaveConfig['browser'] | undefined;

/** The engine a profile runs on. Unknown values are an error, never a silent fallback to Chromium. */
export function engineFor(browser: BrowserConfig, profile: string): BrowserEngine {
  const raw = browser?.profiles?.[profile]?.engine as unknown;
  if (raw === undefined || raw === null || raw === '') return 'chromium';
  if (!BROWSER_ENGINES.includes(raw as BrowserEngine)) throw new Error(`browser.profiles.${profile}.engine is "${String(raw)}". Use chromium or cloak.`);
  return raw as BrowserEngine;
}

const SHA256 = /^[0-9a-f]{64}$/i;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What is wrong with a browser config, one sentence each. Empty when it is fine. */
export function browserConfigProblems(browser: unknown): string[] {
  if (browser === undefined || browser === null) return [];
  if (typeof browser !== 'object' || Array.isArray(browser)) return ['browser must be an object.'];
  const b = browser as Record<string, unknown>;
  const out: string[] = [];
  const profiles = b.profiles;
  if (profiles !== undefined && profiles !== null) {
    if (typeof profiles !== 'object' || Array.isArray(profiles)) out.push('browser.profiles must be an object keyed by profile name.');
    else {
      for (const [name, p] of Object.entries(profiles as Record<string, unknown>)) {
        if (!PROFILE.test(name) || name.includes('..')) out.push(`"${name}" is not a valid profile name. Use letters, digits, dot, dash or underscore (max 64).`);
        if (p === null || p === undefined) continue;
        if (typeof p !== 'object' || Array.isArray(p)) {
          out.push(`browser.profiles.${name} must be an object.`);
          continue;
        }
        const engine = (p as Record<string, unknown>).engine;
        if (engine !== undefined && engine !== null && !BROWSER_ENGINES.includes(engine as BrowserEngine)) out.push(`browser.profiles.${name}.engine must be chromium or cloak.`);
      }
    }
  }
  out.push(...browserProxyProblems(b.proxy));
  const cloak = b.cloak;
  if (cloak !== undefined && cloak !== null) {
    if (typeof cloak !== 'object' || Array.isArray(cloak)) out.push('browser.cloak must be an object.');
    else {
      const c = cloak as Record<string, unknown>;
      if (c.executablePath !== undefined && c.executablePath !== null && typeof c.executablePath !== 'string') out.push('browser.cloak.executablePath must be a path.');
      if (c.sha256 !== undefined && c.sha256 !== null && c.sha256 !== '' && (typeof c.sha256 !== 'string' || !SHA256.test(c.sha256.trim())))
        out.push('browser.cloak.sha256 must be 64 hex characters, as sha256sum prints it.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CloakBrowser
// ---------------------------------------------------------------------------

/** The wrapper's seed file, so a profile keeps one identity whichever program starts it. */
export const CLOAK_SEED_FILE = '.cloakbrowser-seed';
export const CLOAK_SEED_MIN = 10_000;
export const CLOAK_SEED_MAX = 99_999;
/**
 * Default arguments Playwright adds that the wrapper drops: --enable-automation
 * sets navigator.webdriver, and --enable-unsafe-swiftshader gives a WebGL
 * renderer string no real browser has.
 */
export const CLOAK_IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader'];
/** The wrapper's headless viewport: a maximized Chrome on a 1080p Windows screen. Headed windows get no emulated viewport. */
export const CLOAK_HEADLESS_VIEWPORT = { width: 1920, height: 947 };

/**
 * The profile's fingerprint seed, created on first use in <dir>/.cloakbrowser-seed.
 * A damaged file stops the launch instead of quietly giving the cookie jar a new identity.
 */
export function profileSeed(dir: string, random: () => number = () => randomInt(CLOAK_SEED_MIN, CLOAK_SEED_MAX + 1)): number {
  const file = join(dir, CLOAK_SEED_FILE);
  const read = (): number | undefined => {
    let text: string;
    try {
      text = readFileSync(file, 'latin1').trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < CLOAK_SEED_MIN || n > CLOAK_SEED_MAX)
      throw new Error(`The fingerprint seed in ${file} is not a number from ${CLOAK_SEED_MIN} to ${CLOAK_SEED_MAX}. Fix it, or delete it to give this profile a new identity.`);
    return n;
  };
  const have = read();
  if (have !== undefined) return have;
  mkdirSync(dir, { recursive: true });
  const seed = random();
  if (!Number.isInteger(seed) || seed < CLOAK_SEED_MIN || seed > CLOAK_SEED_MAX) throw new Error(`Seed ${seed} is out of range.`);
  // write a temp file, then link it in: the seed file is never seen half written and never replaced
  const tmp = join(dir, `${CLOAK_SEED_FILE}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${seed}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
  return read()!;
}

const hashes = new Map<string, string>();

/** sha256 of a file, hex. Kept per path, size and change time, so a relaunch does not read 300 MB again. */
export async function fileSha256(path: string): Promise<string> {
  const st = statSync(path);
  const key = `${resolve(path)}\0${st.size}\0${st.mtimeMs}`;
  const hit = hashes.get(key);
  if (hit) return hit;
  const h = createHash('sha256');
  await new Promise<void>((done, fail) => {
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => done())
      .on('error', fail);
  });
  const hex = h.digest('hex');
  hashes.set(key, hex);
  return hex;
}

/** Refuse a binary that does not match browser.cloak.sha256. Without a pin there is nothing to check. */
export async function verifyCloakBinary(path: string, expected: string | undefined): Promise<void> {
  const want = expected?.trim().toLowerCase();
  if (!want) return;
  if (!SHA256.test(want)) throw new Error('browser.cloak.sha256 must be 64 hex characters, as sha256sum prints it.');
  const got = await fileSha256(path);
  if (got !== want) throw new Error(`CloakBrowser at ${path} does not match browser.cloak.sha256 (expected ${want.slice(0, 12)}..., found ${got.slice(0, 12)}...). Conclave did not start it.`);
}

/** browser.cloak.executablePath with ~ expanded, or an error that says what to set. */
export function cloakExecutable(browser: BrowserConfig, profile: string): string {
  const raw = browser?.cloak?.executablePath?.trim();
  if (!raw) throw new Error(`Browser profile "${profile}" uses CloakBrowser, but browser.cloak.executablePath is not set. Install CloakBrowser and point it at its chrome binary.`);
  const path = resolve(raw.replace(/^~(?=$|[\\/])/, homedir()));
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`browser.cloak.executablePath not found: ${raw}`);
  }
  return path;
}

export interface CloakLaunchInput {
  executablePath: string;
  seed: number;
  headless: boolean;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/**
 * Options for chromium.launchPersistentContext with the wrapper's flags:
 * a fixed --fingerprint seed, the platform it pretends to be, no automation
 * flags, no SwiftShader. The sandbox stays on and updates stay off.
 */
export function cloakLaunchOptions(o: CloakLaunchInput) {
  const platform = o.platform ?? process.platform;
  const args = [`--fingerprint=${o.seed}`, `--fingerprint-platform=${platform === 'darwin' ? 'macos' : 'windows'}`];
  // the wrapper lets WebGL run on software GPUs in headed mode, and on Windows always
  if (!o.headless || platform === 'win32') args.push('--ignore-gpu-blocklist');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env ?? process.env)) if (typeof v === 'string') env[k] = v;
  env.CLOAKBROWSER_AUTO_UPDATE = 'false';
  return {
    executablePath: o.executablePath,
    headless: o.headless,
    args,
    ignoreDefaultArgs: [...CLOAK_IGNORE_DEFAULT_ARGS],
    // Playwright passes --no-sandbox unless this is true
    chromiumSandbox: true,
    viewport: o.headless ? { ...CLOAK_HEADLESS_VIEWPORT } : null,
    env,
  };
}

/** Chromium refused to start with its sandbox: as root, or without user namespaces. */
export function isSandboxFailure(message: string): boolean {
  return /Chromium sandboxing failed|No usable sandbox|crbug\.com\/638180|Running as root without --no-sandbox|crbug\.com\/357670/i.test(message);
}

export const CLOAK_SANDBOX_HELP =
  'CloakBrowser keeps the renderer sandbox on, and Chromium could not start it here: the hub runs as root, or user namespaces are off. Run the hub as a normal user, or allow unprivileged user namespaces. Conclave does not turn the sandbox off for CloakBrowser.';

/** The browser could not start because the machine lacks a system library it links. */
export function isMissingLibrary(message: string): boolean {
  return /error while loading shared libraries|Host system is missing dependencies to run browsers/i.test(message);
}

/** What the agent and the owner read when the browser misses system libraries. */
export const MISSING_LIBS_HELP =
  "The browser cannot start: the hub's machine lacks system libraries it needs. If the owner installed the root helper (conclave system-helper install), run: sudo /usr/local/libexec/conclave-root-helper browser-deps. Otherwise the owner can install them from Settings, Browser.";
