import { describe, expect, test } from 'bun:test';
import { exec } from '../lib/util';

describe('exec', () => {
  test('a character split between two reads of the pipe stays whole', async () => {
    // the first byte of é, a pause so it arrives on its own, then the second
    const r = await exec(['sh', '-c', "printf 'a\\303'; sleep 0.3; printf '\\251\\n'"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('aé\n');
  });
});
