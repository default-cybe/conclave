/**
 * Setup's extension packs (catalog/packs.ts) point at real catalog entries.
 *
 *   bun test packages/core/test/catalog/packs.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { RECOMMENDED } from '../../src/catalog/recommended';
import { EXTENSION_PACKS, KEY_HELP } from '../../src/catalog/packs';

const byId = new Map(RECOMMENDED.map((i) => [i.id, i]));

describe('extension packs', () => {
  test('every pack id exists in the catalog, once', () => {
    const all = EXTENSION_PACKS.flatMap((p) => p.items);
    for (const id of all) expect(byId.has(id)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  test('only Starter is on by default', () => {
    expect(EXTENSION_PACKS.filter((p) => p.defaultOn).map((p) => p.id)).toEqual(['starter']);
  });

  test('presets name a tool preset the entry has', () => {
    for (const p of EXTENSION_PACKS)
      for (const [id, preset] of Object.entries(p.presets ?? {})) {
        expect(p.items).toContain(id);
        const ins = byId.get(id)!.install;
        expect(ins.type === 'mcp' && ins.toolPresets?.some((t) => t.id === preset)).toBe(true);
      }
  });

  test('key help covers only inputs the packs ask for', () => {
    const names = new Set(EXTENSION_PACKS.flatMap((p) => p.items).flatMap((id) => (byId.get(id)!.inputs ?? []).map((i) => i.name)));
    for (const k of Object.keys(KEY_HELP)) expect(names.has(k)).toBe(true);
  });

  test('the dropped entries stay out', () => {
    const all = EXTENSION_PACKS.flatMap((p) => p.items);
    for (const id of ['mcp:grafana', 'mcp:radare2', 'mcp:ghidra', 'mcp:mcp-proxy']) expect(all).not.toContain(id);
  });
});
