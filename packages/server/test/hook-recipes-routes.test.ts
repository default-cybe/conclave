import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startHub, type TestHub } from './helpers';

/** Hook recipe, lint and built-in routes (docs/design/ECOSYSTEM.md 2.2) over the fake engine with the real recipe service. */

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

describe('hook recipes', () => {
  test('list, get, install, test and remove', async () => {
    const list = await json(await hub.api('/api/hooks/recipes'));
    expect(list.status).toBe(200);
    const trim = list.body.find((r: { id: string }) => r.id === 'test-output-trim');
    expect(trim).toMatchObject({ testCount: 1, installed: [] });
    expect(trim.script).toBeUndefined();
    expect(trim.scriptBytes).toBeGreaterThan(100);

    const one = await json(await hub.api('/api/hooks/recipes/test-output-trim'));
    expect(one.body.script).toContain('#!/usr/bin/env bash');
    expect(one.body.scriptPath).toEndWith('/hooks/recipes/test-output-trim.sh');
    expect((await hub.api('/api/hooks/recipes/nope')).status).toBe(404);

    const bad = await hub.api('/api/hooks/recipes/test-output-trim/install', { method: 'POST', json: { scope: 'user', env: { TEST_TRIM_MIN: 5 } } });
    expect(bad.status).toBe(400);
    const inst = await json(await hub.api('/api/hooks/recipes/test-output-trim/install', { method: 'POST', json: { scope: 'user', env: { TEST_TRIM_MIN: '7000' } } }));
    expect(inst.status).toBe(200);
    expect(inst.body.installed).toMatchObject({ scope: 'user', env: { TEST_TRIM_MIN: '7000' } });
    expect(inst.body.tests.length).toBe(1);
    const saved = hub.engine.calls.filter((c) => c.method === 'saveHooks').at(-1)!.args[0] as { hooks: any };
    expect(saved.hooks.PostToolUse[0].hooks[0]).toMatchObject({ recipe: 'test-output-trim', timeout: 10 });
    expect(saved.hooks.PostToolUse[0].hooks[0].command).toStartWith("TEST_TRIM_MIN='7000' ");

    const after = await json(await hub.api('/api/hooks/recipes'));
    expect(after.body.find((r: { id: string }) => r.id === 'test-output-trim').installed[0].scope).toBe('user');

    const tests = await json(await hub.api('/api/hooks/recipes/secrets-firewall/test', { method: 'POST' }));
    expect(tests.body.length).toBeGreaterThan(0);

    expect((await hub.api('/api/hooks/recipes/test-output-trim?scope=team', { method: 'DELETE' })).status).toBe(400);
    const rm = await json(await hub.api('/api/hooks/recipes/test-output-trim?scope=user', { method: 'DELETE' }));
    expect(rm.body).toEqual({ ok: true, removed: 1 });
  }, 60_000);

  test('project scope needs a folder; unknown targets are refused', async () => {
    const r = await json(await hub.api('/api/hooks/recipes/proxmox-guard/install', { method: 'POST', json: { scope: 'project' } }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/project folder/);
    // a relative folder would land next to wherever the hub was started
    const rel = await json(await hub.api('/api/hooks/recipes/proxmox-guard/install', { method: 'POST', json: { scope: 'project', cwd: 'code/app', skipTests: true } }));
    expect(rel.status).toBe(400);
    expect(rel.body.error).toMatch(/full path/);
    expect((await hub.api('/api/hooks/recipes/proxmox-guard/install', { method: 'POST', json: { scope: 'user', target: { cli: 'vim' } } })).status).toBe(400);
  });
});

describe('hook lint and built-ins', () => {
  test('POST /api/hooks/lint returns issues with fixes', async () => {
    const r = await json(await hub.api('/api/hooks/lint', { method: 'POST', json: { hooks: { PreToolUse: [{ matcher: 'mcp__github', command: 'x' }] } } }));
    expect(r.status).toBe(200);
    expect(r.body.map((i: { text: string }) => i.text).join(' ')).toMatch(/loads as nothing/);
    expect((await hub.api('/api/hooks/lint', { method: 'POST', json: {} })).status).toBe(400);
  });

  test('GET /api/hooks/builtin answers; an unknown id is a 404', async () => {
    expect((await json(await hub.api('/api/hooks/builtin'))).status).toBe(200);
    expect((await hub.api('/api/hooks/builtin/nope', { method: 'PATCH', json: { enabled: true } })).status).toBe(404);
  });
});
