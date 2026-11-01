/**
 * Two "devices" over the local disk for folder tests (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.14).
 *
 * A HomeMachine is a LocalMachine with its own id, name and home. It cannot
 * see the other device's home: paths there read as missing, and a shell
 * command that names them gets a path that does not exist. So the pc copy at
 * <base>/pc/code/portfolio is not on "mac", as on two real computers.
 * Syncthing folders come from <home>/.config/syncthing/config.xml, and the
 * folder status is whatever the test sets.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalMachine } from '../../src/machine/local';
import { syncthingFolders, type SyncthingFolder, type SyncthingStatus } from '../../src/machine/syncthing';
import type { DirEntry, ExecOptions, ExecResult, FileStat, GlobOptions, GrepOptions, GrepResult, MachineProcess, SpawnOptions } from '../../src/machine/types';
import type { Device, MachineInfo } from '../../src/types';
import type { Engine } from '../../src/engine/engine';

const MISSING = '/nonexistent-conclave-other-device';

export class HomeMachine extends LocalMachine {
  readonly home: string;
  /** Homes of the other devices: hidden from this one. */
  others: string[] = [];
  /** Syncthing status per folder id, as the test wants it. */
  status: Record<string, SyncthingStatus> = {};
  execs: string[] = [];

  constructor(id: string, name: string, home: string) {
    super({ id, name });
    this.home = home;
  }

  private hidden(p: string): boolean {
    return this.others.some((o) => p === o || p.startsWith(o + '/'));
  }

  private hide(text: string): string {
    let out = text;
    for (const o of this.others) out = out.split(o).join(MISSING);
    return out;
  }

  infoNow(): MachineInfo {
    return { hostname: this.name, platform: 'linux', arch: 'x64', home: this.home, shell: '/bin/bash', clis: { git: '2' }, capabilities: [] };
  }

  override async info(): Promise<MachineInfo> {
    return this.infoNow();
  }

  override resolve(path: string, cwd: string): string {
    if (path === '~') return this.home;
    if (path.startsWith('~/')) return join(this.home, path.slice(2));
    return super.resolve(path, cwd);
  }

  override async stat(path: string): Promise<FileStat | null> {
    return this.hidden(path) ? null : super.stat(path);
  }
  override async readFile(path: string): Promise<Uint8Array> {
    if (this.hidden(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return super.readFile(path);
  }
  override async readText(path: string): Promise<string> {
    if (this.hidden(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return super.readText(path);
  }
  override async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    if (this.hidden(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
    return super.writeFile(path, data);
  }
  override async readdir(path: string): Promise<DirEntry[]> {
    if (this.hidden(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return super.readdir(path);
  }
  override async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
    if (this.hidden(opts.cwd)) return [];
    return super.glob(pattern, opts);
  }
  override async grep(opts: GrepOptions): Promise<GrepResult> {
    if (this.hidden(opts.path)) return { output: '', total: 0, truncated: false };
    return super.grep(opts);
  }
  override async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    this.execs.push(command);
    return super.exec(this.hide(command), { ...opts, cwd: this.hidden(opts.cwd) ? '/' : opts.cwd, env: { ...(opts.env ?? {}), HOME: opts.env?.HOME ?? this.home } });
  }
  override spawn(command: string, args: string[], opts: SpawnOptions): MachineProcess {
    return super.spawn(command, args, { ...opts, cwd: this.hidden(opts.cwd) ? '/' : opts.cwd });
  }

  override syncthingFolders(): Promise<SyncthingFolder[]> {
    return syncthingFolders(this.home, {});
  }
  override async syncthingStatus(folderId: string): Promise<SyncthingStatus> {
    return this.status[folderId] ?? { state: 'idle', needFiles: 0, needBytes: 0, pullErrors: 0 };
  }
}

/** Run a command and fail loudly (fixtures only). */
export function sh(cmd: string, cwd = '/'): string {
  const p = Bun.spawnSync(['bash', '-c', cmd], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
  if (p.exitCode !== 0) throw new Error(`${cmd}\n${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

const GIT = 'git -c user.email=t@t -c user.name=t -c init.defaultBranch=main -c commit.gpgsign=false';

/** A repo with three commits and a GitHub-style origin URL. Each one has its own history (a random seed file). */
export function makeRepo(path: string, remote = 'git@github.com:kai/portfolio.git'): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, '.seed'), `${crypto.randomUUID()}\n`);
  sh(`${GIT} init -q . && echo one > README.md && mkdir -p src && echo a > src/a.ts && ${GIT} add -A && ${GIT} commit -qm one && echo two >> README.md && ${GIT} commit -qam two && echo three >> README.md && ${GIT} commit -qam three && git remote add origin ${remote}`, path);
  return sh('git rev-parse HEAD', path);
}

/** Clone a repo to dest and point its origin at the same remote URL. */
export function cloneRepo(src: string, dest: string, opts: { shallow?: boolean; remote?: string } = {}): void {
  mkdirSync(join(dest, '..'), { recursive: true });
  sh(`git clone -q ${opts.shallow ? `--depth 1 file://${src}` : src} ${dest} && git -C ${dest} remote set-url origin ${opts.remote ?? 'git@github.com:kai/portfolio.git'}`, '/');
}

export function commit(path: string, file: string, text: string): string {
  writeFileSync(join(path, file), text);
  sh(`${GIT} add -A && ${GIT} commit -qm "${file}"`, path);
  return sh('git rev-parse HEAD', path);
}

/** A Syncthing config.xml in <home>/.config/syncthing with the given folders. */
export function writeSyncthing(home: string, folders: Array<{ id: string; label?: string; path: string; paused?: boolean }>): void {
  const dir = join(home, '.config', 'syncthing');
  mkdirSync(dir, { recursive: true });
  const xml = `<configuration version="37">
${folders.map((f) => `    <folder id="${f.id}" label="${f.label ?? f.id}" path="${f.path}" type="sendreceive" rescanIntervalS="3600">
        <device id="AAAA" introducedBy=""></device>
        <paused>${f.paused ? 'true' : 'false'}</paused>
    </folder>`).join('\n')}
    <gui enabled="true" tls="false" debugging="false">
        <address>127.0.0.1:8384</address>
        <apikey>SECRET-KEY-NEVER-LEAVES</apikey>
    </gui>
</configuration>
`;
  writeFileSync(join(dir, 'config.xml'), xml);
}

export interface TwoDevices {
  base: string;
  pc: HomeMachine;
  mac: HomeMachine;
  cleanup(): void;
}

/** Two devices under one temp folder (conclave-paths-*): pc and mac, each one the engine knows. */
export function twoDevices(engine: Engine, opts: { pcRoots?: string[]; macRoots?: string[] } = {}): TwoDevices {
  const base = mkdtempSync(join(tmpdir(), 'conclave-paths-'));
  const pcHome = join(base, 'pc');
  const macHome = join(base, 'mac');
  mkdirSync(pcHome, { recursive: true });
  mkdirSync(macHome, { recursive: true });
  const pc = new HomeMachine('pc', 'arch-desktop', pcHome);
  const mac = new HomeMachine('mac', 'macbook', macHome);
  pc.others = [macHome];
  mac.others = [pcHome];
  for (const [m, roots] of [
    [pc, opts.pcRoots ?? []],
    [mac, opts.macRoots ?? []],
  ] as const) {
    engine.repos.devices.insert({ id: m.id, name: m.name, tokenHash: 'test', roots: [...roots] });
    attach(engine, m);
  }
  return { base, pc, mac, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function attach(engine: Engine, m: HomeMachine): void {
  const row = engine.repos.devices.get(m.id)!;
  const device: Device = { ...row, online: true, info: m.infoNow() };
  engine.devices.attach(device, m);
}

export function detach(engine: Engine, id: string): void {
  engine.devices.detach(id);
}
