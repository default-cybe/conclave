/**
 * conclave-lxc.sh --dry-run against stub pct, pveam, pvesh and pvesm commands.
 * The stubs log every call and answer the queries; the test checks the
 * printed command lines and that nothing that changes the host was called.
 *
 *   bun test scripts/proxmox
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = join(import.meta.dir, 'conclave-lxc.sh');
const scripts = resolve(import.meta.dir, '..');
const root = resolve(scripts, '..');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface StubOptions {
  /** Templates already in the template storage. */
  local?: string[];
  /** CT ids that exist and run. */
  existing?: string[];
  /** CT ids that exist and are stopped. */
  stopped?: string[];
  /** Lines of pvesm status --content rootdir, after its header. */
  storages?: string[];
}

function stubs(opts: StubOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'conclave-lxc-test-'));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  const write = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >>'${log}'\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const lines = (xs: string[]) => xs.map((x) => `echo '${x}'`).join('\n');
  write('pvesh', `if [ "$*" = "get /cluster/nextid" ]; then echo 123; fi`);
  write(
    'pveam',
    [
      'case $1 in',
      `  list) echo 'NAME                                                   SIZE'`,
      lines((opts.local ?? []).map((t) => `local:vztmpl/${t}      120.29MB`)),
      '  ;;',
      '  available)',
      lines([
        'system          debian-12-standard_12.2-1_amd64.tar.zst',
        'system          debian-12-standard_12.7-1_amd64.tar.zst',
        'system          debian-13-standard_13.1-2_amd64.tar.zst',
        'system          ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
      ]),
      '  ;;',
      'esac',
    ].join('\n'),
  );
  const existing = opts.existing ?? [];
  write(
    'pct',
    [
      'if [ "$1" = status ]; then',
      `  for id in ${existing.join(' ') || 'none'}; do`,
      '    if [ "$2" = "$id" ]; then echo "status: running"; exit 0; fi',
      '  done',
      `  for id in ${(opts.stopped ?? []).join(' ') || 'none'}; do`,
      '    if [ "$2" = "$id" ]; then echo "status: stopped"; exit 0; fi',
      '  done',
      `  echo "Configuration file 'nodes/pve/lxc/$2.conf' does not exist" >&2`,
      '  exit 2',
      'fi',
    ].join('\n'),
  );
  write(
    'pvesm',
    ['echo "Name             Type     Status           Total            Used       Available        %"', lines(opts.storages ?? [])].join('\n'),
  );
  return {
    dir,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

function run(args: string[], stubDir: string, env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CT_') && k !== 'REPO' && k !== 'CONCLAVE_SOURCE_DIR') base[k] = v;
  }
  const r = Bun.spawnSync(['sh', script, ...args], {
    env: { ...base, PATH: `${stubDir}:${process.env.PATH}`, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = r.stdout.toString();
  return { code: r.exitCode, out, err: r.stderr.toString(), lines: out.split('\n') };
}

/** Calls that would change the host. None may happen in a dry run. */
const CHANGES = /^(pct (create|start|push|exec|set|destroy)|pveam (update|download))\b/;

describe('conclave-lxc.sh --dry-run', () => {
  test('create with the defaults: next id, newest template, the storage that holds containers', () => {
    const s = stubs({ storages: ['local-zfs        zfspool     active      100  10  90  10.00%', 'nas              nfs         inactive    0    0   0   0.00%'] });
    const r = run(['--dry-run', '--debian', '12'], s.dir);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const cmds = r.lines.filter((l) => l.startsWith('+ '));
    expect(cmds).toEqual([
      '+ pveam update',
      '+ pveam download local debian-12-standard_12.7-1_amd64.tar.zst',
      "+ pct create 123 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst --hostname conclave --cores 2 --memory 4096 --swap 512 --rootfs local-zfs:16 --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian --timezone host --tags conclave --description 'Conclave hub. Update: conclave-lxc.sh update 123'",
      '+ pct start 123',
      expect.stringMatching(/^\+ pct exec 123 -- sh -c '.*getent hosts github\.com.*'$/),
      '+ pct exec 123 -- mkdir -p /root/conclave-setup',
      `+ pct push 123 ${scripts}/lxc/setup.sh /root/conclave-setup/setup.sh --perms 755`,
      `+ pct push 123 ${scripts}/install.sh /root/conclave-setup/install.sh --perms 755`,
      '+ pct exec 123 -- sh /root/conclave-setup/setup.sh',
    ]);
    expect(r.out).toContain('Template: local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst');
    // only queries ran
    expect(s.calls()).toEqual([
      'pvesh get /cluster/nextid',
      'pct status 123',
      'pveam list local',
      'pveam available --section system',
      'pvesm status --content rootdir',
    ]);
    expect(s.calls().filter((c) => CHANGES.test(c))).toEqual([]);
  });

  test('flags and environment variables override the defaults; a static IP, a VLAN and a bind mount', () => {
    const s = stubs({ local: ['debian-13-standard_13.1-2_amd64.tar.zst'] });
    const projects = join(s.dir, 'projects');
    const r = run(
      ['--dry-run', '--debian', '13', '--id', '150', '--hostname', 'hub', '--disk', '32', '--storage', 'fast', '--bridge', 'vmbr1', '--vlan', '20',
        '--ip', '192.168.1.50/24', '--gw', '192.168.1.1', '--projects', projects, '--no-onboot', '--from', 'git', '--ref', 'dev'],
      s.dir,
      { CT_CORES: '4', CT_MEMORY: '8192' },
    );
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const cmds = r.lines.filter((l) => l.startsWith('+ '));
    expect(cmds).not.toContain('+ pveam update');
    expect(cmds.some((l) => l.startsWith('+ pveam download'))).toBe(false);
    expect(cmds).toContain(`+ mkdir -p ${projects}`);
    expect(cmds).toContain(`+ chown 101000:101000 ${projects}`);
    expect(cmds).toContain(
      `+ pct create 150 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst --hostname hub --cores 4 --memory 8192 --swap 512 --rootfs fast:32 --net0 name=eth0,bridge=vmbr1,ip=192.168.1.50/24,gw=192.168.1.1,tag=20 --unprivileged 1 --features nesting=1 --onboot 0 --ostype debian --timezone host --tags conclave --description 'Conclave hub. Update: conclave-lxc.sh update 150' --mp0 ${projects},mp=/home/conclave/projects`,
    );
    expect(cmds.at(-1)).toBe('+ pct exec 150 -- sh /root/conclave-setup/setup.sh --from git --ref dev');
    expect(r.out).toContain('uid 101000 on this host');
    // a dry run makes no folder, and asks pvesh for no id it was given
    expect(existsSync(projects)).toBe(false);
    expect(s.calls()).toEqual(['pct status 150', 'pveam list local']);
  });

  test('an existing projects folder is left as it is, with the chown to run', () => {
    const s = stubs({ local: ['debian-12-standard_12.7-1_amd64.tar.zst'] });
    const r = run(['--dry-run', '--debian', '12', '--storage', 'local-lvm', '--projects', s.dir], s.dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`chown -R 101000:101000 ${s.dir}`);
    expect(r.lines.filter((l) => l.startsWith('+ chown') || l.startsWith('+ mkdir -p /'))).toEqual([]);
    expect(r.out).toContain(`--mp0 ${s.dir},mp=/home/conclave/projects`);
  });

  test('update pushes setup.sh and a source checkout into a running CT and runs it', () => {
    const s = stubs({ existing: ['200'] });
    const r = run(['update', '200', '--dry-run', '--source-dir', root, '--port', '8080'], s.dir);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const cmds = r.lines.filter((l) => l.startsWith('+ '));
    expect(cmds.some((l) => l.startsWith('+ pct create') || l.startsWith('+ pct start'))).toBe(false);
    expect(cmds[0]).toBe('+ pct exec 200 -- mkdir -p /root/conclave-setup');
    expect(cmds).toContain(`+ pct push 200 ${scripts}/lxc/setup.sh /root/conclave-setup/setup.sh --perms 755`);
    expect(cmds.some((l) => l.startsWith(`+ tar -C ${root} -czf `) && l.includes('--exclude=node_modules') && l.endsWith(' .'))).toBe(true);
    expect(cmds.some((l) => /^\+ pct push 200 \S+\/conclave-src\.tar\.gz \/root\/conclave-setup\/src\.tar\.gz$/.test(l))).toBe(true);
    expect(cmds.at(-1)).toBe('+ pct exec 200 -- sh /root/conclave-setup/setup.sh --port 8080 --source-dir /root/conclave-src');
    expect(s.calls()).toEqual(['pct status 200']);
  });

  test('update starts a stopped CT and waits for its network first', () => {
    const s = stubs({ stopped: ['201'] });
    const r = run(['update', '201', '--dry-run'], s.dir);
    expect(r.code).toBe(0);
    const cmds = r.lines.filter((l) => l.startsWith('+ '));
    expect(cmds[0]).toBe('+ pct start 201');
    expect(cmds[1]).toMatch(/^\+ pct exec 201 -- sh -c '.*getent hosts github\.com.*'$/);
    expect(cmds.at(-1)).toBe('+ pct exec 201 -- sh /root/conclave-setup/setup.sh');
    expect(r.out).toContain('Dry run. Nothing was changed.');
    expect(s.calls()).toEqual(['pct status 201']);
  });

  test('refuses what it cannot do', () => {
    const s = stubs({ existing: ['200'] });
    const noId = run(['update', '--dry-run'], s.dir);
    expect(noId.code).not.toBe(0);
    expect(noId.err).toContain('needs a CT id');
    const missing = run(['update', '999', '--dry-run'], s.dir);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain('no CT 999');
    const taken = run(['--dry-run', '--id', '200'], s.dir);
    expect(taken.code).not.toBe(0);
    expect(taken.err).toContain('CT 200 exists already');
    const ip = run(['--dry-run', '--ip', '192.168.1.50'], s.dir);
    expect(ip.code).not.toBe(0);
    expect(ip.err).toContain('--ip takes dhcp or an address with its prefix');
    expect(s.calls().filter((c) => CHANGES.test(c))).toEqual([]);
  });
});

describe('the root helper and the browser libraries', () => {
  const last = (r: { lines: string[] }) => r.lines.filter((l) => l.startsWith('+ ')).at(-1);

  test('flags and variables pass through to setup.sh; a dry run asks nothing', () => {
    const s = stubs({ local: ['debian-12-standard_12.7-1_amd64.tar.zst'] });
    const r = run(['--dry-run', '--debian', '12', '--storage', 'local-lvm', '--root-helper', '--browser-libs'], s.dir);
    expect(r.err).toBe('');
    expect(last(r)).toBe('+ pct exec 123 -- sh /root/conclave-setup/setup.sh --root-helper --browser-libs');
    expect(r.out).not.toContain('[Y/n]');
    const env = run(['--dry-run', '--debian', '12', '--storage', 'local-lvm'], s.dir, { CT_ROOT_HELPER: '0', CT_BROWSER_LIBS: '0' });
    expect(last(env)).toBe('+ pct exec 123 -- sh /root/conclave-setup/setup.sh --no-root-helper --no-browser-libs');
  });

  test("update passes only what it was given; setup.sh keeps the CT's last answers", () => {
    const s = stubs({ existing: ['140'] });
    expect(last(run(['update', '140', '--dry-run'], s.dir))).toBe('+ pct exec 140 -- sh /root/conclave-setup/setup.sh');
    expect(last(run(['update', '140', '--dry-run', '--root-helper'], s.dir))).toBe('+ pct exec 140 -- sh /root/conclave-setup/setup.sh --root-helper');
  });

  test('refuses a value that is not 1 or 0', () => {
    const s = stubs();
    const r = run(['--dry-run'], s.dir, { CT_ROOT_HELPER: 'maybe' });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('CT_ROOT_HELPER takes 1 or 0');
  });
});
