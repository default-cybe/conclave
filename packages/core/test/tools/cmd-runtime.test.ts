import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine } from '../../src/machine/local';
import type { ExecOptions, ExecResult } from '../../src/machine/types';
import { BashTool } from '../../src/tools/bash';
import { shellRegistry } from '../../src/tools/shells';
import { makeCtx, text } from './helpers';

// The Windows runner has Git Bash; this machine always runs cmd.exe, the shell of a Windows device without it.
class CmdMachine extends LocalMachine {
  override shell(): string {
    return process.env.ComSpec || 'cmd.exe';
  }
}

// every exec, the TEMP lookup included, sees this TEMP
class TempMachine extends CmdMachine {
  constructor(private readonly temp: string) {
    super();
  }
  override exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    return super.exec(command, { ...opts, env: { ...opts.env, TEMP: this.temp } });
  }
}

const CALL_TIMEOUT = 20_000;
const TEST_TIMEOUT = 30_000;
const bun = process.execPath;
const machine = new CmdMachine();
// cmd's output has CRLF line ends
const clean = (s: string) => s.replace(/\r/g, '');
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

describe.skipIf(process.platform !== 'win32')('Bash tool on cmd.exe (Windows runtime)', () => {
  let base = '';
  let root = '';
  let echoJs = '';
  let binDir = '';

  beforeAll(() => {
    // realpath turns the runner's 8.3 temp path (RUNNER~1) into the long form cmd reports
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-cmd-')));
    // the session cwd only: a % typed into a batch command would need doubling
    root = join(base, 'cmd rt (x) 100% & y');
    mkdirSync(root);
    binDir = join(base, 'bin dir');
    mkdirSync(binDir);
    echoJs = join(binDir, 'echo args.js');
    writeFileSync(echoJs, 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nif (process.argv[2] === "exit") process.exit(Number(process.argv[3]));\n');
    writeFileSync(
      join(binDir, 'cc-shim.cmd'),
      // the shape npm writes: no CALL needed by the caller, %~dp0 for its own folder
      ['@ECHO off', 'SETLOCAL', `"${bun}" "%~dp0\\echo args.js" %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n'),
    );
    writeFileSync(
      join(binDir, 'sleeper.js'),
      'const fs = require("node:fs");\nfs.writeFileSync(process.argv[2], "up");\nsetTimeout(() => fs.writeFileSync(process.argv[3], "late"), 3000);\n',
    );
  });

  afterAll(async () => {
    await shellRegistry.disposeAll();
    if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const bash = (command: string, cwd = root, sessionId = 'sess_cmd_rt', timeout = CALL_TIMEOUT) =>
    BashTool.run({ command, timeout }, makeCtx({ cwd, machine, sessionId }));

  test('runs a quoted executable path with spaces and quoted arguments', async () => {
    const exeDir = join(base, 'bun copy');
    mkdirSync(exeDir, { recursive: true });
    const exe = join(exeDir, 'bun.exe');
    if (!existsSync(exe)) {
      try {
        linkSync(bun, exe);
      } catch {
        copyFileSync(bun, exe);
      }
    }
    const out = await bash(`"${exe}" "${echoJs}" alpha "two words"`);
    expect({ isError: out.isError, exitCode: out.meta?.exitCode, out: clean(text(out)) }).toEqual({
      isError: false,
      exitCode: 0,
      out: expect.stringMatching(/^\{/),
    });
    expect(JSON.parse(clean(text(out))).args).toEqual(['alpha', 'two words']);
  }, TEST_TIMEOUT);

  test('starts in a cwd with spaces, parentheses, percent and ampersand, and leaves it unchanged', async () => {
    const out = await bash(`"${bun}" "${echoJs}"`);
    expect({ isError: out.isError, exitCode: out.meta?.exitCode, out: clean(text(out)) }).toEqual({
      isError: false,
      exitCode: 0,
      out: expect.stringMatching(/^\{/),
    });
    expect(same(JSON.parse(clean(text(out))).cwd, root)).toBe(true);
    expect(out.meta?.cwd).toBeUndefined();
    const cd = await bash('cd');
    expect(same(clean(text(cd)), root)).toBe(true);
    expect(cd.meta?.cwd).toBeUndefined();
  }, TEST_TIMEOUT);

  test('a doubled percent prints a literal percent (batch semantics)', async () => {
    const out = await bash('echo 100%%');
    expect(out.isError).toBeFalsy();
    expect(clean(text(out))).toBe('100%');
  }, TEST_TIMEOUT);

  test('types a file with a Unicode name and prints its UTF-8 text exactly', async () => {
    const body = 'héllo wörld ✓ 日本語';
    const file = join(root, 'café.txt');
    writeFileSync(file, body);
    const out = await bash(`type "${file.replace(/%/g, '%%')}"`);
    expect(out.isError).toBeFalsy();
    expect(clean(text(out))).toBe(body);
  }, TEST_TIMEOUT);

  test('TEMP with spaces, &, parentheses and % still runs, and leaves no script behind', async () => {
    const temp = join(base, 'Temp & More (x) 100%');
    mkdirSync(temp, { recursive: true });
    const tm = new TempMachine(temp);
    const call = (command: string) => BashTool.run({ command, timeout: CALL_TIMEOUT }, makeCtx({ cwd: root, machine: tm, sessionId: 'sess_cmd_temp' }));
    // quoted: cmd expands % before it parses &, so a bare %TEMP% would split the line
    const echoed = await call('echo "%TEMP%"');
    expect(echoed.isError).toBeFalsy();
    expect(same(clean(text(echoed)), `"${temp}"`)).toBe(true);
    const failed = await call('echo in-temp\nexit /b 4');
    expect(failed.meta?.exitCode).toBe(4);
    expect(clean(text(failed)).split('\n')[0]).toBe('in-temp');
    expect(readdirSync(temp)).toEqual([]);
  }, TEST_TIMEOUT);

  test('echo with unescaped parentheses', async () => {
    const out = await bash('echo (hello)');
    expect(out.isError).toBeFalsy();
    expect(clean(text(out))).toBe('(hello)');
  }, TEST_TIMEOUT);

  test('a variable set on one line expands on the next', async () => {
    const out = await bash('set CC_A=one\nset CC_B=two\necho %CC_A%-%CC_B%');
    expect(out.isError).toBeFalsy();
    expect(clean(text(out))).toBe('one-two');
  }, TEST_TIMEOUT);

  test('multiline if, for, rem and ::', async () => {
    const script = [
      'rem a comment line',
      ':: a label comment',
      'for %%i in (a b c) do (',
      '  echo item-%%i',
      ')',
      'if exist "%CD%" (',
      '  echo yes',
      ') else (',
      '  echo no',
      ')',
      'rem trailing comment',
    ].join('\n');
    const out = await bash(script);
    expect(out.isError).toBeFalsy();
    expect(clean(text(out))).toBe('item-a\nitem-b\nitem-c\nyes');
  }, TEST_TIMEOUT);

  test('cd /d moves the session and meta.cwd reports the new folder', async () => {
    const sub = join(root, 'sub (1) 50% & z');
    mkdirSync(sub, { recursive: true });
    // batch semantics: a literal % in the command is written %%
    const out = await bash(`cd /d "${sub.replace(/%/g, '%%')}"\n"${bun}" "${echoJs}"`);
    expect({ isError: out.isError, exitCode: out.meta?.exitCode, out: clean(text(out)) }).toEqual({
      isError: false,
      exitCode: 0,
      out: expect.stringMatching(/^\{/),
    });
    expect(same(out.meta?.cwd as string | undefined, sub)).toBe(true);
    expect(same(JSON.parse(clean(text(out)).split('\n')[0] as string).cwd, sub)).toBe(true);
    // the next call starts where the last one ended
    const next = await bash('cd', out.meta?.cwd as string);
    expect(same(clean(text(next)), sub)).toBe(true);
    expect(next.meta?.cwd).toBeUndefined();
  }, TEST_TIMEOUT);

  test('cmd /c exit 7 reports exit code 7', async () => {
    const out = await bash('cmd /c exit 7');
    expect(out.isError).toBe(true);
    expect(out.meta?.exitCode).toBe(7);
  }, TEST_TIMEOUT);

  test('exit /b 9 reports exit code 9', async () => {
    const out = await bash('echo before\nexit /b 9');
    expect(out.isError).toBe(true);
    expect(out.meta?.exitCode).toBe(9);
    expect(clean(text(out)).split('\n')[0]).toBe('before');
  }, TEST_TIMEOUT);

  test('runs an npm-style .cmd shim from PATH without CALL', async () => {
    const out = await bash(`set "PATH=${binDir};%PATH%"\ncc-shim hello "two words"`);
    expect({ isError: out.isError, exitCode: out.meta?.exitCode, out: clean(text(out)) }).toEqual({
      isError: false,
      exitCode: 0,
      out: expect.stringMatching(/^\{/),
    });
    const lines = clean(text(out)).split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).args).toEqual(['hello', 'two words']);
    expect(out.meta?.cwd).toBeUndefined();
    const failed = await bash(`set "PATH=${binDir};%PATH%"\ncc-shim exit 5`);
    expect(failed.meta?.exitCode).toBe(5);
  }, TEST_TIMEOUT);

  test('a timeout kills the whole tree, so a child started by cmd never writes', async () => {
    const started = join(base, 'started.txt');
    const sentinel = join(base, 'sentinel.txt');
    const out = await bash(`"${bun}" "${join(binDir, 'sleeper.js')}" "${started}" "${sentinel}"`, root, 'sess_cmd_rt', 1_000);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('timed out');
    await Bun.sleep(3_500);
    expect(existsSync(started)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  }, 10_000);

  test('a background command (bash -c) runs in cmd', async () => {
    const ctx = makeCtx({ cwd: root, machine, sessionId: 'sess_cmd_bg' });
    const out = await BashTool.run({ command: 'echo os=%OS%', run_in_background: true, timeout: CALL_TIMEOUT }, ctx);
    expect(out.isError).toBeFalsy();
    const shell = shellRegistry.get('sess_cmd_bg', String(out.meta?.shellId));
    expect(shell).toBeDefined();
    const ended = await Promise.race([shell!.done.then(() => true), Bun.sleep(15_000).then(() => false)]);
    if (!ended) await shell!.kill();
    expect(ended).toBe(true);
    expect(shell!.info.exitCode).toBe(0);
    // Git Bash would print %OS% as it is
    expect(clean(shell!.stdout.all()).trim()).toBe('os=Windows_NT');
  }, TEST_TIMEOUT);
});
