import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { expandCommand, substituteArgs, splitArgs } from '../../src/extensions/commands';
import type { CommandDef } from '../../src/extensions/types';
import { FakeMachine, tempDir, cleanup, write } from './_helpers';

/** These tests cover expansion; engine/command-shell.test.ts covers the permission check. */
const permit = async () => undefined;

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

function cmd(body: string): CommandDef {
  return { name: 'c', body, source: 'user' };
}

describe('argument substitution', () => {
  test('$ARGUMENTS and zero-based positional, like Claude Code', () => {
    expect(substituteArgs('all: $ARGUMENTS; first: $0; second: $1; third: $ARGUMENTS[2]', 'a b c')).toBe('all: a b c; first: a; second: b; third: c');
    // Verified live: `/hello Alice Bob` with body `$1 / all=$ARGUMENTS` renders `Bob / all=Alice Bob`.
    expect(substituteArgs('$1 / all=$ARGUMENTS', 'Alice Bob')).toBe('Bob / all=Alice Bob');
  });
  test('splitArgs honors quotes', () => {
    expect(splitArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });
});

describe('expandCommand', () => {
  test('runs bash snippets and inlines file references, then substitutes args', async () => {
    const cwd = tempDir();
    dirs.push(cwd);
    const machine = new FakeMachine();
    write(join(cwd, 'note.txt'), 'file contents here');
    const def = cmd('branch: !`echo main`\nfile: @note.txt\nmsg: $ARGUMENTS');
    const out = await expandCommand(def, 'ship it', { machine, cwd, permit });
    expect(out).toContain('branch: main');
    expect(out).toContain('file contents here');
    expect(out).toContain('note.txt:');
    expect(out).toContain('msg: ship it');
  });

  test('arguments cannot inject a bash snippet', async () => {
    const cwd = tempDir();
    dirs.push(cwd);
    const machine = new FakeMachine();
    const def = cmd('run: $ARGUMENTS');
    const out = await expandCommand(def, '!`echo pwned`', { machine, cwd, permit });
    // The injected snippet is left as inert text, not executed.
    expect(out).toContain('run: !`echo pwned`');
    expect(out).not.toContain('pwned\n');
  });

  test('arguments fill the template, not the files and output it pulls in', async () => {
    const cwd = tempDir();
    dirs.push(cwd);
    const machine = new FakeMachine();
    write(join(cwd, 'deploy.sh'), 'cp "$1" "$2" # $ARGUMENTS');
    const out = await expandCommand(cmd('Review @deploy.sh for $0\nenv: !`printf "%s" \'$1 {{args}}\'`'), 'staging', { machine, cwd, permit });
    expect(out).toContain('cp "$1" "$2" # $ARGUMENTS');
    expect(out).toContain('for staging');
    expect(out).toContain('env: $1 {{args}}');
    const gem = await expandCommand({ ...cmd('@{deploy.sh}'), argStyle: 'gemini' }, 'x', { machine, cwd, permit });
    expect(gem).toContain('cp "$1" "$2"');
    expect(gem).toEndWith('/c x');
  });

  test('missing file reference is left as-is', async () => {
    const cwd = tempDir();
    dirs.push(cwd);
    const machine = new FakeMachine();
    const def = cmd('see @missing.txt');
    const out = await expandCommand(def, '', { machine, cwd, permit });
    expect(out).toContain('@missing.txt');
  });
});
