/**
 * Alert routes (routes-alerts.ts): the list and the actions, with their
 * input checks. The service is tested on a real engine in
 * packages/core/test/engine (file-conflicts, stuck); a stub stands in here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AlertAction, AlertItem } from '@conclave/core/client/alerts.ts';
import { setAlerts } from '@conclave/core/alerts/attached.ts';
import type { AlertService } from '@conclave/core/alerts/service.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
const acts: Array<[string, AlertAction]> = [];

const stuck: AlertItem = { id: 'alrt_stuck', kind: 'stuck', reason: 'idle', sessionId: 'ses_1', text: "No progress in 'Fix login' for 6 min", createdAt: 1, updatedAt: 1, since: 0, thresholdMs: 300_000 };
const conflict: AlertItem = {
  id: 'alrt_conflict',
  kind: 'fileConflict',
  sessionId: 'ses_2',
  text: "'Fix login' and 'Refactor auth' are both editing src/auth/redirect.ts",
  createdAt: 2,
  updatedAt: 2,
  device: 'local',
  path: '/repo/src/auth/redirect.ts',
  file: 'src/auth/redirect.ts',
  sessions: [
    { id: 'ses_1', title: 'Fix login' },
    { id: 'ses_2', title: 'Refactor auth' },
  ],
};

beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

describe('without an alert service', () => {
  test('the list is empty and an action finds nothing', async () => {
    expect(await (await hub.api('/api/alerts')).json()).toEqual([]);
    const res = await hub.api('/api/alerts/alrt_x', { method: 'POST', json: { action: 'stop' } });
    expect(res.status).toBe(404);
  });
});

describe('with one', () => {
  test('lists the open alerts and passes actions through', async () => {
    const items = [stuck, conflict];
    const svc = {
      list: () => items,
      act: (id: string, action: AlertAction) => {
        acts.push([id, action]);
        const it = items.find((i) => i.id === id);
        if (!it) return 'missing';
        if (it.kind === 'stuck' ? action === 'dismiss' : action !== 'dismiss') return 'bad';
        return 'ok';
      },
    };
    setAlerts(hub.engine, svc as unknown as AlertService);

    expect(await (await hub.api('/api/alerts')).json()).toEqual(items);
    expect((await hub.api('/api/alerts/alrt_stuck', { method: 'POST', json: { action: 'wait' } })).status).toBe(200);
    expect((await hub.api('/api/alerts/alrt_stuck', { method: 'POST', json: { action: 'stop' } })).status).toBe(200);
    expect((await hub.api('/api/alerts/alrt_conflict', { method: 'POST', json: { action: 'dismiss' } })).status).toBe(200);
    expect(acts).toEqual([
      ['alrt_stuck', 'wait'],
      ['alrt_stuck', 'stop'],
      ['alrt_conflict', 'dismiss'],
    ]);

    const wrong = await hub.api('/api/alerts/alrt_stuck', { method: 'POST', json: { action: 'dismiss' } });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('A stuck turn takes stop or wait.');
    const wrong2 = await hub.api('/api/alerts/alrt_conflict', { method: 'POST', json: { action: 'stop' } });
    expect((await wrong2.json()).error).toBe('A file conflict takes dismiss.');
    expect((await hub.api('/api/alerts/alrt_stuck', { method: 'POST', json: { action: 'snooze' } })).status).toBe(400);
    expect((await hub.api('/api/alerts/alrt_gone', { method: 'POST', json: { action: 'stop' } })).status).toBe(404);
    // the owner token is needed
    expect((await hub.api('/api/alerts', { token: null })).status).toBe(401);
  });
});
