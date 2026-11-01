/**
 * What the hub knows about the machine it runs on, so it can say where to
 * run a command and whether it can do the job itself:
 *
 * - where it runs: an LXC container (with its Proxmox CT id when the
 *   container's disk name gives it), Docker, another container, a VM or a
 *   machine of its own;
 * - whether the root helper (root-helper.ts) is installed and sudo lets the
 *   hub's user run it;
 * - the one-time command that installs the helper, as root on this machine.
 *
 * Every input can be passed in (HostProbe), so tests describe a machine
 * without being on one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { ROOT_HELPER_PATH, ROOT_HELPER_SUDOERS, helperActions, helperVersion, ROOT_HELPER_VERSION, type HubPlaceDto, type RootHelperAction, type RootHelperDto } from './root-helper';

export type { HubPlaceDto, RootHelperDto } from './root-helper';

export interface HostProbe {
  env: Record<string, string | undefined>;
  uid?: number;
  user?: string;
  exists(path: string): boolean;
  read(path: string): string | undefined;
  /** stat: owner, mode bits, mtime. undefined when it is not there. */
  stat(path: string): { uid: number; mode: number; mtimeMs: number; size: number; file: boolean } | undefined;
  /** Run a program with a short timeout: its exit code and output. */
  run(argv: string[]): { code: number; stdout: string };
  realpath(path: string): string;
  /** process.execPath and the script bun runs. */
  execPath: string;
  main: string;
}

export function probeHost(): HostProbe {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    /* no passwd entry */
  }
  return {
    env: process.env,
    uid: process.getuid?.(),
    user,
    exists: existsSync,
    read: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    stat: (p) => {
      try {
        const s = statSync(p);
        return { uid: s.uid, mode: s.mode, mtimeMs: s.mtimeMs, size: s.size, file: s.isFile() };
      } catch {
        return undefined;
      }
    },
    run: (argv) => {
      try {
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
        return { code: r.status ?? 1, stdout: r.stdout ?? '' };
      } catch {
        return { code: 127, stdout: '' };
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    execPath: process.execPath,
    main: typeof Bun !== 'undefined' ? Bun.main : (process.argv[1] ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Where the hub runs
// ---------------------------------------------------------------------------

/**
 * The Proxmox CT id from /proc/self/mountinfo: the root mount's source or
 * root names the container's disk, subvol-100-disk-0 on ZFS or a directory,
 * pve-vm--100--disk--0 on LVM-thin. Undefined for storage that names no id
 * (a loop device, Ceph).
 */
export function ctidFromMountinfo(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const f = left.split(' ');
    // 36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw
    if (f[4] !== '/') continue;
    const source = right.split(' ')[1] ?? '';
    for (const s of [source, f[3] ?? '']) {
      const m = /(?:^|[/_])(?:subvol|vm|basevol|base)-(\d+)-disk-\d+/.exec(s) ?? /(?:^|[/-])vm--(\d+)--disk--\d+/.exec(s);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** The container systemd-detect-virt or the files it reads name: lxc, docker, podman, or undefined for none. */
function containerKind(p: HostProbe): string | undefined {
  const r = p.run(['systemd-detect-virt', '--container']);
  const said = r.stdout.trim();
  if (r.code === 0 && said && said !== 'none') return said;
  if (r.code === 1 && said === 'none') return undefined;
  // no systemd-detect-virt: what it would have read
  const file = p.read('/run/systemd/container')?.trim();
  if (file) return file;
  const env1 = p.read('/proc/1/environ');
  const m = env1 ? /(?:^|\0)container=([^\0]+)/.exec(env1) : null;
  if (m) return m[1];
  if (p.exists('/run/.containerenv')) return 'podman';
  return undefined;
}

let placeCache: HubPlaceDto | undefined;

/** Where the hub runs. Kept for the life of the process: it does not change. */
export function hubPlace(p?: HostProbe): HubPlaceDto {
  if (!p && placeCache) return placeCache;
  const probe = p ?? probeHost();
  const place = detectPlace(probe);
  if (!p) placeCache = place;
  return place;
}

function detectPlace(p: HostProbe): HubPlaceDto {
  // the image sets CONCLAVE_INSTALL=docker; /.dockerenv covers images built before that
  if (p.env.CONCLAVE_INSTALL === 'docker' || p.exists('/.dockerenv')) return { kind: 'docker' };
  const c = containerKind(p);
  if (c === 'lxc' || c === 'lxc-libvirt') {
    const ctid = ctidFromMountinfo(p.read('/proc/self/mountinfo'));
    return { kind: 'lxc', ...(ctid ? { ctid } : {}) };
  }
  if (c === 'docker') return { kind: 'docker' };
  if (c) return { kind: 'container', virt: c };
  const v = p.run(['systemd-detect-virt', '--vm']);
  const vm = v.stdout.trim();
  if (v.code === 0 && vm && vm !== 'none') return { kind: 'vm', virt: vm };
  return { kind: 'bare' };
}

// ---------------------------------------------------------------------------
// The root helper, from the hub's side
// ---------------------------------------------------------------------------

/** The program root should run for `system-helper install` on this machine. */
export function helperInstallCommand(p: HostProbe): string {
  const sub = 'system-helper install';
  // setup.sh's /usr/local/bin/conclave runs as the conclave user when root starts it;
  // one from before system-helper would drop root, so the binary it wraps is named
  const wrapper = p.read('/usr/local/bin/conclave');
  if (wrapper !== undefined) {
    if (/runuser/.test(wrapper) && !/system-helper/.test(wrapper) && p.exists('/opt/conclave/bin/conclave')) return `/opt/conclave/bin/conclave ${sub}`;
    return `conclave ${sub}`;
  }
  // the install script's ~/.local/bin is on the hub user's PATH, not root's: the full path
  const compiled = /^(\/\$bunfs\/|[A-Z]:[\\/]~BUN[\\/])/i.test(p.main);
  if (compiled) return `${shellWord(p.realpath(p.execPath))} ${sub}`;
  if (p.main && /packages\/cli\/src\/index\.ts$/.test(p.main)) return `${shellWord(p.execPath)} ${shellWord(p.main)} ${sub}`;
  return `conclave ${sub}`;
}

function shellWord(s: string): string {
  return /^[\w.,=+@:/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** sudo -l answers are kept while the files they depend on stay the same. */
const sudoCache = new Map<string, boolean>();

/** Forget the kept sudo answers (after the owner installed or removed the helper). */
export function forgetHelperFacts(): void {
  sudoCache.clear();
}

/**
 * The root helper as the hub sees it, for one action. It never runs the
 * helper: it reads the file, sees the sudoers drop-in is there (it cannot
 * read it), and asks sudo -n -l whether it may run it, which needs no
 * password and changes nothing.
 */
export function rootHelperStatus(action: RootHelperAction, p: HostProbe = probeHost()): RootHelperDto {
  const install = helperInstallCommand(p);
  const asRoot = p.uid === 0;
  const st = p.stat(ROOT_HELPER_PATH);
  if (!st || !st.file) return { installed: false, ready: false, install };
  const text = p.read(ROOT_HELPER_PATH) ?? '';
  // a helper anyone but root could change is not one to run as root
  if (st.uid !== 0 || (st.mode & 0o022) !== 0) return { installed: false, ready: false, install, problem: `${ROOT_HELPER_PATH} is not root's alone. Install it again as root.` };
  if (!helperActions(text).includes(action)) return { installed: false, ready: false, install, problem: `The root helper is from an older Conclave and cannot do ${action}. Install it again.` };
  const outdated = (helperVersion(text) ?? 0) < ROOT_HELPER_VERSION;
  const base = { installed: true, install, ...(outdated ? { outdated } : {}) };
  if (asRoot) return { ...base, ready: true, asRoot };
  const status = p.read('/proc/self/status');
  if (status && /^NoNewPrivs:\s*1/m.test(status)) return { ...base, ready: false, problem: "The hub's service does not allow sudo (NoNewPrivileges). Remove that setting from its unit and restart it." };
  const sudoers = p.stat(ROOT_HELPER_SUDOERS);
  if (!sudoers) return { ...base, ready: false, problem: `The sudo rule is missing (${ROOT_HELPER_SUDOERS}). Install the helper again.` };
  const sudo = ['/usr/bin/sudo', '/bin/sudo', '/usr/local/bin/sudo'].find((s) => p.exists(s));
  if (!sudo) return { ...base, ready: false, problem: 'sudo is not installed. Installing the helper again adds it.' };
  const key = `${p.user}\0${st.mtimeMs}\0${st.size}\0${sudoers.mtimeMs}\0${action}`;
  let ok = sudoCache.get(key);
  if (ok === undefined) {
    ok = p.run([sudo, '-n', '-l', ROOT_HELPER_PATH, action]).code === 0;
    sudoCache.set(key, ok);
  }
  if (!ok) return { ...base, ready: false, problem: `sudo does not let ${p.user ?? "the hub's user"} run the helper. Install it again as root; it finds the hub's user.` };
  return { ...base, ready: true };
}
