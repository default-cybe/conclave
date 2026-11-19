import { afterAll, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine, findWindowsBash, shellArgv } from '../../src/machine/local';
import { tempDir } from './helpers';

const m = new LocalMachine();
const { dir, cleanup } = tempDir();
afterAll(cleanup);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('LocalMachine', () => {
  test('resolve expands ~ and relative paths', () => {
    expect(m.resolve('~/x', '/tmp')).toBe(join(homedir(), 'x'));
    expect(m.resolve('a/../b', '/srv')).toBe('/srv/b');
    expect(m.resolve('/abs//p', '/srv')).toBe('/abs/p');
    expect(m.resolve('x', '~')).toBe(join(homedir(), 'x'));
  });

  test('files: write creates parents, stat, readdir, rename, remove', async () => {
    const p = join(dir, 'a', 'b', 'c.txt');
    await m.writeFile(p, 'hi');
    expect(await m.readText(p)).toBe('hi');
    expect((await m.stat(p))?.type).toBe('file');
    expect((await m.stat(join(dir, 'a')))?.type).toBe('dir');
    expect(await m.stat(join(dir, 'missing'))).toBeNull();
    const entries = await m.readdir(join(dir, 'a', 'b'));
    expect(entries).toEqual([{ name: 'c.txt', type: 'file', size: 2 }]);
    await m.rename(p, join(dir, 'moved', 'c.txt'));
    expect(await m.stat(p)).toBeNull();
    await m.remove(join(dir, 'moved'), { recursive: true });
    expect(await m.stat(join(dir, 'moved'))).toBeNull();
  });

  test('exec: env merge, stdin, exit codes, streaming', async () => {
    const chunks: string[] = [];
    const r = await m.exec('echo "$FOO"; cat; echo err >&2; exit 4', { cwd: dir, env: { FOO: 'bar' }, stdin: 'piped', onOutput: (c) => chunks.push(c) });
    expect(r.stdout).toBe('bar\npiped');
    expect(r.stderr).toBe('err\n');
    expect(r.exitCode).toBe(4);
    expect(chunks.join('')).toContain('bar');
    expect(r.timedOut).toBe(false);
  });

  test('exec: timeout kills the whole process group', async () => {
    const started = Date.now();
    const r = await m.exec('sleep 20 & sleep 20; echo never', { cwd: dir, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).not.toContain('never');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('exec: abort signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await m.exec('sleep 20', { cwd: dir, signal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  test('exec: output capping keeps head and tail', async () => {
    const r = await m.exec('seq 1 100000', { cwd: dir, maxOutputBytes: 2000 });
    expect(r.stdout.startsWith('1\n2\n3\n')).toBe(true);
    expect(r.stdout.trimEnd().endsWith('100000')).toBe(true);
    expect(r.stdout).toContain('characters of output dropped');
    expect(r.stdout.length).toBeLessThan(2200);
  });

  test('exec: missing cwd is a clean failure', async () => {
    const r = await m.exec('pwd', { cwd: join(dir, 'nope') });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('does not exist');
  });

  test('spawn: streams, stdin and kill', async () => {
    const p = m.spawn('cat', [], { cwd: dir });
    p.write('hello\n');
    p.closeStdin();
    expect(await readAll(p.stdout)).toBe('hello\n');
    expect(await p.exited).toBe(0);

    const s = m.spawn('sleep', ['20'], { cwd: dir });
    s.kill('SIGKILL');
    expect(await s.exited).toBeNull();
  });

  test('cmd.exe runs its line with /d /v:off /s /c', async () => {
    const cmd = new LocalMachine();
    // stands in for cmd.exe: a script that prints the argv it got
    const fake = join(dir, 'cmd.exe');
    await cmd.writeFile(fake, '#!/bin/sh\nprintf "%s|" "$@"\n');
    await cmd.exec(`chmod 755 '${fake}'`, { cwd: dir });
    (cmd as any).shellPath = fake;
    const r = await cmd.exec('ver & call echo x', { cwd: dir });
    expect(r.stdout).toBe('/d|/v:off|/s|/c|ver & call echo x|');
    // a background shell's bash -c goes to cmd.exe too
    const p = cmd.spawn('bash', ['-c', 'ver'], { cwd: dir });
    expect(await new Response(p.stdout as never).text()).toBe('/d|/v:off|/s|/c|ver|');
    expect(shellArgv('C:\\WINDOWS\\system32\\cmd.exe', 'ver')).toEqual(['C:\\WINDOWS\\system32\\cmd.exe', '/d', '/v:off', '/s', '/c', 'ver']);
    expect(shellArgv('/usr/bin/bash', 'ver')).toEqual(['/usr/bin/bash', '-c', 'ver']);
  });

  test('Windows shell: Git Bash, not the WSL launcher', () => {
    const which = (paths: Record<string, string>) => (n: string) => paths[n] ?? null;
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(findWindowsBash({ ProgramFiles: 'C:\\Program Files' }, which({ bash: 'C:\\Windows\\System32\\bash.exe' }), (p) => p === gitBash)).toBe(gitBash);
    expect(findWindowsBash({}, which({ git: 'D:\\Git\\cmd\\git.exe' }), (p) => p === 'D:\\Git\\bin\\bash.exe')).toBe('D:\\Git\\bin\\bash.exe');
    expect(findWindowsBash({}, which({}), () => true)).toBeUndefined();
  });

  test('info lists platform and cached CLIs', async () => {
    const info = await m.info();
    expect(info.platform).toBe(process.platform);
    expect(info.home).toBe(homedir());
    expect(info.clis.bun).toMatch(/^\d+\.\d+/);
    const again = await m.info();
    expect(again).toBe(info);
  });

  test('glob and grep fall back when ripgrep is missing', async () => {
    const fb = new LocalMachine();
    (fb as any).rgPath = null;
    const root = join(dir, 'fallback');
    await fb.writeFile(join(root, 'src', 'a.ts'), 'const needle = 1;\n');
    await fb.writeFile(join(root, 'src', 'deep', 'b.ts'), 'needle again\nNEEDLE upper\n');
    await fb.writeFile(join(root, 'node_modules', 'x', 'c.ts'), 'needle hidden\n');
    const files = await fb.glob('*.ts', { cwd: root });
    expect(files.sort()).toEqual([join(root, 'src', 'a.ts'), join(root, 'src', 'deep', 'b.ts')]);
    expect(await fb.glob('src/*.ts', { cwd: root })).toEqual([join(root, 'src', 'a.ts')]);
    const g = await fb.grep({ pattern: 'needle', path: root, outputMode: 'content', caseInsensitive: true });
    expect(g.output).toContain('b.ts:2:NEEDLE upper');
    expect(g.output).not.toContain('node_modules');
    const c = await fb.grep({ pattern: 'needle', path: root, outputMode: 'count' });
    expect(c.total).toBe(2);
  });
});
