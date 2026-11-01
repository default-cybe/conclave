/**
 * Mobile v2 logic (docs/design/MOBILE-V2.md): the tool line sentence and
 * its rows (src/lib/toolLine.ts), the side panel's Recents and the dot after
 * Code (src/lib/recents.ts), and the link a pairing QR code carries
 * (src/lib/pairLink.ts).
 *
 *   bun test packages/web/test/mobile-v2.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import { changeWords, shortCommand, toolLine, toolRowWords, workingWords, type ToolCall } from '../src/lib/toolLine';
import { hrefOf, liveState } from '../src/lib/recents';
import { parsePairLink } from '../src/lib/pairLink';

const read = (file_path: string): ToolCall => ({ name: 'Read', input: { file_path } });
const edit = (file_path: string): ToolCall => ({ name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } });
const bash = (command: string): ToolCall => ({ name: 'Bash', input: { command } });

describe('toolLine', () => {
  test('the spec example: a file read, then edited, then a test run', () => {
    const f = '/home/sam/code/fernway-web/src/auth/redirect.ts';
    expect(toolLine([read(f), edit(f), bash('bun test src/auth')])).toBe('Read redirect.ts, edited it, ran bun test');
  });

  test('first three, then how many more', () => {
    const calls = [read('a.ts'), edit('a.ts'), bash('bun test'), bash('git status'), bash('git add -A'), bash('git commit -m x'), { name: 'WebSearch', input: { query: 'x' } }];
    expect(toolLine(calls)).toBe('Read a.ts, edited it, ran bun test and 4 more');
  });

  test('one call, two calls, none', () => {
    expect(toolLine([bash('git push origin fix/login')])).toBe('Ran git push');
    expect(toolLine([read('src/a.ts'), edit('src/b.ts')])).toBe('Read a.ts, edited b.ts');
    expect(toolLine([])).toBe('');
  });

  test('calls of a kind in a row read as one phrase: the same file once, different files counted', () => {
    expect(toolLine([read('a.ts'), read('a.ts')])).toBe('Read a.ts');
    expect(toolLine([read('a.ts'), read('b.ts'), read('c.ts'), edit('b.ts')])).toBe('Read 3 files, edited b.ts');
    expect(toolLine([edit('a.ts'), edit('b.ts')])).toBe('Edited 2 files');
    expect(toolLine([{ name: 'WebSearch', input: { query: 'a' } }, { name: 'WebSearch', input: { query: 'b' } }])).toBe('Searched the web 2 times');
    expect(toolLine([{ name: 'MemorySave', input: { content: 'a' } }, { name: 'MemorySave', input: { content: 'b' } }])).toBe('Saved 2 notes');
  });

  test('commands stay apart, the same one twice reads once', () => {
    expect(toolLine([bash('bun test'), bash('git push origin main')])).toBe('Ran bun test, ran git push');
    expect(toolLine([bash('bun test'), bash('bun test')])).toBe('Ran bun test');
  });

  test('"it" only for the same single file as the phrase before', () => {
    expect(toolLine([edit('src/x.ts'), read('src/x.ts')])).toBe('Edited x.ts, read it');
    expect(toolLine([read('src/x.ts'), bash('bun test'), edit('src/x.ts')])).toBe('Read x.ts, ran bun test, edited x.ts');
    // two files of the same name in different folders are not "it"
    expect(toolLine([read('a/x.ts'), edit('b/x.ts')])).toBe('Read x.ts, edited x.ts');
  });

  test('every kind of tool has words', () => {
    expect(toolLine([{ name: 'Grep', input: { pattern: 'afterLogin' } }])).toBe('Searched for afterLogin');
    expect(toolLine([{ name: 'Glob', input: { pattern: '**/*.test.ts with a very long tail here' } }])).toBe('Searched the code');
    expect(toolLine([{ name: 'WebFetch', input: { url: 'https://www.example.com/a' } }])).toBe('Read example.com');
    expect(toolLine([{ name: 'Task', input: { description: 'x' } }])).toBe('Ran a subagent');
    expect(toolLine([{ name: 'TodoWrite', input: { todos: [] } }, { name: 'TodoWrite', input: { todos: [] } }])).toBe('Updated the plan');
    expect(toolLine([{ name: 'AskUserQuestion', input: {} }])).toBe('Asked you');
    expect(toolLine([{ name: 'MemorySearch', input: { query: 'x' } }])).toBe('Checked memory');
    expect(toolLine([{ name: 'mcp__proxmox__list_guests', input: {} }])).toBe('Used proxmox list_guests');
    expect(toolLine([{ name: 'Frobnicate', input: {} }])).toBe('Used Frobnicate');
    expect(toolLine([{ name: 'Write', input: { file_path: 'notes.md', content: 'x' } }])).toBe('Wrote notes.md');
  });
});

describe('shortCommand', () => {
  test('the program and what it does', () => {
    expect(shortCommand('bun test src/auth')).toBe('bun test');
    expect(shortCommand('git push origin fix/login')).toBe('git push');
    expect(shortCommand('git log --oneline -3')).toBe('git log');
    expect(shortCommand('npm run build')).toBe('npm run build');
    expect(shortCommand('ls -la')).toBe('ls');
    expect(shortCommand('python3 scripts/check.py')).toBe('python3');
    expect(shortCommand('docker compose up -d')).toBe('docker compose');
  });
  test('past cd, variables and pipes; a path to the program is its name', () => {
    expect(shortCommand('cd web && bun test')).toBe('bun test');
    expect(shortCommand('CI=1 bun test')).toBe('bun test');
    expect(shortCommand('cat package.json | head')).toBe('cat');
    expect(shortCommand('./scripts/run.sh fast')).toBe('run.sh fast');
    expect(shortCommand('/usr/bin/make')).toBe('make');
  });
});

describe('tool rows', () => {
  test('the verb, then the file name or the command', () => {
    expect(toolRowWords(read('/x/src/auth/redirect.ts'))).toEqual({ verb: 'Read', target: 'redirect.ts', mono: true });
    expect(toolRowWords(edit('src/auth/redirect.ts'))).toEqual({ verb: 'Edited', target: 'redirect.ts', mono: true });
    expect(toolRowWords(bash('bun test src/auth'))).toEqual({ verb: 'Ran', target: 'bun test src/auth', mono: true });
    expect(toolRowWords({ name: 'WebSearch', input: { query: 'caddy tailscale' } })).toEqual({ verb: 'Searched the web', target: 'caddy tailscale', mono: false });
    expect(toolRowWords({ name: 'mcp__gh__pr_list', input: {} })).toEqual({ verb: 'Used', target: 'gh pr_list', mono: false });
  });
  test('an edit as lines added and removed, with a minus sign', () => {
    expect(changeWords(2, 0)).toBe('+2 −0');
  });
  test('what the working line says', () => {
    expect(workingWords(bash('bun test src/auth'))).toBe('Running bun test');
    expect(workingWords(read('src/a.ts'))).toBe('Reading a.ts');
    expect(workingWords(edit('src/a.ts'))).toBe('Editing a.ts');
    expect(workingWords({ name: 'WebSearch', input: {} })).toBe('Searching the web');
    expect(workingWords(undefined)).toBe('Working');
    expect(workingWords({ name: 'Unknown' })).toBe('Working');
  });
});

describe('a row in a list', () => {
  const s = (id: string, p: Partial<Session> = {}): Session => ({ id, title: id, status: 'idle', archived: false, updatedAt: 0, ...p }) as Session;

  test('a running one has the breathing dot, one waiting on you the amber one; waiting wins', () => {
    const waiting = new Set(['both']);
    expect([s('run', { status: 'running' }), s('ask', { status: 'waiting_approval' }), s('both', { status: 'running' }), s('done')].map((x) => liveState(x, waiting))).toEqual(['running', 'waiting', 'waiting', undefined]);
    expect(liveState(s('q', { status: 'waiting_input' }), new Set())).toBe('waiting');
  });

  test('where each opens', () => {
    expect(hrefOf({ id: 'a', kind: 'chat' })).toBe('/chat/a');
    expect(hrefOf({ id: 'b' })).toBe('/s/b');
  });
});

describe('parsePairLink', () => {
  const fp = '6d249c9993d23cddb309b8db0fbc36cc';
  const enc = encodeURIComponent;
  test('the addresses, the code and the key a pairing QR code carries', () => {
    const link = `conclave://pair?url=${enc('http://192.168.1.20:7717/')}&code=efxr-8hh3&fp=${fp}&alt=${enc('https://hub.example.com')}&alt=${enc('http://192.168.1.20:7717')}`;
    expect(parsePairLink(link)).toEqual({ urls: ['http://192.168.1.20:7717', 'https://hub.example.com'], code: 'EFXR-8HH3', fp });
  });
  test('a key that is not one is left out; the code still pairs', () => {
    expect(parsePairLink(`conclave://pair?url=${enc('http://10.0.0.2:7717')}&code=ABCDEFGH&fp=xyz`)).toEqual({ urls: ['http://10.0.0.2:7717'], code: 'ABCD-EFGH' });
  });
  test('anything else is not a pairing code', () => {
    expect(parsePairLink('https://example.com/?code=ABCD-EFGH')).toBeUndefined();
    expect(parsePairLink(`conclave://pair?url=${enc('http://10.0.0.2:7717')}&code=ABC`)).toBeUndefined();
    expect(parsePairLink('conclave://pair?code=ABCD-EFGH')).toBeUndefined();
    expect(parsePairLink(`conclave://pair?url=${enc('ftp://x')}&code=ABCD-EFGH`)).toBeUndefined();
    expect(parsePairLink('hello')).toBeUndefined();
  });
});
