/**
 * Mock routes for Settings > Browser (routes-browser.ts): the hub as the
 * owner found it on a Proxmox LXC, with no browser installed. Install on the
 * hub walks through the real steps (the plan is core's own,
 * browser/setup-plan.ts) and ends installed, with the system libraries and
 * fonts a fresh Debian CT missed. Without the root helper the page shows
 * its two choices and where to run them; with ?helper=1 it shows Install
 * system libraries, which ends Ready. ?browser=cloak starts with CloakBrowser
 * in, ?ctid=0 hides the CT id. The proxy saves DataImpulse settings and Test
 * answers an exit IP for the country asked.
 */
import type { BrowserEngineDto, BrowserLibsDto, BrowserLibsResult, BrowserProxySettingsDto, BrowserProxyUpdate, BrowserSetupResult, BrowserStatusDto, RootHelperDto } from '@conclave/core/client';
import { browserSetupOffer, CLOAK_VERSION, PLAYWRIGHT_CHROMIUM_VERSION, PLAYWRIGHT_CORE_VERSION, stepLine, type BrowserSetupFacts } from '@conclave/core/browser/setup-plan';
import { aptCommand, aptPackages } from '@conclave/core/browser/packages';
import { countryCode, countryLabel } from '@conclave/core/browser/proxy-provider';
import { BROWSER_DEPS_SAY, rootHelperLine } from '@conclave/core/system/root-helper';
import type { MockCtx } from './index';
import { browserLoginsState, registerBrowserLogins, withLogins } from './browserLogins';

const DIR = '/var/lib/conclave/browser';
const DAY = 86_400_000;
/** What ldd said on a fresh Debian CT after CloakBrowser went in, plus no fonts. */
const MISSING = ['libX11.so.6', 'libXcomposite.so.1', 'libXdamage.so.1', 'libXext.so.6', 'libXfixes.so.3', 'libXrandr.so.2', 'libasound.so.2', 'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libcups.so.2', 'libgbm.so.1', 'libnss3.so', 'libpango-1.0.so.0', 'libxkbcommon.so.0'].sort();

/** ?helper=1 (the root helper is installed), ?browser=cloak (CloakBrowser is in), ?ctid=0 (the CT id is not known). */
function flag(name: string): string | null {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(name);
  } catch {
    return null;
  }
}

export interface MockBrowserOptions {
  /** The root helper is installed and sudo lets the hub run it. */
  helper?: boolean;
  /** CloakBrowser is installed already. */
  installed?: boolean;
  /** Use the member-shaped status, without the owner's profiles or setup. */
  member?: boolean;
  /** The Proxmox CT id the hub found, or none. */
  ctid?: string | null;
}

export function registerBrowser(ctx: MockCtx, opts: MockBrowserOptions = {}) {
  const { on, fail, sleep, FRESH } = ctx;
  const member = opts.member ?? flag('member') === '1';
  const helperOn = opts.helper ?? flag('helper') === '1';
  const ctidFlag = flag('ctid');
  const ctid = opts.ctid !== undefined ? opts.ctid : ctidFlag === '0' ? null : (ctidFlag ?? '135');
  const startCloak = opts.installed ?? flag('browser') === 'cloak';
  const installed = { playwright: startCloak, chromium: false, cloak: startCloak };
  let libsDone = false;
  const install = 'conclave system-helper install';

  const libs = (): BrowserLibsDto => {
    if (libsDone) return { missing: [], noFonts: false, packages: [] };
    const packages = aptPackages(MISSING, { id: 'debian', versionId: '12' }, { fonts: true });
    const helper: RootHelperDto = helperOn ? { installed: true, ready: true, install } : { installed: false, ready: false, install };
    return {
      missing: MISSING,
      noFonts: true,
      packages,
      command: aptCommand(packages),
      place: { kind: 'lxc', ...(ctid ? { ctid } : {}) },
      helper,
      ...(helper.ready ? { setup: { say: BROWSER_DEPS_SAY, lines: [rootHelperLine('browser-deps')] } } : {}),
    };
  };
  // default never ran, so it follows the engine new profiles get; marketplace ran on Chromium
  const engineOf = new Map<string, 'chromium' | 'cloak'>();
  const proxy: BrowserProxySettingsDto = FRESH
    ? { provider: 'none', dataimpulse: { host: 'gw.dataimpulse.com', port: 823, login: false, password: false }, custom: { password: false } }
    : { provider: 'dataimpulse', dataimpulse: { host: 'gw.dataimpulse.com', port: 823, login: true, password: true, country: 'JP' }, custom: { password: false } };

  const facts = (): BrowserSetupFacts => ({
    platform: 'linux',
    arch: 'x64',
    user: 'conclave',
    dir: DIR,
    runtime: '/opt/conclave/bin/conclave',
    free: 18e9,
    ...(installed.playwright ? { playwright: { version: PLAYWRIGHT_CORE_VERSION, dir: `${DIR}/node_modules/playwright-core`, where: 'hub' as const } } : {}),
    ...(installed.chromium ? { chromium: { path: `${DIR}/ms-playwright/chromium-1248/chrome-linux64/chrome`, version: PLAYWRIGHT_CHROMIUM_VERSION, where: 'hub' as const } } : {}),
    ...(installed.cloak ? { cloak: { path: `${DIR}/cloakbrowser/chromium-${CLOAK_VERSION}/chrome`, version: CLOAK_VERSION, ours: true } } : {}),
  });

  // saved logins, Forget and Delete profile (mock/browserLogins.ts) go on top of these profiles
  const logins = browserLoginsState(FRESH || member);
  const bare = (): BrowserStatusDto => {
    if (member) return {
      available: installed.playwright && (installed.chromium || installed.cloak),
      profiles: [{ name: 'default', engine: 'chromium', label: 'Your browser on the hub', open: false, sites: [], isDefault: true }],
    };
    const f = facts();
    const engines: BrowserEngineDto[] = [
      { engine: 'cloak', label: 'CloakBrowser', installed: !!f.cloak, ...(f.cloak ? { version: f.cloak.version, path: f.cloak.path, where: 'hub' as const } : {}), setup: browserSetupOffer('cloak', f) },
      { engine: 'chromium', label: 'Chromium', installed: !!f.chromium, ...(f.chromium ? { version: f.chromium.version, path: f.chromium.path, where: 'hub' as const } : {}), setup: browserSetupOffer('chromium', f) },
    ];
    const any = installed.chromium || installed.cloak;
    const names = FRESH ? ['default'] : ['default', 'marketplace'];
    if (!FRESH && !engineOf.has('marketplace')) engineOf.set('marketplace', 'chromium');
    return {
      available: installed.playwright && any,
      ...(installed.playwright && any ? {} : { reason: 'No browser is installed on this hub yet. The owner can install one in Settings, Browser, Engines.' }),
      profiles: names.map((name) => {
        const engine = engineOf.get(name) ?? (installed.cloak ? 'cloak' : 'chromium');
        return {
          name,
          engine,
          label: engine === 'cloak' ? 'CloakBrowser' : 'Chromium',
          open: false,
          sites: name === 'marketplace' ? [{ host: 'facebook.com', at: Date.now() - 2 * DAY }] : [],
          folder: name === 'marketplace',
          engineSet: engineOf.has(name),
        };
      }),
      playwright: installed.playwright ? { installed: true, version: PLAYWRIGHT_CORE_VERSION, where: 'hub' } : { installed: false },
      engines,
      ...(any ? { libs: libs() } : {}),
      proxy: { ...proxy, dataimpulse: { ...proxy.dataimpulse }, custom: { ...proxy.custom } },
      newProfileEngine: installed.cloak ? 'cloak' : 'chromium',
      dir: DIR,
    };
  };

  const status = (): BrowserStatusDto => withLogins(bare(), logins);
  registerBrowserLogins(ctx, status, logins);

  on('GET', '/api/browser', () => status());

  on('POST', '/api/browser/setup', async ({ body }: { body?: { target?: 'chromium' | 'cloak'; steps?: string[] } }) => {
    const target = body?.target;
    if (target !== 'chromium' && target !== 'cloak') fail(400, 'target must be chromium or cloak');
    const offer = browserSetupOffer(target!, facts());
    if (!offer.steps.length) fail(409, offer.why ?? 'Nothing to install.');
    if (JSON.stringify(body?.steps) !== JSON.stringify(offer.lines)) fail(409, 'What it would run changed since you looked. Check the steps again.');
    await sleep(1600);
    const tail = offer.steps
      .map((s) => `$ ${stepLine(s)}\n${s.kind === 'download' ? `${s.sha512 ? 14 : 217} MB, ${s.sha512 ? 'sha512' : 'sha256'} matches` : s.kind === 'verify' ? 'sha256 matches' : s.kind === 'config' ? 'browser.cloak is set' : target === 'chromium' && s.run.includes('cli.js') ? `Downloading Chrome for Testing ${PLAYWRIGHT_CHROMIUM_VERSION} (playwright chromium v1248) from https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/linux64/chrome-linux64.zip\n|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 173.2 MiB\nChrome for Testing ${PLAYWRIGHT_CHROMIUM_VERSION} (playwright chromium v1248) downloaded to ${DIR}/ms-playwright/chromium-1248` : ''}`)
      .join('\n');
    installed.playwright = true;
    installed[target!] = true;
    const r: BrowserSetupResult = { ok: true, target: target!, ran: offer.lines, tail, durationMs: 94_000 };
    return r;
  });

  on('POST', '/api/browser/libs', async ({ body }: { body?: { steps?: string[] } }) => {
    const l = libs();
    if (!l.missing.length && !l.noFonts) fail(409, 'Nothing is missing: the browser has every library it needs.');
    if (!l.setup) fail(409, `The root helper is not installed. Once, as root on the hub's machine: ${install}`);
    if (JSON.stringify(body?.steps) !== JSON.stringify(l.setup!.lines)) fail(409, 'What it would run changed since you looked. Check the step again.');
    await sleep(1400);
    libsDone = true;
    const r: BrowserLibsResult = {
      ok: true,
      ran: l.setup!.lines,
      tail: [
        `$ ${l.setup!.lines[0]}`,
        `Installing for the browser on Debian GNU/Linux 12 (bookworm): ${l.packages.join(' ')}`,
        'Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]',
        'Fetched 9,212 kB in 2s (4,606 kB/s)',
        `The following NEW packages will be installed: ${l.packages.slice(0, 8).join(' ')} ...`,
        '0 upgraded, 61 newly installed, 0 to remove and 0 not upgraded.',
        'Need to get 47.9 MB of archives. After this operation, 152 MB of additional disk space will be used.',
        'Done.',
      ].join('\n'),
      durationMs: 52_000,
      ready: true,
    };
    return r;
  });

  on('PUT', '/api/browser/profiles/:name',({ params, body }: { params: string[]; body?: { engine?: 'chromium' | 'cloak' } }) => {
    if (body?.engine !== 'chromium' && body?.engine !== 'cloak') fail(400, 'engine must be chromium or cloak');
    if (body?.engine === 'cloak' && !installed.cloak) fail(409, 'CloakBrowser is not installed on this hub. Install it first.');
    engineOf.set(decodeURIComponent(params[0]), body!.engine!);
    return status();
  });

  on('PUT', '/api/browser/proxy', ({ body }: { body?: BrowserProxyUpdate }) => {
    if (!body || !['none', 'dataimpulse', 'custom'].includes(body.provider)) fail(400, 'provider must be none, dataimpulse or custom');
    proxy.provider = body!.provider;
    const d = body!.dataimpulse;
    if (d) {
      if (d.login) proxy.dataimpulse.login = true;
      if (d.password) proxy.dataimpulse.password = true;
      if (d.country !== undefined) {
        if (d.country === null || d.country === '') delete proxy.dataimpulse.country;
        else {
          const cc = countryCode(d.country);
          if (!cc) fail(400, `"${d.country}" is not a country. Use a two-letter code such as JP.`);
          proxy.dataimpulse.country = cc;
        }
      }
      if (d.host) proxy.dataimpulse.host = d.host;
      if (d.port) proxy.dataimpulse.port = d.port;
    }
    const c = body!.custom;
    if (c?.url !== undefined) proxy.custom.url = c.url ?? undefined;
    if (c?.password) proxy.custom.password = true;
    delete proxy.problem;
    if (proxy.provider === 'dataimpulse' && (!proxy.dataimpulse.login || !proxy.dataimpulse.password)) proxy.problem = 'Save the DataImpulse login and password.';
    return status();
  });

  on('POST', '/api/browser/proxy/test', async ({ body }: { body?: { country?: string } }) => {
    if (proxy.provider === 'none') fail(409, 'No proxy is set up on this hub. The owner can add one in Settings, Browser, Proxy.');
    const asked = body?.country?.trim();
    const cc = asked ? countryCode(asked) : proxy.provider === 'dataimpulse' ? proxy.dataimpulse.country : undefined;
    if (asked && !cc) fail(409, `"${asked}" is not a country the hub knows. Use a two-letter code such as JP.`);
    if (asked && proxy.provider === 'custom') fail(409, 'The hub\'s proxy is a custom one with no country choice.');
    await sleep(700);
    const ip = cc === 'JP' ? '126.209.14.83' : cc === 'DE' ? '91.64.122.7' : '203.0.113.44';
    return { ok: true, proxy: proxy.provider === 'dataimpulse' ? `DataImpulse${cc ? `, ${countryLabel(cc)}` : ''}` : (proxy.custom.url ?? 'custom'), ip, country: cc ?? 'US', ms: 812 };
  });
}
