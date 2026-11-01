/**
 * What the hub knows about its machine (system/host.ts): where it runs (an
 * LXC container with its Proxmox CT id, Docker, a VM, a machine of its own),
 * the command root runs to install the helper, and whether the helper is
 * there and sudo lets the hub run it. Every machine here is a description.
 *
 *   bun test packages/core/test/system/host.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { ctidFromMountinfo, forgetHelperFacts, helperInstallCommand, hubPlace, rootHelperStatus, type HostProbe } from '../../src/system/host';
import { ROOT_HELPER_PATH, ROOT_HELPER_SUDOERS, rootHelperScript } from '../../src/system/root-helper';

interface Machine {
  env?: Record<string, string>;
  files?: Record<string, string>;
  /** stat answers: path -> owner and mode. Files in `files` are root's 0644 unless given here. */
  stats?: Record<string, { uid: number; mode: number }>;
  /** systemd-detect-virt answers, or undefined when it is not installed. */
  virt?: { container: string; vm: string };
  uid?: number;
  user?: string;
  /** What sudo -n -l answers. */
  sudoAllows?: boolean;
  execPath?: string;
  main?: string;
}

function probe(m: Machine): HostProbe & { runs: string[][] } {
  const runs: string[][] = [];
  const files = m.files ?? {};
  return {
    runs,
    env: m.env ?? {},
    uid: m.uid ?? 1000,
    user: m.user ?? 'conclave',
    exists: (p) => p in files,
    read: (p) => files[p],
    stat: (p) => {
      if (!(p in files)) return undefined;
      const s = m.stats?.[p] ?? { uid: 0, mode: 0o100644 };
      return { uid: s.uid, mode: s.mode, mtimeMs: 1, size: files[p].length, file: true };
    },
    run: (argv) => {
      runs.push(argv);
      if (argv[0] === 'systemd-detect-virt') {
        if (!m.virt) return { code: 127, stdout: '' };
        const said = argv[1] === '--container' ? m.virt.container : m.virt.vm;
        return { code: said === 'none' ? 1 : 0, stdout: `${said}\n` };
      }
      if (argv[0].endsWith('sudo')) return { code: m.sudoAllows ? 0 : 1, stdout: m.sudoAllows ? `${ROOT_HELPER_PATH} browser-deps\n` : '' };
      return { code: 127, stdout: '' };
    },
    realpath: (p) => (p === '/home/kai/.local/bin/conclave' ? '/home/kai/.local/share/conclave/conclave' : p),
    execPath: m.execPath ?? '/opt/conclave/release/conclave',
    main: m.main ?? '/$bunfs/root/conclave',
  };
}

const LVM = '412 380 253:5 / / rw,relatime master:255 - ext4 /dev/mapper/pve-vm--135--disk--0 rw,stripe=16\n413 412 0:59 / /proc rw - proc proc rw\n';
const ZFS = '600 590 0:62 / / rw,relatime shared:291 - zfs rpool/data/subvol-201-disk-0 rw,xattr,posixacl\n';
const BTRFS = '22 1 0:34 /images/150/subvol-150-disk-0.subvol / rw,relatime - btrfs /dev/sdb1 rw,subvolid=262\n';
const LOOP = '30 1 7:0 / / rw,relatime - ext4 /dev/loop0 rw\n';

describe('where the hub runs', () => {
  test('a Proxmox CT: lxc, with its id from the disk name on LVM-thin, ZFS and btrfs', () => {
    expect(hubPlace(probe({ virt: { container: 'lxc', vm: 'none' }, files: { '/proc/self/mountinfo': LVM } }))).toEqual({ kind: 'lxc', ctid: '135' });
    expect(hubPlace(probe({ virt: { container: 'lxc', vm: 'none' }, files: { '/proc/self/mountinfo': ZFS } }))).toEqual({ kind: 'lxc', ctid: '201' });
    expect(hubPlace(probe({ virt: { container: 'lxc', vm: 'none' }, files: { '/proc/self/mountinfo': BTRFS } }))).toEqual({ kind: 'lxc', ctid: '150' });
    // a loop device names no id: the page shows <CTID>
    expect(hubPlace(probe({ virt: { container: 'lxc', vm: 'none' }, files: { '/proc/self/mountinfo': LOOP } }))).toEqual({ kind: 'lxc' });
  });

  test('lxc without systemd-detect-virt: from /run/systemd/container, or pid 1 environment', () => {
    expect(hubPlace(probe({ files: { '/run/systemd/container': 'lxc\n', '/proc/self/mountinfo': LVM } }))).toEqual({ kind: 'lxc', ctid: '135' });
    expect(hubPlace(probe({ files: { '/proc/1/environ': 'PATH=/bin\0container=lxc\0TERM=linux\0' } }))).toEqual({ kind: 'lxc' });
  });

  test('docker: the image says so, or /.dockerenv, or systemd-detect-virt', () => {
    expect(hubPlace(probe({ env: { CONCLAVE_INSTALL: 'docker' } })).kind).toBe('docker');
    expect(hubPlace(probe({ files: { '/.dockerenv': '' } })).kind).toBe('docker');
    expect(hubPlace(probe({ virt: { container: 'docker', vm: 'none' } })).kind).toBe('docker');
  });

  test('another container, a VM, or a machine of its own', () => {
    expect(hubPlace(probe({ virt: { container: 'podman', vm: 'none' } }))).toEqual({ kind: 'container', virt: 'podman' });
    expect(hubPlace(probe({ files: { '/run/.containerenv': '' } }))).toEqual({ kind: 'container', virt: 'podman' });
    expect(hubPlace(probe({ virt: { container: 'none', vm: 'kvm' } }))).toEqual({ kind: 'vm', virt: 'kvm' });
    expect(hubPlace(probe({ virt: { container: 'none', vm: 'none' } }))).toEqual({ kind: 'bare' });
    expect(hubPlace(probe({}))).toEqual({ kind: 'bare' });
  });

  test('ctidFromMountinfo reads only the root mount', () => {
    expect(ctidFromMountinfo('40 30 0:5 / /mnt rw - zfs rpool/data/subvol-999-disk-0 rw\n' + LOOP)).toBeUndefined();
    expect(ctidFromMountinfo(undefined)).toBeUndefined();
  });
});

describe('the command root runs to install the helper', () => {
  test("setup.sh's conclave command, or the binary it wraps when that command predates system-helper", () => {
    const old = '#!/bin/sh\nif [ "$(id -u)" = 0 ]; then\n  exec runuser -u conclave -- sh -c \'cd "$1"\' sh "$PWD" /opt/conclave/bin/conclave "$@"\nfi\n';
    const now = '#!/bin/sh\nif [ "$(id -u)" = 0 ]; then\n  case ${1:-} in system-helper) exec /opt/conclave/bin/conclave "$@" ;; esac\n  exec runuser -u conclave -- x\nfi\n';
    expect(helperInstallCommand(probe({ files: { '/usr/local/bin/conclave': old, '/opt/conclave/bin/conclave': '' } }))).toBe('/opt/conclave/bin/conclave system-helper install');
    expect(helperInstallCommand(probe({ files: { '/usr/local/bin/conclave': now, '/opt/conclave/bin/conclave': '' } }))).toBe('conclave system-helper install');
  });

  test('the install script: the full path of the binary, since root has no ~/.local/bin on its PATH', () => {
    expect(helperInstallCommand(probe({ execPath: '/home/kai/.local/bin/conclave' }))).toBe('/home/kai/.local/share/conclave/conclave system-helper install');
    expect(helperInstallCommand(probe({ execPath: '/usr/local/bin/bun', main: '/srv/conclave/packages/cli/src/index.ts' }))).toBe('/usr/local/bin/bun /srv/conclave/packages/cli/src/index.ts system-helper install');
  });
});

describe('the root helper as the hub sees it', () => {
  // a release binary with no setup.sh wrapper: root runs it by its full path
  const install = '/opt/conclave/release/conclave system-helper install';
  const installed = (over: Machine = {}): Machine => ({
    sudoAllows: true,
    ...over,
    files: { [ROOT_HELPER_PATH]: rootHelperScript(), [ROOT_HELPER_SUDOERS]: '', '/usr/bin/sudo': '', '/proc/self/status': 'Name:\tconclave\nNoNewPrivs:\t0\n', ...over.files },
    stats: { [ROOT_HELPER_PATH]: { uid: 0, mode: 0o100755 }, ...over.stats },
  });

  test('not installed: the command to install it, nothing run', () => {
    const p = probe({});
    expect(rootHelperStatus('browser-deps', p)).toEqual({ installed: false, ready: false, install });
    expect(p.runs.filter((r) => r[0].endsWith('sudo'))).toEqual([]);
  });

  test('installed, with the rule, sudo there and allowing it: ready', () => {
    forgetHelperFacts();
    const p = probe(installed());
    expect(rootHelperStatus('browser-deps', p)).toEqual({ installed: true, ready: true, install });
    // sudo -n -l asks without a password and runs nothing
    expect(p.runs.find((r) => r[0].endsWith('sudo'))).toEqual(['/usr/bin/sudo', '-n', '-l', ROOT_HELPER_PATH, 'browser-deps']);
  });

  test('a helper someone besides root can change is not used', () => {
    expect(rootHelperStatus('browser-deps', probe(installed({ stats: { [ROOT_HELPER_PATH]: { uid: 1000, mode: 0o100755 } } })))).toMatchObject({ installed: false, ready: false, problem: expect.stringContaining("not root's alone") });
    expect(rootHelperStatus('browser-deps', probe(installed({ stats: { [ROOT_HELPER_PATH]: { uid: 0, mode: 0o100777 } } })))).toMatchObject({ ready: false });
  });

  test('why an installed helper cannot run: NoNewPrivileges, no rule, no sudo, sudo says no', () => {
    forgetHelperFacts();
    expect(rootHelperStatus('browser-deps', probe(installed({ files: { '/proc/self/status': 'NoNewPrivs:\t1\n' } }))).problem).toContain('NoNewPrivileges');
    const noRule = installed();
    delete noRule.files![ROOT_HELPER_SUDOERS];
    expect(rootHelperStatus('browser-deps', probe(noRule)).problem).toContain('sudo rule is missing');
    const noSudo = installed();
    delete noSudo.files!['/usr/bin/sudo'];
    expect(rootHelperStatus('browser-deps', probe(noSudo)).problem).toContain('sudo is not installed');
    forgetHelperFacts();
    expect(rootHelperStatus('browser-deps', probe(installed({ sudoAllows: false, user: 'kai' }))).problem).toContain('sudo does not let kai run the helper');
  });

  test('an older helper without the action is not installed for it; an older one with it still runs', () => {
    const old = rootHelperScript().replace(/^# actions: .*$/m, '# actions: something-else');
    expect(rootHelperStatus('browser-deps', probe(installed({ files: { [ROOT_HELPER_PATH]: old } })))).toMatchObject({ installed: false, problem: expect.stringContaining('older Conclave') });
    forgetHelperFacts();
    const v0 = rootHelperScript().replace(/^# version: \d+$/m, '# version: 0');
    expect(rootHelperStatus('browser-deps', probe(installed({ files: { [ROOT_HELPER_PATH]: v0 } })))).toMatchObject({ installed: true, ready: true, outdated: true });
  });

  test('a hub that runs as root runs the helper itself, with no sudo', () => {
    const p = probe(installed({ uid: 0, user: 'root' }));
    expect(rootHelperStatus('browser-deps', p)).toMatchObject({ installed: true, ready: true, asRoot: true });
    expect(p.runs.filter((r) => r[0].endsWith('sudo'))).toEqual([]);
  });
});
