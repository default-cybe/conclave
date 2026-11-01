import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeHub, type FakeHub } from './fake-hub';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
let hub: FakeHub;
let home: string;

beforeAll(() => {
  hub = startFakeHub();
  home = mkdtempSync(join(tmpdir(), 'conclave-run-'));
});
afterAll(() => hub.stop());

async function run(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args, '--hub', hub.url, '--token', hub.token], {
    env: { ...process.env, CONCLAVE_HOME: home, NO_COLOR: '1', CONCLAVE_HUB: '', CONCLAVE_TOKEN: '' },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe('conclave run against a fake hub', () => {
  test('streams assistant text to stdout and exits 0', async () => {
    const r = await run(['run', 'say hello']);
    expect(r.stderr).not.toContain('Error');
    expect(r.stdout).toBe('Hello world!\n');
    expect(r.code).toBe(0);
    expect(hub.requests).toContain('POST /api/sessions');
  }, 15_000);

  test('denies approvals without --yes and prints tool lines to stderr', async () => {
    const before = hub.approvals.length;
    const r = await run(['run', 'please approve this']);
    expect(r.code).toBe(0);
    expect(hub.approvals.length).toBe(before + 1);
    expect(hub.approvals.at(-1)!.response.decision).toBe('deny');
    expect(r.stdout).toContain('Cleaning up.');
    expect(r.stdout).toContain('Skipped the cleanup.');
    expect(r.stderr).toContain('Denied: Run: rm -rf build');
  }, 15_000);

  test('--yes allows approvals', async () => {
    const r = await run(['run', 'approve it', '--yes']);
    expect(r.code).toBe(0);
    expect(hub.approvals.at(-1)!.response).toEqual({ decision: 'allow', scope: 'once' });
    expect(r.stdout).toContain('Done.');
  }, 15_000);

  test('escape codes in tool output are shown, not sent to the terminal', async () => {
    const r = await run(['run', 'print the escape codes']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('⎿ ␛]52;c;ZXZpbA==␇notes');
    expect(r.stderr).not.toContain('\x1b]52');
  }, 15_000);

  test('exits 1 when the session errors', async () => {
    const r = await run(['run', 'fail now']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('provider exploded');
  }, 15_000);

  test('--json prints JSON lines ending with run.done', async () => {
    const r = await run(['run', 'hi', '--json']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].type).toBe('run.session');
    expect(lines.some((l) => l.type === 'message.delta')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: 'run.done', exitCode: 0, status: 'idle' });
  }, 15_000);

  test('reads the prompt from stdin', async () => {
    const r = await run(['run', 'summarize'], 'some piped text');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Hello world!\n');
    const sent = [...hub.messages.values()].flat().filter((m) => m.role === 'user').at(-1)!;
    const text = (sent.content[0] as { text: string }).text;
    expect(text).toContain('summarize');
    expect(text).toContain('<stdin>\nsome piped text\n</stdin>');
  }, 15_000);

  test('-p is an alias for run', async () => {
    const r = await run(['-p', 'hello there']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Hello world!\n');
  }, 15_000);
});
