/**
 * Compact numbers (src/lib/format.ts compact), as token counts and costs
 * show them: a value that rounds up to 1000 of a unit reads in the next.
 * Paths as a session shows them (pathIn, folderName).
 *
 *   bun test packages/web/test/format.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { compact, folderName, pathIn, shortPath } from '../src/lib/format';

describe('compact', () => {
  test('the usual sizes', () => {
    expect(compact(0)).toBe('0');
    expect(compact(999)).toBe('999');
    expect(compact(1500)).toBe('1.5K');
    expect(compact(9_999)).toBe('10K');
    expect(compact(46_200)).toBe('46K');
    expect(compact(1_250_000)).toBe('1.3M');
    expect(compact(2e9)).toBe('2B');
    expect(compact(-1500)).toBe('-1.5K');
    expect(compact(undefined)).toBe('0');
  });

  test('a value that rounds to 1000 reads in the next unit', () => {
    expect(compact(999.6)).toBe('1K');
    expect(compact(999_950)).toBe('1M');
    expect(compact(999_960_000)).toBe('1B');
    expect(compact(-999_950)).toBe('-1M');
  });
});

describe('paths in a session', () => {
  test('inside the session folder, relative to it; elsewhere cut from the start', () => {
    const cwd = '/tmp/conclave-demo-I67lq5/code/fernway-web';
    expect(pathIn(`${cwd}/src/auth/redirect.ts`, cwd)).toBe('src/auth/redirect.ts');
    expect(pathIn(`${cwd}/src/auth/redirect.ts`, `${cwd}/`)).toBe('src/auth/redirect.ts');
    expect(pathIn('/home/kai/code/conclave/notes.md', '~/code/conclave')).toBe('notes.md');
    expect(pathIn('/etc/caddy/Caddyfile', cwd)).toBe('/etc/caddy/Caddyfile');
    expect(pathIn('/var/lib/app/data/conf/site.yaml', cwd)).toBe('…/data/conf/site.yaml');
    expect(pathIn('/home/kai/notes/today.md', '~')).toBe('~/notes/today.md');
    expect(pathIn(undefined, cwd)).toBe('');
  });
  test('the project is the folder name', () => {
    expect(folderName('/tmp/conclave-demo-I67lq5/code/fernway-web')).toBe('fernway-web');
    expect(folderName('~/code/conclave/')).toBe('conclave');
    expect(folderName('~')).toBe('');
    expect(folderName('/home/kai')).toBe('');
    expect(folderName(undefined)).toBe('');
  });
  test('Windows paths read the same way', () => {
    const cwd = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\conclave-demo-rJVZ5d\\code\\fernway-web';
    expect(pathIn(`${cwd}\\src\\auth\\redirect.ts`, cwd)).toBe('src/auth/redirect.ts');
    expect(pathIn('c:\\code\\app\\src\\main.ts', 'C:\\code\\app')).toBe('src/main.ts');
    expect(pathIn('D:\\data\\conf\\site\\site.yaml', cwd)).toBe('…/conf/site/site.yaml');
    expect(folderName(`${cwd}\\`)).toBe('fernway-web');
    expect(folderName('C:\\Users\\sam')).toBe('');
    expect(shortPath('C:\\Users\\sam\\notes\\today.md')).toBe('~/notes/today.md');
  });
});
