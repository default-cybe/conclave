/**
 * Discover catalog routes over the fake engine, with the catalog offline
 * (CONCLAVE_CATALOG_OFFLINE=1): shipped data only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { startHub, OWNER, type TestHub } from './helpers';

let hub: TestHub;
let client: ConclaveClient;
const prev = process.env.CONCLAVE_CATALOG_OFFLINE;

beforeAll(() => {
  process.env.CONCLAVE_CATALOG_OFFLINE = '1';
  hub = startHub();
  client = new ConclaveClient({ baseUrl: hub.url, token: OWNER });
});

afterAll(async () => {
  await hub.stop();
  if (prev === undefined) delete process.env.CONCLAVE_CATALOG_OFFLINE;
  else process.env.CONCLAVE_CATALOG_OFFLINE = prev;
});

describe('catalog routes', () => {
  test('GET /api/catalog: the must-haves first, with status', async () => {
    const page = await client.catalog({ limit: 10 });
    expect(page.items.slice(0, 2).map((i) => i.id)).toEqual(['plugin:ponytail', 'plugin:caveman']);
    expect(page.items[0].ready).toBeDefined();
    expect(page.next).toBe('10');
    expect(page.status.github).toMatchObject({ authenticated: false, limit: 60 });
    const hooks = await client.catalog({ kind: 'hook', recommended: true });
    expect(hooks.items.every((i) => i.kind === 'hook' && i.recommended)).toBe(true);
  });

  test('bad queries are 400s and unknown items 404s', async () => {
    expect((await hub.api('/api/catalog?kind=widget')).status).toBe(400);
    expect((await hub.api('/api/catalog/search')).status).toBe(400);
    expect((await hub.api('/api/catalog/items/nope%3Ax')).status).toBe(404);
    expect((await hub.api('/api/catalog/preview', { method: 'POST', json: { id: 'plugin:ponytail', variant: -1 } })).status).toBe(400);
    expect((await hub.api('/api/catalog/install', { method: 'POST', json: { planId: 'nope' } })).status).toBe(409);
    expect((await hub.api('/api/catalog', { token: null })).status).toBe(401);
  });

  test('an id with a colon and slashes survives the path', async () => {
    const d = await client.catalogItem('mcp:basic-memory');
    expect(d.repo).toBe('basicmachines-co/basic-memory');
    // offline: no README, but the detail still answers
    expect(d.readme).toBeUndefined();
  });

  test('a routine preview hands off to the Routines tab and cannot be installed here', async () => {
    const p = await client.catalogPreview({ id: 'routine:librarian-deep-pass' });
    expect(p.handoff?.href).toBe('/routines?suggest=librarian-deep-pass');
    const res = await hub.api('/api/catalog/install', { method: 'POST', json: { planId: p.planId } });
    expect(res.status).toBe(400);
  });

  test('preview then install of a remote MCP server: missing input is a 400 with the names, then it saves and tests', async () => {
    const p = await client.catalogPreview({ id: 'mcp:github' });
    expect(p.config).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${secret:github-pat}' } });
    expect(p.variants.map((v) => v.label)).toEqual(['Remote, hosted by GitHub', 'Docker on the hub, read-only']);
    const missing = await hub.api('/api/catalog/install', { method: 'POST', json: { planId: p.planId, values: {} } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ missing: ['GITHUB_PAT'] });
    const r = await client.catalogInstall({ planId: p.planId, values: { GITHUB_PAT: 'ghp_x' } });
    expect(r).toMatchObject({ ok: true, installed: { kind: 'mcp', ref: 'github', matchedBy: 'record' }, test: { ok: true } });
    expect(hub.engine.config.getUser().mcpServers?.github).toMatchObject({ headers: { Authorization: 'Bearer ${secret:github-pat}' } });
    // the secret is stored, never echoed
    expect(JSON.stringify(r)).not.toContain('ghp_x');
    const installed = await client.catalogInstalled();
    expect(installed.map((i) => i.id)).toEqual(['mcp:github']);
    const audit = await client.audit({ limit: 20 });
    expect(audit.some((a) => a.action === 'catalog.install' && a.detail.startsWith('mcp:github') && a.actor === 'owner')).toBe(true);
    const listed = await client.catalog({ installed: true });
    expect(listed.items.map((i) => i.id)).toContain('mcp:github');
    const rm = await client.catalogRemove('mcp:github', { secrets: true });
    expect(rm.removed).toEqual(['mcpServers.github', 'secret github-pat']);
  });

  test('a hook recipe installs through the hook recipe routes, with the same answer they give', async () => {
    const p = await client.catalogPreview({ id: 'hook:git-work-saver' });
    expect(p.files[0].path).toBe('~/.conclave/hooks/recipes/git-work-saver.sh');
    const recipeRoutes = (await hub.api('/api/hooks/recipes/git-work-saver', {})).status !== 404;
    expect(p.warnings.some((w) => w.text.includes('cannot add hook recipes'))).toBe(!recipeRoutes);
    const res = await hub.api('/api/catalog/install', { method: 'POST', json: { planId: p.planId } });
    if (!recipeRoutes) expect(res.status).toBe(501);
    else {
      const direct = await hub.api('/api/hooks/recipes/git-work-saver/install', { method: 'POST', json: { scope: 'user' } });
      expect(res.status).toBe(direct.status);
    }
  });

  test('status and refresh', async () => {
    const st = await client.catalogStatus();
    expect(st.sources.map((s) => s.id)).toEqual(['shipped', 'marketplaces', 'mcp-registry', 'github', 'star-index', 'awesome-claude-code']);
    expect(st.sources.find((s) => s.id === 'github')?.on).toBe(false);
    expect((await hub.api('/api/catalog/refresh', { method: 'POST', json: { source: 'nope' } })).status).toBe(400);
    await client.catalogRefresh('marketplaces');
    const again = await hub.api('/api/catalog/refresh', { method: 'POST', json: {} });
    expect(again.status).toBe(429);
  });

  test('task import validates its body', async () => {
    expect((await hub.api('/api/tasks/import', { method: 'POST', json: { from: 'other', path: '/x' } })).status).toBe(400);
    expect((await hub.api('/api/tasks/import', { method: 'POST', json: { from: 'agentic-tools-mcp' } })).status).toBe(400);
    expect((await hub.api('/api/tasks/import', { method: 'POST', json: { from: 'agentic-tools-mcp', path: '/x', device: 'nope' } })).status).toBe(404);
  });
});
