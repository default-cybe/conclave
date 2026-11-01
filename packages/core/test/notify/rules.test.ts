/**
 * The owner's notification rules, through the real engine: a rule that is
 * off sends nothing, and approvals, questions and failures are never held
 * while someone is using Conclave.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import type { Notice } from '../../src/types';

let t: TestEngine;
const notices: Notice[] = [];

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  t.engine.bus.on((e) => {
    if (e.type === 'notice') notices.push(e.notice);
  });
});
afterAll(() => t.close());

test('questions, approvals and failures reach devices while Conclave is in use; the rest waits', async () => {
  const { engine } = t;
  engine.notifier.touch('owner');
  engine.notifyEvent('approvalNeeded', { title: 'Question', body: 'Which branch?', level: 'info', sessionId: 's1' });
  engine.notifyEvent('approvalNeeded', { title: 'Approval needed', body: 'git push', level: 'warning', approvalId: 'apv_1' });
  engine.notifyEvent('errors', { title: 'Session error', body: 'boom', level: 'error' });
  engine.notifyEvent('sessionDone', { title: 'Fix tests', body: 'Session finished a turn', level: 'success' });
  engine.notifyEvent('routineDone', { title: 'Routine: digest', body: 'Done', level: 'success' });
  await Bun.sleep(20);
  expect(notices.map((n) => [n.title, n.alert ?? false])).toEqual([
    ['Question', true],
    ['Approval needed', true],
    ['Session error', true],
    ['Fix tests', false],
    ['Routine: digest', false],
  ]);

  // the app went to the background: nothing is held any more
  engine.notifier.release('owner');
  engine.notifyEvent('sessionDone', { title: 'Away', body: 'Session finished a turn', level: 'success' });
  await Bun.sleep(20);
  expect(notices.at(-1)).toMatchObject({ title: 'Away', alert: true });
});

test('a rule that is off sends nothing, not even to open apps', async () => {
  const { engine } = t;
  engine.config.update({ notifications: { ...engine.config.get().notifications, on: { ...engine.config.get().notifications.on, routineDone: false } } });
  const before = notices.length;
  engine.notifyEvent('routineDone', { title: 'Routine: quiet', body: 'Done', level: 'success' });
  await Bun.sleep(20);
  expect(notices.length).toBe(before);
});
