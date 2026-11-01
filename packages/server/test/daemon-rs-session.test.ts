/**
 * A session on the hub whose tools run on a device served by the Rust daemon
 * (packages/daemon-rs): the real engine with a scripted model, the real
 * server, the daemon paired with a code and running as its own process.
 * Bash, Write, Read, Edit, Glob and Grep all go through it.
 *
 * Runs when a Rust build is found (CONCLAVE_DAEMON_RS, or under
 * packages/daemon-rs/target); otherwise it is skipped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, toolResults, type TestEngine } from '../../core/test/engine/harness';
import { waitFor } from '../../core/test/machine/fake-machine';
import { startServer, type RunningServer } from '../src/app';

const ROOT = new URL('../../..', import.meta.url).pathname;
const OWNER = 'owner-token-rust-session-0123456789';

function rustBinary(): string | undefined {
  if (process.env.CONCLAVE_DAEMON_RS) return process.env.CONCLAVE_DAEMON_RS;
  const dirs = [process.env.CARGO_TARGET_DIR, join(ROOT, 'packages/daemon-rs/target')].filter(Boolean) as string[];
  for (const d of dirs) for (const p of ['release', 'debug']) if (existsSync(join(d, p, 'conclave-daemon'))) return join(d, p, 'conclave-daemon');
  return undefined;
}

const RUST = rustBinary();
let root: string;
let work: string;
let t: TestEngine;
let running: RunningServer;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let deviceId: string;

describe.skipIf(!RUST)('a hub session on a Rust daemon device', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'conclave-rs-session-'));
    const home = join(root, 'home');
    work = join(home, 'project');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'notes.md'), '# Notes\nnothing yet\n');
    t = await startTestEngine({
      approve: 'allow',
      script: [
        [{ tool: 'Bash', input: { command: 'echo "from $(basename "$PWD") on $(uname -s)"; echo "[$CONCLAVE_TOKEN]"', description: 'where am I' } }],
        [{ tool: 'Write', input: { file_path: join(work, 'hello.txt'), content: 'hello from the hub\n' } }],
        [{ tool: 'Read', input: { file_path: join(work, 'hello.txt') } }],
        [{ tool: 'Edit', input: { file_path: join(work, 'hello.txt'), old_string: 'the hub', new_string: 'the model' } }],
        [{ tool: 'Glob', input: { pattern: '*.txt' } }],
        [{ tool: 'Grep', input: { pattern: 'model', output_mode: 'content' } }],
        [{ text: 'All done on the device.' }],
      ],
    });
    t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
    running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
    const pairing = await fetch(`${running.url}/api/pairing`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'device' }) }).then((r) => r.json());
    const env = { ...process.env, HOME: home, CONCLAVE_HOME: join(root, 'conclave'), CONCLAVE_TOKEN: 'hub-secret', NO_COLOR: '1' } as Record<string, string>;
    // not spawnSync: the hub in this process must answer the pairing request
    const pair = Bun.spawn([RUST!, 'pair', '--hub', running.url, '--code', pairing.code, '--name', 'rust-box', '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(pair.stdout).text(), new Response(pair.stderr).text(), pair.exited]);
    expect(err).toBe('');
    expect(code).toBe(0);
    deviceId = JSON.parse(out).deviceId;
    daemon = Bun.spawn([RUST!, 'run'], { env, stdout: 'ignore', stderr: 'ignore' });
    await waitFor(() => t.engine.devices.isOnline(deviceId), 15_000, 'the Rust daemon online');
  }, 60_000);

  afterAll(async () => {
    daemon?.kill('SIGTERM');
    await daemon?.exited;
    await running?.stop();
    await t?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('Bash and the file tools run on the device', async () => {
    expect(t.engine.devices.list().find((d) => d.id === deviceId)?.info?.daemon?.impl).toBe('rust');
    const s = await t.engine.createSession({ device: deviceId, cwd: work });
    await t.run(s.id, 'Write a hello file on this computer, change it, then find it.');
    const results = toolResults(t.engine, s.id);
    expect(results.map((r) => r.name)).toEqual(['Bash', 'Write', 'Read', 'Edit', 'Glob', 'Grep']);
    for (const r of results) expect(r.isError).toBe(false);
    // the shell ran in the project folder on the device, without the hub's token
    expect(results[0].content).toContain(`from project on ${process.platform === 'darwin' ? 'Darwin' : 'Linux'}`);
    expect(results[0].content).toContain('[]');
    expect(results[2].content).toContain('hello from the hub');
    expect(results[4].content).toContain(join(work, 'hello.txt'));
    expect(results[5].content).toContain('hello from the model');
    expect(readFileSync(join(work, 'hello.txt'), 'utf8')).toBe('hello from the model\n');
    expect(t.rejected).toEqual([]);
  }, 60_000);
});
