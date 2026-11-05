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
  test('is the owner only', () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/settings/SettingsPage.tsx'), 'utf8');
    const def = src.slice(src.indexOf("id: 'secrets'"), src.indexOf("id: 'secrets'") + 400);
    expect(def).toContain('C: SecretsSection');
    expect(def).toContain('owner: true');
    expect(def).not.toContain('member:');
  });
});
