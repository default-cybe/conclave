/**
 * A config change refetches the hub's state, not the transcripts of every
 * chat opened in the tab; a resync (events the hub could not replay) does.
 *
 *   bun test packages/web/test/store-resync.test.ts
 */
import { afterAll, expect, test } from 'bun:test';
import { connectClient } from '../src/lib/api';
import { applyEvent, loadAll, useHub } from '../src/store/store';

const realFetch = globalThis.fetch;
const paths: string[] = [];
globalThis.fetch = (async (url: string | URL | Request) => {
  paths.push(new URL(String(url)).pathname);
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const transcriptCalls = () => paths.filter((p) => /\/api\/sessions\/[^/]+\/(messages|todos)$/.test(p));

async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(5);
}

test('config.updated reloads state but no transcripts; a resync reloads them', async () => {
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  useHub.setState({ messagesLoaded: { ses_a: true, ses_b: true } });
  const v = useHub.getState().configVersion;
  applyEvent({ type: 'config.updated', seq: 1, ts: 1 });
  await until(() => useHub.getState().configVersion > v);
  await Bun.sleep(20);
  expect(paths).toContain('/api/config');
  expect(transcriptCalls()).toEqual([]);

  await loadAll({ transcripts: true });
  await until(() => transcriptCalls().length >= 4);
  expect(transcriptCalls().sort()).toEqual(['/api/sessions/ses_a/messages', '/api/sessions/ses_a/todos', '/api/sessions/ses_b/messages', '/api/sessions/ses_b/todos']);
});
