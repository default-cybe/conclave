import { describe, expect, test } from 'bun:test';
import { fileWords, openFileHref } from '../src/features/extensions/hooks/EventSection';

describe('hook problem file words', () => {
  test('names the file the way the owner knows it', () => {
    expect(fileWords('/var/lib/conclave/config.json')).toBe('config.json');
    expect(fileWords('/home/conclave/.claude/settings.json')).toBe('~/.claude/settings.json');
    expect(fileWords('/home/me/code/app/.claude/settings.local.json')).toBe('.claude/settings.local.json');
    expect(fileWords('/home/me/code/app/.conclave/settings.json')).toBe('.conclave/settings.json');
  });

  test('Open file goes to the hub file viewer at that file', () => {
    expect(openFileHref('/home/conclave/.claude/settings.json')).toBe('/devices/local/files?path=%2Fhome%2Fconclave%2F.claude&file=%2Fhome%2Fconclave%2F.claude%2Fsettings.json');
  });
});
