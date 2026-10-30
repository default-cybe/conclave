/**
 * A member's own proxy (docs/design/ACCOUNTS.md 2): the settings in kv under
 * their account's keys (acct:<id>:proxy), the login and password in their
 * own secrets file (values, the PROXY_SECRETS names). WebFetch and WebSearch
 * retry a blocked request through it (tools/blocked.ts); the hub's proxy is
 * never theirs. The proxy host must be a public one: a member never reaches
 * the hub's own network through it.
 */
import type { KvRepo } from '../storage/repos';
import type { AccountSecrets } from '../people/secrets';
import { accountKv } from '../people/scoped';
import { checkPublicHost } from '../people/net';
import { parseProxyUrl } from './proxy-list';
import type { MemberProxyDto, MemberProxyUpdate } from '../tools/search-providers';
import { countryCode, DATAIMPULSE_HOST, PROXY_SECRETS, type BrowserProxyConfig, type SecretReader } from './proxy-provider';

const KEY = 'proxy';

export class MemberProxyError extends Error {}

export type { MemberProxyDto, MemberProxyUpdate };

type Secrets = Pick<AccountSecrets, 'value' | 'set'>;

export function memberProxyConfig(kv: KvRepo, accountId: string): BrowserProxyConfig | undefined {
  return accountKv(kv, accountId).get<BrowserProxyConfig | undefined>(KEY, undefined);
}

/** Reads the ${secret:name} refs of a member's proxy from their own secrets file only. */
export function memberProxyReader(secrets: Secrets, accountId: string): SecretReader {
  return (name) => secrets.value(accountId, name);
}

export function memberProxy(kv: KvRepo, secrets: Secrets, accountId: string): MemberProxyDto {
  const cfg = memberProxyConfig(kv, accountId);
  const read = memberProxyReader(secrets, accountId);
  if (cfg?.provider === 'dataimpulse')
    return { provider: 'dataimpulse', ...(cfg.dataimpulse?.country ? { country: cfg.dataimpulse.country } : {}), loginSet: !!read(PROXY_SECRETS.dataimpulseLogin), passwordSet: !!read(PROXY_SECRETS.dataimpulsePassword) };
  if (cfg?.provider === 'custom') return { provider: 'custom', ...(cfg.custom?.url ? { url: cfg.custom.url } : {}), loginSet: false, passwordSet: !!read(PROXY_SECRETS.customPassword) };
  return { provider: 'none', loginSet: false, passwordSet: false };
}

const ref = (name: string) => `\${secret:${name}}`;

function secretText(v: unknown, what: string): string | undefined {
  if (v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 512) throw new MemberProxyError(`${what} must be text up to 512 characters.`);
  return v;
}

export async function setMemberProxy(kv: KvRepo, secrets: Secrets, accountId: string, body: MemberProxyUpdate, resolve?: (host: string) => Promise<string[]>): Promise<MemberProxyDto> {
  if (!['none', 'dataimpulse', 'custom'].includes(body?.provider as string)) throw new MemberProxyError('provider must be none, dataimpulse or custom.');
  const own = accountKv(kv, accountId);
  const setSecret = (name: string, v: unknown, what: string) => {
    if (v !== undefined) secrets.set(accountId, 'values', name, secretText(v, what));
  };
  if (body.provider === 'none') {
    own.delete(KEY);
    for (const n of Object.values(PROXY_SECRETS)) secrets.set(accountId, 'values', n, undefined);
    return memberProxy(kv, secrets, accountId);
  }
  if (body.provider === 'dataimpulse') {
    let country: string | undefined;
    if (body.country) {
      country = countryCode(String(body.country));
      if (!country) throw new MemberProxyError(`"${body.country}" is not a country. Use a two-letter code such as JP.`);
    }
    setSecret(PROXY_SECRETS.dataimpulseLogin, body.login, 'The login');
    setSecret(PROXY_SECRETS.dataimpulsePassword, body.password, 'The password');
    own.set(KEY, { provider: 'dataimpulse', dataimpulse: { host: DATAIMPULSE_HOST, login: ref(PROXY_SECRETS.dataimpulseLogin), password: ref(PROXY_SECRETS.dataimpulsePassword), ...(country ? { country } : {}) } } satisfies BrowserProxyConfig);
    return memberProxy(kv, secrets, accountId);
  }
  const url = String(body.url ?? memberProxyConfig(kv, accountId)?.custom?.url ?? '').trim().replace(/\/$/, '');
  const r = parseProxyUrl(url);
  if (!r.ok) throw new MemberProxyError(r.why);
  // a member's proxy never points into the hub's own network
  try {
    await checkPublicHost(r.proxy.host, resolve);
  } catch (err) {
    throw new MemberProxyError((err as Error).message);
  }
  setSecret(PROXY_SECRETS.customPassword, body.password, 'The password');
  const hasPassword = !!secrets.value(accountId, PROXY_SECRETS.customPassword);
  own.set(KEY, { provider: 'custom', custom: { url, ...(hasPassword ? { password: ref(PROXY_SECRETS.customPassword) } : {}) } } satisfies BrowserProxyConfig);
  return memberProxy(kv, secrets, accountId);
}
