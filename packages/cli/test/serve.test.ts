import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginLine, stopWhenStdinEnds } from '../src/commands/serve';
import { openHubLog } from '../src/hub';

describe('stopWhenStdinEnds (the desktop app stops its hub by closing stdin)', () => {
  test('stops once when the pipe ends, not on input', async () => {
    const input = new PassThrough();
    let stops = 0;
    stopWhenStdinEnds(() => stops++, input);
    input.write('anything the parent writes is ignored\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toBe(0);
    input.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toBe(1);
    // end and close both fire; the hub is asked to stop once
    input.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toBe(1);
  });

  test('a broken pipe counts as the end', async () => {
    const input = new PassThrough();
    let stops = 0;
    stopWhenStdinEnds(() => stops++, input);
    input.destroy(new Error('EPIPE'));
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toBe(1);
  });
});

describe('a detached hub keeps its owner token out of its output', () => {
  test('the Login line has the token only in a terminal', () => {
    const token = 'tok-0123456789abcdefSECRET';
    expect(loginLine('http://127.0.0.1:7717', token, { detached: false, config: '/h/config.json' })).toContain(token);
    const detached = loginLine('http://127.0.0.1:7717', token, { detached: true, config: '/h/config.json' });
    expect(detached).not.toContain(token);
    expect(detached).toContain('http://127.0.0.1:7717');
    expect(detached).toContain('/h/config.json');
  });

  test.skipIf(process.platform === 'win32')('logs/hub.log is 0600 in a 0700 folder, also one made before', () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-hublog-'));
    try {
      mkdirSync(join(home, 'logs'), { recursive: true });
      chmodSync(join(home, 'logs'), 0o755);
      writeFileSync(join(home, 'logs', 'hub.log'), 'old line\n', { mode: 0o644 });
      closeSync(openHubLog(home));
      expect(statSync(join(home, 'logs')).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'logs', 'hub.log')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
