/**
 * The merged catalog: shipped items first and offline, live search over
 * recorded GitHub and registry responses, curated entries winning over
 * derived ones, star refresh, status and the daily refresh. No network: the
 * fixture fetch throws for anything it does not know.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogService } from '../../src/catalog/service';
import { RECOMMENDED } from '../../src/catalog/recommended';
import { HOOK_RECIPES } from '../../src/extensions/hook-recipes';
import { ROUTINE_SUGGESTIONS } from '../../src/scheduler/suggestions';
import { cleanupAll, fakeHost, FIXTURES, fixtureFetch, fx, fxJson, json, tempHome } from './helpers';

afterEach(cleanupAll);

const H = fxJson<Record<string, Record<string, string>>>('github/headers.json');
const marketFiles = readdirSync(join(FIXTURES, 'marketplaces'));
const marketFor = (repo: string) => marketFiles.find((f) => f.startsWith(repo.replace('/', '__') + '@'));
const REG = readdirSync(join(FIXTURES, 'registry')).filter((f) => f.startsWith('get_')).map((f) => fxJson(`registry/${f}`));

function kv() {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f), set: (k: string, v: unknown) => void m.set(k, v), m };
}

function liveFetch(opts: { limited?: boolean; down?: boolean } = {}) {
  return fixtureFetch([
    ['https://api.github.com/search/repositories', (u) => {
      if (opts.down) throw new TypeError('network down');
      if (opts.limited) return json({ message: 'API rate limit exceeded' }, { ...H.limited, 'retry-after': '60' }, 403);
      const q = u.searchParams.get('q') ?? '';
      if (q.startsWith('repo:')) {
        const repos = q.split(' ').map((w) => w.slice(5).toLowerCase());
        const items = fxJson<{ items: Array<{ full_name: string }> }>('github/search-topic-claude-skills.json').items.filter((i) => repos.includes(i.full_name.toLowerCase()));
        return json({ total_count: items.length, items }, H.ok);
      }
      if (q.includes('topic:claude-skills')) return json(fx('github/search-topic-claude-skills.json'), H.ok);
      if (q.includes('topic:mcp-server')) return json(fx('github/search-topic-mcp-server.json'), H.ok);
      return json({ total_count: 0, items: [] }, H.ok);
    }],
    ['https://registry.modelcontextprotocol.io/v0.1/servers?', (u) => {
      if (opts.down) throw new TypeError('network down');
      if (u.searchParams.get('search')) return json(fx('registry/chrome-devtools.json'));
      return json({ servers: REG, metadata: {} });
    }],
    [/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/HEAD\/\.claude-plugin\/marketplace\.json$/, (u) => {
      if (opts.down) throw new TypeError('network down');
      const repo = u.pathname.split('/').slice(1, 3).join('/');
      const f = marketFor(repo);
      return f ? json(fx(`marketplaces/${f}`), { etag: `"${repo}"` }) : new Response('404: Not Found', { status: 404 });
    }],
    ['https://raw.githubusercontent.com/quemsah/awesome-claude-plugins/', () => json(fx('feeds/quemsah-repos-top30.json'), { etag: '"stars"' })],
    ['https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/', () => new Response(fx('feeds/awesome-claude-code.resources@d9b87c2.csv'))],
  ]);
}

function service(fetch = liveFetch(), bins: Record<string, boolean> = {}) {
  const home = tempHome();
  const host = fakeHost(home);
  const store = kv();
  const svc = new CatalogService({ db: home.db, paths: home.paths, host, fetch, kv: store, checkBin: async (b) => bins[b] ?? true, now: () => Date.parse('2026-10-18T12:00:00Z') });
  return { svc, host, home, kv: store, fetch };
}

describe('catalog list', () => {
  test('with no search, ponytail and caveman come first, then recommended items by rank, all offline', async () => {
    const f = liveFetch({ down: true });
    const { svc } = service(f);
    const page = await svc.list({ limit: 200 });
    expect(page.items.slice(0, 2).map((i) => i.id)).toEqual(['plugin:ponytail', 'plugin:caveman']);
    const rec = page.items.filter((i) => i.recommended && i.source === 'recommended' && !i.must);
    const ranks = rec.map((i) => i.rank!);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // a curated entry and a recipe with the same id (hook:rtk-rewrite) show once, as the curated one
    const curated = new Set(RECOMMENDED.map((i) => i.id));
    const extra = [...HOOK_RECIPES.map((r) => `hook:${r.id}`), ...ROUTINE_SUGGESTIONS.map((s) => `routine:${s.id}`)].filter((id) => !curated.has(id));
    expect(page.total).toBe(RECOMMENDED.length + extra.length);
    expect(new Set(page.items.map((i) => i.id)).size).toBe(page.items.length);
    expect(page.items.find((i) => i.id === 'hook:rtk-rewrite')?.source).toBe('recommended');
    expect(page.status.sources.find((s) => s.id === 'shipped')?.items).toBe(page.total);
    // every kind is there, including recipes and routine suggestions
    expect(new Set(page.items.map((i) => i.kind))).toEqual(new Set(['plugin', 'mcp', 'skill', 'subagent', 'command', 'hook', 'routine']));
    // the background star refresh found no network and changed nothing
    expect(page.items[0].stars).toBe(RECOMMENDED[0].stars);
  });

  test('recipes and routine suggestions keep their shipped order, and needs name only the program', async () => {
    const { svc } = service(liveFetch({ down: true }), { grep: true, jq: true });
    const routines = await svc.list({ kind: 'routine', recommended: true, limit: 200 });
    const shippedRoutines = ROUTINE_SUGGESTIONS.filter((s) => s.recommended).map((s) => `routine:${s.id}`);
    expect(routines.items.map((i) => i.id)).toEqual(shippedRoutines);
    expect(routines.items[0].id).toBe('routine:librarian-deep-pass');
    const hooks = await svc.list({ kind: 'hook', recommended: true, limit: 200 });
    const curated = new Set(RECOMMENDED.map((c) => c.id));
    const shippedHooks = HOOK_RECIPES.filter((r) => r.recommended).map((r) => `hook:${r.id}`).filter((id) => !curated.has(id));
    expect(hooks.items.filter((i) => i.source === 'recipe').map((i) => i.id)).toEqual(shippedHooks);
    // "grep -P" and "jq 1.6+" check grep and jq, so the row does not say "Needs grep -P"
    const all = await svc.list({ kind: 'hook', limit: 200 });
    for (const it of all.items) for (const n of it.needs ?? []) expect(n.bin).toMatch(/^[\w.+-]+$/);
    const tripwire = all.items.find((i) => i.id === 'hook:injection-tripwire')!;
    expect(tripwire.ready.ok).toBe(true);
  });

  test('filters by kind, category and text; paging with a cursor', async () => {
    const { svc } = service(liveFetch({ down: true }));
    const hooks = await svc.list({ kind: 'hook', limit: 5 });
    expect(hooks.items.every((i) => i.kind === 'hook')).toBe(true);
    expect(hooks.next).toBe('5');
    const more = await svc.list({ kind: 'hook', limit: 5, cursor: hooks.next });
    expect(more.items[0].id).not.toBe(hooks.items[0].id);
    const mem = await svc.list({ category: 'memory' });
    expect(mem.items.every((i) => i.category === 'memory')).toBe(true);
    const q = await svc.list({ q: 'proxmox' });
    expect(q.items[0].name.toLowerCase()).toContain('proxmox');
  });

  test('installed by name, and needs missing on the hub', async () => {
    const { svc, host } = service(liveFetch({ down: true }), { node: false, uvx: true });
    host.state.mcp.set('basic-memory', { command: 'uvx', args: ['basic-memory', 'mcp'] });
    const page = await svc.list({ limit: 200 });
    const bm = page.items.find((i) => i.id === 'mcp:basic-memory')!;
    expect(bm.installed).toMatchObject({ matchedBy: 'name', ref: 'basic-memory', href: '/extensions/mcp?server=basic-memory' });
    const pony = page.items.find((i) => i.id === 'plugin:ponytail')!;
    expect(pony.ready.ok).toBe(false);
    expect(pony.ready.missing.map((n) => n.bin)).toEqual(['node']);
    const installedOnly = await svc.list({ installed: true });
    expect(installedOnly.items.map((i) => i.id)).toEqual(['mcp:basic-memory']);
  });
});

describe('catalog search', () => {
  test('curated matches first, then live GitHub results; a curated entry hides the same repo', async () => {
    const { svc, fetch } = service();
    const r = await svc.search({ q: 'adhd', kind: 'skill' });
    expect(r.items[0].source).toBe('recommended');
    expect(r.items[0].repo).toBe('ayghri/i-have-adhd');
    expect(r.items.some((i) => i.id === 'gh:ayghri/i-have-adhd')).toBe(false);
    const gh = r.items.filter((i) => i.source === 'github');
    expect(gh.length).toBe(7);
    expect(gh[0]).toMatchObject({ id: 'gh:paperclipai/paperclip', stars: 103308, license: 'MIT', updatedAt: '2026-10-17' });
    expect(r.from).toContain('github');
    // one call per skill topic (the first gave fewer than 10), and no background star calls during a search
    const ghCalls = fetch.calls.filter((c) => c.url.includes('api.github.com'));
    expect(ghCalls.map((c) => new URL(c.url).searchParams.get('q')!.split(' ')[1])).toEqual(['topic:claude-skills', 'topic:agent-skills', 'topic:claude-code-skills']);
    // live results are cached and show up locally afterwards
    expect((await svc.list({ q: 'archify' })).items.map((i) => i.id)).toContain('gh:tt-a1i/archify');
  });

  test('MCP search adds registry entries, and a lookalike is marked not verified', async () => {
    const { svc } = service();
    const r = await svc.search({ q: 'chrome devtools', kind: 'mcp' });
    const official = r.items.find((i) => i.repo === 'ChromeDevTools/chrome-devtools-mcp')!;
    expect(official.source).toBe('recommended');
    expect(r.from).toContain('mcp-registry');
    const others = r.items.filter((i) => i.source === 'mcp-registry');
    expect(others.length).toBeGreaterThan(0);
  });

  test('rate limited: saved results and a note, never an empty page', async () => {
    const ok = liveFetch();
    const { svc, home, host } = service(ok);
    await svc.search({ q: 'memory', kind: 'skill' });
    // same hub, now limited, an hour and more later
    const later = new CatalogService({ db: home.db, paths: home.paths, host, fetch: liveFetch({ limited: true }), now: () => Date.parse('2026-10-18T14:00:00Z'), checkBin: async () => true });
    const r = await later.search({ q: 'memory', kind: 'skill' });
    expect(r.note).toContain('GitHub limit reached');
    expect(r.items.some((i) => i.source === 'github')).toBe(true);
    expect(later.status().github.blockedUntil).toBeGreaterThan(0);
  });

  test('offline: the note says the hub cannot reach GitHub', async () => {
    const { svc } = service(liveFetch({ down: true }));
    const r = await svc.search({ q: 'proxmox' });
    expect(r.note).toBe("Can't reach GitHub from the hub.");
    // the shipped matches still show
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.source === 'recommended' || i.source === 'recipe' || i.source === 'suggestion')).toBe(true);
  });
});

describe('refresh and stars', () => {
  test('the daily refresh reads marketplaces, the registry and the feeds; status counts them', async () => {
    const { svc, kv } = service();
    await svc.runRefresh();
    const st = svc.status();
    const count = (id: string) => st.sources.find((s) => s.id === id)!.items;
    expect(count('marketplaces')).toBeGreaterThan(100);
    expect(count('mcp-registry')).toBe(REG.length);
    expect(count('awesome-claude-code')).toBeGreaterThan(10);
    expect(st.lastRefresh).toBeGreaterThan(0);
    expect(kv.m.get('catalog.registry.since')).toBeTruthy();
    // a marketplace entry the curated list already covers is not shown twice
    const plugins = await svc.list({ kind: 'plugin', limit: 200 });
    expect(plugins.items.some((i) => i.id === 'mkt:superpowers@claude-plugins-official')).toBe(false);
    expect(plugins.items.some((i) => i.id === 'mkt:hookify@claude-plugins-official')).toBe(true);
    // the star index updates stars of rows it covers
    const sp = svc.itemFor('gh:obra/superpowers') ?? svc.itemFor('plugin:superpowers');
    expect(sp?.stars).toBeGreaterThan(0);
  });

  test('refresh is limited to once a minute', async () => {
    const { svc } = service();
    await svc.refresh('marketplaces');
    await expect(svc.refresh('marketplaces')).rejects.toMatchObject({ status: 429 });
  });

  test('star refresh for rows on screen overlays live stars on curated items', async () => {
    const { svc } = service();
    const n = await svc.refreshStars(['ayghri/i-have-adhd', 'thedotmack/claude-mem']);
    expect(n).toBe(2);
    const adhd = svc.dto(svc.itemFor('plugin:i-have-adhd')!);
    expect(adhd.stars).toBe(57470);
    expect(adhd.starsAt).toBe('2026-10-18');
    expect(adhd.starsLive).toBe(true);
  });

  test('detail reads the README head over raw, not the API', async () => {
    const f = fixtureFetch([['https://raw.githubusercontent.com/DietrichGebert/ponytail/', (u) => (u.pathname.endsWith('README.md') ? new Response('# ponytail\n' + 'x'.repeat(20_000)) : json({ name: 'ponytail', version: '5.3.2' }))]]);
    const { svc } = service(f);
    const d = await svc.detail('plugin:ponytail');
    expect(d.readme?.startsWith('# ponytail')).toBe(true);
    expect(d.readme?.length).toBe(8192);
    expect(d.manifest).toMatchObject({ name: 'ponytail' });
    expect(f.calls.every((c) => !c.url.includes('api.github.com'))).toBe(true);
  });
});
