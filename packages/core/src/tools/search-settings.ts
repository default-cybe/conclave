/**
 * Settings > Web search on the hub: the owner's choice, the SearXNG address,
 * each engine's key and the Test button. A key is a hub secret named
 * search.<id> (${secret:search.brave}); it never goes in config.json and no
 * reply carries it, only whether one is set. The engine list is in
 * search-providers.ts.
 */
import type { ConfigStore } from '../config';
import type { AccountSecrets } from '../people/secrets';
import { activeEngine, engineKeys, providerForKey, searchOnce, SearchHttpError, searxngUrl, type SearchKeys } from './websearch';
import { SEARCH_PROVIDERS, type SearchChoice, type SearchKeyDto, type SearchProviderInfo, type WebSearchKeysPatch, type WebSearchKeyUpdate, type WebSearchSettingsDto, type WebSearchSettingsPatch, type WebSearchTestResult } from './search-providers';
import { classifyKeyError, editKeys, keyLast4, KeyListError, keyPool, memoryMeta, readKeys, type KeyMetaStore, type PoolKey, type SecretSlots } from './search-keys';

const CHOICES: SearchChoice[] = ['auto', ...SEARCH_PROVIDERS.map((p) => p.id)];

type SearchConfig = Pick<ConfigStore, 'get' | 'getUser' | 'replace' | 'setSecret' | 'secretValue'>;

export class SearchSettingsError extends Error {}

export const searchSecretName = (id: string) => `search.${id}`;

/** The first saved key of an engine (key 1), for code that needs only one. */
export const savedSearchKey = (config: Pick<ConfigStore, 'secretValue'>) => (id: string) => config.secretValue(searchSecretName(id));

/**
 * One account's search keys: the secrets they live in and the kv that holds
 * their labels and marks. A hub without a database (tests) keeps labels and
 * marks in memory, one store per config.
 */
export interface SearchKeyStore {
  slots: SecretSlots;
  meta: KeyMetaStore;
}

const memoryByConfig = new WeakMap<object, KeyMetaStore>();

/** The hub's (the owner's) keys, in secrets.json values. meta: the owner's kv; left out, memory. */
export function hubKeyStore(config: Pick<ConfigStore, 'setSecret' | 'secretValue'>, meta?: KeyMetaStore): SearchKeyStore {
  let m = meta ?? memoryByConfig.get(config);
  if (!m) memoryByConfig.set(config, (m = memoryMeta()));
  return { slots: { get: (n) => config.secretValue(n), set: (n, v) => config.setSecret('values', n, v) }, meta: m };
}

/** A member's own keys, in their own secrets file, with labels and marks in their own kv. */
export function memberKeyStore(secrets: Pick<AccountSecrets, 'value' | 'set'>, accountId: string, meta: KeyMetaStore): SearchKeyStore {
  return { slots: { get: (n) => secrets.value(accountId, n), set: (n, v) => secrets.set(accountId, 'values', n, v) }, meta };
}

export const storeKeys = (s: SearchKeyStore, own?: boolean): SearchKeys => ({ pool: keyPool(s.slots, s.meta), ...(own ? { own } : {}) });

function keyDto(k: PoolKey): SearchKeyDto {
  return { ...(k.label ? { label: k.label } : {}), last4: keyLast4(k.key), status: k.mark?.status ?? 'working', ...(k.mark?.until ? { until: k.mark.until } : {}) };
}

function keyFrom(config: SearchConfig, store: SearchKeyStore, p: SearchProviderInfo): 'hub' | 'config' | 'env' | undefined {
  if (p.needs !== 'key') return undefined;
  if (store.slots.get(searchSecretName(p.id))) return 'hub';
  const cfg = config.get().search;
  const configured = cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
  // the same rule as websearch.ts keyFor: a configured key is the chosen engine's, or in auto the one its prefix names
  if (configured && (cfg.provider === p.id || (cfg.provider === 'auto' && providerForKey(configured) === p.id))) return 'config';
  if (p.env?.some((e) => process.env[e])) return 'env';
  return undefined;
}

export function searchSettings(config: SearchConfig, store = hubKeyStore(config)): WebSearchSettingsDto {
  const cfg = config.get().search;
  const url = searxngUrl(cfg);
  const keys = storeKeys(store);
  return {
    chosen: cfg.provider ?? 'auto',
    active: activeEngine(cfg, keys),
    ...(url ? { url, urlFrom: cfg.url ? ('config' as const) : ('env' as const) } : {}),
    providers: SEARCH_PROVIDERS.map((p) => {
      const from = keyFrom(config, store, p);
      return { ...p, keySet: !!from, ...(from ? { keyFrom: from } : {}), keys: from === 'hub' ? keys.pool.list(p.id).map(keyDto) : [] };
    }),
  };
}

export function patchSearchSettings(config: SearchConfig, p: WebSearchSettingsPatch, store = hubKeyStore(config)): WebSearchSettingsDto {
  const user = structuredClone(config.getUser());
  const next = { ...(user.search ?? { provider: 'auto' as const }) };
  if (p.provider !== undefined) {
    if (!CHOICES.includes(p.provider)) throw new SearchSettingsError(`provider must be one of ${CHOICES.join(', ')}.`);
    next.provider = p.provider;
  }
  if (p.url !== undefined) {
    const u = p.url?.trim();
    if (!u) delete next.url;
    else {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        throw new SearchSettingsError('That is not a web address. It looks like http://searxng.lan:8080.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new SearchSettingsError('The SearXNG address must start with http:// or https://.');
      // config.json is not a secret store, and the hub adds its own /search?q=
      if (parsed.username || parsed.password) throw new SearchSettingsError('Leave the user name and password out of the SearXNG address.');
      if (parsed.search || parsed.hash) throw new SearchSettingsError('Leave the ? and # parts out of the SearXNG address.');
      next.url = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }
  }
  config.replace({ ...user, search: next });
  return searchSettings(config, store);
}

/** A key for one engine, trimmed and checked; undefined removes it. */
function checkedKey(id: string, key: string | null): string | undefined {
  const p = SEARCH_PROVIDERS.find((x) => x.id === id);
  if (!p || p.needs !== 'key') throw new SearchSettingsError(`${id} takes no key. Keys go with ${SEARCH_PROVIDERS.filter((x) => x.needs === 'key').map((x) => x.id).join(', ')}.`);
  const k = key?.trim();
  if (k && !/^\S{8,512}$/.test(k)) throw new SearchSettingsError(`That does not look like a ${p.name} key: it is one word of at least 8 characters, with no spaces.`);
  return k || undefined;
}

/** Run a list change, with its refusal in the words the routes send back. */
function edit(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof KeyListError) throw new SearchSettingsError(err.message);
    throw err;
  }
}

/** PUT /api/websearch/key on one account's keys: add, replace or remove one key, or (no index) replace key 1 or remove them all. */
export function updateSearchKey(store: SearchKeyStore, u: WebSearchKeyUpdate): void {
  const key = checkedKey(u.provider, u.key);
  if (u.index !== undefined && (typeof u.index !== 'number' || !Number.isInteger(u.index))) throw new SearchSettingsError('index must be a whole number.');
  if (u.label !== undefined && typeof u.label !== 'string') throw new SearchSettingsError('label must be text.');
  edit(() => {
    const n = readKeys(store.slots, u.provider).length;
    if (!key) editKeys(store.slots, store.meta, u.provider, { remove: u.index ?? 'all' });
    else if (u.add || (u.index === undefined && n === 0)) editKeys(store.slots, store.meta, u.provider, { add: key, label: u.label });
    else editKeys(store.slots, store.meta, u.provider, { replace: u.index ?? 0, key, label: u.label });
  });
}

/** PATCH /api/websearch/keys: reorder an engine's keys, or relabel one. */
export function patchSearchKeys(store: SearchKeyStore, p: WebSearchKeysPatch): void {
  checkedKey(p.provider, null);
  edit(() => {
    if (p.order !== undefined) {
      if (!Array.isArray(p.order) || p.order.some((i) => typeof i !== 'number')) throw new KeyListError('order must be a list of key indexes.');
      editKeys(store.slots, store.meta, p.provider, { order: p.order });
    } else if (typeof p.index === 'number') editKeys(store.slots, store.meta, p.provider, { relabel: p.index, label: typeof p.label === 'string' ? p.label : undefined });
    else throw new KeyListError('Send order, or index with a label.');
  });
}

/** Save a key (trimmed) as an engine's key 1, or remove all its keys with null. */
export function setSearchKey(config: SearchConfig, id: string, key: string | null, store = hubKeyStore(config)): WebSearchSettingsDto {
  updateSearchKey(store, { provider: id, key });
  return searchSettings(config, store);
}

// ---------------------------------------------------------------------------
// A member's own web search (docs/design/ACCOUNTS.md 6): their own keys first,
// the hub's only when the owner allows it, else DuckDuckGo, which needs no key.
// Never the hub's env vars, config key or SearXNG address.
// ---------------------------------------------------------------------------

/** The keys a member's WebSearch rotates through: their own when they saved any, else the hub's when the owner allows it, else none (DuckDuckGo). */
export function memberSearchKeys(own: SearchKeyStore, hub: SearchKeyStore, hubAllowed: boolean): SearchKeys {
  const mine = storeKeys(own, true);
  if (hubAllowed && !SEARCH_PROVIDERS.some((p) => p.needs === 'key' && mine.pool.list(p.id).length)) return storeKeys(hub);
  return mine;
}

/** A member's Settings > Web search: their own keys, and whether the hub's search is theirs to use. Nothing of the hub's keys or address. */
export function memberSearchSettings(config: SearchConfig, own: SearchKeyStore, hubAllowed: boolean, hub = hubKeyStore(config)): WebSearchSettingsDto {
  const mine = storeKeys(own, true);
  return {
    chosen: 'auto',
    active: activeEngine(config.get().search, memberSearchKeys(own, hub, hubAllowed)),
    hubAllowed,
    providers: SEARCH_PROVIDERS.map((p) => {
      const keys = p.needs === 'key' ? mine.pool.list(p.id).map(keyDto) : [];
      return { ...p, keySet: keys.length > 0, ...(keys.length ? { keyFrom: 'own' as const } : {}), keys };
    }),
  };
}

const testQuery = 'open source search engine';

/** One real query with one key. A key the engine refuses is marked; one that works is marked working again. */
async function testKey(info: SearchProviderInfo, keys: SearchKeys, k: PoolKey | undefined, signal: AbortSignal, url?: string): Promise<WebSearchTestResult> {
  const provider = info.id;
  try {
    const results = await searchOnce(provider, { query: testQuery, limit: 3, key: k?.key, url, signal });
    if (k) keys.pool.mark(provider, k.key, undefined);
    return { provider, ok: results.length > 0, message: results.length ? `Works. ${info.name} answered with ${results.length} result${results.length === 1 ? '' : 's'}.` : `${info.name} answered, but with no results.` };
  } catch (err) {
    if (k && err instanceof SearchHttpError) {
      const mark = classifyKeyError(err.status, err.body, err.headers);
      if (mark) keys.pool.mark(provider, k.key, mark);
    }
    let msg = (err as Error).message;
    // a provider may echo the key in its error body
    if (k) msg = msg.split(k.key).join('[key]');
    return { provider, ok: false, message: msg.slice(0, 300) };
  }
}

function engineInfo(id: string | undefined): SearchProviderInfo {
  const info = SEARCH_PROVIDERS.find((x) => x.id === id);
  if (!info) throw new SearchSettingsError(`Unknown search engine ${id}.`);
  return info;
}

/** The key a Test runs on: the one at index, else the first working one. */
function keyAt(keys: PoolKey[], index: number | undefined): PoolKey | undefined {
  if (index === undefined) return keys.find((k) => !k.mark) ?? keys[0];
  if (!Number.isInteger(index) || !keys[index]) throw new SearchSettingsError(`There is no key ${index + 1}.`);
  return keys[index];
}

/** The Test button on a member's page: one of their own keys. */
export async function testMemberSearch(own: SearchKeyStore, id?: string, signal = new AbortController().signal, index?: number): Promise<WebSearchTestResult> {
  const keys = storeKeys(own, true);
  const info = engineInfo(id ?? SEARCH_PROVIDERS.find((p) => p.needs === 'key' && keys.pool.list(p.id).length)?.id ?? 'duckduckgo');
  if (info.needs === 'url') throw new SearchSettingsError(`${info.name} needs a server address, which is the hub owner's to set.`);
  const k = info.needs === 'key' ? keyAt(keys.pool.list(info.id), index) : undefined;
  if (info.needs === 'key' && !k) return { provider: info.id, ok: false, message: `Add your own ${info.name} key first.` };
  return testKey(info, keys, k, signal);
}

/** One real query on one engine (the one in use by default) and one key, no fallback. Only ok and words come back. */
export async function testSearch(config: SearchConfig, id?: string, signal = new AbortController().signal, index?: number, store = hubKeyStore(config)): Promise<WebSearchTestResult> {
  const cfg = config.get().search;
  const keys = storeKeys(store);
  const info = engineInfo(id ?? activeEngine(cfg, keys));
  const own = info.needs === 'key' ? engineKeys(info.id, cfg, keys) : undefined;
  const k = own ? keyAt(own.keys, index) : undefined;
  return testKey(info, own ? { pool: own.pool } : keys, k, signal, info.id === 'searxng' ? searxngUrl(cfg) : undefined);
}
