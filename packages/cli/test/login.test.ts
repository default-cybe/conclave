import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER, startHub, type TestHub } from '../../server/test/helpers';
import { readClientFile } from '../src/files';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
const PASSWORD = 'correct horse battery staple';
let hub: TestHub;
let home: string;

beforeAll(() => {
  hub = startHub();
  home = mkdtempSync(join(tmpdir(), 'conclave-login-'));
});
afterAll(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
});

async function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // the saved login is used only when no hub or token comes from the environment
  const { CONCLAVE_HUB: _hub, CONCLAVE_TOKEN: _token, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    env: { ...env, CONCLAVE_HOME: home, NO_COLOR: '1' },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe('conclave password and login against a hub', () => {
  test('password set, status and clear need the owner token', async () => {
    const owner = ['--hub', hub.url, '--token', OWNER];
    const short = await cli(['password', 'set', ...owner], 'too short\n');
    expect(short.code).toBe(1);
    expect(short.stderr).toContain('The password needs 12 characters or more. Nothing was changed.');

    const set = await cli(['password', 'set', ...owner], `${PASSWORD}\n`);
    expect(set.stderr).not.toContain('Error');
    expect(set.stdout).toContain('Password set.');
    expect(set.stdout).toContain(`Hub key ${hub.running.conclave.ctx.identity.fingerprint.slice(0, 4)} `);
    expect(await hub.api('/api/auth/password').then((r) => r.json())).toMatchObject({ set: true });
    expect((await cli(['password', ...owner])).stdout).toContain('A password is set');

    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const paired = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name: 'phone' } }).then((r) => r.json());
    const asClient = await cli(['password', 'clear', '--hub', hub.url, '--token', paired.token]);
    expect(asClient.code).toBe(1);
    expect(asClient.stderr).toContain('Only the owner token can change the hub password.');
  }, 30_000);

  test('login with a code or the password saves the hub key with the token', async () => {
    const { publicKey, fingerprint } = hub.running.conclave.ctx.identity;
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const withCode = await cli(['login', hub.url, '--code', pairing.code]);
    expect(withCode.stderr).not.toContain('Error');
    expect(withCode.stdout).toContain('Hub key');
    expect(readClientFile(home)).toMatchObject({ hub: hub.url, hubKey: publicKey, fingerprint });

    const withPassword = await cli(['login', hub.url, '--password'], `${PASSWORD}\n`);
    expect(withPassword.stderr).not.toContain('Error');
    const saved = readClientFile(home)!;
    expect(saved).toMatchObject({ hub: hub.url, hubKey: publicKey, fingerprint });
    expect(saved.token).toStartWith('ccl_');

    const wrong = await cli(['login', hub.url, '--password'], 'not the password at all\n');
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('Wrong password, or no password is set on this hub.');

    // the saved login works, key and all
    const list = await cli(['sessions', '--json']);
    expect(list.stderr).toBe('');
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toBeArray();

    expect((await cli(['password', 'clear', '--hub', hub.url, '--token', OWNER])).stdout).toContain('Password removed.');
  }, 30_000);
});
