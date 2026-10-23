/**
 * How this program was installed, which decides how it updates. Read from
 * what the process can see: where its binary is, the cgroup systemd put it
 * in, and a few markers. Every input can be passed in, so tests describe a
 * machine without being on one.
 */
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HubInstallDto } from '../client/updates';
import { RELEASES_REPO } from './manifest';

export interface InstallProbe {
  platform: string;
  env: Record<string, string | undefined>;
  /** process.execPath: the compiled conclave binary, or bun. */
  execPath: string;
  /** The script bun runs (Bun.main), when it is not a compiled binary. */
  main: string;
  uid?: number;
  /** /proc/self/cgroup. */
  cgroup?: string;
  exists: (path: string) => boolean;
  writable: (path: string) => boolean;
  realpath: (path: string) => string;
}

export function probeThisProcess(): InstallProbe {
  let cgroup: string | undefined;
  try {
    cgroup = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    /* not Linux */
  }
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    main: typeof Bun !== 'undefined' ? Bun.main : (process.argv[1] ?? ''),
    uid: process.getuid?.(),
    cgroup,
    exists: existsSync,
    writable: (p) => {
      try {
        accessSync(p, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
  };
}

/** A binary bun compiled: its own modules live in a virtual /$bunfs (B:/~BUN on Windows). */
export function isCompiled(main: string): boolean {
  return /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(main);
}

/** The systemd unit this process runs in, from /proc/self/cgroup: its name and whether it is a user unit. */
export function systemdUnit(cgroup: string | undefined): { unit: string; scope: 'user' | 'system' } | undefined {
  if (!cgroup) return undefined;
  for (const line of cgroup.split('\n')) {
    const path = line.split(':').slice(2).join(':');
    if (!path) continue;
    const parts = path.split('/').filter(Boolean);
    const unit = [...parts].reverse().find((p) => p.endsWith('.service'));
    if (!unit) continue;
    // user@1000.service holds the user's own units; the hub's is the last .service under it
    if (/^user@\d+\.service$/.test(unit)) continue;
    const scope = parts.some((p) => /^user@\d+\.service$/.test(p)) ? 'user' : 'system';
    // systemd-run's own transient units (run-u12.service) are not a service someone installed
    if (/^run-/.test(unit)) return undefined;
    return { unit, scope };
  }
  return undefined;
}

/** Linux x64 CPUs without AVX2 need Bun's baseline build (install.sh checks the same). Undefined elsewhere. */
export function hasAvx2(cpuinfo?: string): boolean | undefined {
  if (process.platform !== 'linux' || process.arch !== 'x64') return undefined;
  try {
    return /\bavx2\b/.test(cpuinfo ?? readFileSync('/proc/cpuinfo', 'utf8'));
  } catch {
    return undefined;
  }
}

export const INSTALL_SCRIPT = `curl -fsSL https://github.com/${RELEASES_REPO}/releases/latest/download/install.sh | sh`;
export const DOCKER_COMMAND = 'docker compose pull && docker compose up -d';
/** The root helper setup.sh installs for a hub in a container or VM. */
export const HELPER_PATH_UNIT = '/etc/systemd/system/conclave-update.path';

export interface HubInstall extends HubInstallDto {
  /** The service to restart, and how. */
  unit?: string;
  scope?: 'user' | 'system';
  /** How the finisher starts: systemd-run (user, or a root hub) or the path unit (a hub in a container run by setup.sh). */
  helper?: 'systemd-run' | 'path-unit';
}

/** How this hub was installed and whether Update now can run (docs/DESIGN.md, Updates). */
export function detectHubInstall(p: InstallProbe = probeThisProcess()): HubInstall {
  const { env } = p;
  // the image sets CONCLAVE_INSTALL=docker; /.dockerenv covers images built before that
  if (env.CONCLAVE_INSTALL === 'docker' || p.exists('/.dockerenv')) {
    return { kind: 'docker', canUpdate: false, why: 'This hub runs in Docker. Pull the new image where your docker-compose.yml is; the volume keeps your data.', command: DOCKER_COMMAND };
  }
  // the desktop app runs its hub with this set (serve.ts STOP_ON_STDIN_END), and updates it with itself
  if (env.CONCLAVE_STOP_ON_STDIN_END === '1') {
    return { kind: 'desktop', canUpdate: false, why: 'The desktop app runs this hub. It updates with the app.' };
  }
  if (!isCompiled(p.main)) {
    const lxc = p.exists('/etc/conclave/setup.conf');
    return {
      kind: 'source',
      canUpdate: false,
      why: lxc ? 'This hub was installed from source by setup.sh. Run setup again to update it.' : 'This hub runs from a source checkout.',
      command: lxc ? 'conclave-lxc.sh update <ctid>   (or in the container: sh setup.sh)' : 'git pull && bun install',
    };
  }
  const exe = p.realpath(p.execPath);
  const dir = dirname(exe);
  if (p.platform === 'win32') {
    return { kind: 'manual', canUpdate: false, dir, why: 'On Windows the hub updates by hand.', command: `Download conclave-windows-x64.zip from https://github.com/${RELEASES_REPO}/releases/latest` };
  }
  const svc = p.platform === 'linux' && env.INVOCATION_ID ? systemdUnit(p.cgroup) : undefined;
  if (!svc) {
    return { kind: 'manual', canUpdate: false, dir, why: 'This hub is not run by a service, so it cannot restart itself. Run the install script again, then start the hub again.', command: INSTALL_SCRIPT };
  }
  // restarting some other service would be wrong: only a unit named for Conclave is the hub's
  if (!/conclave/i.test(svc.unit)) return { kind: 'manual', canUpdate: false, dir, why: `This hub runs inside ${svc.unit}, which is not a Conclave service.`, command: INSTALL_SCRIPT };
  const base = { dir, unit: svc.unit, scope: svc.scope };
  if (!p.exists(join(dir, 'web')) || !/^conclave(\.exe)?$/.test(basename(exe))) {
    return { kind: 'manual', canUpdate: false, ...base, why: `${dir} is not a Conclave release folder.`, command: INSTALL_SCRIPT };
  }
  if (svc.scope === 'user') {
    if (!p.writable(dir) || !p.writable(dirname(dir))) return { kind: 'systemd-user', canUpdate: false, ...base, why: `The hub cannot write ${dir}.`, command: INSTALL_SCRIPT };
    return { kind: 'systemd-user', canUpdate: true, ...base, helper: 'systemd-run' };
  }
  // a system service: as root the hub can do it all; otherwise the helper setup.sh installs swaps it in
  if (p.uid === 0) return { kind: 'systemd-system', canUpdate: true, ...base, helper: 'systemd-run' };
  if (p.exists(HELPER_PATH_UNIT)) return { kind: 'systemd-system', canUpdate: true, ...base, helper: 'path-unit' };
  return {
    kind: 'systemd-system',
    canUpdate: false,
    ...base,
    why: 'This hub was set up before updates from the app. Run setup once more to turn them on.',
    command: 'conclave-lxc.sh update <ctid>   (or in the container: sh setup.sh)',
  };
}

// ---------------------------------------------------------------------------
// The TypeScript daemon (`conclave daemon`)
// ---------------------------------------------------------------------------

export interface DaemonInstall {
  /** self: it can update itself. app: the desktop app's copy. manual: by hand, `why` says how. */
  mode: 'self' | 'app' | 'manual';
  why?: string;
  /** The release folder it runs from. */
  dir?: string;
  /** How it comes back after it exits: the service manager restarts it. */
  restart?: 'systemd' | 'launchd';
}

/** The desktop app keeps its daemon in a folder with bundled.stamp (packages/desktop/src-tauri/src/computer.rs). */
export function appManaged(exeDir: string, exists: (p: string) => boolean): boolean {
  return exists(join(exeDir, 'bundled.stamp')) || /\.app\/Contents\/MacOS$/.test(exeDir) || /\/\.mount_[^/]+/.test(exeDir);
}

export function detectDaemonInstall(p: InstallProbe = probeThisProcess()): DaemonInstall {
  if (!isCompiled(p.main)) return { mode: 'manual', why: 'This daemon runs from a source checkout: git pull.' };
  const exe = p.realpath(p.execPath);
  const dir = dirname(exe);
  if (appManaged(dir, p.exists)) return { mode: 'app', why: 'The desktop app updates this daemon with itself.' };
  if (p.platform === 'win32') return { mode: 'manual', dir, why: 'On Windows this daemon updates by hand: download the new conclave-windows-x64.zip.' };
  if (basename(exe) !== 'conclave' || !p.exists(join(dir, 'web'))) {
    // only the install script's release folder is swapped as a whole
    return { mode: 'manual', dir, why: `${dir} is not a Conclave release folder. Run the install script again.` };
  }
  const unit = p.platform === 'linux' && p.env.INVOCATION_ID ? systemdUnit(p.cgroup) : undefined;
  const restart = unit && /conclave/i.test(unit.unit) ? 'systemd' : p.platform === 'darwin' && p.env.XPC_SERVICE_NAME === 'dev.conclave.daemon' ? 'launchd' : undefined;
  if (!restart) return { mode: 'manual', dir, why: 'This daemon is not run by its service, so it cannot restart itself. Run conclave daemon install --start, then update from the hub.' };
  if (!p.writable(dir) || !p.writable(dirname(dir))) return { mode: 'manual', dir, why: `The daemon cannot write ${dir}.` };
  return { mode: 'self', dir, restart };
}
