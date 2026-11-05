/**
 * `conclave secret set <name>` writes a named secret (kind values) that
 * ${secret:name} reads; `conclave secret <provider>` still writes a
 * provider key (kind providers), as before (issue #266).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER, startHub, type TestHub } from '../../server/test/helpers';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
let hub: TestHub;
let home: string;

beforeAll(() => {
  hub = startHub();
  home = mkdtempSync(join(tmpdir(), 'conclave-secret-cli-'));
});

afterAll(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const { CONCLAVE_HUB: _h, CONCLAVE_TOKEN: _t, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, ENTRY, 'secret', ...args, '--hub', hub.url, '--token', OWNER], { env: { ...env, CONCLAVE_HOME: home, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('conclave secret', () => {
  test('set <name> writes kind values, never prints the value', async () => {
    const value = 'caido-cli-value-0123456789';
    const r = await run('set', 'caido-token', '--value', value);
    expect(r.code).toBe(0);
    expect(hub.engine.config.secretValue('caido-token')).toBe(value);
    expect(hub.engine.config.storedKey('caido-token')).toBeUndefined();
    expect(r.stdout).toContain('Saved the secret caido-token on the hub (caid…)');
    expect(r.stdout).not.toContain(value);
  });

  test('set <name> with a short value prints no prefix', async () => {
    const r = await run('set', 'pin', '--value', 'q7z9');
    expect(r.code).toBe(0);
    expect(hub.engine.config.secretValue('pin')).toBe('q7z9');
    expect(r.stdout + r.stderr).not.toContain('q7z9');
  });

  test('set <name> --delete removes it', async () => {
    expect((await run('set', 'caido-token', '--delete')).code).toBe(0);
    expect(hub.engine.config.secretValue('caido-token')).toBeUndefined();
  });

  test('set refuses a name the hub would refuse', async () => {
    const r = await run('set', 'Bad Name', '--value', 'x');
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('lowercase letters');
  });

  test('<provider> still writes kind providers', async () => {
    const r = await run('anthropic', '--value', 'sk-ant-cli-test-key');
    expect(r.code).toBe(0);
    expect(hub.engine.config.storedKey('anthropic')).toBe('sk-ant-cli-test-key');
    expect(hub.engine.config.secretValue('anthropic')).toBeUndefined();
  });
});
