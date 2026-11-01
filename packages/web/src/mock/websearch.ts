/**
 * Mock routes for Settings > Web search: DuckDuckGo until a key is saved,
 * keys that answer only whether one is set, and the Test button.
 */
import { SEARCH_PROVIDERS, type SearchChoice, type SearchProviderId, type WebSearchSettingsDto, type WebSearchSettingsPatch, type WebSearchTestResult } from '@conclave/core/client';
import type { MockCtx } from './index';

export function registerWebSearch(ctx: MockCtx) {
  const { on, fail } = ctx;
  let chosen: SearchChoice = 'auto';
  let url: string | undefined;
  const keys = new Set<string>();
  const active = (): SearchProviderId => {
    if (chosen !== 'auto') return chosen;
    // the hub's automatic order is the catalog's
    return SEARCH_PROVIDERS.find((p) => (p.needs === 'key' && keys.has(p.id)) || (p.needs === 'url' && url))?.id ?? 'duckduckgo';
  };
  const view = (): WebSearchSettingsDto => ({
    chosen,
    active: active(),
    ...(url ? { url, urlFrom: 'config' as const } : {}),
    providers: SEARCH_PROVIDERS.map((p) => ({ ...p, keySet: keys.has(p.id), ...(keys.has(p.id) ? { keyFrom: 'hub' as const } : {}) })),
  });

  on('GET', '/api/websearch', () => view());
  on('PATCH', '/api/websearch', ({ body }) => {
    const p = body as WebSearchSettingsPatch;
    if (p.provider !== undefined) {
      if (p.provider !== 'auto' && !SEARCH_PROVIDERS.some((x) => x.id === p.provider)) fail(400, `provider must be one of ${['auto', ...SEARCH_PROVIDERS.map((x) => x.id)].join(', ')}.`);
      chosen = p.provider;
    }
    if (p.url !== undefined) {
      const u = p.url ? URL.parse(p.url.trim()) : undefined;
      if (p.url && (!u || !/^https?:$/.test(u.protocol))) fail(400, 'The SearXNG address must start with http:// or https://.');
      if (u && (u.username || u.password || u.search || u.hash)) fail(400, 'Leave the user name, password, ? and # parts out of the SearXNG address.');
      url = u ? u.origin + u.pathname.replace(/\/+$/, '') : undefined;
    }
    return view();
  });
  on('PUT', '/api/websearch/key', ({ body }) => {
    const { provider, key } = body as { provider: string; key: string | null };
    if (SEARCH_PROVIDERS.find((p) => p.id === provider)?.needs !== 'key') fail(400, `${provider} takes no key.`);
    if (key && !/^\S{8,512}$/.test(key.trim())) fail(400, 'That does not look like a key: it is one word of at least 8 characters, with no spaces.');
    if (key) keys.add(provider);
    else keys.delete(provider);
    return view();
  });
  on('POST', '/api/websearch/test', async ({ body }): Promise<WebSearchTestResult> => {
    await ctx.sleep(500);
    const provider = ((body as { provider?: SearchProviderId } | undefined)?.provider ?? active()) as SearchProviderId;
    const info = SEARCH_PROVIDERS.find((p) => p.id === provider)!;
    if (info.needs === 'key' && !keys.has(provider)) return { provider, ok: false, message: `no ${info.name} API key` };
    if (provider === 'duckduckgo') return { provider, ok: false, message: 'DuckDuckGo refused this hub with a bot check (HTTP 202).' };
    return { provider, ok: true, message: `Works. ${info.name} answered with 3 results.` };
  });
}
