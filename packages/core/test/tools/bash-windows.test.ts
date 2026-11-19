import { describe, expect, test } from 'bun:test';
import { windowsBash } from '../../src/machine/local';
import { followCwd } from '../../src/tools/bash';

describe('followCwd on a Windows session', () => {
  const cur = 'D:\\Coding\\site';
  test('keeps a Windows path and turns slashes around', () => {
    expect(followCwd('D:/Coding/site/web', cur)).toBe('D:\\Coding\\site\\web');
    expect(followCwd('C:\\Users\\n', cur)).toBe('C:\\Users\\n');
  });
  test("maps Git Bash's /d/x to D:\\x", () => {
    expect(followCwd('/d/Coding/site/web', cur)).toBe('D:\\Coding\\site\\web');
    expect(followCwd('/c', cur)).toBe('C:\\');
  });
  test('drops a Linux path (WSL) so later calls still start', () => {
    expect(followCwd('/mnt/d/Coding/site', cur)).toBeUndefined();
    expect(followCwd('/home/n', cur)).toBeUndefined();
  });
  test('leaves POSIX sessions alone', () => {
    expect(followCwd('/d/x', '/home/k')).toBe('/d/x');
    expect(followCwd(undefined, cur)).toBeUndefined();
  });
});

describe('windowsBash', () => {
  const WSL = 'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
  const env = (k: string) => ({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local' })[k];
  const pick = (path: string, files: string[]) => windowsBash(path, env, (p) => files.some((f) => f.toLowerCase() === p.toLowerCase()));

  test('follows git.exe on PATH, before the WSL launcher', () => {
    const path = 'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32;D:\\Tools\\Git\\cmd';
    expect(pick(path, [WSL, 'C:\\Windows\\System32\\bash.exe', 'D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe'])).toBe('D:\\Tools\\Git\\bin\\bash.exe');
  });
  test('tries the standard folders', () => {
    const path = 'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps';
    expect(pick(path, [WSL, 'C:\\Program Files\\Git\\bin\\bash.exe'])).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(pick(path, [WSL, 'C:\\Users\\n\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'])).toBe('C:\\Users\\n\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });
  test('never picks the WSL launcher', () => {
    expect(pick('C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps;C:\\WINDOWS\\system32', [WSL, 'C:\\WINDOWS\\system32\\bash.exe'])).toBeUndefined();
  });
});
