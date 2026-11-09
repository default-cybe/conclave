/**
 * Mock routes for Settings > Web search: DuckDuckGo until a key is saved,
 * a list of keys per engine that answers only labels, last 4 characters and
 * states, and the Test button. The full mock (not ?fresh) starts with two
 * Brave keys, the first out of credit, so the page shows the rotation.
 */
import { SEARCH_PROVIDERS, type SearchChoice, type SearchKeyDto, type SearchProviderId, type WebSearchKeysPatch, type WebSearchKeyUpdate, type WebSearchSettingsDto, type WebSearchSettingsPatch, type WebSearchTestResult } from '@conclave/core/client';
import type { MockCtx } from './index';

interface MockKey {
  key: string;
  label?: string;
  status: SearchKeyDto['status'];
  until?: number;
}

const nextUtcDay = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export function registerWebSearch(ctx: MockCtx) {
  const { on, fail } = ctx;
  let chosen: SearchChoice = 'auto';
  let url: string | undefined;
  const keys = new Map<string, MockKey[]>();
  if (!ctx.FRESH)
    keys.set('brave', [
      { key: 'BSA-mock-personal-7f3a', label: 'personal', status: 'credit', until: nextUtcDay() },
      { key: 'BSA-mock-card2-91c2', label: 'card 2', status: 'working' },
    ]);
  const list = (id: string) => keys.get(id) ?? [];
  const working = (id: string) => list(id).some((k) => k.status === 'working');
  const active = (): SearchProviderId => {
    if (chosen !== 'auto') return chosen;
    // the hub's automatic order is the catalog's; an engine whose keys are all down is skipped
    return SEARCH_PROVIDERS.find((p) => (p.needs === 'key' && working(p.id)) || (p.needs === 'url' && url))?.id ?? 'duckduckgo';
  };
  const view = (): WebSearchSettingsDto => ({
    chosen,
    active: active(),
    ...(url ? { url, urlFrom: 'config' as const } : {}),
    providers: SEARCH_PROVIDERS.map((p) => {
      const ks = list(p.id);
      return { ...p, keySet: ks.length > 0, ...(ks.length ? { keyFrom: 'hub' as const } : {}), keys: ks.map((k) => ({ ...(k.label ? { label: k.label } : {}), last4: k.key.length >= 12 ? k.key.slice(-4) : '', status: k.status, ...(k.until ? { until: k.until } : {}) })) };
    }),
  });
  const at = (id: string, i: number) => {
    if (!list(id)[i]) fail(400, `There is no key ${i + 1}.`);
    return i;
  };

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
    const { provider, key, label, index, add } = body as WebSearchKeyUpdate;
    if (SEARCH_PROVIDERS.find((p) => p.id === provider)?.needs !== 'key') fail(400, `${provider} takes no key.`);
    const k = key?.trim();
    if (k && !/^\S{8,512}$/.test(k)) fail(400, 'That does not look like a key: it is one word of at least 8 characters, with no spaces.');
    const ks = [...list(provider)];
    if (k && ks.some((x) => x.key === k)) fail(400, 'That key is already in the list.');
    if (!k) {
      if (index === undefined) ks.splice(0);
      else ks.splice(at(provider, index), 1);
    } else if (add || (index === undefined && !ks.length)) ks.push({ key: k, ...(label?.trim() ? { label: label.trim() } : {}), status: 'working' });
    else ks[at(provider, index ?? 0)] = { key: k, label: label?.trim() || ks[index ?? 0]!.label, status: 'working' };
    keys.set(provider, ks);
    return view();
  });
  on('PATCH', '/api/websearch/keys', ({ body }) => {
    const { provider, order, index, label } = body as WebSearchKeysPatch;
    const ks = list(provider);
    if (order) {
      if (order.length !== ks.length || new Set(order).size !== order.length) fail(400, 'order must list every key index once.');
      keys.set(provider, order.map((i) => ks[at(provider, i)]!));
    } else if (index !== undefined) ks[at(provider, index)]!.label = label?.trim() || undefined;
    return view();
  });
  on('POST', '/api/websearch/test', async ({ body }): Promise<WebSearchTestResult> => {
    await ctx.sleep(500);
    const b = (body ?? {}) as { provider?: SearchProviderId; index?: number };
    const provider = (b.provider ?? active()) as SearchProviderId;
    const info = SEARCH_PROVIDERS.find((p) => p.id === provider)!;
    const k = b.index !== undefined ? list(provider)[b.index] : list(provider).find((x) => x.status === 'working');
    if (info.needs === 'key' && !k) return { provider, ok: false, message: `no ${info.name} API key` };
    if (k && k.status !== 'working') return { provider, ok: false, message: 'HTTP 402: usage limit exceeded for this subscription' };
    if (provider === 'duckduckgo') return { provider, ok: false, message: 'DuckDuckGo refused this hub with a bot check (HTTP 202).' };
    return { provider, ok: true, message: `Works. ${info.name} answered with 3 results.` };
  });
}
