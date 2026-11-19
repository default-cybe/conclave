import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BashTool, isBlockingWait, windowsCwd, wrapCmdCommand, wrapCommand } from '../../src/tools/bash';
import type { Machine } from '../../src/machine/types';
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

  test('a command that only waits goes to the background', async () => {
    for (const c of ['gh run watch 123', 'gh run watch 1 --exit-status', 'gh pr checks 5 --watch', 'watch -n5 ls', 'sleep 120', 'sleep 2m', ' sleep 1m 30s\n']) {
      expect(isBlockingWait(c)).toBe(true);
    }
    for (const c of [
      'sleep 5',
      'sleep 30',
      'gh pr checks 5',
      'echo watch me',
      'ls | grep sleep',
      'rg -n while src; rg -n sleep src',
      'until curl -sf localhost:3000; do sleep 1; done && bun run e2e',
      'while true; do sleep 5; done',
      'git commit -m "$(cat <<\'EOF\'\nfix race\nwatch the cwd\nEOF\n)"',
      'echo "sleep 60" >> notes.txt',
      'gh run watch 1 --exit-status && gh pr merge 5',
      'cd sub && sleep 120',
      'sleep 120; true',
    ]) {
      expect(isBlockingWait(c)).toBe(false);
    }
  });

  test('a moved wait tells the session when it ends, and keeps its timeout', async () => {
    const ended: string[] = [];
    const host = fakeHost({ shellEnded: (_id, t) => void ended.push(t) });
    const ctx = makeCtx({ cwd: dir, host, sessionId: 'sess_wait' });
    const out = await BashTool.run({ command: 'sleep 31', timeout: 1000 }, ctx);
    expect(out.meta?.background).toBe(true);
    expect(text(out)).toContain('moved to the background');
    expect(ended).toHaveLength(0);
    for (let i = 0; i < 50 && !ended.length; i++) await Bun.sleep(100);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toContain(`${out.meta?.shellId}) ended`);
    expect(shellRegistry.get('sess_wait', String(out.meta?.shellId))?.running).toBe(false);
  });

  test('a wait in a subagent or headless run stays in the foreground', async () => {
    const sub = await BashTool.run({ command: 'sleep 31', timeout: 1000 }, makeCtx({ cwd: dir, depth: 1 }));
    expect(sub.meta?.background).toBeFalsy();
    expect(text(sub)).toContain('timed out');
    for (const tags of [['workflow'], ['cli-run'], ['routine']]) {
      const ctx = makeCtx({ cwd: dir });
      ctx.session = { ...ctx.session, tags };
      const out = await BashTool.run({ command: 'sleep 31', timeout: 1000 }, ctx);
      expect(out.meta?.background).toBeFalsy();
      expect(text(out)).toContain('timed out');
    }
  });

  test('a killed moved wait stays quiet', async () => {
    const ended: string[] = [];
    const ctx = makeCtx({ cwd: dir, host: fakeHost({ shellEnded: (_id, t) => void ended.push(t) }), sessionId: 'sess_wait2' });
    const out = await BashTool.run({ command: 'sleep 31' }, ctx);
    await shellRegistry.kill('sess_wait2', String(out.meta?.shellId));
    await Bun.sleep(50);
    expect(ended).toHaveLength(0);
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

  test('a Git Bash cwd on a Windows session comes back in Windows form', () => {
    expect(windowsCwd('/c/Users/me/src', 'C:\\Users\\me')).toBe('C:\\Users\\me\\src');
    expect(windowsCwd('/d', 'C:\\Users\\me')).toBe('D:\\');
    expect(windowsCwd('/c/Users/me', '/home/me')).toBe('/c/Users/me');
    expect(windowsCwd('/home/me/src', '/home/me')).toBe('/home/me/src');
  });

  test('a cmd.exe device gets the cmd wrapper; the cwd marker and exit code come back', async () => {
    const sent: Array<{ command: string; env?: Record<string, string> }> = [];
    const machine = {
      id: 'win',
      lastInfo: { shell: 'C:\\WINDOWS\\system32\\cmd.exe' },
      exec: async (command: string, opts: { env?: Record<string, string> }) => {
        sent.push({ command, env: opts.env });
        const marker = /(__CONCLAVE_CWD_\w+__)/.exec(command)![1];
        return { exitCode: 2, stdout: 'File Not Found\r\n', stderr: `nope\r\n${marker}D:\\proj\\sub \r\n`, timedOut: false, aborted: false, durationMs: 5 };
      },
    } as unknown as Machine;
    const out = await BashTool.run({ command: 'cd sub\ndir x' }, makeCtx({ cwd: 'D:\\proj', machine }));
    const { command } = sent[0]!;
    const marker = /(__CONCLAVE_CWD_\w+__)/.exec(command)![1]!;
    expect(command).toBe(wrapCmdCommand(marker, 'cd sub\ndir x'));
    expect(command).toBe(`cd sub & dir x & call set __cc_ec=%^errorlevel%& call echo ${marker}%^CD% 1>&2 & call exit %^__cc_ec%`);
    expect(command).not.toContain('exec 3>&2');
    expect(out.isError).toBe(true);
    expect(out.meta?.exitCode).toBe(2);
    expect(out.meta?.cwd).toBe('D:\\proj\\sub');
    expect(text(out)).not.toContain('__CONCLAVE_CWD_');
    expect(text(out)).toContain('File Not Found');
    expect(text(out)).toContain('nope');
  });

  test('a bash device still gets the POSIX wrapper', async () => {
    const sent: string[] = [];
    const machine = {
      id: 'mac',
      lastInfo: { shell: '/bin/zsh' },
      exec: async (command: string) => {
        sent.push(command);
        return { exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false, aborted: false, durationMs: 1 };
      },
    } as unknown as Machine;
    await BashTool.run({ command: 'echo hi' }, makeCtx({ cwd: '/w', machine }));
    const marker = /(__CONCLAVE_CWD_\w+__)/.exec(sent[0]!)![1]!;
    expect(sent[0]).toBe(wrapCommand(marker));
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
