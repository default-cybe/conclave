/**
 * The root helper (system/root-helper.ts): its sudo rule, its package lists,
 * and the script itself, run with bash and dash against stand-ins for
 * apt-get, dpkg-query, id and logger. Nothing here runs as root or touches
 * apt: the stand-ins are first on the PATH the script sets for itself, and
 * the test checks that before it runs anything.
 *
 *   bun test packages/core/test/system/root-helper.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aptPackages, LIB_PACKAGES, allBrowserPackages } from '../../src/browser/packages';
import {
  helperActions,
  helperVersion,
  ROOT_HELPER_ACTIONS,
  ROOT_HELPER_PATH,
  ROOT_HELPER_SAFE_PATH,
  ROOT_HELPER_VERSION,
  rootHelperLine,
  rootHelperScript,
  sudoersRule,
  validUserName,
} from '../../src/system/root-helper';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'conclave-root-helper-'));
  dirs.push(d);
  return d;
}

const OS = {
  debian12: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
  debian13: 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_ID="13"\nID=debian\n',
  sid: 'PRETTY_NAME="Debian GNU/Linux trixie/sid"\nID=debian\n',
  ubuntu24: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n',
  ubuntu22: 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nID=ubuntu\nVERSION_ID="22.04"\n',
  fedora: 'NAME="Fedora Linux"\nVERSION_ID=40\nID=fedora\nPRETTY_NAME="Fedora Linux 40 (Workstation Edition)"\n',
} as const;

interface Rig {
  dir: string;
  file: string;
  log: () => string[];
}

/**
 * A helper rendered with a folder of stand-ins first on its PATH. apt-get,
 * dpkg-query, id and logger write what they were asked to calls.log.
 * `installed` lists the packages dpkg-query says are there; `uid` is what id -u says.
 */
function rig(o: { os: string; installed?: string[]; uid?: number; aptFails?: boolean; noApt?: boolean }): Rig {
  const dir = tmp();
  const bin = join(dir, 'bin');
  Bun.spawnSync(['mkdir', '-p', bin]);
  const log = join(dir, 'calls.log');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >>'${log}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  if (!o.noApt) {
    stub('apt-get', o.aptFails ? 'case "$*" in *install*) echo "E: Unable to locate package" >&2; exit 100 ;; esac\nexit 0' : 'exit 0');
    writeFileSync(join(dir, 'installed'), (o.installed ?? []).join('\n') + '\n');
    stub('dpkg-query', `p=$(eval "echo \\\${$#}"); if grep -qx "$p" '${join(dir, 'installed')}'; then printf 'install ok installed'; else exit 1; fi`);
  }
  stub('id', `if [ "$1" = -u ]; then echo ${o.uid ?? 0}; else /usr/bin/id "$@"; fi`);
  stub('logger', 'exit 0');
  let path = `${bin}:${ROOT_HELPER_SAFE_PATH}`;
  if (o.noApt) {
    // a PATH with no apt-get at all: only what the script needs besides it
    const only = join(dir, 'only');
    Bun.spawnSync(['mkdir', '-p', only]);
    for (const t of ['sed', 'head', 'grep']) {
      const real = Bun.which(t);
      if (real) symlinkSync(real, join(only, t));
    }
    path = `${bin}:${only}`;
  }
  writeFileSync(join(dir, 'os-release'), o.os);
  const file = join(dir, 'conclave-root-helper');
  const script = rootHelperScript({ path, osRelease: join(dir, 'os-release') });
  // the stand-ins must come first, or a run here would reach the real apt-get
  expect(script).toContain(`PATH=${path}\n`);
  writeFileSync(file, script, { mode: 0o755 });
  return { dir, file, log: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const SHELLS = ['bash', 'dash', 'sh'].map((s) => Bun.which(s)).filter((s): s is string => !!s);

function run(r: Rig, args: string[], shell = SHELLS[0], env: Record<string, string> = {}) {
  // the caller's environment is not the helper's: a hostile PATH and these changes nothing
  const p = Bun.spawnSync([shell, r.file, ...args], { env: { PATH: '/nonexistent', OS_RELEASE: '/nonexistent', IFS: 'x', ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const apt = (r: Rig) => r.log().filter((l) => l.startsWith('apt-get '));

describe('the sudo rule and the line', () => {
  test("names the hub's user, the helper and each action, and nothing else", () => {
    const rule = sudoersRule('conclave');
    const lines = rule.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual([`conclave ALL=(root) NOPASSWD: ${ROOT_HELPER_PATH} browser-deps`]);
    expect(rootHelperLine('browser-deps')).toBe('sudo /usr/local/libexec/conclave-root-helper browser-deps');
    expect(rootHelperLine('browser-deps', { asRoot: true })).toBe('/usr/local/libexec/conclave-root-helper browser-deps');
  });

  test('refuses a user name that could change the rule', () => {
    // ALL and Defaults are sudoers keywords and an upper case word is an alias: each would widen the rule
    for (const bad of ['', 'root ALL=(ALL) ALL', 'a,b', 'x:y', 'kai\nALL', '%sudo', '+admins', 'ALL', 'Defaults', 'ADMINS', '-x', 'a'.repeat(40)]) {
      expect(validUserName(bad)).toBe(false);
      expect(() => sudoersRule(bad)).toThrow();
    }
    expect(validUserName('conclave')).toBe(true);
    expect(validUserName('kai.ahir')).toBe(true);
  });

  test('the script says its version and actions', () => {
    const s = rootHelperScript();
    expect(helperVersion(s)).toBe(ROOT_HELPER_VERSION);
    expect(helperActions(s)).toEqual([...ROOT_HELPER_ACTIONS]);
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain(`PATH=${ROOT_HELPER_SAFE_PATH}\n`);
    expect(s).toContain('set -eu');
    // it never runs os-release, it reads it
    expect(s).not.toMatch(/^\s*\.\s+"?\$OS_RELEASE/m);
  });
});

describe('the package lists built into the helper', () => {
  test('cover every package the page can name, for each release', () => {
    const s = rootHelperScript();
    const lists = [...s.matchAll(/packages='([^']+)'/g)].map((m) => m[1].split(' '));
    expect(lists).toHaveLength(2);
    const [t64, classic] = lists;
    expect(t64).toEqual(allBrowserPackages(true));
    expect(classic).toEqual(allBrowserPackages(false));
    const everything = [...Object.keys(LIB_PACKAGES), 'libunknown.so.1'];
    for (const [os, list] of [
      [{ id: 'debian', versionId: '12' }, classic],
      [{ id: 'debian', versionId: '13' }, t64],
      [{ id: 'ubuntu', versionId: '24.04' }, t64],
      [{ id: 'ubuntu', versionId: '22.04' }, classic],
    ] as const) {
      for (const p of aptPackages(everything, os, { fonts: true })) expect(list).toContain(p);
    }
    expect(classic).toContain('libasound2');
    expect(t64).toContain('libasound2t64');
    expect(t64).not.toContain('libasound2');
  });
});

describe('the helper script', () => {
  test('runs with bash, dash and sh', () => {
    expect(SHELLS.length).toBeGreaterThan(0);
    for (const sh of SHELLS) {
      const r = rig({ os: OS.debian12 });
      const res = run(r, ['browser-deps'], sh);
      expect(res.code).toBe(0);
      expect(apt(r).length).toBe(2);
    }
  });

  test('refuses unknown actions, no action and extra arguments, before it does anything', () => {
    for (const args of [[], ['install'], ['browser-deps', 'libevil'], ['browser-deps', '--yes'], ['-y', 'browser-deps'], ['browser-deps;id'], ['browser-deps libx11-6'], ['BROWSER-DEPS'], ['']]) {
      for (const sh of SHELLS) {
        const r = rig({ os: OS.debian12 });
        const res = run(r, args, sh);
        expect(res.code).toBe(2);
        expect(res.err).toMatch(/takes exactly one action|unknown action/);
        expect(r.log().filter((l) => !l.startsWith('logger '))).toEqual([]);
      }
    }
  });

  test('refuses when not root', () => {
    const r = rig({ os: OS.debian12, uid: 1000 });
    const res = run(r, ['browser-deps']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('runs as root only');
    expect(apt(r)).toEqual([]);
  });

  test('Debian 12: apt-get update, then the older names, only those missing', () => {
    const r = rig({ os: OS.debian12, installed: ['libudev1', 'libexpat1'] });
    const res = run(r, ['browser-deps']);
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    const calls = apt(r);
    expect(calls[0]).toBe('apt-get -q -o DPkg::Lock::Timeout=300 update');
    expect(calls[1].startsWith('apt-get -q -y -o DPkg::Lock::Timeout=300 install --no-install-recommends ')).toBe(true);
    const pkgs = calls[1].split('--no-install-recommends ')[1].trim().split(' ');
    expect(pkgs).toEqual(allBrowserPackages(false).filter((p) => p !== 'libudev1' && p !== 'libexpat1'));
    expect(pkgs).toContain('libasound2');
    expect(res.out).toContain('Debian GNU/Linux 12 (bookworm)');
    // it says what it did in the system log
    expect(r.log().some((l) => l.startsWith('logger -t conclave-root-helper -- browser-deps for root on Debian GNU/Linux 12'))).toBe(true);
  });

  test('Debian 13, testing and Ubuntu 24.04 get the t64 names; Ubuntu 22.04 the older ones', () => {
    for (const [os, t64] of [
      [OS.debian13, true],
      [OS.sid, true],
      [OS.ubuntu24, true],
      [OS.ubuntu22, false],
    ] as const) {
      const r = rig({ os });
      expect(run(r, ['browser-deps']).code).toBe(0);
      const pkgs = apt(r)[1].split('--no-install-recommends ')[1].trim().split(' ');
      expect(pkgs).toEqual(allBrowserPackages(t64));
    }
  });

  test('the user sudo names goes in the log, only when it is a plain name', () => {
    const r = rig({ os: OS.debian12 });
    run(r, ['browser-deps'], SHELLS[0], { SUDO_USER: 'conclave' });
    expect(r.log().some((l) => l.includes('browser-deps for conclave on'))).toBe(true);
    const r2 = rig({ os: OS.debian12 });
    run(r2, ['browser-deps'], SHELLS[0], { SUDO_USER: 'x; rm -rf /' });
    expect(r2.log().some((l) => l.includes('browser-deps for root on'))).toBe(true);
  });

  test('idempotent: with everything there it runs no apt-get', () => {
    const r = rig({ os: OS.debian13, installed: allBrowserPackages(true) });
    const res = run(r, ['browser-deps']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('all installed');
    expect(apt(r)).toEqual([]);
  });

  test('a failing apt-get fails the run', () => {
    const r = rig({ os: OS.debian12, aptFails: true });
    const res = run(r, ['browser-deps']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('apt-get install failed');
  });

  test('refuses other systems and machines without apt-get, with a clear line', () => {
    const fedora = rig({ os: OS.fedora });
    const f = run(fedora, ['browser-deps']);
    expect(f.code).toBe(2);
    expect(f.err).toContain('Debian and Ubuntu only. This is Fedora Linux 40');
    expect(apt(fedora)).toEqual([]);
    const none = rig({ os: OS.debian12, noApt: true });
    const n = run(none, ['browser-deps']);
    expect(n.code).toBe(2);
    expect(n.err).toContain('needs apt-get, so Debian or Ubuntu');
  });

  test('shellcheck finds nothing (when shellcheck is here)', () => {
    const sc = Bun.which('shellcheck');
    if (!sc) return;
    const file = join(tmp(), 'helper.sh');
    writeFileSync(file, rootHelperScript());
    for (const dialect of ['sh', 'dash', 'bash']) {
      const p = Bun.spawnSync([sc, '-s', dialect, file], { stdout: 'pipe', stderr: 'pipe' });
      expect(p.stdout.toString()).toBe('');
      expect(p.exitCode).toBe(0);
    }
  });
});
