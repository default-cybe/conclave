/**
 * The hub's proxy (browser.proxy): DataImpulse, or one custom proxy.
 *
 * The rule the owner set: the hub goes out from its own address; when a site
 * blocks it, that request is retried once through the proxy in the hub's own
 * country (tools/blocked.ts), and the owner can ask for a proxy in a chat.
 * No profile always uses it. The browser tools open a throwaway browser for
 * that session through the proxy (manager.ts), so the profiles' saved logins
 * never go through it.
 *
 * DataImpulse (from its public tutorials): an HTTP proxy at
 * gw.dataimpulse.com:823; the user name is the login, and parameters follow
 * two underscores, separated by semicolons, so a country is
 * `<login>__cr.jp`. The password is the account password. Chromium answers
 * an HTTP proxy's login itself, so this needs no relay. Login and password
 * are hub secrets, never plain config.
 *
 * Pure, with no node imports, so the web app uses it too.
 */
import { parseProxyUrl, proxyLabel, SECRET_REF, type ProxyEntry } from './proxy-list';

export const DATAIMPULSE_HOST = 'gw.dataimpulse.com';
export const DATAIMPULSE_PORT = 823;
/** Secret names Settings > Browser keeps the proxy's login in. */
export const PROXY_SECRETS = {
  dataimpulseLogin: 'browser.dataimpulse.login',
  dataimpulsePassword: 'browser.dataimpulse.password',
  customPassword: 'browser.proxy.password',
} as const;

export type ProxyProvider = 'dataimpulse' | 'custom';

/** browser.proxy */
export interface BrowserProxyConfig {
  /** Unset: no proxy, and the proxy input of the browser tools answers that none is set up. */
  provider?: ProxyProvider;
  dataimpulse?: {
    /** Default gw.dataimpulse.com. */
    host?: string;
    /** Default 823 (HTTP). */
    port?: number;
    /** ${secret:name} */
    login?: string;
    /** ${secret:name} */
    password?: string;
    /** Two-letter country for a request with no country. Unset: DataImpulse picks. */
    country?: string;
  };
  custom?: {
    /** socks5://[user@]host:port or http://[user@]host:port */
    url?: string;
    /** ${secret:name} */
    password?: string;
  };
}

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** Names people say that Intl does not give, or gives differently. */
const ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  usa: 'US',
  us: 'US',
  america: 'US',
  'united states of america': 'US',
  'the us': 'US',
  'the usa': 'US',
  'the uk': 'GB',
  korea: 'KR',
  'south korea': 'KR',
  'north korea': 'KP',
  'czech republic': 'CZ',
  holland: 'NL',
  'the netherlands': 'NL',
  uae: 'AE',
  'the uae': 'AE',
  emirates: 'AE',
  turkey: 'TR',
  türkiye: 'TR',
  'viet nam': 'VN',
  russia: 'RU',
  'ivory coast': 'CI',
  burma: 'MM',
};

let names: Map<string, string> | undefined;

/** Lower-case English country name -> two-letter code, from Intl. */
function countryNames(): Map<string, string> {
  if (names) return names;
  names = new Map();
  let dn: Intl.DisplayNames | undefined;
  try {
    dn = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return names;
  }
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try {
        name = dn.of(code);
      } catch {
        name = undefined;
      }
      if (name && name !== code && !/unknown/i.test(name)) names.set(name.toLowerCase(), code);
    }
  }
  return names;
}

/** True when the code is a country Intl knows (or a code it cannot check). */
function knownCode(code: string): boolean {
  if (code === 'GB' || code === 'US') return true;
  const m = countryNames();
  if (!m.size) return true;
  for (const c of m.values()) if (c === code) return true;
  return false;
}

/** "Japan", "jp", "JP", "the UK" -> "JP" / "GB". undefined when it is not a country. */
export function countryCode(input: string): string | undefined {
  const raw = (input ?? '').trim().replace(/\.$/, '');
  if (!raw) return undefined;
  const low = raw.toLowerCase();
  if (Object.hasOwn(ALIASES, low)) return ALIASES[low];
  if (/^[a-z]{2}$/i.test(raw)) {
    const code = raw.toUpperCase();
    return knownCode(code) ? code : undefined;
  }
  return countryNames().get(low) ?? countryNames().get(low.replace(/^the /, ''));
}

/** "Japan" for "JP", or the code itself. */
export function countryLabel(code: string): string {
  try {
    const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return n && n !== code ? n : code;
  } catch {
    return code;
  }
}

// ---------------------------------------------------------------------------
// The proxy for a request
// ---------------------------------------------------------------------------

/** The DataImpulse user name for a country: login__cr.jp, or login;cr.jp when it has parameters already. */
export function dataimpulseUser(login: string, country?: string): string {
  if (!country) return login;
  const param = `cr.${country.toLowerCase()}`;
  return login.includes('__') ? `${login};${param}` : `${login}__${param}`;
}

/** Reads a ${secret:name} the config names. */
export type SecretReader = (name: string) => string | undefined;

export interface ResolvedProxy {
  entry: ProxyEntry;
  /** What the owner and the agent see: never a login or password. */
  label: string;
  /** The country it was asked for, two letters. */
  country?: string;
}

function secretOf(ref: string | undefined, read: SecretReader): { name?: string; value?: string } {
  const name = ref ? SECRET_REF.exec(ref.trim())?.[1] : undefined;
  return { name, value: name ? read(name) : undefined };
}

/** The provider's default country, if it has one. */
export function defaultCountry(cfg: BrowserProxyConfig | undefined): string | undefined {
  return cfg?.provider === 'dataimpulse' ? cfg.dataimpulse?.country?.toUpperCase() || undefined : undefined;
}

/**
 * The proxy to use for one request, with the secrets read now. Throws a
 * sentence the agent can pass on when nothing is set up or a secret is missing.
 */
export function resolveProxy(cfg: BrowserProxyConfig | undefined, read: SecretReader, country?: string): ResolvedProxy {
  if (!cfg?.provider) throw new Error('No proxy is set up on this hub. The owner can add one in Settings, Browser, Proxy.');
  if (cfg.provider === 'dataimpulse') {
    const d = cfg.dataimpulse ?? {};
    const login = secretOf(d.login, read);
    const password = secretOf(d.password, read);
    if (!login.value || !password.value) throw new Error('The DataImpulse login or password is not saved. The owner can add them in Settings, Browser, Proxy.');
    const cc = country ?? defaultCountry(cfg);
    const host = d.host?.trim() || DATAIMPULSE_HOST;
    const port = d.port ?? DATAIMPULSE_PORT;
    return {
      entry: { scheme: 'http', host, port, username: dataimpulseUser(login.value, cc), password: password.value },
      label: `DataImpulse${cc ? `, ${countryLabel(cc)}` : ''}`,
      ...(cc ? { country: cc } : {}),
    };
  }
  const c = cfg.custom ?? {};
  const r = parseProxyUrl(c.url ?? '');
  if (!r.ok) throw new Error(`The custom proxy address is not right: ${r.why}`);
  if (country) throw new Error(`The hub's proxy is a custom one with no country choice, so it cannot go out from ${countryLabel(country)}. The owner can switch to DataImpulse in Settings, Browser, Proxy.`);
  const password = secretOf(c.password, read);
  if (c.password && !password.value) throw new Error('The custom proxy password is not saved. The owner can add it in Settings, Browser, Proxy.');
  return { entry: { ...r.proxy, ...(password.value ? { password: password.value } : {}) }, label: proxyLabel(r.proxy) };
}

// ---------------------------------------------------------------------------
// Config checks
// ---------------------------------------------------------------------------

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

/** What is wrong with browser.proxy, one sentence each. */
export function browserProxyProblems(proxy: unknown): string[] {
  if (proxy === undefined || proxy === null) return [];
  if (typeof proxy !== 'object' || Array.isArray(proxy)) return ['browser.proxy must be an object.'];
  const p = proxy as Record<string, unknown>;
  const out: string[] = [];
  const secret = (v: unknown, at: string) => {
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'string' || !SECRET_REF.test(v.trim())) out.push(`${at} must be \${secret:name}. Save it as a hub secret, not in the config.`);
  };
  if (p.provider !== undefined && p.provider !== null && p.provider !== 'dataimpulse' && p.provider !== 'custom') out.push('browser.proxy.provider must be dataimpulse or custom.');
  for (const k of Object.keys(p)) if (!['provider', 'dataimpulse', 'custom'].includes(k)) out.push(`browser.proxy.${k} is not a proxy setting.`);
  const d = p.dataimpulse;
  if (d !== undefined && d !== null) {
    if (typeof d !== 'object' || Array.isArray(d)) out.push('browser.proxy.dataimpulse must be an object.');
    else {
      const x = d as Record<string, unknown>;
      if (x.host !== undefined && x.host !== '' && (typeof x.host !== 'string' || !HOST.test(x.host))) out.push('browser.proxy.dataimpulse.host must be a host name.');
      if (x.port !== undefined && (!Number.isInteger(x.port) || (x.port as number) < 1 || (x.port as number) > 65535)) out.push('browser.proxy.dataimpulse.port must be a number from 1 to 65535.');
      secret(x.login, 'browser.proxy.dataimpulse.login');
      secret(x.password, 'browser.proxy.dataimpulse.password');
      if (x.country !== undefined && x.country !== null && x.country !== '' && (typeof x.country !== 'string' || !/^[A-Za-z]{2}$/.test(x.country) || !countryCode(x.country)))
        out.push('browser.proxy.dataimpulse.country must be a two-letter country code, such as JP.');
      for (const k of Object.keys(x)) if (!['host', 'port', 'login', 'password', 'country'].includes(k)) out.push(`browser.proxy.dataimpulse.${k} is not a DataImpulse setting.`);
    }
  }
  const c = p.custom;
  if (c !== undefined && c !== null) {
    if (typeof c !== 'object' || Array.isArray(c)) out.push('browser.proxy.custom must be an object.');
    else {
      const x = c as Record<string, unknown>;
      if (x.url !== undefined && x.url !== '') {
        const r = typeof x.url === 'string' ? parseProxyUrl(x.url) : { ok: false as const, why: 'It must be a URL.' };
        if (!r.ok) out.push(`browser.proxy.custom.url: ${r.why}`);
      }
      secret(x.password, 'browser.proxy.custom.password');
      for (const k of Object.keys(x)) if (!['url', 'password'].includes(k)) out.push(`browser.proxy.custom.${k} is not a custom proxy setting.`);
    }
  }
  if (p.provider === 'custom' && !(c as Record<string, unknown> | undefined)?.url) out.push('browser.proxy.custom.url is missing.');
  return out;
}
