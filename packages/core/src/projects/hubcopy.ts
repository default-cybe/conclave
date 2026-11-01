/**
 * Move to hub: copy a session's whole project folder from its device to the
 * hub's projects drive, byte for byte (node_modules, build output, .env and
 * .git too), then run the session on the copy. The device folder is left as
 * it was. Move back copies the hub's changes to the device after the owner
 * saw a diff, and never deletes a device file unless asked.
 *
 * Transport: tar. The device runs `tar -c` through Machine.spawn, whose
 * stdout already streams (proc.stdout frames from a daemon, a pipe on the
 * hub), and the hub unpacks it with `tar -x`. tar keeps symlinks, modes and
 * mtimes. Old daemons need no new RPC.
 */
import { existsSync, mkdirSync, statfsSync, accessSync, constants, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Machine, MachineProcess } from '../machine/types';
import type { Session } from '../types';
import type { HubBackFile, HubBackInput, HubBackPreview, HubChange, HubCopyPreview, HubCopyRecord, ManifestEntry, MoveInput, MoveResult } from '../client/projects';
import { EngineError } from '../engine/errors';
import { baseName } from './identity';
import { trimSlash } from './store';
import type { ProjectsService } from './service';

export const DEFAULT_HUB_ROOT = '/srv/conclave-projects';
/** Files under this size get a sha256 in the manifest; bigger ones are compared by size and mtime. */
export const HASH_LIMIT = 50 * 1024 * 1024;
/** Text diffs shown in Move back, and the biggest file one is made for. */
const MAX_DIFFS = 40;
const MAX_DIFF_BYTES = 512 * 1024;
/** Files listed in Move back. Every changed file is copied, listed or not. */
const MAX_LISTED = 500;

/** Where copies go: the configured folder, else /srv/conclave-projects when it is there and writable, else ~/conclave-projects. */
export function hubRoot(configured?: string, home = homedir()): string {
  const c = configured?.trim();
  if (c) return trimSlash(c === '~' ? home : c.startsWith('~/') ? join(home, c.slice(2)) : c);
  try {
    if (statSync(DEFAULT_HUB_ROOT).isDirectory()) {
      accessSync(DEFAULT_HUB_ROOT, constants.W_OK);
      return DEFAULT_HUB_ROOT;
    }
  } catch {
    /* not mounted */
  }
  return join(home, 'conclave-projects');
}

/** Free bytes for an unprivileged user on the disk that holds path (or its nearest existing parent). */
export function freeBytes(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
}

/** What a copy of this size needs free: 5% and 64 MB more for tar's metadata and the manifest. */
export function needed(bytes: number): number {
  return bytes + Math.ceil(bytes * 0.05) + 64 * 1024 * 1024;
}

export function sizeWords(bytes: number): string {
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} bytes` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'device';
}

/** <base>/<name>, or <base>/<name>-2, -3... when taken. */
export function uniqueTarget(base: string, name: string): string {
  const n = safeName(name);
  let p = join(base, n);
  for (let i = 2; existsSync(p); i++) p = join(base, `${n}-${i}`);
  return p;
}

/** Size (du -sk) and entry count of a folder on its device. */
export async function measure(m: Machine, root: string): Promise<{ bytes: number; files: number }> {
  const info = await m.info();
  if (info.platform === 'win32') throw new EngineError(400, 'Move to hub copies with tar, du and find, which a Windows device does not have. Copy the folder another way.');
  const r = await m.exec('du -sk . 2>/dev/null; find . 2>/dev/null | wc -l', { cwd: root, timeoutMs: 10 * 60_000 });
  const [du, count] = r.stdout.trim().split('\n');
  const kb = Number.parseInt(du ?? '', 10);
  const n = Number.parseInt((count ?? '').trim(), 10);
  if (!Number.isFinite(kb) || !Number.isFinite(n)) throw new EngineError(502, `Could not measure ${root}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  // find lists "." too
  return { bytes: kb * 1024, files: Math.max(0, n - 1) };
}

async function drain(stream: ReadableStream<Uint8Array>, onText?: (s: string) => void): Promise<string> {
  const dec = new TextDecoder();
  let tail = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const s = dec.decode(chunk, { stream: true });
    onText?.(s);
    tail = (tail + s).slice(-4000);
  }
  return tail;
}

function lastLines(s: string): string {
  return s.trim().split('\n').slice(-3).join(' ').slice(0, 400);
}

export interface PipeOptions {
  signal: AbortSignal;
  onProgress?: (bytes: number, files: number) => void;
  /** Only these paths (relative, "/" separated); else the whole folder. */
  files?: string[];
}

/**
 * tar a folder (or some files in it) on one machine and unpack it in a folder
 * on another. `to` null is the hub's own disk: tar reads the stream as it
 * writes, so a slow disk slows the sender (backpressure). Resolves with a
 * warning when the sender's tar said something but finished (GNU tar exits 1
 * for "file changed as we read it").
 */
export async function pipeTar(from: Machine, fromDir: string, to: Machine | null, toDir: string, opts: PipeOptions): Promise<{ bytes: number; files: number; warning?: string }> {
  if (opts.signal.aborted) throw abortError();
  const src = from.spawn('tar', ['-cf', '-', '-C', fromDir, ...(opts.files ? ['--null', '-T', '-'] : ['.'])], { cwd: fromDir, env: { COPYFILE_DISABLE: '1' } });
  // "./" first: a name that starts with "-" is never read as an option
  if (opts.files) src.write(opts.files.map((f) => `./${f}\0`).join(''));
  src.closeStdin();
  let bytes = 0;
  let files = 0;
  const tick = () => opts.onProgress?.(bytes, files);
  const countLines = (s: string) => {
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) files++;
    tick();
  };
  let dst: { kill: () => void; exited: Promise<number | null>; out: Promise<string>; err: Promise<string>; feed?: Promise<void> };
  if (!to) {
    const counted = src.stdout.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(c, ctl) {
          bytes += c.byteLength;
          tick();
          ctl.enqueue(c);
        },
      }),
    );
    const p = Bun.spawn(['tar', '-xpvf', '-', '-C', toDir], { stdin: counted, stdout: 'pipe', stderr: 'pipe' });
    dst = { kill: () => p.kill('SIGKILL'), exited: p.exited.then(() => (p.signalCode ? null : p.exitCode)), out: drain(p.stdout, countLines), err: drain(p.stderr) };
  } else {
    // shortcut: a daemon's stdin has no backpressure, so a copy back to a device is paced by the hub's disk; fine for the changed files it sends, add an acked RPC if whole folders go back
    const p: MachineProcess = to.spawn('tar', ['-xpf', '-', '-C', toDir], { cwd: toDir });
    const feed = (async () => {
      for await (const c of src.stdout as unknown as AsyncIterable<Uint8Array>) {
        bytes += c.byteLength;
        tick();
        p.write(c);
      }
      p.closeStdin();
    })();
    dst = { kill: () => p.kill('SIGKILL'), exited: p.exited, out: drain(p.stdout), err: drain(p.stderr), feed };
  }
  const srcErr = drain(src.stderr);
  const onAbort = () => {
    src.kill('SIGKILL');
    dst.kill();
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const [srcCode, dstCode] = await Promise.all([src.exited, dst.exited, dst.feed?.catch(() => undefined)]);
    const [se, , de] = await Promise.all([srcErr, dst.out, dst.err]);
    if (opts.signal.aborted) throw abortError();
    if (srcCode !== 0 && srcCode !== 1) throw new Error(`tar on ${from.name} failed (${srcCode ?? 'killed'}): ${lastLines(se)}`);
    if (dstCode !== 0) throw new Error(`tar on ${to ? to.name : 'the hub'} failed (${dstCode ?? 'killed'}): ${lastLines(de || se)}`);
    tick();
    return { bytes, files, ...(srcCode === 1 ? { warning: lastLines(se) } : {}) };
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }
}

function abortError(): Error {
  return Object.assign(new Error('cancelled'), { name: 'AbortError' });
}

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256');
  for await (const c of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) h.update(c);
  return h.digest('hex');
}

/**
 * Files and symlinks under a folder on the hub's disk, sorted by path.
 * Directories are not listed. `hash` says which files get a sha256 (default:
 * every file under HASH_LIMIT).
 */
export async function manifestOf(dir: string, opts: { signal?: AbortSignal; hash?: (e: ManifestEntry) => boolean } = {}): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];
  const stack = [''];
  while (stack.length) {
    if (opts.signal?.aborted) throw abortError();
    const rel = stack.pop()!;
    for (const e of await fs.readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        stack.push(r);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const abs = join(dir, r);
      const st = await fs.lstat(abs);
      const ent: ManifestEntry = { p: r, t: e.isSymbolicLink() ? 'l' : 'f', s: st.size, m: Math.floor(st.mtimeMs / 1000) };
      if (ent.t === 'l') ent.l = await fs.readlink(abs);
      else if (opts.hash ? opts.hash(ent) : st.size < HASH_LIMIT) ent.h = await sha256(abs);
      out.push(ent);
    }
  }
  return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

/** What changed in a copy on the hub since its manifest. A file only touched (same bytes, new mtime) has not changed. */
export async function hubChanges(dir: string, manifest: ManifestEntry[]): Promise<Map<string, HubChange>> {
  const before = new Map(manifest.map((e) => [e.p, e]));
  // hash only what could be the same bytes with a new mtime
  const now = await manifestOf(dir, { hash: (e) => { const o = before.get(e.p); return !!o?.h && e.s === o.s && e.m !== o.m; } });
  const out = new Map<string, HubChange>();
  for (const e of now) {
    const o = before.get(e.p);
    if (!o) out.set(e.p, 'added');
    else if (o.t !== e.t || (e.t === 'l' ? o.l !== e.l : o.s !== e.s || (o.m !== e.m && (!e.h || e.h !== o.h)))) out.set(e.p, 'changed');
  }
  const seen = new Set(now.map((e) => e.p));
  for (const e of manifest) if (!seen.has(e.p)) out.set(e.p, 'deleted');
  return out;
}

/** Files and symlinks on a device with size and mtime (seconds): one find and stat, GNU or BSD. */
export async function deviceList(m: Machine, root: string): Promise<Map<string, { s: number; m: number }>> {
  const info = await m.info();
  if (info.platform === 'win32') throw new EngineError(400, 'Move back reads the device folder with find and stat, which a Windows device does not have.');
  const fmt = info.platform === 'darwin' || info.platform === 'freebsd' ? "stat -f '%z %m %N'" : "stat -c '%s %Y %n'";
  const r = await m.exec(`find . \\( -type f -o -type l \\) -exec ${fmt} {} +`, { cwd: root, timeoutMs: 10 * 60_000, maxOutputBytes: 512 * 1024 * 1024 });
  if (r.exitCode !== 0 && !r.stdout) throw new EngineError(502, `Could not list ${root} on ${m.name}: ${lastLines(r.stderr)}`);
  const out = new Map<string, { s: number; m: number }>();
  // shortcut: one line per file, so a name with a line break in it is misread; use find -print0 if that ever matters
  for (const line of r.stdout.split('\n')) {
    const hit = /^(\d+) (\d+) \.\/(.+)$/.exec(line);
    if (hit) out.set(hit[3]!, { s: Number(hit[1]), m: Number(hit[2]) });
  }
  return out;
}

/** Paths the device changed since the copy: added, changed (size or mtime) or deleted there. */
export function deviceChanges(now: Map<string, { s: number; m: number }>, manifest: ManifestEntry[]): Set<string> {
  const out = new Set<string>();
  const known = new Set<string>();
  for (const e of manifest) {
    known.add(e.p);
    const d = now.get(e.p);
    if (!d || d.s !== e.s || d.m !== e.m) out.add(e.p);
  }
  for (const p of now.keys()) if (!known.has(p)) out.add(p);
  return out;
}

function binary(b: Uint8Array | undefined): boolean {
  return !!b && b.subarray(0, 8000).includes(0);
}

type Phase = 'measuring' | 'copying' | 'manifest' | 'done' | 'failed' | 'cancelled';

/** Move to hub and Move back for one projects service. */
export class HubCopies {
  /** Copies and copies back running now, per session, to cancel. */
  private running = new Map<string, AbortController>();
  /** Free bytes on the hub; tests replace it. */
  freeSpace: (path: string) => number = freeBytes;

  constructor(private readonly svc: ProjectsService) {}

  root(): string {
    return hubRoot(this.svc.engine.config.get().projects?.hubRoot);
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(this.svc.rootSession(this.svc.engine.requireSession(sessionId)).id);
  }

  record(s: Session): HubCopyRecord | undefined {
    const r = this.svc.rootSession(s).meta?.hubCopy;
    return r && typeof r === 'object' ? (r as HubCopyRecord) : undefined;
  }

  private setRecord(id: string, rec: HubCopyRecord | undefined): void {
    const engine = this.svc.engine;
    engine.patchMeta(id, { hubCopy: rec });
    engine.bus.emit({ type: 'session.updated', session: engine.requireSession(id) });
  }

  private progress(sessionId: string, direction: 'to-hub' | 'back', totals: { bytes?: number; files?: number }) {
    let last = 0;
    const emit = (phase: Phase, bytes = 0, files = 0, line?: string) =>
      this.svc.engine.bus.emit({ type: 'hubcopy.progress', sessionId, direction, phase, bytes, files, ...(totals.bytes !== undefined ? { totalBytes: totals.bytes } : {}), ...(totals.files !== undefined ? { totalFiles: totals.files } : {}), ...(line ? { line } : {}) });
    // twice a second at most
    const tick = (bytes: number, files: number) => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      emit('copying', bytes, files);
    };
    return { emit, tick };
  }

  cancel(sessionId: string): boolean {
    const id = this.svc.rootSession(this.svc.engine.requireSession(sessionId)).id;
    const ac = this.running.get(id);
    ac?.abort();
    return !!ac;
  }

  /** What Move to hub would copy and where, without copying. */
  async preview(sessionId: string): Promise<HubCopyPreview> {
    const s = this.svc.rootSession(this.svc.engine.requireSession(sessionId));
    const m = this.svc.machine(s.device);
    if (!m) throw new EngineError(409, `${this.svc.deviceName(s.device)} is offline.`);
    const src = await this.svc.source(s);
    const { bytes, files } = await measure(m, src.root);
    const base = this.root();
    const target = uniqueTarget(join(base, safeName(this.svc.deviceName(s.device))), baseName(src.root));
    const free = this.freeSpace(base);
    const fits = free >= needed(bytes);
    const record = this.record(s);
    return {
      device: s.device,
      deviceName: this.svc.deviceName(s.device),
      path: src.root,
      target,
      bytes,
      files,
      freeBytes: free,
      fits,
      line: fits ? `${sizeWords(bytes)}, ${files.toLocaleString('en-US')} files to ${target}` : `${sizeWords(bytes)} does not fit: ${sizeWords(free)} free on ${base}.`,
      ...(this.running.has(s.id) ? { running: true } : {}),
      ...(record ? { record } : {}),
    };
  }

  /** Start Move to hub in the background; progress and the outcome land in the session. */
  start(sessionId: string): { line: string } {
    const s = this.svc.engine.requireSession(sessionId);
    this.svc.checkMovable(s);
    if (this.svc.isMoving(s.id) || this.running.has(this.svc.rootSession(s).id)) throw new EngineError(409, 'This session is already moving. Wait for that move to finish.');
    this.svc.track(this.svc.move(s.id, { device: 'local', copy: true }).catch((err: unknown) => this.failed(s.id, 'Move to hub', err)));
    return { line: 'Copying the folder to the hub. Progress shows in this session.' };
  }

  private failed(id: string, what: string, err: unknown): void {
    const cancelled = err instanceof Error && (err.name === 'AbortError' || /cancelled/.test(err.message));
    const msg = err instanceof Error ? err.message : String(err);
    this.svc.engine.notice(id, cancelled ? `${what} cancelled.${what === 'Move to hub' ? ' The partial copy was removed.' : ''}` : `${what} failed. ${msg}`, cancelled ? 'info' : 'warning');
  }

  /** MoveInput.copy, inside the service's move guard: copy, record the manifest, then move to the copy. */
  async toHub(s: Session, input: MoveInput): Promise<MoveResult> {
    const svc = this.svc;
    const engine = svc.engine;
    if (input.device !== 'local') throw new EngineError(400, 'copy moves a session to the hub only (device "local").');
    svc.checkMovable(s);
    const from = svc.machine(s.device);
    const fromName = svc.deviceName(s.device);
    if (!from) return { resolved: false, reason: 'offline', line: `${fromName} is offline.`, candidates: [] };
    const ac = new AbortController();
    this.running.set(s.id, ac);
    let target: string | undefined;
    let mfile: string | undefined;
    const totals: { bytes?: number; files?: number } = {};
    const p = this.progress(s.id, 'to-hub', totals);
    try {
      p.emit('measuring');
      const src = await svc.source(s);
      const m = await measure(from, src.root);
      Object.assign(totals, m);
      if (ac.signal.aborted) throw abortError();
      const base = this.root();
      const free = this.freeSpace(base);
      if (free < needed(m.bytes)) throw new EngineError(409, `${baseName(src.root)} is ${sizeWords(m.bytes)} and ${base} has ${sizeWords(free)} free. Nothing was copied. Free some space or set another projects folder for the hub under Devices.`);
      target = uniqueTarget(join(base, safeName(fromName)), baseName(src.root));
      mkdirSync(target, { recursive: true });
      engine.notice(s.id, `Copying ${src.root} from ${fromName} to the hub at ${target} (${sizeWords(m.bytes)}, ${m.files.toLocaleString('en-US')} files).`, 'info');
      const res = await pipeTar(from, src.root, null, target, { signal: ac.signal, onProgress: p.tick });
      p.emit('manifest', res.bytes, res.files);
      const copiedAt = Date.now();
      const manifest = await manifestOf(target, { signal: ac.signal });
      mfile = join(base, '.conclave', 'manifests', `${s.id}-${copiedAt}.json`);
      await fs.mkdir(dirname(mfile), { recursive: true });
      await Bun.write(mfile, JSON.stringify(manifest));
      // the owner chose this copy: no write gate, and the path pair is learned
      const result = await svc.moveNow(engine.requireSession(s.id), { device: 'local', cwd: src.rel ? join(target, src.rel) : target, remember: true });
      if (!result.resolved) throw new EngineError(409, result.line);
      const files = manifest.length;
      const bytes = manifest.reduce((n, e) => n + e.s, 0);
      this.setRecord(s.id, { device: s.device, deviceName: fromName, root: src.root, rel: src.rel, hubPath: target, copiedAt, manifest: mfile, bytes, files });
      p.emit('done', res.bytes, files, result.line);
      if (res.warning) engine.notice(s.id, `tar on ${fromName} warned while copying: ${res.warning}`, 'warning');
      return result;
    } catch (err) {
      if (target) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      if (mfile) await fs.rm(mfile, { force: true }).catch(() => undefined);
      p.emit(ac.signal.aborted ? 'cancelled' : 'failed', 0, 0, err instanceof Error ? err.message : String(err));
      throw ac.signal.aborted ? new EngineError(409, 'Move to hub cancelled. The partial copy was removed.') : err;
    } finally {
      this.running.delete(s.id);
    }
  }

  private async changes(rec: HubCopyRecord): Promise<{ manifest: ManifestEntry[]; hub: Map<string, HubChange>; device?: Set<string>; deviceSizes?: Map<string, { s: number; m: number }> }> {
    const manifest = JSON.parse(await fs.readFile(rec.manifest, 'utf8')) as ManifestEntry[];
    const hub = await hubChanges(rec.hubPath, manifest);
    const m = this.svc.machine(rec.device);
    if (!m) return { manifest, hub };
    const deviceSizes = await deviceList(m, rec.root);
    const device = deviceChanges(deviceSizes, manifest);
    // a file only touched on the device (same size, new mtime, e.g. .git/index rewritten by git status) has not changed: compare its bytes
    for (const e of manifest) {
      const d = deviceSizes.get(e.p);
      if (!e.h || !d || d.s !== e.s || d.m === e.m || !device.has(e.p)) continue;
      const bytes = await m.readFile(join(rec.root, e.p)).catch(() => undefined);
      if (bytes && new Bun.CryptoHasher('sha256').update(bytes).digest('hex') === e.h) device.delete(e.p);
    }
    return { manifest, hub, device, deviceSizes };
  }

  /** What Move back would copy: the hub's changes since the copy, conflicts and text diffs. */
  async backPreview(sessionId: string): Promise<HubBackPreview> {
    const s = this.svc.rootSession(this.svc.engine.requireSession(sessionId));
    const rec = this.record(s);
    if (!rec) throw new EngineError(404, 'This session was not copied to the hub.');
    const dev = this.svc.machine(rec.device);
    const { manifest, hub, device, deviceSizes } = await this.changes(rec);
    const old = new Map(manifest.map((e) => [e.p, e]));
    const all = [...hub].map(([path, change]) => ({ path, change, conflict: !!device?.has(path) }));
    all.sort((a, b) => Number(b.conflict) - Number(a.conflict) || (a.path < b.path ? -1 : 1));
    const files: HubBackFile[] = [];
    let diffs = 0;
    for (const f of all.slice(0, MAX_LISTED)) {
      const hubAbs = join(rec.hubPath, f.path);
      const st = f.change === 'deleted' ? undefined : await fs.lstat(hubAbs).catch(() => undefined);
      const before = deviceSizes ? deviceSizes.get(f.path)?.s : old.get(f.path)?.s;
      const row: HubBackFile = { ...f, ...(before !== undefined ? { before } : {}), ...(st ? { after: st.size } : {}) };
      const small = (n?: number) => n === undefined || n <= MAX_DIFF_BYTES;
      if (diffs < MAX_DIFFS && (!st || st.isFile()) && small(before) && small(st?.size)) {
        const a = dev && before !== undefined ? await dev.readFile(join(rec.root, f.path)).catch(() => undefined) : undefined;
        const b = st ? await fs.readFile(hubAbs).catch(() => undefined) : undefined;
        if (binary(a) || binary(b)) row.binary = true;
        else if (a || b) {
          const dec = new TextDecoder();
          row.diff = createTwoFilesPatch(`${rec.deviceName}/${f.path}`, `hub/${f.path}`, a ? dec.decode(a) : '', b ? dec.decode(b) : '', undefined, undefined, { context: 3 });
          diffs++;
        }
      }
      files.push(row);
    }
    const conflicts = all.filter((f) => f.conflict).length;
    const deviceOnly = device ? [...device].filter((p) => !hub.has(p)).length : 0;
    const devicePath = rec.rel ? join(rec.root, rec.rel) : rec.root;
    const line = !dev
      ? `${rec.deviceName} is offline. Changes on the device cannot be checked until it is back.`
      : `${all.length} ${all.length === 1 ? 'file' : 'files'} changed on the hub since the copy${conflicts ? `, ${conflicts} also changed on ${rec.deviceName}` : ''}.`;
    return { device: rec.device, deviceName: rec.deviceName, online: !!dev, devicePath, hubPath: rec.hubPath, files, conflicts, deviceOnly, truncated: all.length > MAX_LISTED, line };
  }

  /** Start Move back in the background. */
  startBack(sessionId: string, input: HubBackInput): { line: string } {
    const s = this.svc.engine.requireSession(sessionId);
    this.svc.checkMovable(s);
    const rec = this.record(s);
    if (!rec) throw new EngineError(404, 'This session was not copied to the hub.');
    if (!this.svc.machine(rec.device)) throw new EngineError(409, `${rec.deviceName} is offline.`);
    if (this.svc.isMoving(s.id) || this.running.has(this.svc.rootSession(s).id)) throw new EngineError(409, 'This session is already moving. Wait for that move to finish.');
    this.svc.track(this.svc.withMoveLock(s.id, () => this.back(s.id, input)).catch((err: unknown) => this.failed(s.id, 'Move back', err)));
    return { line: `Copying the hub's changes back to ${rec.deviceName}.` };
  }

  /**
   * Copy the hub's changes back to the device folder (all, or without the
   * files the device changed too), delete files removed on the hub only when
   * asked, then move the session back there.
   */
  async back(sessionId: string, input: HubBackInput): Promise<MoveResult> {
    const svc = this.svc;
    const engine = svc.engine;
    const s = svc.rootSession(engine.requireSession(sessionId));
    svc.checkMovable(s);
    const rec = this.record(s);
    if (!rec) throw new EngineError(404, 'This session was not copied to the hub.');
    const dev = svc.machine(rec.device);
    if (!dev) throw new EngineError(409, `${rec.deviceName} is offline.`);
    const hubM = svc.machine('local');
    if (!hubM) throw new EngineError(500, 'The hub has no machine of its own.');
    const ac = new AbortController();
    this.running.set(s.id, ac);
    try {
      const { hub, device } = await this.changes(rec);
      const keep = (p: string) => !input.skipConflicts || !device?.has(p);
      const copy = [...hub].filter(([p, c]) => c !== 'deleted' && keep(p)).map(([p]) => p);
      const del = input.deleteRemoved ? [...hub].filter(([p, c]) => c === 'deleted' && keep(p)).map(([p]) => p) : [];
      const skipped = [...hub.keys()].filter((p) => !keep(p)).length;
      const p = this.progress(s.id, 'back', { files: copy.length });
      p.emit('copying');
      if (copy.length) await pipeTar(hubM, rec.hubPath, rec.device === 'local' ? null : dev, rec.root, { signal: ac.signal, files: copy, onProgress: p.tick });
      for (const f of del) {
        if (ac.signal.aborted) throw abortError();
        await dev.remove(join(rec.root, f));
      }
      const result = await svc.moveNow(engine.requireSession(s.id), { device: rec.device, cwd: rec.rel ? join(rec.root, rec.rel) : rec.root });
      if (!result.resolved) throw new EngineError(409, result.line);
      this.setRecord(s.id, undefined);
      const line = `Copied ${copy.length} ${copy.length === 1 ? 'file' : 'files'} back to ${rec.deviceName} at ${rec.root}${del.length ? `, deleted ${del.length}` : ''}${skipped ? `, left ${skipped} that changed on ${rec.deviceName} too as it has them` : ''}. The hub copy stays at ${rec.hubPath}.`;
      engine.notice(s.id, line, 'info');
      p.emit('done', 0, copy.length, line);
      return result;
    } catch (err) {
      this.svc.engine.bus.emit({ type: 'hubcopy.progress', sessionId: s.id, direction: 'back', phase: ac.signal.aborted ? 'cancelled' : 'failed', bytes: 0, files: 0, line: err instanceof Error ? err.message : String(err) });
      throw ac.signal.aborted ? new EngineError(409, 'Move back cancelled. Files already copied stay on the device.') : err;
    } finally {
      this.running.delete(s.id);
    }
  }
}
