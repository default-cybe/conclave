/**
 * Words for Settings > Browser: an engine's status, the proxy, a proxy test
 * and the install confirm. Pure, so tests read them.
 */
import type { BrowserEngineDto, BrowserLibsDto, BrowserLibsResult, BrowserProxySettingsDto, BrowserProxyTestDto, BrowserSetupOffer, BrowserSetupResult, HubPlaceDto } from '@conclave/core/client';

/** "Installed, 146.0.7680.177.5" or "Not installed". */
export function engineStatus(e: BrowserEngineDto): { word: string; tone: 'ok' | 'dim'; detail?: string } {
  if (!e.installed) return { word: 'Not installed', tone: 'dim' };
  const where = e.where === 'hub' ? "in the hub's browser folder" : e.where === 'config' ? 'at the path in the config' : e.where === 'system' ? 'on the machine' : e.where === 'playwright' ? "in Playwright's folder" : undefined;
  return { word: 'Installed', tone: 'ok', detail: [e.version, where].filter(Boolean).join(', ') || undefined };
}

/** One line under an engine's name. */
export function engineHelp(e: BrowserEngineDto): string {
  return e.engine === 'cloak'
    ? 'Chromium with fingerprint patches, for sites that block automated browsers. One identity per profile.'
    : 'Plain Chrome for Testing. For sites that do not mind automation, and for screenshots.';
}

/** The line at the top of the Proxy group: the owner's rule. */
export const PROXY_HELP =
  "Pages load from the hub's own address. When a site blocks that address (Reddit, a captcha, a Cloudflare check), the hub retries that request once through this proxy, in the hub's own country, and tells the assistant. You can also ask for it in a chat (\"open it through the proxy\", \"open it from Japan\"). Only your own chats use it, never another person's. A proxied page opens in a separate browser with no saved logins.";

/** The line under Provider. */
export function providerWords(p: BrowserProxySettingsDto | undefined): string {
  if (!p || p.provider === 'none') return 'No proxy. A chat that asks for one is told none is set up.';
  if (p.problem) return p.problem;
  if (p.provider === 'dataimpulse') return `DataImpulse at ${p.dataimpulse.host}:${p.dataimpulse.port}${p.dataimpulse.country ? `, ${countryName(p.dataimpulse.country)} by default` : ''}. Login and password saved as secrets.`;
  return `Custom: ${p.custom.url ?? 'no address yet'}${p.custom.password ? ', password saved' : ''}.`;
}

/** The answer of Test. */
export function testWords(r: BrowserProxyTestDto): string {
  if (!r.ok) return `${r.proxy} did not work: ${r.error ?? 'no answer'}.`;
  return `Sites see ${r.ip}${r.country ? ` in ${countryName(r.country)}` : ''} through ${r.proxy}. It took ${r.ms} ms.`;
}

/** A country code as its English name, where the browser knows it. */
export function countryName(code: string): string {
  try {
    const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    return n && n !== code.toUpperCase() ? `${n} (${code.toUpperCase()})` : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** The line at the top of the install confirm. */
export function setupConfirmWords(o: BrowserSetupOffer): string {
  const mb = Math.round(o.needBytes / 1e6);
  return `These run on the hub as ${o.user}, in ${o.dir}, without root. It needs about ${mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`} free while it runs.`;
}

export function setupResultWords(r: BrowserSetupResult, label: string): { ok: boolean; text: string } {
  if (r.ok) return { ok: true, text: `${label} is installed. Profiles that use it start with it from now on.` };
  return { ok: false, text: `The install stopped${r.failed ? ` at: ${r.failed.length > 90 ? `${r.failed.slice(0, 90)}...` : r.failed}` : ''}. Nothing after that step ran. The output is below.` };
}

/** The warning when the browsers miss system libraries or fonts. */
export function libsWords(l: BrowserLibsDto | undefined): string | undefined {
  if (!l || (!l.missing.length && !l.noFonts)) return undefined;
  const what = [l.missing.length ? `${l.missing.length === 1 ? 'a system library' : 'system libraries'} it cannot find (${l.missing.join(', ')})` : '', l.noFonts ? 'fonts' : ''].filter(Boolean).join(' and ');
  if (l.docker) return `The browser needs ${what}, and this Docker image does not have them. Build the image with --build-arg BROWSER=1, then start the hub again.`;
  if (l.setup) return `The browser needs ${what}. The hub can install them itself with its root helper.`;
  if (l.helper?.problem) return `The browser needs ${what}. The root helper cannot do it now: ${l.helper.problem}`;
  return `The browser needs ${what}. Adding them takes root, once. Pick one:`;
}

/** "in the hub's container" or "on the hub's VM": where a root command runs. */
export function placeWords(place: HubPlaceDto | undefined): string {
  switch (place?.kind) {
    case 'lxc':
    case 'container':
    case 'docker':
      return "in the hub's container";
    case 'vm':
      return "on the hub's VM";
    default:
      return "on the hub's machine";
  }
}

/** How to get to a root shell where the hub runs, with the install command as the example. */
export function whereWords(place: HubPlaceDto | undefined, install: string): { text: string; example?: string; hint?: string } {
  switch (place?.kind) {
    case 'lxc': {
      const id = place.ctid;
      return {
        text: `Run these as root inside the hub's container${id ? ` (CT ${id})` : ''}, not on the Proxmox host. From the Proxmox host shell, put pct exec ${id ?? '<CTID>'} -- in front:`,
        example: `pct exec ${id ?? '<CTID>'} -- ${install}`,
        hint: id ? `Or open the Console of CT ${id} in the Proxmox web UI and run them there.` : "<CTID> is the container's number in Proxmox, for example 135. Or open the container's Console in the Proxmox web UI and run them there.",
      };
    }
    case 'container':
    case 'docker':
      return { text: "Run these as root inside the hub's container, not on the machine that hosts it." };
    case 'vm':
      return { text: "Run these as root on the hub's VM, not on the machine that hosts it. With sudo, put sudo in front." };
    default:
      return { text: 'Run these as root on the machine the hub runs on. With sudo, put sudo in front.' };
  }
}

export interface LibsChoice {
  title: string;
  text: string;
  command: string;
}

/** The two ways when the hub cannot add the libraries itself: the root helper once, or the apt-get line by hand. */
export function libsChoices(l: BrowserLibsDto | undefined): LibsChoice[] {
  if (!l || l.docker || l.setup || (!l.missing.length && !l.noFonts)) return [];
  const where = placeWords(l.place);
  const out: LibsChoice[] = [];
  if (l.helper)
    out.push({
      title: l.helper.installed ? 'Install the root helper again' : 'Let the hub do it',
      text: `Once, as root ${where}. The hub then installs these, and other system packages it needs later, by itself.`,
      command: l.helper.install,
    });
  if (l.command) out.push({ title: out.length ? 'Or install them yourself' : 'Install them yourself', text: `As root ${where}:`, command: l.command });
  return out;
}

/** The line at the top of the Install system libraries confirm. */
export function libsConfirmWords(l: BrowserLibsDto): string {
  return l.helper?.asRoot
    ? 'The hub runs as root, so it runs the root helper itself. The helper installs the packages built into it and takes nothing else from the hub. About 150 MB.'
    : 'The hub runs this through sudo. Only the root helper runs as root: it installs the packages built into it and takes nothing else from the hub. About 150 MB.';
}

/** The answer after Install system libraries. */
export function libsResultWords(r: BrowserLibsResult): { tone: 'ok' | 'warn' | 'fault'; text: string } {
  if (!r.ok) return { tone: 'fault', text: `It stopped${r.failed ? ` at: ${r.failed}` : ''}. Nothing else ran. The output is below.` };
  if (r.ready) return { tone: 'ok', text: 'Ready. The browser has every library it needs.' };
  const left = [...(r.libs?.missing ?? []), ...(r.libs?.noFonts ? ['fonts'] : [])];
  return { tone: 'warn', text: `The helper finished, but the browser still misses ${left.join(', ') || 'something'}. The output is below.` };
}

/** The engine a new profile gets, for the Profiles help line. */
export function newProfileWords(engine: 'chromium' | 'cloak' | undefined): string {
  return engine === 'cloak' ? 'New profiles run on CloakBrowser.' : 'New profiles run on Chromium. Install CloakBrowser and new ones run on it.';
}
