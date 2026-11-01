/**
 * Setup's "Make Conclave better" step (features/onboarding/packs.ts): one
 * field per input name, skip on an empty key, a re-run skips what is
 * installed, and members never reach setup.
 *
 *   bun test packages/web/test/onboarding-packs.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { RECOMMENDED } from '@conclave/core/catalog/recommended';
import { EXTENSION_PACKS } from '@conclave/core/catalog/packs';
import { ApiError, type CatalogInstallRequest, type CatalogItemDto, type CatalogPreviewRequest, type InstallPreview } from '@conclave/core/client';
import { installAll, keyFields, packIds, skipReason, type Row } from '../src/features/onboarding/packs';
import { setupRedirect } from '../src/lib/onboarding';

const dto = (id: string, extra: Partial<CatalogItemDto> = {}): CatalogItemDto => ({ ...RECOMMENDED.find((x) => x.id === id)!, ready: { ok: true, missing: [] }, ...extra });

function fakeHub(installed = new Set<string>()) {
  const sent: CatalogInstallRequest[] = [];
  return {
    sent,
    deps: {
      preview: async (r: CatalogPreviewRequest) => ({ planId: `plan:${r.id}`, inputs: RECOMMENDED.find((x) => x.id === r.id)!.inputs ?? [], needs: [], options: r.options }) as unknown as InstallPreview,
      install: async (r: CatalogInstallRequest) => {
        const id = r.planId.slice(5);
        if (installed.has(id)) throw new ApiError(409, 'It is already installed.');
        sent.push(r);
        installed.add(id);
        return { ok: true, installed: { id, kind: 'mcp', ref: id, href: '/', matchedBy: 'record' }, warnings: [], next: [] } as never;
      },
    },
  };
}

async function runAll(items: CatalogItemDto[], values: Record<string, string>, saved: string[], deps: ReturnType<typeof fakeHub>['deps']) {
  const rows: Record<string, Row> = {};
  await installAll(items, values, saved, deps, (id, r) => (rows[id] = r));
  return rows;
}

describe('extension packs in setup', () => {
  test('pack ids all exist in the catalog', () => {
    for (const id of packIds(EXTENSION_PACKS.map((p) => p.id))) expect(RECOMMENDED.some((x) => x.id === id)).toBe(true);
  });

  test('keys are deduped by input name', () => {
    const a = dto('mcp:github');
    const b = { ...dto('mcp:context7'), name: 'Other', inputs: [{ ...a.inputs![0] }] };
    const f = keyFields([a, b], []);
    expect(f.filter((x) => x.name === 'GITHUB_PAT')).toHaveLength(1);
    expect(f[0].for).toEqual(['GitHub MCP Server', 'Other']);
    expect(keyFields([a], ['github-pat'])[0].saved).toBe(true);
    expect(keyFields([dto('mcp:github', { installed: { id: 'mcp:github', kind: 'mcp', ref: 'github', href: '/', matchedBy: 'record' } })], [])).toEqual([]);
  });

  test('an empty required key skips the entry, others still install', async () => {
    const hub = fakeHub();
    const rows = await runAll([dto('mcp:github'), dto('mcp:context7')], {}, [], hub.deps);
    expect(rows['mcp:github']).toEqual({ state: 'skipped', why: 'Missing key' });
    expect(rows['mcp:context7'].state).toBe('done');
    expect(hub.sent.map((r) => r.planId)).toEqual(['plan:mcp:context7']);
    // a key already saved on the hub counts
    expect(skipReason(dto('mcp:github'), {}, ['github-pat'])).toBeUndefined();
  });

  test('a filled key is sent with the install, and a missing hub program is named', async () => {
    const hub = fakeHub();
    const uvx = { bin: 'uvx', where: 'hub' as const, why: '' };
    const rows = await runAll([dto('mcp:github'), dto('mcp:markitdown', { ready: { ok: false, missing: [uvx] } })], { GITHUB_PAT: ' ghp_x ' }, [], hub.deps);
    expect(hub.sent[0].values).toEqual({ GITHUB_PAT: 'ghp_x' });
    expect(rows['mcp:markitdown']).toEqual({ state: 'skipped', why: 'Needs uvx on the hub' });
  });

  test('a re-run skips what is installed', async () => {
    const hub = fakeHub();
    await runAll([dto('mcp:context7')], {}, [], hub.deps);
    // the list now says installed
    const again = await runAll([dto('mcp:context7', { installed: { id: 'mcp:context7', kind: 'mcp', ref: 'context7', href: '/', matchedBy: 'record' } })], {}, [], hub.deps);
    expect(again['mcp:context7']).toEqual({ state: 'skipped', why: 'Already installed' });
    // a stale list: the hub's 409 still reads as installed, not failed
    const stale = await runAll([dto('mcp:context7')], {}, [], hub.deps);
    expect(stale['mcp:context7']).toEqual({ state: 'skipped', why: 'Already installed' });
    expect(hub.sent).toHaveLength(1);
  });

  test('members never see setup', () => {
    expect(setupRedirect(false, false, '/')).toBeUndefined();
    expect(setupRedirect(false, false, '/setup/extensions')).toBe('/');
    expect(setupRedirect(false, true, '/welcome')).toBe('/');
    expect(setupRedirect(true, false, '/')).toBe('/welcome');
    expect(setupRedirect(true, false, '/setup/extensions')).toBeUndefined();
  });
});
