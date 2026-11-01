/**
 * Minimal Machine for tests, built on node:fs and Bun.spawn. The real
 * LocalMachine lives in machine/local.ts; this one only needs to be good
 * enough for the ACP adapter, importers and usage readers.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath, dirname } from 'node:path';
import * as fs from 'node:fs/promises';
import type { DirEntry, ExecOptions, ExecResult, FileStat, GlobOptions, GrepOptions, GrepResult, Machine, MachineProcess, SpawnOptions } from '../../src/machine/types';
import type { MachineInfo } from '../../src/types';

export class TestMachine implements Machine {
  readonly id: string;
  readonly name: string;
  /** Overrides "~" so tests can point at a fixture home. */
  home: string;
  spawned: Array<{ command: string; args: string[]; cwd: string }> = [];

  constructor(opts: { id?: string; name?: string; home?: string } = {}) {
    this.id = opts.id ?? 'local';
    this.name = opts.name ?? 'test';
    this.home = opts.home ?? homedir();
  }

  async info(): Promise<MachineInfo> {
    return { hostname: 'test', platform: process.platform, arch: process.arch, home: this.home, shell: '/bin/sh', clis: {}, capabilities: [] };
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await fs.lstat(path);
      return { type: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'other', size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(path));
  }

  async readText(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, data);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'other' }));
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.rm(path, { recursive: opts?.recursive, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
    const g = new Bun.Glob(pattern);
    const out: string[] = [];
    for await (const f of g.scan({ cwd: opts.cwd, dot: opts.dot, absolute: true })) out.push(f);
    return out;
  }

  async grep(_opts: GrepOptions): Promise<GrepResult> {
    throw new Error('grep not supported in TestMachine');
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const start = Date.now();
    const proc = Bun.spawn(['sh', '-c', command], { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr, timedOut: false, aborted: false, durationMs: Date.now() - start };
  }

  spawn(command: string, args: string[], opts: SpawnOptions): MachineProcess {
    this.spawned.push({ command, args, cwd: opts.cwd });
    const proc = Bun.spawn([command, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      pid: proc.pid,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      write(data) {
        proc.stdin.write(data);
        proc.stdin.flush();
      },
      closeStdin() {
        try {
          proc.stdin.end();
        } catch {
          // already closed
        }
      },
      kill(signal) {
        proc.kill(signal);
      },
      exited: proc.exited,
    };
  }

  resolve(path: string, cwd: string): string {
    if (path === '~') return this.home;
    if (path.startsWith('~/')) return join(this.home, path.slice(2));
    return isAbsolute(path) ? path : resolvePath(cwd, path);
  }
}
