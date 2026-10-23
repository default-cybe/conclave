/**
 * Settings > Web search on the hub: the owner's choice, the SearXNG address,
 * each engine's key and the Test button. A key is a hub secret named
 * search.<id> (${secret:search.brave}); it never goes in config.json and no
 * reply carries it, only whether one is set. The engine list is in
 * search-providers.ts.
 */
import type { ConfigStore } from '../config';
import { keyFor, pickProvider, providerForKey, searchOnce, searxngUrl, type SearchProviderId } from './websearch';
import { SEARCH_PROVIDERS, type SearchChoice, type SearchProviderInfo, type WebSearchSettingsDto, type WebSearchSettingsPatch, type WebSearchTestResult } from './search-providers';

const CHOICES: SearchChoice[] = ['auto', ...SEARCH_PROVIDERS.map((p) => p.id)];

type SearchConfig = Pick<ConfigStore, 'get' | 'getUser' | 'replace' | 'setSecret' | 'secretValue'>;

export class SearchSettingsError extends Error {}

export const searchSecretName = (id: string) => `search.${id}`;

/** The saved key lookup WebSearch uses. */
export const savedSearchKey = (config: Pick<ConfigStore, 'secretValue'>) => (id: string) => config.secretValue(searchSecretName(id));

function keyFrom(config: SearchConfig, p: SearchProviderInfo): 'hub' | 'config' | 'env' | undefined {
  if (p.needs !== 'key') return undefined;
  if (config.secretValue(searchSecretName(p.id))) return 'hub';
  const cfg = config.get().search;
  const configured = cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
  // the same rule as websearch.ts keyFor: a configured key is the chosen engine's, or in auto the one its prefix names
  if (configured && (cfg.provider === p.id || (cfg.provider === 'auto' && providerForKey(configured) === p.id))) return 'config';
  if (p.env?.some((e) => process.env[e])) return 'env';
  return undefined;
}

export function searchSettings(config: SearchConfig): WebSearchSettingsDto {
  const cfg = config.get().search;
  const url = searxngUrl(cfg);
  return {
    chosen: cfg.provider ?? 'auto',
    active: pickProvider(cfg, savedSearchKey(config)).id,
    ...(url ? { url, urlFrom: cfg.url ? ('config' as const) : ('env' as const) } : {}),
    providers: SEARCH_PROVIDERS.map((p) => {
      const from = keyFrom(config, p);
      return { ...p, keySet: !!from, ...(from ? { keyFrom: from } : {}) };
    }),
  };
}

export function patchSearchSettings(config: SearchConfig, p: WebSearchSettingsPatch): WebSearchSettingsDto {
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
  return searchSettings(config);
}

/** Save a key (trimmed) for one engine, or remove it with null. */
export function setSearchKey(config: SearchConfig, id: string, key: string | null): WebSearchSettingsDto {
  const p = SEARCH_PROVIDERS.find((x) => x.id === id);
  if (!p || p.needs !== 'key') throw new SearchSettingsError(`${id} takes no key. Keys go with ${SEARCH_PROVIDERS.filter((x) => x.needs === 'key').map((x) => x.id).join(', ')}.`);
  const k = key?.trim();
  if (k && !/^\S{8,512}$/.test(k)) throw new SearchSettingsError(`That does not look like a ${p.name} key: it is one word of at least 8 characters, with no spaces.`);
  config.setSecret('values', searchSecretName(id), k || undefined);
  return searchSettings(config);
}

/** One real query on one engine (the one in use by default), no fallback. Only ok and words come back. */
export async function testSearch(config: SearchConfig, id?: string, signal = new AbortController().signal): Promise<WebSearchTestResult> {
  const cfg = config.get().search;
  const saved = savedSearchKey(config);
  const provider = (id ?? pickProvider(cfg, saved).id) as SearchProviderId;
  const info = SEARCH_PROVIDERS.find((x) => x.id === provider);
  if (!info) throw new SearchSettingsError(`Unknown search engine ${id}.`);
  const key = info.needs === 'key' ? keyFor(provider, cfg, saved) : undefined;
  try {
    const results = await searchOnce(provider, { query: 'open source search engine', limit: 3, key, url: provider === 'searxng' ? searxngUrl(cfg) : undefined, signal });
    return { provider, ok: results.length > 0, message: results.length ? `Works. ${info.name} answered with ${results.length} result${results.length === 1 ? '' : 's'}.` : `${info.name} answered, but with no results.` };
  } catch (err) {
    let msg = (err as Error).message;
    // a provider may echo the key in its error body
    if (key) msg = msg.split(key).join('[key]');
    return { provider, ok: false, message: msg.slice(0, 300) };
  }
}
