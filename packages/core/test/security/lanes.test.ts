import { describe, expect, test } from 'bun:test';
import { DEFAULT_LANE, detectLanes, laneOf, type Lane } from '../../src/security/lanes';

// one row per rank of SECURITY-MODE.md 1.2, then the edge cases of design PR 5
const ROWS: Array<[string, Parameters<typeof detectLanes>[0], Lane[]]> = [
  ['1 CTF: flag{', 'find the flag{...} in this binary service', ['ctf']],
  ['1 CTF: nc host port line', 'connect with\nnc chall.pwn.lab 31337\nand get a shell', ['ctf']],
  ['1 CTF: challenge plus attached files', { text: 'here is the challenge', files: ['task.txt'] }, ['ctf']],
  ['1 CTF: challenge word alone is not a bundle', 'what is the challenge of fuzzing?', []],
  ['2 variant: CVE', 'look for variants of CVE-2024-3094', ['variant']],
  ['2 variant: GHSA', 'GHSA-abcd-1234-efgh is fixed upstream', ['variant']],
  ['2 variant: commit URL', 'the fix is https://github.com/acme/lib/commit/abc123', ['variant', 'source']],
  ['3 exploit: AddressSanitizer', '==1==ERROR: AddressSanitizer: heap-buffer-overflow', ['exploit']],
  ['3 exploit: SIGSEGV plus a stack', 'Program received SIGSEGV\n#0 0x0000555 in parse()', ['exploit']],
  ['3 exploit: SIGSEGV with no stack is not enough', 'it died with SIGSEGV once', []],
  ['3 exploit: attached PoC', { text: 'make this reliable', files: ['poc.py'] }, ['exploit']],
  ['4 RE: firmware', 'unpack this router firmware', ['re']],
  ['4 RE: .apk named', 'reverse app-release.apk', ['re']],
  ['4 RE: attached binary', { text: 'what does this do', files: ['target.bin'] }, ['re']],
  ['5 source: GitHub repo', 'audit github.com/acme/lib', ['source']],
  ['5 source: .git URL', 'clone git@example.org:acme/lib.git and audit it', ['source']],
  ['5 source: folder path', 'review ~/src/acme/ for injection', ['source']],
  ['6 web: URL', 'test https://app.example.com for IDOR', ['web']],
  ['6 web: bare host', 'test app.example.com for IDOR', ['web']],
  ['7 nothing matched', 'help me think about threat models', []],
];

describe('lane detector (SECURITY-MODE.md 1.2)', () => {
  for (const [name, input, want] of ROWS) test(name, () => expect(detectLanes(input)).toEqual(want));

  test('a GitHub URL goes to source, not web', () => {
    expect(detectLanes('https://github.com/acme/lib')).toEqual(['source']);
  });

  test('a CTF bundle with a crash log inside goes to CTF first', () => {
    expect(detectLanes({ text: 'challenge: AddressSanitizer: SEGV on unknown address', files: ['chall.tar.gz'] })[0]).toBe('ctf');
  });

  test('a repo plus a CVE gives variant, with source as the alternative', () => {
    expect(detectLanes('CVE-2025-1234 in https://github.com/acme/lib')).toEqual(['variant', 'source']);
  });

  test('every match is returned in rank order', () => {
    expect(detectLanes('CVE-2025-1234 hits https://app.example.com and github.com/acme/lib')).toEqual(['variant', 'source', 'web']);
  });

  test('nothing matched defaults to white-box source', () => {
    expect(DEFAULT_LANE).toBe('source');
  });

  test('long runs of one character stay linear (CodeQL js/polynomial-redos)', () => {
    const t0 = performance.now();
    for (const c of ['!', '-', 'a', '/', '.']) detectLanes(c.repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test('laneOf reads only valid lanes', () => {
    expect(laneOf({ lane: { lane: 'web', detected: ['web', 'bogus'] } })).toEqual({ lane: 'web', detected: ['web'] });
    expect(laneOf({ lane: { lane: 'bogus', detected: [] } })).toBeUndefined();
    expect(laneOf(undefined)).toBeUndefined();
  });
});
