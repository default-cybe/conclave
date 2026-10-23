import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BashTool } from '../../src/tools/bash';
import { BashOutputTool } from '../../src/tools/bash-output';
import { KillShellTool } from '../../src/tools/kill-shell';
import { shellRegistry } from '../../src/tools/shells';
import { fakeHost, makeCtx, tempDir, text } from './helpers';

const { dir: rawDir, cleanup } = tempDir();
const dir = realpathSync(rawDir);
afterAll(async () => {
  await shellRegistry.disposeAll();
  cleanup();
});

describe('Bash', () => {
  test('returns combined output and exit code', async () => {
    const ctx = makeCtx({ cwd: dir });
    const ok = await BashTool.run({ command: 'echo out; echo err >&2' }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toBe('out\nerr');
    expect(ok.meta?.exitCode).toBe(0);

    const bad = await BashTool.run({ command: 'echo nope; exit 3' }, ctx);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('nope');
    expect(text(bad)).toContain('Exit code 3');
    expect(bad.meta?.exitCode).toBe(3);
  });

  test('tracks the working directory without leaking the marker', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const ctx = makeCtx({ cwd: dir });
    const out = await BashTool.run({ command: 'cd sub && pwd' }, ctx);
    expect(text(out)).toContain(join(dir, 'sub'));
    expect(text(out)).not.toContain('__CONCLAVE_CWD_');
    expect(out.meta?.cwd).toBe(join(dir, 'sub'));

    const same = await BashTool.run({ command: 'true' }, ctx);
    expect(same.meta?.cwd).toBeUndefined();
    expect(text(same)).toBe('(no output)');
  });

  test('streams progress', async () => {
    const ctx = makeCtx({ cwd: dir });
    await BashTool.run({ command: 'echo one; echo two' }, ctx);
    expect(ctx.progressLog.join('')).toContain('one');
  });

  test('times out and kills the command', async () => {
    const ctx = makeCtx({ cwd: dir });
    const started = Date.now();
    const out = await BashTool.run({ command: 'echo start; sleep 30', timeout: 1000 }, ctx);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('timed out');
    expect(text(out)).toContain('start');
  });

  test('truncates huge output middle-out and stores the full text', async () => {
    const host = fakeHost();
    const ctx = makeCtx({ cwd: dir, host });
    const out = await BashTool.run({ command: 'seq 1 20000' }, ctx);
    const t = text(out);
    expect(t.length).toBeLessThan(31_000);
    expect(t).toContain('characters truncated');
    expect(t.startsWith('1\n2\n')).toBe(true);
    expect(t).toContain('20000');
    const id = String(out.meta?.outputId);
    expect(host.outputs.get(id)?.split('\n').length).toBe(20000);
  });

  test('syntax errors are reported, not thrown', async () => {
    const out = await BashTool.run({ command: 'if then fi (' }, makeCtx({ cwd: dir }));
    expect(out.isError).toBe(true);
    expect(text(out).toLowerCase()).toContain('syntax');
  });

  test('background shell with BashOutput and KillShell', async () => {
    const ctx = makeCtx({ cwd: dir, sessionId: 'sess_bg' });
    const started = await BashTool.run({ command: 'echo ready; sleep 30', run_in_background: true }, ctx);
    const id = String(started.meta?.shellId);
    expect(id).toMatch(/^bash_\d+$/);

    let saw = '';
    for (let i = 0; i < 40 && !saw.includes('ready'); i++) {
      await Bun.sleep(50);
      saw += text(await BashOutputTool.run({ bash_id: id }, ctx));
    }
    expect(saw).toContain('ready');
    expect(saw).toContain('<status>running</status>');

    // nothing new on the next read
    const again = text(await BashOutputTool.run({ bash_id: id }, ctx));
    expect(again).toContain('(no new output)');

    const killed = await KillShellTool.run({ shell_id: id }, ctx);
    expect(text(killed)).toContain('Killed');
    const after = text(await BashOutputTool.run({ bash_id: id }, ctx));
    expect(after).toContain('<status>killed</status>');

    const unknown = await BashOutputTool.run({ bash_id: 'bash_999' }, ctx);
    expect(unknown.isError).toBe(true);
  });

  test('background shell completion and filter', async () => {
    const ctx = makeCtx({ cwd: dir, sessionId: 'sess_bg2' });
    const started = await BashTool.run({ command: 'echo keep-1; echo drop; echo keep-2', run_in_background: true }, ctx);
    const id = String(started.meta?.shellId);
    await shellRegistry.get('sess_bg2', id)!.done;
    const out = text(await BashOutputTool.run({ bash_id: id, filter: '^keep' }, ctx));
    expect(out).toContain('<status>completed</status>');
    expect(out).toContain('<exit_code>0</exit_code>');
    expect(out).toContain('keep-1');
    expect(out).toContain('keep-2');
    expect(out).not.toContain('drop');
    // other sessions cannot see it
    const other = await BashOutputTool.run({ bash_id: id }, makeCtx({ cwd: dir, sessionId: 'sess_other' }));
    expect(other.isError).toBe(true);
  });

  test('readOnly and rule hooks', () => {
    const ro = BashTool.readOnly as (i: any) => boolean;
    expect(ro({ command: 'ls -la' })).toBe(true);
    expect(ro({ command: 'ls -la', run_in_background: true })).toBe(false);
    expect(ro({ command: 'rm -rf x' })).toBe(false);
    expect(BashTool.ruleContent!({ command: ' npm test ' }, { cwd: dir } as any)).toBe('npm test');
    expect(BashTool.suggestRule!({ command: 'npm test -- --watch' })).toBe('Bash(npm test:*)');
  });
});
