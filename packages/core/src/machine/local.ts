import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { MachineInfo } from '../types';
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
} from './types';
import { syncthingFolders, syncthingStatus, type SyncthingFolder, type SyncthingStatus } from './syncthing';
import { loopbackProcess } from './connect';
import { PRIVATE_REFUSAL, assertNotHubPrivate, commandTouchesHubPrivate, hubPrivateDirs, privateRefusal, startsWithPrivate } from './private';

const INFO_TTL_MS = 5 * 60_000;
const KILL_GRACE_MS = 3_000;
/** How long to keep draining pipes after the main process exits (children may hold them open). */
const DRAIN_GRACE_MS = 500;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 4_000;

const CLI_NAMES = ['claude', 'codex', 'opencode', 'gemini', 'git', 'rg', 'docker', 'node', 'bun', 'python3'];
const CHROMIUM_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge', 'brave-browser'];

// ---------------------------------------------------------------------------
// Process group bookkeeping. Children run in their own process group so a
// timeout or kill takes down the whole tree (bash plus anything it started).
// ---------------------------------------------------------------------------

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pid: number | undefined): void {
  if (!pid) return;
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const p of liveGroups) killTree(p, 'SIGKILL');
    });
  }
}

function untrackGroup(pid: number | undefined): void {
  if (pid) liveGroups.delete(pid);
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group leader or already gone */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** Keeps the first and last part of a long stream and drops the middle. */
class HeadTailBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(max: number) {
    this.headMax = Math.floor(max / 2);
    this.tailMax = max - this.headMax;
  }

  push(s: string): void {
    if (this.head.length < this.headMax) {
      const take = this.headMax - this.head.length;
      this.head += s.slice(0, take);
      s = s.slice(take);
      if (!s) return;
    }
    this.tail += s;
    if (this.tail.length > this.tailMax * 2) {
      const cut = this.tail.length - this.tailMax;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  toString(): string {
    let tail = this.tail;
    let dropped = this.dropped;
    if (tail.length > this.tailMax) {
      dropped += tail.length - this.tailMax;
      tail = tail.slice(tail.length - this.tailMax);
    }
    if (!dropped) return this.head + tail;
    return `${this.head}\n[... ${dropped} characters of output dropped ...]\n${tail}`;
  }
}

async function readAllText(stream: ReadableStream<Uint8Array> | null | undefined, maxBytes = 32 * 1024 * 1024): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
  } catch {
    /* stream closed */
  }
  return out;
}

/** Paths outside the hub's private folders (machine/private.ts). */
function withoutPrivate(paths: string[]): string[] {
  const dirs = hubPrivateDirs();
  return paths.filter((p) => !dirs.some((d) => p === d || p.startsWith(d + nodePath.sep)));
}

function globHasMagic(segment: string): boolean {
  return /[*?[\]{}]/.test(segment);
}

function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The hub's own disk and shell. Every built-in tool reaches the world through
 * this class (or a RemoteMachine with the same interface).
 */
/**
 * Variables that hold the hub's own credentials. Shells, hooks and tools the
 * model starts never inherit them, so a session cannot read the hub token or a
 * provider key and send it out. Names in CONCLAVE_PASS_ENV (comma separated)
 * are passed through anyway, for an owner who needs one in their shells.
 */
const HUB_SECRET_ENV = new Set([
  'CONCLAVE_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'CLIPROXY_API_KEY',
  'CLIPROXY_MANAGEMENT_KEY',
  // the Google Maps key, when an install sets it in the environment (maps/service.ts)
  'GOOGLE_MAPS_API_KEY',
  // CLIProxyAPI turns on remote management when it sees this one
  'MANAGEMENT_PASSWORD',
]);

export function isHubSecretEnv(name: string): boolean {
  const pass = (process.env.CONCLAVE_PASS_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (pass.includes(name)) return false;
  if (HUB_SECRET_ENV.has(name)) return true;
  // any other CONCLAVE_ variable that looks like a credential
  return /^CONCLAVE_/.test(name) && /(TOKEN|KEY|SECRET|PASSWORD)/.test(name);
}

export class LocalMachine implements Machine {
  readonly id: string;
  readonly name: string;
  private infoCache?: { at: number; value: MachineInfo };
  private infoPending?: Promise<MachineInfo>;
  private shellPath?: string;
  private rgPath?: string | null;

  constructor(opts: { id?: string; name?: string } = {}) {
    this.id = opts.id ?? 'local';
    this.name = opts.name ?? os.hostname();
  }

  /** Kill every process group this module started that is still running. Call on server shutdown. */
  static killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const pid of liveGroups) killTree(pid, signal);
  }

  // -------------------------------------------------------------------------
  // Info
  // -------------------------------------------------------------------------

  async info(): Promise<MachineInfo> {
    if (this.infoCache && Date.now() - this.infoCache.at < INFO_TTL_MS) return this.infoCache.value;
    if (!this.infoPending) {
      this.infoPending = this.collectInfo()
        .then((value) => {
          this.infoCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.infoPending = undefined;
        });
    }
    return this.infoPending;
  }

  private async collectInfo(): Promise<MachineInfo> {
    const clis: Record<string, string> = {};
    await Promise.all(
      CLI_NAMES.map(async (name) => {
        const bin = Bun.which(name);
        if (!bin) return;
        const version = await this.versionOf(bin);
        clis[name] = version ?? 'unknown';
      }),
    );
    const capabilities: string[] = [];
    if (await this.findChromium()) capabilities.push('browser');
    if (Bun.which('docker')) capabilities.push('docker');
    if (Bun.which('nvidia-smi')) capabilities.push('gpu');
    if (clis.git) capabilities.push('git');
    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      home: os.homedir(),
      shell: process.env.SHELL || this.shell(),
      clis,
      capabilities,
    };
  }

  private async versionOf(bin: string): Promise<string | undefined> {
    try {
      const proc = Bun.spawn([bin, '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env as Record<string, string> });
      const timer = setTimeout(() => proc.kill('SIGKILL'), VERSION_TIMEOUT_MS);
      const [out, err] = await Promise.all([readAllText(proc.stdout, 64 * 1024), readAllText(proc.stderr, 64 * 1024)]);
      await proc.exited;
      clearTimeout(timer);
      const text = (out.trim() || err.trim()).split('\n')[0]?.trim() ?? '';
      if (!text) return undefined;
      const m = text.match(/\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?/);
      return m ? m[0] : text.slice(0, 60);
    } catch {
      return undefined;
    }
  }

  private async findChromium(): Promise<string | undefined> {
    for (const name of CHROMIUM_NAMES) {
      const p = Bun.which(name);
      if (p) return p;
    }
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const c of candidates) {
      if (await this.stat(c).catch(() => null)) return c;
    }
    // Playwright's bundled Chromium
    const pwDirs = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      nodePath.join(os.homedir(), '.cache', 'ms-playwright'),
      nodePath.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    ].filter(Boolean) as string[];
    for (const dir of pwDirs) {
      try {
        const entries = await fs.readdir(dir);
        const hit = entries.find((e) => e.startsWith('chromium'));
        if (hit) return nodePath.join(dir, hit);
      } catch {
        /* missing */
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Syncthing (machine/syncthing.ts): folders from config.xml, status from the local REST API
  // -------------------------------------------------------------------------

  syncthingFolders(): Promise<SyncthingFolder[]> {
    return syncthingFolders(os.homedir());
  }

  syncthingStatus(folderId: string): Promise<SyncthingStatus> {
    return syncthingStatus(folderId, os.homedir());
  }

  // -------------------------------------------------------------------------
  // Chat import (import/wire.ts): the same readers as the hub, on this disk
  // -------------------------------------------------------------------------

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    assertNotHubPrivate(path);
    const fh = await fs.open(path, 'r');
    try {
      const size = (await fh.stat()).size;
      // a size of 0 is also what /proc files show, so those get the whole ask
      const want = Math.max(0, Math.min(length, 64 * 1024 * 1024, size > 0 ? size - Math.max(0, offset) : Infinity));
      const buf = Buffer.alloc(want);
      // fill the buffer: a short read means end of file to callers that read in pieces (machine/remote.ts)
      let bytesRead = 0;
      while (bytesRead < want) {
        const n = (await fh.read(buf, bytesRead, want - bytesRead, Math.max(0, offset) + bytesRead)).bytesRead;
        if (n === 0) break;
        bytesRead += n;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async importScan(params: import('../import/types').ImportScanParams): Promise<import('../import/types').ImportScanWire> {
    const { deviceScan } = await import('../import/wire');
    return deviceScan(this, params);
  }

  async importRead(params: import('../import/types').ImportReadParams): Promise<import('../importers/types').ConvertedSession> {
    const { deviceRead } = await import('../import/wire');
    return deviceRead(this, params);
  }

  async importAppend(params: import('../import/types').ImportAppendParams): Promise<import('../import/types').ImportAppendResult> {
    assertNotHubPrivate(params.path);
    const { appendSession } = await import('../import/writeback');
    return appendSession(params);
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  resolve(path: string, cwd: string): string {
    const home = os.homedir();
    const expand = (p: string) => (p === '~' ? home : p.startsWith('~/') ? nodePath.join(home, p.slice(2)) : p);
    const p = expand(path.trim());
    if (nodePath.isAbsolute(p)) return nodePath.normalize(p);
    return nodePath.resolve(expand(cwd || home), p);
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await fs.stat(path);
      return {
        type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    } catch (err) {
      if (!isEnoent(err)) throw err;
      // A dangling symlink still exists as a link.
      try {
        const l = await fs.lstat(path);
        if (l.isSymbolicLink()) return { type: 'symlink', size: l.size, mtimeMs: l.mtimeMs };
      } catch {
        /* really missing */
      }
      return null;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    assertNotHubPrivate(path);
    const buf = await fs.readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  readText(path: string): Promise<string> {
    try {
      assertNotHubPrivate(path);
    } catch (err) {
      return Promise.reject(err);
    }
    return fs.readFile(path, 'utf8');
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    assertNotHubPrivate(path);
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, data);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    assertNotHubPrivate(path);
    const entries = await fs.readdir(path, { withFileTypes: true });
    const out: DirEntry[] = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other',
    }));
    // Sizes are cheap to add for normal-sized directories.
    if (out.length <= 2000) {
      await Promise.all(
        out.map(async (e) => {
          if (e.type !== 'file') return;
          try {
            e.size = (await fs.lstat(nodePath.join(path, e.name))).size;
          } catch {
            /* raced with a delete */
          }
        }),
      );
    }
    return out;
  }

  async mkdir(path: string): Promise<void> {
    assertNotHubPrivate(path);
    await fs.mkdir(path, { recursive: true });
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    assertNotHubPrivate(path);
    // removing a folder that holds a private one would take it along
    const above = nodePath.resolve(path) + nodePath.sep;
    if (opts.recursive && hubPrivateDirs().some((d) => d.startsWith(above))) throw Object.assign(new Error(PRIVATE_REFUSAL), { code: 'EACCES' });
    await fs.rm(path, { recursive: !!opts.recursive, force: false });
  }

  async rename(from: string, to: string): Promise<void> {
    assertNotHubPrivate(from);
    assertNotHubPrivate(to);
    await fs.mkdir(nodePath.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private hasRg(): string | null {
    if (this.rgPath === undefined) this.rgPath = Bun.which('rg') ?? null;
    return this.rgPath;
  }

  async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
    let cwd = this.resolve(opts.cwd || '.', os.homedir());
    let pat = pattern.trim();
    // Absolute pattern: move the literal prefix into cwd.
    if (nodePath.isAbsolute(pat) || pat.startsWith('~')) {
      const abs = this.resolve(pat, cwd);
      const parts = abs.split(nodePath.sep);
      const idx = parts.findIndex((seg) => globHasMagic(seg));
      if (idx === -1) {
        const st = await this.stat(abs);
        return st && st.type !== 'dir' ? [abs] : [];
      }
      cwd = parts.slice(0, idx).join(nodePath.sep) || nodePath.sep;
      pat = parts.slice(idx).join('/');
    }
    if (pat.startsWith('./')) pat = pat.slice(2);
    const limit = opts.limit ?? 1000;
    const dot = opts.dot ?? /(^|\/)\.[^/.]/.test(pat);
    const st = await this.stat(cwd);
    if (!st || st.type !== 'dir') throw new Error(`Directory does not exist: ${cwd}`);

    const rg = this.hasRg();
    if (rg) {
      const args = ['--files', '--color=never', '--sortr=modified', '--glob', pat];
      if (dot) args.push('--hidden', '--glob', '!.git/');
      if (opts.includeIgnored) args.push('--no-ignore');
      const { stdout, code, stderr } = await this.runSearch([rg, ...args], cwd);
      if (code !== 0 && code !== 1 && !stdout) throw new Error(stderr.trim() || `rg exited with ${code}`);
      const lines = stdout.split('\n').filter(Boolean);
      return withoutPrivate(lines.map((l) => nodePath.resolve(cwd, l))).slice(0, limit);
    }
    return withoutPrivate(await this.globFallback(pat, cwd, limit, dot, !!opts.includeIgnored));
  }

  private async globFallback(pat: string, cwd: string, limit: number, dot: boolean, includeIgnored: boolean): Promise<string[]> {
    // rg treats a slash-free glob as matching at any depth; mirror that.
    const pattern = pat.includes('/') ? pat : `**/${pat}`;
    const g = new Bun.Glob(pattern);
    const skip = /(^|\/)(node_modules|\.git)(\/|$)/;
    const found: Array<{ path: string; mtime: number }> = [];
    for await (const rel of g.scan({ cwd, dot, onlyFiles: true, followSymlinks: false })) {
      if (!includeIgnored && skip.test(rel)) continue;
      const abs = nodePath.join(cwd, rel);
      const st = await this.stat(abs).catch(() => null);
      found.push({ path: abs, mtime: st?.mtimeMs ?? 0 });
      if (found.length >= 50_000) break;
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return found.slice(0, limit).map((f) => f.path);
  }

  async grep(opts: GrepOptions): Promise<GrepResult> {
    const path = this.resolve(opts.path || '.', os.homedir());
    assertNotHubPrivate(path);
    const st = await this.stat(path);
    if (!st) throw new Error(`Path does not exist: ${path}`);
    const cwd = st.type === 'dir' ? path : nodePath.dirname(path);
    const rg = this.hasRg();
    let stdout: string;
    if (rg) {
      const args = ['--color=never', '--no-messages', '--hidden', '--glob', '!.git/', '--max-columns=500', '--max-columns-preview'];
      if (opts.caseInsensitive) args.push('-i');
      if (opts.multiline) args.push('-U', '--multiline-dotall');
      for (const g of splitGlobs(opts.glob)) args.push('--glob', g);
      if (opts.type) args.push('--type', opts.type);
      if (opts.outputMode === 'files') args.push('--files-with-matches', '--sortr=modified');
      else if (opts.outputMode === 'count') args.push('--count', '--with-filename');
      else {
        args.push('--no-heading', '--with-filename');
        if (opts.lineNumbers !== false) args.push('-n');
        if (opts.before) args.push('-B', String(opts.before));
        if (opts.after) args.push('-A', String(opts.after));
      }
      args.push('-e', opts.pattern, '--', path);
      const res = await this.runSearch([rg, ...args], cwd);
      if (res.code === 2 && !res.stdout) throw new Error(res.stderr.trim() || 'ripgrep failed (invalid pattern?)');
      stdout = res.stdout;
    } else {
      const args = ['-r', '-E', '-I'];
      if (opts.caseInsensitive) args.push('-i');
      for (const g of splitGlobs(opts.glob)) args.push(`--include=${g}`);
      args.push('--exclude-dir=.git', '--exclude-dir=node_modules');
      if (opts.outputMode === 'files') args.push('-l');
      else if (opts.outputMode === 'count') args.push('-c');
      else {
        args.push('-H');
        if (opts.lineNumbers !== false) args.push('-n');
        if (opts.before) args.push('-B', String(opts.before));
        if (opts.after) args.push('-A', String(opts.after));
      }
      args.push('-e', opts.pattern, '--', path);
      const res = await this.runSearch(['grep', ...args], cwd);
      if (res.code === 2 && !res.stdout) throw new Error(res.stderr.trim() || 'grep failed');
      stdout = res.stdout;
      // grep -c lists zero counts too.
      if (opts.outputMode === 'count') stdout = stdout.split('\n').filter((l) => l && !/:0$/.test(l)).join('\n');
    }
    let lines = stdout.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // a search above a private folder never shows what is in it
    const priv = hubPrivateDirs().filter((d) => d.startsWith(path + nodePath.sep) || d === path);
    if (priv.length) lines = lines.filter((l) => !startsWithPrivate(l, priv));
    const total = lines.length;
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : undefined;
    lines = lines.slice(offset, limit ? offset + limit : undefined);
    return { output: lines.join('\n'), total, truncated: limit !== undefined && offset + limit < total };
  }

  private async runSearch(cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const proc = Bun.spawn(cmd, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env as Record<string, string> });
    const timer = setTimeout(() => proc.kill('SIGKILL'), SEARCH_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([readAllText(proc.stdout), readAllText(proc.stderr, 256 * 1024)]);
      const code = await proc.exited;
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Processes
  // -------------------------------------------------------------------------

  /** bash when available, else sh. */
  shell(): string {
    if (!this.shellPath) this.shellPath = Bun.which('bash') ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    return this.shellPath;
  }

  private env(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !isHubSecretEnv(k)) base[k] = v;
    // values a caller passes on purpose (an MCP server's env, a harness login) still go through
    return { ...base, ...(extra ?? {}) };
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const started = Date.now();
    const cwd = this.resolve(opts.cwd || '.', os.homedir());
    const fail = (msg: string): ExecResult => ({
      exitCode: 1,
      stdout: '',
      stderr: msg,
      timedOut: false,
      aborted: false,
      durationMs: Date.now() - started,
    });
    const st = await this.stat(cwd).catch(() => null);
    if (!st || st.type !== 'dir') return fail(`Working directory does not exist: ${cwd}`);
    // the Bash tool hands its command over in __CONCLAVE_CMD (tools/bash.ts): that text counts as the command
    const named = `${command}\n${opts.env?.__CONCLAVE_CMD ?? ''}`;
    if (commandTouchesHubPrivate(named, cwd) || hubPrivateDirs().some((d) => cwd === d || cwd.startsWith(d + nodePath.sep))) return fail(privateRefusal(named));
    if (opts.signal?.aborted) return { ...fail('Aborted before start'), exitCode: null, aborted: true };

    const shell = this.shell();
    const argv = shell.endsWith('cmd.exe') ? [shell, '/d', '/s', '/c', command] : [shell, '-c', command];
    let proc: ReturnType<typeof Bun.spawn<'pipe' | 'ignore', 'pipe', 'pipe'>>;
    try {
      proc = Bun.spawn(argv, {
        cwd,
        env: this.env(opts.env),
        stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });
    } catch (err) {
      return fail(`Failed to start shell: ${(err as Error).message}`);
    }
    trackGroup(proc.pid);

    if (opts.stdin !== undefined && proc.stdin && typeof proc.stdin !== 'number') {
      try {
        proc.stdin.write(opts.stdin);
        proc.stdin.end();
      } catch {
        /* process exited early */
      }
    }

    const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const outBuf = new HeadTailBuffer(max);
    const errBuf = new HeadTailBuffer(max);
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    const pump = async (stream: ReadableStream<Uint8Array>, buf: HeadTailBuffer, which: 'stdout' | 'stderr') => {
      const reader = stream.getReader();
      readers.push(reader);
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const s = dec.decode(value, { stream: true });
          if (!s) continue;
          buf.push(s);
          try {
            opts.onOutput?.(s, which);
          } catch {
            /* listener errors must not kill the command */
          }
        }
        const rest = dec.decode();
        if (rest) buf.push(rest);
      } catch {
        /* cancelled */
      }
    };
    const pumps = Promise.all([pump(proc.stdout, outBuf, 'stdout'), pump(proc.stderr, errBuf, 'stderr')]);

    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      killTree(proc.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => killTree(proc.pid, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs)
        : undefined;
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    await proc.exited;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    // Background children can keep the pipes open forever; drain briefly then stop.
    let drained = false;
    await Promise.race([pumps.then(() => (drained = true)), Bun.sleep(DRAIN_GRACE_MS)]);
    if (!drained) for (const r of readers) r.cancel().catch(() => {});
    if (killTimer && !timedOut && !aborted) clearTimeout(killTimer);
    if (timedOut || aborted) {
      // Make sure stragglers in the group die too.
      killTree(proc.pid, 'SIGKILL');
      if (killTimer) clearTimeout(killTimer);
    }
    untrackGroup(proc.pid);

    return {
      exitCode: proc.signalCode ? null : proc.exitCode,
      stdout: outBuf.toString(),
      stderr: errBuf.toString(),
      timedOut,
      aborted,
      durationMs: Date.now() - started,
    };
  }

  spawn(command: string, args: string[], opts: SpawnOptions): MachineProcess {
    const cwd = this.resolve(opts.cwd || '.', os.homedir());
    // a background shell (tools/shells.ts) names its command in the arguments
    const named = [command, ...args].join(' ');
    if (commandTouchesHubPrivate(named, cwd) || hubPrivateDirs().some((d) => cwd === d || cwd.startsWith(d + nodePath.sep))) throw Object.assign(new Error(privateRefusal(named)), { code: 'EACCES' });
    const proc = Bun.spawn([command, ...args], {
      cwd,
      env: this.env(opts.env),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    trackGroup(proc.pid);
    const exited = proc.exited.then(() => {
      untrackGroup(proc.pid);
      return proc.signalCode ? null : proc.exitCode;
    });
    return {
      pid: proc.pid,
      stdout: proc.stdout,
      stderr: proc.stderr,
      write(data: string | Uint8Array) {
        proc.stdin.write(data);
        proc.stdin.flush();
      },
      closeStdin() {
        try {
          proc.stdin.end();
        } catch {
          /* already closed */
        }
      },
      kill(signal = 'SIGTERM') {
        killTree(proc.pid, signal);
      },
      exited,
    };
  }

  connect(port: number): MachineProcess {
    return loopbackProcess(port);
  }
}

/** "*.ts *.tsx" -> ["*.ts", "*.tsx"]. Commas inside braces stay together. */
function splitGlobs(glob?: string): string[] {
  if (!glob) return [];
  return glob
    .split(/\s+/)
    .map((g) => g.trim())
    .filter(Boolean);
}
