/**
 * Security mode lane detector (src/features/chat/lanes.ts) against the
 * rows of docs/design/SECURITY-MODE.md 1.2.
 *
 *   bun test packages/web/test/security-lanes.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { detectLanes } from '../src/features/chat/lanes.ts';

describe('detectLanes', () => {
  test('one row each', () => {
    expect(detectLanes('nc pwn.example.org 31337, flag{...}')[0]).toBe('ctf');
    expect(detectLanes('Variant hunt for CVE-2026-41822')[0]).toBe('variant');
    expect(detectLanes('ERROR: AddressSanitizer: heap-use-after-free')[0]).toBe('exploit');
    expect(detectLanes('Look at router.bin from the vendor')[0]).toBe('re');
    expect(detectLanes('Audit ~/hunts/acme/src')[0]).toBe('source');
    expect(detectLanes('Test https://app.example.com')[0]).toBe('web');
    expect(detectLanes('hello')).toEqual([]);
  });
  test('a GitHub URL is source, not web', () => {
    expect(detectLanes('https://github.com/acme/app')).toEqual(['source']);
  });
  test('a CTF bundle with a crash log is CTF first', () => {
    expect(detectLanes('challenge files attached, SIGSEGV in AddressSanitizer log').slice(0, 2)).toEqual(['ctf', 'exploit']);
  });
  test('a repo plus a CVE is variant with source as the alternative', () => {
    expect(detectLanes('CVE-2026-1234 in github.com/tooljet/tooljet')).toEqual(['variant', 'source']);
  });
});
