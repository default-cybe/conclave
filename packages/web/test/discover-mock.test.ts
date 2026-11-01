/**
 * The Discover mock (src/mock/discover.ts) against a stub mock context: the
 * list order, search, preview and install, so the screens the mock feeds
 * keep the shapes of docs/design/ECOSYSTEM.md 2.1. The routine suggestion
 * routes are routines-suggest.ts (routines-suggest-mock.test.ts).
 *
 *   bun test packages/web/test/discover-mock.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { registerDiscover } from '../src/mock/discover';
import type { CatalogInstallResult, CatalogPage, CatalogSearchResult, InstallPreview } from '@conclave/core/client';

type Handler = (p: { params: string[]; query: URLSearchParams; body: any }) => unknown;

function world() {
  const routes: Array<[string, RegExp, Handler]> = [];
  const mcp: Record<string, unknown> = { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }, 'basic-memory': { command: 'uvx', args: ['basic-memory', 'mcp'] } };
  const plugins = [{ name: 'superpowers' }];
  const db = { config: { mcpServers: mcp, hooks: {} } as Record<string, any>, values: [] as string[], agents: [] as any[], routines: new Map<string, any>(), devices: new Map<string, any>([['local', { id: 'local', name: 'madx' }]]) };
  let n = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const ctx = {
    on: (m: string, path: string, h: Handler) => routes.push([m, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]),
    db,
    emit: () => undefined,
    uid: (p: string) => `${p}_${++n}`,
    sleep: async () => undefined,
    notFound: () => {
      throw new Error('404');
    },
    fail: (status: number, msg: string): never => {
      throw Object.assign(new Error(msg), { status });
    },
    FRESH: false,
    pass: Symbol('pass'),
    request: async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === '/api/plugins' && method === 'GET') return json(plugins);
      if (path === '/api/plugins' && method === 'POST') {
        const name = String(body.source).split('/').pop();
        plugins.push({ name: name! });
        return json({ name });
      }
      if (path === '/api/mcp' && method === 'POST') {
        mcp[body.name] = body.config;
        return json({ name: body.name });
      }
      if (path === '/api/secrets') {
        db.values.push(body.key);
        return json({ ok: true });
      }
      if (path === '/api/routines' && method === 'POST') {
        const r = { id: `r_${++n}`, ...body };
        db.routines.set(r.id, r);
        return json(r);
      }
      return json({ error: `no stub for ${method} ${path}` }, 404);
    },
  };
  registerDiscover(ctx as never);
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const u = new URL(url, 'http://x');
    for (const [m, re, h] of routes) {
      const match = m === method && u.pathname.match(re);
      if (match) return (await h({ params: match.slice(1).map(decodeURIComponent), query: u.searchParams, body })) as T;
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { call, db, mcp };
}

describe('catalog list', () => {
  test('picks first, then recommended by rank, with installed state by name', async () => {
    const { call } = world();
    const page = await call<CatalogPage>('GET', '/api/catalog?limit=500');
    expect(page.items[0].id).toBe('plugin:ponytail');
    expect(page.items[1].id).toBe('plugin:caveman');
    const ids = page.items.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page.items.find((x) => x.id === 'mcp:github')?.installed?.matchedBy).toBe('name');
    expect(page.items.find((x) => x.id === 'plugin:superpowers')?.updateAvailable).toBe(true);
    expect(page.items.some((x) => x.kind === 'hook' && x.source === 'recipe')).toBe(true);
    expect(page.items.some((x) => x.kind === 'routine' && x.id === 'routine:librarian-deep-pass')).toBe(true);
    expect(page.status.github).toMatchObject({ authenticated: false, limit: 60, remaining: 54 });
  });
  test('missing hub programs make a row not ready', async () => {
    const { call } = world();
    const page = await call<CatalogPage>('GET', '/api/catalog?kind=mcp');
    expect(page.items.find((x) => x.id === 'mcp:searxng')?.ready).toMatchObject({ ok: false, missing: [{ bin: 'npx' }] });
    expect(page.items.find((x) => x.id === 'mcp:basic-memory')?.ready.ok).toBe(true);
  });
  test('a missing program the hub can install comes with its offer; one that needs root with the command to copy', async () => {
    const { call } = world();
    const page = await call<CatalogPage>('GET', '/api/catalog?kind=mcp');
    const serena = page.items.find((x) => x.id === 'mcp:serena')!.ready.hubSetup!;
    expect(serena.commands.map((c) => c.run)).toEqual([expect.stringContaining('uv-installer.sh'), 'uv tool install -p 3.13 serena-agent && serena init']);
    const searxng = page.items.find((x) => x.id === 'mcp:searxng')!.ready.hubSetup!;
    expect(searxng).toMatchObject({ commands: [], refusal: 'nothing', byHand: [{ bin: 'npx', run: 'sudo apt-get install -y npm', root: true }] });
    const p = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:semgrep' });
    expect(p.steps.find((s) => s.run === 'uv tool install semgrep')?.hub?.target).toEqual({ step: 0, variant: 0 });
  });
});

describe('search', () => {
  test('curated matches first, then live results, and a search spends one call', async () => {
    const { call } = world();
    const r = await call<CatalogSearchResult>('GET', '/api/catalog/search?q=reverse');
    expect(r.items[0].source).toBe('recommended');
    expect(r.items.some((x) => x.source === 'github')).toBe(true);
    const page = await call<CatalogPage>('GET', '/api/catalog?limit=1');
    expect(page.status.github.remaining).toBe(53);
    await call('GET', '/api/catalog/search?q=reverse');
    expect((await call<CatalogPage>('GET', '/api/catalog?limit=1')).status.github.remaining).toBe(53);
  });
  test('the limit word serves saved results with a note', async () => {
    const { call } = world();
    const r = await call<CatalogSearchResult>('GET', '/api/catalog/search?q=memory%20limit');
    expect(r.note).toMatch(/^GitHub limit reached/);
    expect(r.from).toEqual(['cache']);
  });
});

describe('preview and install', () => {
  test('ponytail: pinned commit, two ways to run it, three node hooks', async () => {
    const { call } = world();
    const p = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'plugin:ponytail' });
    expect(p.sha).toBe('16352ac229eb08a9598dcae48fe9f2b342567d86');
    expect(p.shaFrom).toBe('pinned');
    expect(p.variants.map((v) => v.type)).toEqual(['plugin', 'files']);
    expect(p.hooks.map((h) => h.event)).toEqual(['SessionStart', 'SubagentStart', 'UserPromptSubmit']);
    const off = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'plugin:ponytail', options: { hooks: false } });
    expect(off.hooks).toEqual([]);
    const r = await call<CatalogInstallResult>('POST', '/api/catalog/install', { planId: p.planId, values: {} });
    expect(r.ok).toBe(true);
    expect(r.installed).toMatchObject({ id: 'plugin:ponytail', kind: 'plugin', ref: 'ponytail', matchedBy: 'record' });
    const page = await call<CatalogPage>('GET', '/api/catalog?kind=plugin');
    expect(page.items.find((x) => x.id === 'plugin:ponytail')?.installed?.href).toBe('/extensions/plugins?plugin=ponytail');
  });
  test('inputs follow the picked way to run it; secrets stay out of args and url', async () => {
    const { call } = world();
    const remote = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:context7', variant: 0 });
    expect(remote.inputs).toEqual([]);
    const npx = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:context7', variant: 1 });
    expect(npx.inputs.map((i) => i.name)).toEqual(['CONTEXT7_API_KEY']);
    const gh = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:github' });
    expect(gh.config?.headers?.Authorization).toBe('Bearer ${secret:github-pat}');
    expect(JSON.stringify(gh.config?.args ?? []) + (gh.config?.url ?? '')).not.toContain('secret');
  });
  test('a server whose program is missing fails its test and saves nothing, unless saved disabled', async () => {
    const { call, mcp } = world();
    const p = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:searxng' });
    const r = await call<CatalogInstallResult>('POST', '/api/catalog/install', { planId: p.planId, values: { SEARXNG_URL: 'http://searx.lan' } });
    expect(r.ok).toBe(false);
    expect(r.test?.error).toContain('npx');
    expect(mcp.searxng).toBeUndefined();
    const p2 = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:searxng' });
    const saved = await call<CatalogInstallResult>('POST', '/api/catalog/install', { planId: p2.planId, values: { SEARXNG_URL: 'http://searx.lan' }, saveOnFail: true });
    expect(saved.ok).toBe(true);
    expect((mcp.searxng as { enabled?: boolean }).enabled).toBe(false);
  });
  test('a required input left empty is refused, and a used plan expires', async () => {
    const { call } = world();
    const p = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'mcp:github' });
    await expect(call('POST', '/api/catalog/install', { planId: p.planId, values: {} })).rejects.toMatchObject({ status: 400 });
    const ok = await call<CatalogInstallResult>('POST', '/api/catalog/install', { planId: p.planId, values: { GITHUB_PAT: 'github_pat_x' } });
    expect(ok.ok).toBe(true);
    await expect(call('POST', '/api/catalog/install', { planId: p.planId, values: {} })).rejects.toMatchObject({ status: 409 });
  });
  test('a hook recipe runs its tests and lands in Hooks', async () => {
    const { call, db } = world();
    const p = await call<InstallPreview>('POST', '/api/catalog/preview', { id: 'hook:proxmox-guard' });
    expect(p.files[0].path).toBe('hooks/recipes/proxmox-guard.sh');
    const r = await call<CatalogInstallResult>('POST', '/api/catalog/install', { planId: p.planId, values: {} });
    expect(r.recipeTests?.length).toBeGreaterThan(0);
    expect(r.recipeTests?.every((t) => t.ok)).toBe(true);
    expect(r.installed.href).toBe('/extensions/hooks?event=PreToolUse');
    expect(JSON.stringify(db.config.hooks)).toContain('"recipe":"proxmox-guard"');
  });
  test('recipe routes answer with the hub\'s shapes: needs by program, file, note, scriptPath', async () => {
    const { call } = world();
    // "grep -P" and "jq 1.6+" are checked by their program, as on the hub
    const list = await call<Array<{ id: string; ready: { ok: boolean } }>>('GET', '/api/hooks/recipes');
    expect(list.find((r) => r.id === 'injection-tripwire')?.ready.ok).toBe(true);
    const d = await call<{ scriptPath: string; ready: { ok: boolean } }>('GET', '/api/hooks/recipes/git-work-saver');
    expect(d.scriptPath).toEndWith('/hooks/recipes/git-work-saver.sh');
    const user = await call<{ file: string; note?: string }>('POST', '/api/hooks/recipes/git-work-saver/install', { scope: 'user' });
    expect(user.file).toEndWith('/config.json');
    expect(user.note).toBeUndefined();
    const proj = await call<{ file: string }>('POST', '/api/hooks/recipes/git-work-saver/install', { scope: 'project', cwd: '/home/kai/code/conclave' });
    expect(proj.file).toBe('/home/kai/code/conclave/.conclave/settings.json');
    await expect(call('POST', '/api/hooks/recipes/git-work-saver/install', { scope: 'project', cwd: 'relative' })).rejects.toMatchObject({ status: 400 });
    const codex = await call<{ file: string; note?: string }>('POST', '/api/hooks/recipes/git-work-saver/install', { scope: 'user', target: { cli: 'codex', device: 'arch-desktop' } });
    expect(codex.file).toBe('~/.codex/hooks.json on arch-desktop');
    expect(codex.note).toContain('trust');
  });
  test('routines never install from Discover', async () => {
    const { call } = world();
    await expect(call('POST', '/api/catalog/preview', { id: 'routine:librarian-deep-pass' })).rejects.toMatchObject({ status: 400 });
  });
});
