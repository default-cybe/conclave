import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  FileStat,
  GlobOptions,
  GrepOptions,
  GrepResult,
  Machine,
  MachineProcess,
  SpawnOptions,
} from '../../src/machine/types';
import type { MachineInfo } from '../../src/types';

/** Make an isolated temp directory, cleaned up by the caller. */
export function tempDir(prefix = 'conclave-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

/** Write a file, creating parent directories. */
export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A real-filesystem Machine for tests. Runs shell commands with Bun.spawn and
 * reads/writes the local disk. `home` is configurable so instruction loading
 * and cli-sync never touch the real home directory.
 */
export class FakeMachine implements Machine {
  readonly id = 'test';
  readonly name = 'test';
  private homeDir: string;
  private clis: Record<string, string>;

  constructor(opts: { home?: string; clis?: Record<string, string> } = {}) {
    this.homeDir = opts.home ?? tempDir('conclave-home-');
    this.clis = opts.clis ?? {};
  }

  get home(): string {
    return this.homeDir;
  }

  async info(): Promise<MachineInfo> {
    return {
      hostname: 'test',
      platform: process.platform,
      arch: process.arch,
      home: this.homeDir,
      shell: '/bin/sh',
      clis: this.clis,
      capabilities: [],
    };
  }

  resolve(path: string, cwd: string): string {
    if (path.startsWith('~')) return join(this.homeDir, path.slice(1));
    if (isAbsolute(path)) return path;
    return join(cwd, path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const f = Bun.file(path);
    if (await f.exists()) return { type: 'file', size: f.size, mtimeMs: 0 };
    try {
      const { statSync } = await import('node:fs');
      const st = statSync(path);
      return { type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, data);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const { readdirSync, statSync } = await import('node:fs');
    return readdirSync(path).map((name) => {
      const st = statSync(join(path, name));
      return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.size } as DirEntry;
    });
  }

  async mkdir(path: string): Promise<void> {
    mkdirSync(path, { recursive: true });
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    rmSync(path, { recursive: opts?.recursive ?? false, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const { renameSync } = await import('node:fs');
    renameSync(from, to);
  }

  async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
    const g = new Bun.Glob(pattern);
    const out: string[] = [];
    for await (const f of g.scan({ cwd: opts.cwd, absolute: true })) out.push(f);
    return out;
  }

  async grep(_opts: GrepOptions): Promise<GrepResult> {
    return { output: '', total: 0, truncated: false };
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const start = Date.now();
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr, timedOut: false, aborted: false, durationMs: Date.now() - start };
  }

  spawn(command: string, args: string[], opts: SpawnOptions): MachineProcess {
    const proc = Bun.spawn([command, ...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    return {
      pid: proc.pid,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      write: (data) => (proc.stdin as unknown as { write: (d: string | Uint8Array) => void }).write(data),
      closeStdin: () => (proc.stdin as unknown as { end: () => void }).end(),
      kill: (signal) => proc.kill(signal as never),
      exited: proc.exited,
    };
  }
}
