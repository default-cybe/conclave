/**
 * "Install on the hub" in Settings > Browser: what the hub puts in its own
 * browser folder (<CONCLAVE_HOME>/browser) so the browser works with no
 * shell, and in what order. The same rules as Discover's hub setup
 * (catalog/hub-setup.ts):
 *
 * - Owner only, run as the hub's own user, never with sudo. Everything goes
 *   in a folder that user owns.
 * - Every version is pinned here and every download is checked against a
 *   hash pinned here before it is unpacked.
 * - The owner sees each step (the command, or the URL and its hash) before
 *   anything runs, and the hub runs exactly the steps the owner confirmed.
 * - System libraries need root, so these steps never install them. The page
 *   names the apt packages (browser/packages.ts), and Install system
 *   libraries runs the root helper's one fixed action when the owner has
 *   installed it (system/root-helper.ts, BrowserSetup.installLibs).
 *
 * Pure, with no node imports, so the web app's mock plans with it too.
 */

/** playwright-core, at the version core/package.json pins and bun.lock resolves. */
export const PLAYWRIGHT_CORE_VERSION = '1.64.1';
/** The npm tarball's sha512, as bun.lock records it for this version. */
export const PLAYWRIGHT_CORE_INTEGRITY = 'sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ==';
export const PLAYWRIGHT_CORE_URL = `https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz`;
/** The Chromium that playwright-core 1.64.1 installs (its browsers.json): Chrome for Testing. */
export const PLAYWRIGHT_CHROMIUM_REVISION = '1248';
export const PLAYWRIGHT_CHROMIUM_VERSION = '156.0.8078.4';
/** Where Playwright's installer takes it from on Linux x64. */
export const PLAYWRIGHT_CHROMIUM_URL = `https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/linux64/chrome-linux64.zip`;

/**
 * CloakBrowser for Linux x64, pinned. The release CloakHQ/cloakbrowser
 * chromium-v146.0.7680.177.5 (2026-05-21) is the build the cloakbrowser npm
 * wrapper (0.6.3) downloads for linux-x64. Its SHA256SUMS is signed with the
 * Ed25519 key the wrapper pins, and that signature checks out; the archive
 * hash below is the one in it. CloakBrowser's terms: builds up to v146 are
 * free for personal and commercial use, without redistribution; v148 and
 * later need a CloakBrowser Pro key. The hub downloads it from CloakHQ's own
 * release for its owner, so nothing is redistributed.
 */
export const CLOAK_VERSION = '146.0.7680.177.5';
export const CLOAK_ARCHIVE = `cloakbrowser-${CLOAK_VERSION}-linux-x64.tar.gz`;
export const CLOAK_ARCHIVE_URL = `https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v${CLOAK_VERSION}/cloakbrowser-linux-x64.tar.gz`;
export const CLOAK_ARCHIVE_SHA256 = '4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e';
/** sha256 of the chrome binary in that archive: the hub checks it after unpacking and pins browser.cloak.sha256 to it. */
export const CLOAK_CHROME_SHA256 = '715722e8605ae3ce81523c1218aba1ec89425786ab33ceaf99f8a6cb5e70e6e8';
/** The folder it unpacks to, inside the hub's browser folder, the name the wrapper uses in ~/.cloakbrowser. */
export const CLOAK_DIR = `cloakbrowser/chromium-${CLOAK_VERSION}`;

/** Roughly what each install needs free while it runs (download and unpacked files together). */
export const NEED_BYTES = { playwright: 40e6, chromium: 650e6, cloak: 950e6 } as const;

export type BrowserSetupTarget = 'chromium' | 'cloak';

/** What the hub knows about itself, for the plan. */
export interface BrowserSetupFacts {
  platform: string;
  arch: string;
  /** The account the steps run as. */
  user: string;
  /** The hub's browser folder. Steps run in it. */
  dir: string;
  /** The program that runs Playwright's installer: the hub's own binary, or bun. */
  runtime: string;
  /** playwright-core the hub can load: with the app, or in the browser folder. */
  playwright?: { version: string; dir: string; where: 'app' | 'hub' };
  /** A Chromium the chromium engine would start. */
  chromium?: { path: string; version?: string; where: 'hub' | 'playwright' | 'system' | 'config' };
  /** The CloakBrowser binary browser.cloak.executablePath names, when it is there. */
  cloak?: { path: string; version?: string; ours: boolean };
  /** Free bytes where the browser folder is, when known. */
  free?: number;
}

export type BrowserSetupStep =
  | { kind: 'download'; say: string; url: string; file: string; sha256?: string; sha512?: string }
  | { kind: 'run'; say: string; run: string }
  | { kind: 'verify'; say: string; file: string; sha256: string }
  | { kind: 'config'; say: string; executablePath: string; sha256: string };

export type BrowserSetupRefusal = 'os' | 'no-build' | 'done' | 'space';

export interface BrowserSetupOffer {
  target: BrowserSetupTarget;
  user: string;
  /** The browser folder, where the steps run. */
  dir: string;
  steps: BrowserSetupStep[];
  /** One line per step, exactly as shown and confirmed. */
  lines: string[];
  /** About how much disk it needs while it runs. */
  needBytes: number;
  refusal?: BrowserSetupRefusal;
  /** Set when there is nothing to run: why. */
  why?: string;
}

/** sha512 integrity (base64) as hex, as sha512sum prints it. */
export function integrityHex(integrity: string): string {
  const b64 = integrity.replace(/^sha512-/, '');
  const bin = atob(b64);
  let out = '';
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return out;
}

/** Single quotes when the text has anything a shell would read. */
export function shQuote(s: string): string {
  return /^[\w.,=+@:/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/\/+$/, '')}/${rel}`;
}

/** The exact line the owner sees and confirms for a step. */
export function stepLine(s: BrowserSetupStep): string {
  switch (s.kind) {
    case 'download':
      return `download ${s.url} to ${s.file}, check ${s.sha512 ? `sha512 ${s.sha512}` : `sha256 ${s.sha256}`}`;
    case 'verify':
      return `check ${s.file} sha256 ${s.sha256}`;
    case 'config':
      return `set browser.cloak.executablePath ${s.executablePath} and browser.cloak.sha256 ${s.sha256}`;
    case 'run':
      return s.run;
  }
}

/** Where the pinned playwright-core goes, inside the browser folder. */
export const PLAYWRIGHT_REL = 'node_modules/playwright-core';
/** Where Playwright's Chromium goes, inside the browser folder (PLAYWRIGHT_BROWSERS_PATH). */
export const BROWSERS_REL = 'ms-playwright';

function playwrightSteps(): BrowserSetupStep[] {
  const tgz = `playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz`;
  return [
    {
      kind: 'download',
      say: `Downloads playwright-core ${PLAYWRIGHT_CORE_VERSION} from the npm registry and checks it against the sha512 in Conclave's lockfile.`,
      url: PLAYWRIGHT_CORE_URL,
      file: tgz,
      sha512: integrityHex(PLAYWRIGHT_CORE_INTEGRITY),
    },
    {
      kind: 'run',
      say: `Unpacks it into ${PLAYWRIGHT_REL}, where the hub loads it from.`,
      run: `rm -rf ${PLAYWRIGHT_REL} && mkdir -p ${PLAYWRIGHT_REL} && tar -xzf ${tgz} -C ${PLAYWRIGHT_REL} --strip-components=1 && rm -f ${tgz}`,
    },
  ];
}

/**
 * The steps for one engine, in order: playwright-core first when the hub has
 * none, then the browser. Empty with a refusal when nothing can or needs to run.
 */
export function browserSetupOffer(target: BrowserSetupTarget, f: BrowserSetupFacts): BrowserSetupOffer {
  const steps: BrowserSetupStep[] = [];
  let need = 0;
  const offer = (extra: Partial<BrowserSetupOffer> = {}): BrowserSetupOffer => ({
    target,
    user: f.user,
    dir: f.dir,
    steps,
    lines: steps.map(stepLine),
    needBytes: need,
    ...extra,
  });
  const refuse = (refusal: BrowserSetupRefusal, why: string) => {
    steps.length = 0;
    need = 0;
    return offer({ refusal, why });
  };
  if (f.platform === 'win32') return refuse('os', 'Install on the hub works on Linux and macOS hubs.');
  if (target === 'cloak') {
    if (f.cloak) return refuse('done', `CloakBrowser${f.cloak.version ? ` ${f.cloak.version}` : ''} is installed.`);
    if (f.platform !== 'linux' || f.arch !== 'x64') return refuse('no-build', 'Conclave pins a CloakBrowser build for Linux x64 only. On this machine, install CloakBrowser yourself and set browser.cloak.executablePath.');
  } else if (f.chromium) return refuse('done', `Chromium${f.chromium.version ? ` ${f.chromium.version}` : ''} is installed.`);

  if (!f.playwright) {
    steps.push(...playwrightSteps());
    need += NEED_BYTES.playwright;
  }
  const pwDir = f.playwright ? f.playwright.dir : joinPath(f.dir, PLAYWRIGHT_REL);
  if (target === 'chromium') {
    const browsers = joinPath(f.dir, BROWSERS_REL);
    const version = f.playwright?.version ?? PLAYWRIGHT_CORE_VERSION;
    steps.push({
      kind: 'run',
      say:
        version === PLAYWRIGHT_CORE_VERSION && f.platform === 'linux' && f.arch === 'x64'
          ? `Installs Chromium ${PLAYWRIGHT_CHROMIUM_VERSION} with Playwright's own installer, from ${PLAYWRIGHT_CHROMIUM_URL}, into ${BROWSERS_REL}.`
          : `Installs the Chromium that playwright-core ${version} pins, with Playwright's own installer, into ${BROWSERS_REL}.`,
      // BUN_BE_BUN makes the hub's own binary act as bun, so no Node.js is needed
      run: `env PLAYWRIGHT_BROWSERS_PATH=${shQuote(browsers)} BUN_BE_BUN=1 ${shQuote(f.runtime)} ${shQuote(joinPath(pwDir, 'cli.js'))} install --no-shell chromium`,
    });
    need += NEED_BYTES.chromium;
  } else {
    const partial = `${CLOAK_DIR}.partial`;
    steps.push(
      {
        kind: 'download',
        say: `Downloads CloakBrowser ${CLOAK_VERSION} for Linux x64 from CloakHQ's release on GitHub and checks it against the sha256 in its signed SHA256SUMS.`,
        url: CLOAK_ARCHIVE_URL,
        file: CLOAK_ARCHIVE,
        sha256: CLOAK_ARCHIVE_SHA256,
      },
      {
        kind: 'run',
        say: `Unpacks it next to its final folder.`,
        run: `rm -rf ${partial} && mkdir -p ${partial} && tar -xzf ${CLOAK_ARCHIVE} -C ${partial} && rm -f ${CLOAK_ARCHIVE}`,
      },
      { kind: 'verify', say: 'Checks the chrome binary in it against its pinned sha256.', file: `${partial}/chrome`, sha256: CLOAK_CHROME_SHA256 },
      { kind: 'run', say: `Moves it to ${CLOAK_DIR}.`, run: `rm -rf ${CLOAK_DIR} && mv ${partial} ${CLOAK_DIR}` },
      {
        kind: 'config',
        say: 'Points browser.cloak.executablePath at it and pins browser.cloak.sha256, so the hub refuses a changed binary.',
        executablePath: joinPath(f.dir, `${CLOAK_DIR}/chrome`),
        sha256: CLOAK_CHROME_SHA256,
      },
    );
    need += NEED_BYTES.cloak;
  }
  if (f.free !== undefined && f.free < need) {
    const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
    return refuse('space', `The hub's disk has ${mb(f.free)} free where the browser goes (${f.dir}). This needs about ${mb(need)} while it installs.`);
  }
  return offer();
}

/** True when the offer has steps the button can run. */
export function canRunBrowserSetup(o: BrowserSetupOffer | undefined): boolean {
  return !!o && o.steps.length > 0 && !o.refusal;
}
