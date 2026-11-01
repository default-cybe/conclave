/**
 * The hub's own log files (docs/DESIGN.md 33) are this user's only and never
 * hold the owner token, also when an app sends it in the query string (the
 * socket) and the hub's folder was made by someone else first (the desktop
 * app writes hub.log there).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

let hub: TestHub;
let logs: string;

beforeAll(() => {
  // a hub home whose logs folder another program made with the usual rights
  hub = startHub();
  logs = hub.engine.config.paths.logs;
  mkdirSync(logs, { recursive: true });
  const ctx = hub.running.conclave.ctx;
  ctx.logs.stop('test');
  chmodSync(logs, 0o755);
  ctx.logs.start({ bus: hub.engine.bus });
});
afterAll(() => hub.stop());

describe('the log files', () => {
  test('are 0600 in a 0700 folder, and never hold the owner token', async () => {
    const ws = await openWs(`${hub.url.replace(/^http/, 'ws')}/api/ws?token=${OWNER}`);
    await ws.next((f) => f.type === 'hello');
    ws.close();
    expect((await hub.api('/api/sessions')).status).toBe(200);
    // a wrong token, and a 404 with the token in the query
    expect((await hub.api('/api/sessions', { token: 'not-the-token-at-all' })).status).toBe(401);
    expect((await hub.api(`/api/nothing-here?token=${OWNER}`)).status).toBe(404);
    await Bun.sleep(200);

    const files = readdirSync(logs).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(statSync(logs).mode & 0o777).toBe(0o700);
      for (const f of files) expect(statSync(join(logs, f)).mode & 0o777).toBe(0o600);
    }
    for (const f of files) expect(readFileSync(join(logs, f), 'utf8')).not.toContain(OWNER);
  });
});
