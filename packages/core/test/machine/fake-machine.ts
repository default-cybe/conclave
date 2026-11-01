/**
 * In-memory Machine for protocol tests. Files live in a Map. exec and spawn
 * understand a few toy commands:
 *   exec:  echo <text> | stream <n> | sleep <ms> | exit <code> | cat (echoes stdin) | env <NAME>
 *   spawn: cat (echoes stdin until closed) | yes (prints until killed) | anything else throws ENOENT
 */
import type { MachineInfo } from '../../src/types';
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

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

export class FakeMachine implements Machine {
  readonly id: string;
  readonly name: string;
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['/', '/home', '/home/me']);
  calls: string[] = [];
  killed: string[] = [];

  constructor(id = 'fake', name = 'Fake box') {
    this.id = id;
    this.name = name;
  }

  async info(): Promise<MachineInfo> {
    this.calls.push('info');
    return { hostname: 'fakebox', platform: 'linux', arch: 'x64', home: '/home/me', shell: '/bin/sh', clis: { git: '2.50.0' }, capabilities: ['test'] };
  }

  async stat(path: string): Promise<FileStat | null> {
    const f = this.files.get(path);
    if (f) return { type: 'file', size: f.byteLength, mtimeMs: 1 };
    if (this.dirs.has(path)) return { type: 'dir', size: 0, mtimeMs: 1 };
    return null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw enoent(path);
    return f;
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/') || '/');
  }

  async readdir(path: string): Promise<DirEntry[]> {
    if (!this.dirs.has(path)) throw enoent(path);
    const prefix = path.endsWith('/') ? path : path + '/';
    const out: DirEntry[] = [];
    for (const [p, data] of this.files) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ name: p.slice(prefix.length), type: 'file', size: data.byteLength });
    }
    for (const d of this.dirs) {
      if (d !== path && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) out.push({ name: d.slice(prefix.length), type: 'dir' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path) && !this.dirs.delete(path)) throw enoent(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw enoent(from);
    this.files.delete(from);
    this.files.set(to, f);
  }

  async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
    const ext = pattern.replace(/^\*\*\/\*/, '').replace(/^\*/, '');
    return [...this.files.keys()].filter((p) => p.startsWith(opts.cwd) && p.endsWith(ext)).sort();
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const re = new RegExp(opts.pattern, opts.caseInsensitive ? 'i' : '');
    const lines: string[] = [];
    for (const [p, data] of this.files) {
      if (!p.startsWith(opts.path)) continue;
      new TextDecoder()
        .decode(data)
        .split('\n')
        .forEach((l, i) => re.test(l) && lines.push(`${p}:${i + 1}:${l}`));
    }
    return { output: lines.join('\n'), total: lines.length, truncated: false };
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    this.calls.push(`exec:${command}`);
    const started = Date.now();
    const [cmd, ...rest] = command.split(' ');
    const arg = rest.join(' ');
    const res = (o: Partial<ExecResult>): ExecResult => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      durationMs: Date.now() - started,
      ...o,
    });
    switch (cmd) {
      case 'echo':
        opts.onOutput?.(`${arg}\n`, 'stdout');
        return res({ stdout: `${arg}\n` });
      case 'env':
        return res({ stdout: `${opts.env?.[arg] ?? ''}\n` });
      case 'cat':
        return res({ stdout: opts.stdin ?? '' });
      case 'exit':
        opts.onOutput?.('bye\n', 'stderr');
        return res({ exitCode: Number(arg), stderr: 'bye\n' });
      case 'stream': {
        let out = '';
        for (let i = 0; i < Number(arg); i++) {
          await Bun.sleep(5);
          const line = `line ${i}\n`;
          out += line;
          opts.onOutput?.(line, 'stdout');
        }
        return res({ stdout: out });
      }
      case 'sleep': {
        const ms = Number(arg);
        const outcome = await new Promise<'done' | 'aborted' | 'timeout'>((resolve) => {
          const t = setTimeout(() => resolve('done'), ms);
          const to = opts.timeoutMs ? setTimeout(() => (clearTimeout(t), resolve('timeout')), opts.timeoutMs) : undefined;
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            if (to) clearTimeout(to);
            resolve('aborted');
          });
        });
        if (outcome === 'aborted') return res({ exitCode: null, aborted: true });
        if (outcome === 'timeout') return res({ exitCode: null, timedOut: true });
        return res({});
      }
      default:
        return res({ exitCode: 127, stderr: `${cmd}: command not found\n` });
    }
  }

  spawn(command: string, args: string[], _opts: SpawnOptions): MachineProcess {
    this.calls.push(`spawn:${command} ${args.join(' ')}`.trim());
    if (command !== 'cat' && command !== 'yes') {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
    }
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number | null) => void;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) });
    const exited = new Promise<number | null>((r) => (resolveExit = r));
    let done = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      out.close();
      err.close();
      resolveExit(code);
    };
    if (command === 'yes') {
      timer = setInterval(() => !done && out.enqueue(new TextEncoder().encode('y\n')), 5);
    }
    const self = this;
    return {
      pid: 4242,
      stdout,
      stderr,
      exited,
      write(data) {
        if (done) return;
        out.enqueue(typeof data === 'string' ? new TextEncoder().encode(data) : data);
      },
      closeStdin() {
        err.enqueue(new TextEncoder().encode('stdin closed\n'));
        finish(0);
      },
      kill(signal = 'SIGTERM') {
        self.killed.push(signal);
        finish(signal === 'SIGKILL' ? 137 : 143);
      },
    };
  }

  resolve(path: string, cwd: string): string {
    if (path.startsWith('/')) return path;
    if (path.startsWith('~')) return '/home/me' + path.slice(1);
    return `${cwd.replace(/\/$/, '')}/${path}`;
  }
}

/** Read a stream to a string. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Wait until pred() is true or fail after ms. */
export async function waitFor(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
