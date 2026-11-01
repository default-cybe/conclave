import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Paths inside a Playwright `chromium-<rev>` folder, newest layouts first. */
const PW_CHROMIUM_BINARIES = [
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
];

/** Paths inside a Playwright `chromium_headless_shell-<rev>` folder. Headless only. */
const PW_SHELL_BINARIES = [
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-linux/headless_shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-mac/headless_shell',
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
  'chrome-win/headless_shell.exe',
];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Folders where Playwright keeps downloaded browsers on this OS. `extra` (the hub's browser folder) comes first. */
export function playwrightCacheDirs(extra: string[] = []): string[] {
  const dirs: string[] = [...extra];
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env && env !== '0') dirs.push(env);
  const home = homedir();
  if (process.platform === 'darwin') dirs.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(local, 'ms-playwright'));
  } else {
    dirs.push(join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright'));
  }
  dirs.push('/opt/pw-browsers', '/ms-playwright');
  return [...new Set(dirs)];
}

/** Revision folders like chromium-1194, newest first. */
function revisionDirs(dir: string, prefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  return names
    .map((n) => ({ n, m: re.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]))
    .map((x) => join(dir, x.n));
}

function systemCandidates(): string[] {
  if (process.platform === 'darwin') {
    const apps = ['/Applications', join(homedir(), 'Applications')];
    const names = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return apps.flatMap((a) => names.map((n) => join(a, n)));
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(
      (x): x is string => !!x,
    );
    const names = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Chromium\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    return roots.flatMap((r) => names.map((n) => join(r, n)));
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium',
    '/usr/local/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
}

/**
 * Find a Chromium-based browser. Order: explicit path, Playwright downloads
 * (the hub's browser folder first), system installs, then (headless only)
 * the Playwright headless shell.
 */
export function findBrowserExecutable(opts: { explicit?: string; headless?: boolean; extraDirs?: string[] } = {}): string | undefined {
  if (opts.explicit) return existsSync(opts.explicit) ? opts.explicit : undefined;
  const cacheDirs = playwrightCacheDirs(opts.extraDirs);
  for (const dir of cacheDirs) {
    for (const rev of revisionDirs(dir, 'chromium')) {
      for (const bin of PW_CHROMIUM_BINARIES) {
        const p = join(rev, bin);
        if (isFile(p)) return p;
      }
    }
  }
  for (const p of systemCandidates()) if (isFile(p)) return p;
  if (opts.headless !== false) {
    for (const dir of cacheDirs) {
      for (const rev of revisionDirs(dir, 'chromium_headless_shell')) {
        for (const bin of PW_SHELL_BINARIES) {
          const p = join(rev, bin);
          if (isFile(p)) return p;
        }
      }
    }
  }
  return undefined;
}
