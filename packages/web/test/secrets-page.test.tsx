/**
 * Settings > Secrets (issue #266): the name rule the hub uses, the MCP
 * form's "Missing." note for a ${secret:name} the hub has no value for, and
 * the section is the owner's only.
 *
 *   bun test packages/web/test/secrets-page.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingSecrets } from '../src/features/extensions/mcp/parts';
import { secretNameError } from '../src/features/settings/secrets';

describe('secret names', () => {
  test('follow SECRET_NAME and refuse one that exists', () => {
    expect(secretNameError('', [])).toBeUndefined();
    expect(secretNameError('caido-token', [])).toBeUndefined();
    expect(secretNameError('my.key_2', [])).toBeUndefined();
    for (const bad of ['Caido', 'a b', 'a/b', 'x'.repeat(65)]) expect(secretNameError(bad, [])).toContain('lowercase');
    expect(secretNameError('caido-token', ['caido-token'])).toContain('Replace');
  });
});

describe('MCP form missing secrets', () => {
  test('names each ${secret:name} the hub has none for, once', () => {
    const fields = ['uvx caido-mcp --token ${secret:caido-token}', '${secret:caido-token}', 'Bearer ${secret:homelab-token}', '${env:HOME}', 'plain'];
    expect(missingSecrets(fields, ['homelab-token'])).toEqual(['caido-token']);
    expect(missingSecrets(fields, ['homelab-token', 'caido-token'])).toEqual([]);
    expect(missingSecrets(fields, undefined)).toEqual(['caido-token', 'homelab-token']);
  });

  test('the form shows the note and links the hint to Settings, Secrets', () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/extensions/mcp/ServerForm.tsx'), 'utf8');
    expect(src).toContain('missing.length > 0');
    expect(src).toContain('href="/settings/secrets"');
  });
});

describe('the section', () => {
  test("a member gets it too, on their own secrets (/api/me/secrets), never the hub's", () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/settings/SettingsPage.tsx'), 'utf8');
    const def = src.slice(src.indexOf("id: 'secrets'"), src.indexOf("id: 'secrets'") + 500);
    expect(def).toContain('C: SecretsSection');
    expect(def).toContain('member: { C: SecretsSection');
    const page = readFileSync(join(import.meta.dir, '../src/features/settings/secrets.tsx'), 'utf8');
    expect(page).toContain("isOwnerNow() ? api().secrets() : api().mySecrets()");
    expect(page).toContain("isOwnerNow() ? api().setSecret('values', name, value) : api().setMySecret(name, value)");
  });

  test('Defaults has a member page of its own', () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/settings/SettingsPage.tsx'), 'utf8');
    const def = src.slice(src.indexOf("id: 'defaults'"), src.indexOf("id: 'defaults'") + 500);
    expect(def).toContain('member: { C: MemberDefaultsSection');
    expect(def).not.toContain('owner: true');
  });
});
