/**
 * `conclave config set` falls back to the local config file only when no
 * local hub answers; a hub's refusal is an error, never a write to the file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER, startHub, type TestHub } from '../../server/test/helpers';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
let hub: TestHub;
let home: string;

beforeAll(() => {
  hub = startHub();
  home = mkdtempSync(join(tmpdir(), 'conclave-config-cli-'));
});

afterAll(async () => {
  await hub.stop();
  rmSync(home, { recursive: true, force: true });
});

async function run(port: string, token: string, ...args: string[]) {
  const { CONCLAVE_HUB: _h, CONCLAVE_TOKEN: _t, CONCLAVE_HOST: _o, CONCLAVE_PORT: _p, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, ENTRY, 'config', 'set', ...args], { env: { ...env, CONCLAVE_HOME: home, CONCLAVE_PORT: port, CONCLAVE_TOKEN: token, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('conclave config set', () => {
  test('a change the running hub refuses (here a wrong token, 401) is an error and stays out of the local file', async () => {
    const r = await run(new URL(hub.url).port, 'wrong-token', 'server.port', '7799');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('401');
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  test('with no hub running it goes to the local file', async () => {
    const r = await run('1', OWNER, 'server.port', '7799');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ server: { port: 7799 } });
  });
});
