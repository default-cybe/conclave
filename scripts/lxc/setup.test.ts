/**
 * Parts of scripts/lxc/setup.sh that run without a container: its options,
 * and the /usr/local/bin/conclave command it writes. That command runs as
 * the conclave user even when root starts it, except `system-helper`, which
 * writes root's own files. The test takes the command's text out of
 * setup.sh and runs it with stand-ins for id, runuser and the binary.
 *
 *   bun test scripts/lxc
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperInstallCommand, type HostProbe } from '../../packages/core/src/system/host';

const setup = join(import.meta.dir, 'setup.sh');
const text = readFileSync(setup, 'utf8');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The conclave command setup.sh writes, as it would be on a hub with no --port. */
function wrapper(): string {
  const m = /cat <<'EOF'\n(#!\/bin\/sh\n# Conclave CLI for the hub[\s\S]*?)EOF\n[\s\S]*?cat <<'EOF'\n([\s\S]*?)EOF\n\} >"\$tmp\/conclave"/.exec(text);
  expect(m).not.toBeNull();
  return m![1] + m![2];
}

describe('setup.sh', () => {
  test('--help lists the root helper and the browser libraries', () => {
    const r = Bun.spawnSync(['sh', setup, '--help'], { stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain('--root-helper, --no-root-helper');
    expect(out).toContain('--browser-libs, --no-browser-libs');
    expect(out).toContain('Default: ask, yes.');
    expect(out).toContain('Default: ask, no.');
  });

  test('an unknown option is refused before anything else', () => {
    const r = Bun.spawnSync(['sh', setup, '--root-helpers'], { stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('unknown option: --root-helpers');
  });

  test("the conclave command keeps root for system-helper and drops to conclave for the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-wrapper-'));
    dirs.push(dir);
    const log = join(dir, 'calls.log');
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    stub('id', 'echo 0');
    stub('runuser', `echo "runuser $*" >>'${log}'`);
    stub('conclave-bin', `echo "binary $*" >>'${log}'`);
    const file = join(dir, 'conclave');
    writeFileSync(file, wrapper().replaceAll('/opt/conclave/bin/conclave', join(dir, 'conclave-bin')));
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    Bun.spawnSync(['sh', file, 'system-helper', 'install'], { env });
    Bun.spawnSync(['sh', file, 'remote'], { env });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe('binary system-helper install');
    expect(calls[1]).toMatch(/^runuser -u conclave -- sh -c .* remote$/);
  });

  test('the hub tells this command from the one before system-helper', () => {
    const probe = (w: string): HostProbe => ({
      env: {},
      exists: (p) => p === '/opt/conclave/bin/conclave',
      read: (p) => (p === '/usr/local/bin/conclave' ? w : undefined),
      stat: () => undefined,
      run: () => ({ code: 127, stdout: '' }),
      realpath: (p) => p,
      execPath: '/opt/conclave/release/conclave',
      main: '/$bunfs/root/conclave',
    });
    expect(helperInstallCommand(probe(wrapper()))).toBe('conclave system-helper install');
    const before = wrapper().replace(/^\s*# system-helper writes[^\n]*\n[^\n]*system-helper\)[^\n]*\n/m, '');
    expect(before).not.toContain('system-helper');
    expect(helperInstallCommand(probe(before))).toBe('/opt/conclave/bin/conclave system-helper install');
  });
});
