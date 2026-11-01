/**
 * HTTP cache and GitHub client, replaying recorded search responses. The
 * rate limit headers are synthetic (fixtures/github/headers.json): the
 * connector that recorded the bodies does not pass headers through.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CatalogStore } from '../../src/catalog/store';
import { CatalogHttp, OfflineError } from '../../src/catalog/http';
import { GithubClient, ghRepoToItem, kindFromRepo, mapGhRepo } from '../../src/catalog/github';
import { cleanupAll, fixtureFetch, fxJson, json, tempHome } from './helpers';

afterEach(cleanupAll);

const H = fxJson<Record<string, Record<string, string>>>('github/headers.json');
const SKILLS = fxJson<{ items: Array<Record<string, unknown>>; total_count: number }>('github/search-topic-claude-skills.json');
const MCP = fxJson<{ items: Array<Record<string, unknown>> }>('github/search-topic-mcp-server.json');

function setup(fetch: ReturnType<typeof fixtureFetch>, now = () => Date.parse('2026-10-17T12:00:00Z'), token?: string) {
  const { db } = tempHome();
  const store = new CatalogStore(db);
  const http = new CatalogHttp(store, { fetch, now });
  let saved: unknown;
  const gh = new GithubClient({ http, now, fetch, token: () => token, save: (s) => (saved = s) });
  return { store, http, gh, saved: () => saved };
}

describe('CatalogHttp', () => {
  test('serves a fresh copy without a call, revalidates a stale one with its ETag, and a 304 keeps the body', async () => {
    let t = 1_000_000;
    let n = 0;
    const f = fixtureFetch([
      ['https://raw.example/x.json', (_u, init) => {
        n++;
        const inm = new Headers(init?.headers).get('if-none-match');
        if (inm === 'W/"v1"') return new Response(null, { status: 304 });
        return json({ v: 1 }, { etag: 'W/"v1"' });
      }],
    ]);
    const { db } = tempHome();
    const http = new CatalogHttp(new CatalogStore(db), { fetch: f, now: () => t });
    const a = await http.get('https://raw.example/x.json', { ttlMs: 1000 });
    expect(a.fromCache).toBe(false);
    const b = await http.get('https://raw.example/x.json', { ttlMs: 1000 });
    expect(b.fromCache).toBe(true);
    expect(n).toBe(1);
    t += 5000;
    const c = await http.get('https://raw.example/x.json', { ttlMs: 1000 });
    expect(n).toBe(2);
    expect(c.notModified).toBe(true);
    expect(JSON.parse(c.body)).toEqual({ v: 1 });
    expect(f.calls[1].headers['if-none-match']).toBe('W/"v1"');
  });

  test('offline: the stale copy is served and marked, and nothing cached throws OfflineError', async () => {
    let t = 0;
    let up = true;
    const f = fixtureFetch([['https://raw.example/', () => (up ? json({ ok: 1 }) : Promise.reject(new TypeError('network down')))]]);
    const { db } = tempHome();
    const http = new CatalogHttp(new CatalogStore(db), { fetch: f, now: () => t });
    await http.get('https://raw.example/a', { ttlMs: 10 });
    up = false;
    t = 100;
    const r = await http.get('https://raw.example/a', { ttlMs: 10 });
    expect(r.stale).toBe(true);
    expect(r.error).toContain('network down');
    expect(http.offline).toBe(true);
    await expect(http.get('https://raw.example/b', { ttlMs: 10 })).rejects.toBeInstanceOf(OfflineError);
  });

  test('a 404 is cached until its TTL ends', async () => {
    const f = fixtureFetch([['https://raw.example/', () => new Response('nope', { status: 404 })]]);
    const { db } = tempHome();
    const http = new CatalogHttp(new CatalogStore(db), { fetch: f, now: () => 0 });
    await http.get('https://raw.example/missing', { ttlMs: 1000 });
    const again = await http.get('https://raw.example/missing', { ttlMs: 1000 });
    expect(again.status).toBe(404);
    expect(f.calls.length).toBe(1);
  });
});

describe('GitHub client', () => {
  test('maps the REST fields the row shows: stars, license, pushed date, topics', () => {
    const r = mapGhRepo(SKILLS.items[1]);
    expect(r).toMatchObject({ fullName: 'thedotmack/claude-mem', stars: 101275, license: 'Apache-2.0', pushedAt: '2026-10-17', archived: false });
    expect(mapGhRepo(SKILLS.items[4]).license).toBe('Other');
    // a missing push date never becomes text like "nullT00:00" that sorts after every real date
    expect(mapGhRepo({ ...SKILLS.items[1], pushed_at: 'nullT00:00:00Z', updated_at: null }).pushedAt).toBeUndefined();
    expect(mapGhRepo({ ...SKILLS.items[1], pushed_at: null, updated_at: '2026-10-01T10:00:00Z' }).pushedAt).toBe('2026-10-01');
    const item = ghRepoToItem(r, kindFromRepo(r, 'skill'), Date.parse('2026-10-17'));
    // the searched kind wins when the repo carries its topic
    expect(item).toMatchObject({ id: 'gh:thedotmack/claude-mem', kind: 'skill', source: 'github', starsAt: '2026-10-17', category: 'memory' });
    expect(kindFromRepo(r, 'mcp')).toBe('plugin');
    expect(item.install.type).toBe('manual');
  });

  test('a kind search sends the topic query and tries the next topic only when results are fewer than 10', async () => {
    const f = fixtureFetch([
      [/topic%3Aclaude-skills/, () => json(SKILLS, H.ok)],
      [/topic%3Aagent-skills/, () => json({ total_count: 2, items: [MCP.items[0], MCP.items[1]] }, H.ok)],
    ]);
    const { gh } = setup(f);
    const r = await gh.searchKind('memory', 'skill');
    const q0 = new URL(f.calls[0].url).searchParams;
    expect(q0.get('q')).toBe('memory topic:claude-skills archived:false fork:false');
    expect(q0.get('sort')).toBe('stars');
    expect(q0.get('per_page')).toBe('30');
    // 8 results from the first topic, so the second was tried; 10 then, so the third was not
    expect(f.calls.length).toBe(2);
    expect(r.items.length).toBe(10);
    expect(gh.rate().searchRemaining).toBe(9);
  });

  test('a 403 with no calls left pauses search until reset, and the saved result is served meanwhile', async () => {
    let t = Date.parse('2026-10-17T12:00:00Z');
    let limited = false;
    const f = fixtureFetch([[/search\/repositories/, () => (limited ? json({ message: 'API rate limit exceeded' }, H.limited, 403) : json(SKILLS, H.ok))]]);
    const { gh } = setup(f, () => t);
    await gh.searchRepositories('topic:claude-skills');
    limited = true;
    t += 2 * 3_600_000; // past the 1 hour TTL
    const r = await gh.searchRepositories('topic:claude-skills');
    expect(r.res.liveStatus).toBe(403);
    expect(r.res.stale).toBe(true);
    expect(r.items.length).toBe(8);
    const rate = gh.rate();
    expect(rate.blockedUntil).toBe(Number(H.limited['x-ratelimit-reset']) * 1000);
    expect(gh.canCall('search')).toBe(false);
    const calls = f.calls.length;
    await gh.searchRepositories('topic:claude-skills');
    expect(f.calls.length).toBe(calls); // paused: no call went out
    t = rate.blockedUntil! + 1;
    expect(gh.canCall('search')).toBe(true);
  });

  test('background work keeps a reserve of calls for the owner', () => {
    const f = fixtureFetch([]);
    const { gh } = setup(f);
    gh.noteResponse('core', { headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1792241400' }, status: 200, fromCache: false });
    expect(gh.canCall('core', true)).toBe(false);
    expect(gh.canCall('core', false)).toBe(true);
    gh.noteResponse('search', { headers: { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '2', 'x-ratelimit-limit': '10' }, status: 200, fromCache: false });
    expect(gh.canCall('search', true)).toBe(false);
  });

  test('star refresh batches repo: qualifiers under 256 chars', async () => {
    const repos = (fxJson<{ repos: Array<{ repo: string; stars: number }> }>('github/stars-recorded.json').repos ?? []).map((r) => r.repo);
    const f = fixtureFetch([[/search\/repositories/, () => json({ total_count: 0, items: [] }, H.ok)]]);
    const { gh } = setup(f);
    await gh.stars(repos, false);
    expect(f.calls.length).toBeGreaterThan(1);
    for (const c of f.calls) {
      const q = new URL(c.url).searchParams.get('q')!;
      expect(q.length).toBeLessThanOrEqual(256);
      expect(q.split(' ').every((w) => w.startsWith('repo:'))).toBe(true);
    }
  });

  test('a token is sent as a bearer header and raises the limits', async () => {
    const f = fixtureFetch([[/search\/repositories/, () => json(SKILLS, { ...H.ok, 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '29' })]]);
    const { gh } = setup(f, undefined, 'ghp_test');
    expect(gh.rate()).toMatchObject({ authenticated: true, limit: 5000 });
    await gh.searchRepositories('topic:claude-skills');
    expect(f.calls[0].headers.authorization).toBe('Bearer ghp_test');
  });
});
