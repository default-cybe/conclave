/**
 * Settings > Web search (features/settings/websearch.tsx) and its mock
 * (src/mock/websearch.ts): the engine list with free allowances, the steps
 * and key field of the one picked, a key that is never in an answer, and
 * the section kept from members.
 *
 *   cd packages/web && bun test test/websearch-settings.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WebSearchSettingsDto, WebSearchTestResult } from '@conclave/core/client';
import { registerWebSearch } from '../src/mock/websearch';
import { inUseWords, WebSearchBody } from '../src/features/settings/websearch';

type Handler = (p: { params: string[]; query: URLSearchParams; body: any }) => unknown;

function mock() {
  const routes: Array<[string, string, Handler]> = [];
  const ctx = {
    on: (m: string, path: string, h: Handler) => routes.push([m, path, h]),
    fail: (status: number, msg: string): never => {
      throw Object.assign(new Error(msg), { status });
    },
    sleep: async () => undefined,
    FRESH: false,
  };
  registerWebSearch(ctx as never);
  return async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = routes.find(([m, p]) => m === method && p === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    return (await r[2]({ params: [], query: new URLSearchParams(), body })) as T;
  };
}

describe('Settings > Web search', () => {
  test('lists every engine with its free allowance; the picked one shows numbered steps with links and a masked key field', async () => {
    const s = await mock()<WebSearchSettingsDto>('GET', '/api/websearch');
    const html = renderToStaticMarkup(<WebSearchBody s={s} onChange={() => {}} initial="brave" />);
    for (const name of ['Tavily', 'Exa', 'LangSearch', 'Linkup', 'Firecrawl', 'You.com', 'Serper', 'SerpApi', 'Jina Search', 'Brave Search', 'SearXNG', 'DuckDuckGo']) expect(html).toContain(name);
    // only Brave is marked, next to its allowance
    expect(html.match(/Needs a card\./g)).toHaveLength(1);
    expect(html).toMatch(/Needs a card\.<\/span>\$5 of free credit/);
    expect(html).toContain('1,000 API credits a month');
    expect(html).toContain('<ol');
    expect(html).toContain('href="https://api-dashboard.search.brave.com/app/keys"');
    expect(html).toContain('type="password"');
    for (const b of ['>Paste<', '>Save<', '>Test<', 'Use Brave Search']) expect(html).toContain(b);
    expect(html).toContain('A card is needed');
    expect(inUseWords(s)).toBe('DuckDuckGo, because no engine has a key or address yet.');
  });

  test('SearXNG shows the address field, not a key', async () => {
    const s = await mock()<WebSearchSettingsDto>('GET', '/api/websearch');
    const html = renderToStaticMarkup(<WebSearchBody s={s} onChange={() => {}} initial="searxng" />);
    expect(html).toContain('aria-label="SearXNG address"');
    expect(html).not.toContain('type="password"');
  });

  test('saving a key: the answer says it is set and in use, never the key; Remove and Test work', async () => {
    const api = mock();
    const KEY = 'tvly-mock-secret-123';
    const s = await api<WebSearchSettingsDto>('PUT', '/api/websearch/key', { provider: 'tavily', key: KEY });
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(s.active).toBe('tavily');
    expect(s.providers.find((p) => p.id === 'tavily')).toMatchObject({ keySet: true, keyFrom: 'hub' });
    const html = renderToStaticMarkup(<WebSearchBody s={s} onChange={() => {}} initial="tavily" />);
    expect(html).toContain('>Remove<');
    expect(html).toContain('In use');
    expect(await api<WebSearchTestResult>('POST', '/api/websearch/test', { provider: 'tavily' })).toMatchObject({ ok: true });
    await expect(api('PUT', '/api/websearch/key', { provider: 'searxng', key: 'abcdefghij' })).rejects.toThrow('takes no key');
    const chosen = await api<WebSearchSettingsDto>('PATCH', '/api/websearch', { provider: 'exa' });
    expect(inUseWords(chosen)).toBe('Exa, chosen here.');
  });

  test('automatic order is the catalog order: a SearXNG address loses to any key, Brave loses to the free engines', async () => {
    const api = mock();
    expect((await api<WebSearchSettingsDto>('PATCH', '/api/websearch', { url: 'http://sx.lan/' })).active).toBe('searxng');
    expect((await api<WebSearchSettingsDto>('PUT', '/api/websearch/key', { provider: 'brave', key: 'BSA-0123456789' })).active).toBe('brave');
    expect((await api<WebSearchSettingsDto>('PUT', '/api/websearch/key', { provider: 'serper', key: 'serper-0123456789' })).active).toBe('serper');
    await expect(api('PATCH', '/api/websearch', { url: 'http://me:pw@sx.lan' })).rejects.toThrow('user name');
  });

  test('owner only, in the Customize group; no em or en dashes', () => {
    const root = join(import.meta.dir, '../src');
    const page = readFileSync(join(root, 'features/settings/SettingsPage.tsx'), 'utf8');
    expect(page).toMatch(/id: 'websearch',[\s\S]*?owner: true,/);
    expect(readFileSync(join(root, 'features/settings/nav.ts'), 'utf8')).toContain("'maps', 'websearch'");
    for (const f of ['features/settings/websearch.tsx', 'mock/websearch.ts', '../../core/src/tools/search-providers.ts']) expect({ f, dash: /[–—]/.test(readFileSync(join(root, f), 'utf8')) }).toEqual({ f, dash: false });
  });
});
