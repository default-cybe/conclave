/**
 * `conclave people` and `conclave login --account` against a hub
 * (docs/design/ACCOUNTS.md): the owner adds a person with a password and
 * access to a key with a budget, the person logs in with their name, the
 * owner changes their access and removes them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER, startHub, type TestHub } from '../../server/test/helpers';
import { RateLimiter } from '../../server/src/auth';
import { readClientFile } from '../src/files';
import { parseProviders } from '../src/commands/people';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
const PW = 'sams long password';
let hub: TestHub;
let home: string;

beforeAll(() => {
  hub = startHub();
  // the hub has keys to share for these two (the hub refuses access to a provider it has none for)
  const providers = hub.engine.config.get().providers;
  hub.engine.config.update({ providers: { ...providers, anthropic: { ...providers.anthropic, apiKey: 'sk-ant-hub-test' }, openai: { ...providers.openai, apiKey: 'sk-hub-openai-test' } } });
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
  home = mkdtempSync(join(tmpdir(), 'conclave-people-'));
});
afterAll(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
});

async function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe('parseProviders', () => {
  test('a budget after the colon, none for no cap, "none" for no access', () => {
    expect(parseProviders('anthropic:5,openai')).toEqual({ anthropic: { monthlyUsd: 5 }, openai: { monthlyUsd: null } });
    expect(parseProviders('anthropic:$2.5')).toEqual({ anthropic: { monthlyUsd: 2.5 } });
    expect(parseProviders('none')).toEqual({});
    expect(parseProviders(undefined)).toBeUndefined();
    expect(() => parseProviders('anthropic:lots')).toThrow('not a number');
  });
});

describe('conclave people', () => {
  const o = () => ['--hub', hub.url, '--token', OWNER];

  test('add with a password and a budget, then they log in with their name', async () => {
    const add = await cli(['people', 'add', 'sam', '--email', 'sam@example.com', '--password', '--providers', 'anthropic:5', ...o()], `${PW}\n`);
    expect(add.stderr).not.toContain('Error');
    expect(add.stdout).toContain('Added sam.');
    const list = await cli(['people', ...o()]);
    expect(list.stdout).toContain('sam');
    expect(list.stdout).toContain('member');
    expect(list.stdout).toContain('$0.00/$5');

    const login = await cli(['login', hub.url, '--password', '--account', 'sam', '--name', 'laptop'], `${PW}\n`);
    expect(login.stderr).not.toContain('Error');
    expect(login.stdout).toContain('as sam');
    const saved = readClientFile(home);
    expect(saved?.account).toMatchObject({ name: 'sam', role: 'member' });
    // a member cannot manage people
    const denied = await cli(['people', '--hub', hub.url, '--token', saved!.token]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('Only the owner of this hub can do this.');
  }, 30_000);

  test('an invite, access changes, and remove', async () => {
    const add = await cli(['people', 'add', 'kim', '--display-name', 'Kim Lee-Park', ...o()]);
    expect(add.stdout).toContain('/invite/');
    // the display name shows in the list beside the name they sign in with
    expect((await cli(['people', ...o()])).stdout).toContain('Kim Lee-Park');
    const access = await cli(['people', 'access', 'sam', '--providers', 'anthropic:20,openai', ...o()]);
    expect(access.stdout).toContain('anthropic up to $20 a month, openai, no cap');
    const none = await cli(['people', 'access', 'sam', '--providers', 'none', ...o()]);
    expect(none.stdout).toContain("no access to the hub's keys");
    expect((await cli(['people', 'remove', 'sam', ...o()])).code).toBe(1);
    const rm = await cli(['people', 'remove', 'sam', '--yes', ...o()]);
    expect(rm.stdout).toContain('Removed sam.');
    expect((await cli(['people', 'passwd', 'sam', ...o()], 'x\n')).stderr).toContain('Nobody called sam');
  }, 30_000);
});
