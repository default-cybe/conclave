/**
 * The hub's browser folder (<CONCLAVE_HOME>/browser) and what is in it.
 *
 * The compiled conclave binary keeps playwright-core out (scripts/build-cli.ts
 * marks it external), so `import('playwright-core')` fails on a hub installed
 * from a release. Install on the hub puts the pinned playwright-core in
 * <browser folder>/node_modules/playwright-core and loadPlaywright imports it
 * from there by its full path. A source checkout and the Docker image have it
 * with the app, which wins.
 *
 * Also here: the version of a browser binary, and the system libraries it
 * cannot find. The apt packages that have them are in packages.ts.
 */
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConclaveConfig } from '../config/schema';
import { parseOsRelease, type OsRelease } from './packages';
import { BROWSERS_REL, PLAYWRIGHT_REL } from './setup-plan';

export { aptCommand, aptPackages, allBrowserPackages, CHROMIUM_PACKAGES, FONT_PACKAGES, LIB_PACKAGES, parseOsRelease, usesT64, type OsRelease } from './packages';

type PlaywrightModule = typeof import('playwright-core');

/** The hub's browser folder. */
export function browserDir(home: string): string {
  return join(home, 'browser');
}

/** Where Install on the hub puts Playwright's Chromium. */
export function hubBrowsersPath(home: string): string {
  return join(browserDir(home), BROWSERS_REL);
}

function hubPlaywrightEntry(dir: string): string {
  return join(dir, PLAYWRIGHT_REL, 'index.mjs');
}

/** playwright-core from the app, else from the hub's browser folder. */
export async function loadPlaywright(dir?: string): Promise<PlaywrightModule> {
  try {
    return await import('playwright-core');
  } catch {
    /* not with the app: a release binary */
  }
  if (dir) {
    const entry = hubPlaywrightEntry(dir);
    if (existsSync(entry)) return (await import(entry)) as PlaywrightModule;
  }
  throw new Error('playwright-core is not installed. Install it from Settings, Browser.');
}

function versionAt(pkgDir: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The playwright-core the hub would load, without loading it. */
export function playwrightInfo(dir?: string): { version: string; dir: string; where: 'app' | 'hub' } | undefined {
  try {
    const resolved = import.meta.resolve('playwright-core');
    if (resolved.startsWith('file:')) {
      let d = dirname(fileURLToPath(resolved));
      for (let i = 0; i < 3 && !existsSync(join(d, 'package.json')); i++) d = dirname(d);
      const version = versionAt(d);
      if (version && existsSync(join(d, 'cli.js'))) return { version, dir: d, where: 'app' };
    }
  } catch {
    /* not with the app */
  }
  if (dir) {
    const d = join(dir, PLAYWRIGHT_REL);
    const version = versionAt(d);
    if (version && existsSync(hubPlaywrightEntry(dir))) return { version, dir: d, where: 'hub' };
  }
  return undefined;
}

const versions = new Map<string, string | undefined>();

/** "156.0.8078.4" from `<binary> --version`, kept per path and change time. */
export async function binaryVersion(path: string): Promise<string | undefined> {
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return undefined;
  }
  if (versions.has(key)) return versions.get(key);
  let v: string | undefined;
  try {
    const p = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const timer = setTimeout(() => p.kill(), 5_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    await p.exited;
    v = /(\d+\.\d+\.\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1];
  } catch {
    v = undefined;
  }
  // a CloakBrowser folder name carries its full version (146.0.7680.177.5); --version says the Chromium part
  const fromDir = /chromium-(\d+\.\d+\.\d+\.\d+(?:\.\d+)?)/.exec(path)?.[1];
  if (fromDir && (!v || fromDir.startsWith(v))) v = fromDir;
  versions.set(key, v);
  return v;
}

const libs = new Map<string, { missing: string[]; at: number }>();
/** A "missing" answer is asked again after this long: the owner may have run apt-get by hand. */
const MISSING_TTL_MS = 20_000;

/** Shared libraries a binary needs that this machine does not have (ldd's "not found"). Linux only. */
export async function missingLibraries(path: string): Promise<string[]> {
  if (process.platform !== 'linux') return [];
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return [];
  }
  const hit = libs.get(key);
  if (hit && (!hit.missing.length || Date.now() - hit.at < MISSING_TTL_MS)) return hit.missing;
  let out = '';
  try {
    const p = Bun.spawn(['ldd', path], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => p.kill(), 10_000);
    out = await new Response(p.stdout).text();
    clearTimeout(timer);
    await p.exited;
  } catch {
    return [];
  }
  const missing = [...new Set([...out.matchAll(/^\s*(\S+)\s+=>\s+not found/gm)].map((m) => m[1]))].sort();
  libs.set(key, { missing, at: Date.now() });
  return missing;
}

/** Forget the kept answers (after an install, or an apt-get the owner ran). */
export function forgetBinaryFacts(): void {
  versions.clear();
  libs.clear();
}

/** ID and VERSION_ID of this machine's /etc/os-release, or of the text given. */
export function readOsRelease(text?: string): OsRelease {
  if (text !== undefined) return parseOsRelease(text);
  try {
    return parseOsRelease(readFileSync('/etc/os-release', 'utf8'));
  } catch {
    return {};
  }
}

/** True when the machine has at least one font file Chromium can use. */
export function hasFonts(dirs = ['/usr/share/fonts', '/usr/local/share/fonts']): boolean {
  if (process.platform !== 'linux') return true;
  const look = (d: string, depth: number): boolean => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return false;
    }
    for (const n of names) {
      if (/\.(ttf|otf|ttc|pfb|woff2?)$/i.test(n)) return true;
      if (depth < 3) {
        try {
          if (statSync(join(d, n)).isDirectory() && look(join(d, n), depth + 1)) return true;
        } catch {
          /* gone */
        }
      }
    }
    return false;
  };
  return dirs.some((d) => look(d, 0));
}

/** Free bytes on the disk that holds `dir` (or its nearest parent that exists). */
export function freeBytes(dir: string): number | undefined {
  let d = dir;
  for (let i = 0; i < 32 && !existsSync(d); i++) d = dirname(d);
  try {
    const s = statfsSync(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/** True when browser.cloak.executablePath names a file that is there. */
export function cloakInstalled(browser: ConclaveConfig['browser'] | undefined, home = ''): boolean {
  const raw = browser?.cloak?.executablePath?.trim();
  if (!raw) return false;
  const path = raw.replace(/^~(?=$|[\\/])/, home || process.env.HOME || '');
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
