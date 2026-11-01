/**
 * The Debian and Ubuntu packages that hold the system libraries Chromium and
 * CloakBrowser link, and the fonts they need. Settings > Browser names the
 * ones a hub misses (browser/runtime.ts finds them with ldd), and the root
 * helper (system/root-helper.ts) has the whole list for each release built
 * into it.
 *
 * Pure, with no node imports, so the web app and the helper's script use it.
 */

/** Library file -> Debian package, the libraries Chromium and CloakBrowser link. [older name, t64 name] where they differ. */
export const LIB_PACKAGES: Readonly<Record<string, string | readonly [string, string]>> = {
  'libasound.so.2': ['libasound2', 'libasound2t64'],
  'libatk-bridge-2.0.so.0': ['libatk-bridge2.0-0', 'libatk-bridge2.0-0t64'],
  'libatk-1.0.so.0': ['libatk1.0-0', 'libatk1.0-0t64'],
  'libatspi.so.0': ['libatspi2.0-0', 'libatspi2.0-0t64'],
  'libcairo.so.2': 'libcairo2',
  'libcups.so.2': ['libcups2', 'libcups2t64'],
  'libdbus-1.so.3': 'libdbus-1-3',
  'libdrm.so.2': 'libdrm2',
  'libgbm.so.1': 'libgbm1',
  'libglib-2.0.so.0': ['libglib2.0-0', 'libglib2.0-0t64'],
  'libgio-2.0.so.0': ['libglib2.0-0', 'libglib2.0-0t64'],
  'libgobject-2.0.so.0': ['libglib2.0-0', 'libglib2.0-0t64'],
  'libgmodule-2.0.so.0': ['libglib2.0-0', 'libglib2.0-0t64'],
  'libnspr4.so': 'libnspr4',
  'libplc4.so': 'libnspr4',
  'libplds4.so': 'libnspr4',
  'libnss3.so': 'libnss3',
  'libnssutil3.so': 'libnss3',
  'libsmime3.so': 'libnss3',
  'libpango-1.0.so.0': 'libpango-1.0-0',
  'libX11.so.6': 'libx11-6',
  'libxcb.so.1': 'libxcb1',
  'libXcomposite.so.1': 'libxcomposite1',
  'libXdamage.so.1': 'libxdamage1',
  'libXext.so.6': 'libxext6',
  'libXfixes.so.3': 'libxfixes3',
  'libxkbcommon.so.0': 'libxkbcommon0',
  'libXrandr.so.2': 'libxrandr2',
  'libXi.so.6': 'libxi6',
  'libXrender.so.1': 'libxrender1',
  'libxcb-render.so.0': 'libxcb-render0',
  'libxcb-shm.so.0': 'libxcb-shm0',
  'libfontconfig.so.1': 'libfontconfig1',
  'libfreetype.so.6': 'libfreetype6',
  'libexpat.so.1': 'libexpat1',
  'libavahi-client.so.3': 'libavahi-client3',
  'libavahi-common.so.3': 'libavahi-common3',
  'libharfbuzz.so.0': 'libharfbuzz0b',
  'libudev.so.1': 'libudev1',
};

/** Playwright's own list for Chromium (1.64.1, nativeDeps), for a library this table does not know. */
export const CHROMIUM_PACKAGES: readonly string[] = ['libasound2', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libatspi2.0-0', 'libcairo2', 'libcups2', 'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2'];
const T64 = new Set(['libasound2', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libatspi2.0-0', 'libcups2', 'libglib2.0-0']);
/** Fonts for a machine with none: Chromium draws no text without one. */
export const FONT_PACKAGES: readonly string[] = ['fonts-liberation', 'fonts-noto-color-emoji'];

export interface OsRelease {
  id?: string;
  versionId?: string;
}

/** ID and VERSION_ID from the text of /etc/os-release. */
export function parseOsRelease(t: string): OsRelease {
  const get = (k: string) => new RegExp(`^${k}=("?)([^"\\n]*)\\1$`, 'm').exec(t)?.[2];
  return { id: get('ID'), versionId: get('VERSION_ID') };
}

/** Debian 13 and Ubuntu 24.04 renamed some libraries with a t64 suffix. */
export function usesT64(os: OsRelease): boolean {
  const v = Number.parseFloat(os.versionId ?? '');
  if (os.id === 'debian') return v >= 13;
  if (os.id === 'ubuntu') return v >= 24;
  return false;
}

function pick(p: string | readonly [string, string], t64: boolean): string {
  return typeof p === 'string' ? p : p[t64 ? 1 : 0];
}

/** The apt packages for the missing libraries. A library the table does not know brings Playwright's whole list. */
export function aptPackages(missing: string[], os: OsRelease, opts: { fonts?: boolean } = {}): string[] {
  const t64 = usesT64(os);
  const out = new Set<string>();
  let unknown = false;
  for (const lib of missing) {
    const p = LIB_PACKAGES[lib];
    if (p) out.add(pick(p, t64));
    else unknown = true;
  }
  if (unknown) for (const p of CHROMIUM_PACKAGES) out.add(t64 && T64.has(p) ? `${p}t64` : p);
  if (opts.fonts) for (const f of FONT_PACKAGES) out.add(f);
  return [...out].sort();
}

/**
 * Every package aptPackages can name, with the older names or the t64 ones:
 * the list the root helper's browser-deps action installs, so whatever ldd
 * finds missing, the helper has it.
 */
export function allBrowserPackages(t64: boolean): string[] {
  const out = new Set<string>();
  for (const p of Object.values(LIB_PACKAGES)) out.add(pick(p, t64));
  for (const p of CHROMIUM_PACKAGES) out.add(t64 && T64.has(p) ? `${p}t64` : p);
  for (const f of FONT_PACKAGES) out.add(f);
  return [...out].sort();
}

/** The one command for root: apt-get on Debian and Ubuntu, nothing elsewhere. */
export function aptCommand(packages: string[]): string | undefined {
  return packages.length ? `apt-get install -y --no-install-recommends ${packages.join(' ')}` : undefined;
}
