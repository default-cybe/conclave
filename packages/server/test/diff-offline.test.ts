import { expect, test } from 'bun:test';
import { startTestEngine } from '../../core/test/engine/harness';
import { createServer } from '../src/app';

test('an offline device diff returns HTTP 200 with the offline flag', async () => {
  const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  const token = 'diff-offline-owner-token-0123456789';
  t.engine.config.update({ server: { ...t.engine.config.get().server, token } });
  const server = createServer({ engine: t.engine });
  try {
    t.engine.repos.devices.insert({ id: 'dev-off', name: 'Offline box', tokenHash: 'test' });
    const session = await t.engine.createSession({ device: 'dev-off', cwd: '/work' });
    const response = await server.app.request(`/api/sessions/${session.id}/diff`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ diff: '', files: [], offline: true });
  } finally {
    server.close();
    await t.close();
  }
}, 30_000);
