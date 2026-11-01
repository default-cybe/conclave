import { describe, expect, test } from 'bun:test';
import { bool, num, parseArgs, parseTimeout, str } from '../src/args';
import { route } from '../src/index';

describe('parseArgs', () => {
  test('positionals and long flags with values', () => {
    const a = parseArgs(['run', 'fix', 'tests', '--model', 'openai/gpt-5.5', '--cwd=/tmp/x']);
    expect(a._).toEqual(['run', 'fix', 'tests']);
    expect(str(a, 'model')).toBe('openai/gpt-5.5');
    expect(str(a, 'cwd')).toBe('/tmp/x');
  });

  test('boolean flags do not eat the next token', () => {
    const a = parseArgs(['run', '--json', 'hello world', '--yes']);
    expect(a._).toEqual(['run', 'hello world']);
    expect(bool(a, 'json')).toBe(true);
    expect(bool(a, 'yes')).toBe(true);
  });

  test('short aliases and grouped short booleans', () => {
    const a = parseArgs(['-m', 'zai/glm-5', '-cy', '-r', 's_123']);
    expect(str(a, 'model')).toBe('zai/glm-5');
    expect(bool(a, 'continue')).toBe(true);
    expect(bool(a, 'yes')).toBe(true);
    expect(str(a, 'resume')).toBe('s_123');
  });

  test('inline short value and --no- prefix', () => {
    const a = parseArgs(['-mopenai/gpt-5.5', '--no-open']);
    expect(str(a, 'model')).toBe('openai/gpt-5.5');
    expect(bool(a, 'open')).toBe(false);
  });

  test('-- stops flag parsing', () => {
    const a = parseArgs(['run', '--', '--not-a-flag', '-x']);
    expect(a._).toEqual(['run']);
    expect(a.rest).toEqual(['--not-a-flag', '-x']);
  });

  test('unknown flags take a value when one follows', () => {
    const a = parseArgs(['--search', 'foo', '--weird', '--json']);
    expect(str(a, 'search')).toBe('foo');
    expect(a.flags.weird).toBe(true);
    expect(bool(a, 'json')).toBe(true);
  });

  test('negative numbers stay positional', () => {
    const a = parseArgs(['usage', '-5']);
    expect(a._).toEqual(['usage', '-5']);
  });

  test('numbers', () => {
    expect(num(parseArgs(['--port', '7800']), 'port')).toBe(7800);
    expect(num(parseArgs(['--port', 'abc']), 'port')).toBeUndefined();
  });

  test('--yes=false', () => {
    expect(bool(parseArgs(['--yes=false']), 'yes')).toBe(false);
  });
});

describe('parseTimeout', () => {
  test('units and bare seconds', () => {
    expect(parseTimeout('90')).toBe(90_000);
    expect(parseTimeout('90s')).toBe(90_000);
    expect(parseTimeout('10m')).toBe(600_000);
    expect(parseTimeout('1h30m')).toBe(5_400_000);
    expect(parseTimeout('soon')).toBeUndefined();
    expect(parseTimeout(undefined)).toBeUndefined();
  });
});

describe('route', () => {
  test('no args is chat', () => {
    expect(route(parseArgs([]))).toEqual({ name: 'chat', promptFrom: 0 });
  });
  test('known commands and aliases', () => {
    expect(route(parseArgs(['sessions', 'ls']))).toEqual({ name: 'sessions', promptFrom: 1 });
    expect(route(parseArgs(['ls']))).toEqual({ name: 'sessions', promptFrom: 1 });
  });
  test('free text starts a chat with that prompt', () => {
    expect(route(parseArgs(['fix', 'the', 'tests']))).toEqual({ name: 'chat', promptFrom: 0 });
  });
  test('a lone near-miss word is a typo', () => {
    expect(route(parseArgs(['sesions']))).toEqual({ unknown: 'sesions', suggestion: 'sessions' });
  });
  test('-p runs headless with the positional prompt', () => {
    expect(route(parseArgs(['-p', 'hello']))).toEqual({ name: 'run', promptFrom: 0 });
  });
});
