/**
 * What the app reports about itself to the hub's logs (lib/clientLog.ts):
 * batched, capped, deduplicated, never chat text, and quiet when the hub
 * has no logs route.
 *
 *   bun test packages/web/test/client-log.test.ts
 */
import { beforeEach, expect, test } from 'bun:test';
import type { ClientLogBatch } from '@conclave/core/client';
import { _clientLogState, _resetClientLog, clientLog, flush, foldPath, logRequestFailure, platformName, startClientLog } from '../src/lib/clientLog';
import { componentPath } from '../src/components/ErrorBoundary';
import { filesWords } from '../src/features/settings/logs';

beforeEach(() => _resetClientLog());

test('paths lose their ids and query strings', () => {
  expect(foldPath('/api/sessions/ses_0mvhhgjec6nozowliiu/messages?afterSeq=4')).toBe('/api/sessions/:id/messages');
  expect(foldPath('/api/workflows/runs/wf_abc123def/calls/3/skip')).toBe('/api/workflows/runs/:id/calls/3/skip');
  expect(foldPath('/api/devices/3f2b8c1e-0000-4000-8000-123456789abc/files')).toBe('/api/devices/:id/files');
  expect(foldPath('/api/logs')).toBe('/api/logs');
});

test('the operating system in one word', () => {
  expect(platformName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iOS');
  expect(platformName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
  expect(platformName('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe('Android');
  expect(platformName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
});

test('batches go to the sender with the app, version and platform; sent events leave the queue', async () => {
  const sent: ClientLogBatch[] = [];
  startClientLog(async (b) => sent.push(b));
  clientLog('info', 'connect', { was: 'connecting' });
  clientLog('warn', 'request.failed', { method: 'GET', path: '/api/x', status: 502 }, new Error('Hub error 502: bad gateway'));
  await flush();
  expect(sent.length).toBe(1);
  expect(sent[0].app).toBe('web');
  expect(typeof sent[0].version).toBe('string');
  expect(sent[0].events.map((e) => e.event)).toEqual(['connect', 'request.failed']);
  expect(sent[0].events[1]).toMatchObject({ level: 'warn', msg: 'Hub error 502: bad gateway', fields: { status: 502 } });
  expect(_clientLogState().queue).toEqual([]);
});

test('the same event again soon counts on the first; the queue and the minute are capped', () => {
  for (let i = 0; i < 5; i++) clientLog('error', 'js.error', undefined, 'boom');
  expect(_clientLogState().queue.length).toBe(1);
  expect(_clientLogState().queue[0].fields?.repeats).toBe(5);
  for (let i = 0; i < 100; i++) clientLog('info', `e${i}`);
  // 60 a minute: the rest are counted, and the count goes in the next batch
  expect(_clientLogState().queue.length).toBe(60);
  expect(_clientLogState().dropped).toBe(41);
});

test('an older hub without the route stops the sending; a 5xx keeps the events for later', async () => {
  let calls = 0;
  startClientLog(async () => {
    calls++;
    throw Object.assign(new Error('server error'), { status: 503 });
  });
  clientLog('info', 'connect');
  await flush();
  expect(_clientLogState().queue.length).toBe(1);
  startClientLog(async () => {
    calls++;
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  await flush();
  expect(_clientLogState().off).toBe(true);
  clientLog('info', 'connect');
  await flush();
  expect(calls).toBe(2);
});

test('failed requests: the folded path and status, never the logs route itself', () => {
  logRequestFailure('POST', '/api/sessions/ses_abcdef123/messages', Object.assign(new Error('busy'), { status: 409 }));
  logRequestFailure('POST', '/api/logs/client', Object.assign(new Error('x'), { status: 500 }));
  logRequestFailure('GET', '/api/info', new TypeError('Failed to fetch'));
  const q = _clientLogState().queue;
  expect(q.length).toBe(2);
  expect(q[0]).toMatchObject({ level: 'info', event: 'request.failed', fields: { method: 'POST', path: '/api/sessions/:id/messages', status: 409 } });
  expect(q[1]).toMatchObject({ level: 'warn', fields: { status: 0 } });
});

test('render errors name the components they were in', () => {
  const stack = '\n    at Broken (http://x/src/Broken.tsx:3:9)\n    at div\n    at SectionBody (http://x/src/S.tsx:1:1)\n    at SettingsPage\n    at Shell\n    at App';
  expect(componentPath(stack)).toBe('Broken < SectionBody < SettingsPage < Shell');
  expect(componentPath(undefined)).toBeUndefined();
});

test('Settings, Logs: the files in words', () => {
  expect(filesWords({ files: 0, bytes: 0 })).toBe('No files yet');
  expect(filesWords({ files: 12, bytes: 4_812_000, oldest: '2026-10-10', newest: '2026-10-21' })).toBe('12 files, 4.6 MB, 2026-10-10 to 2026-10-21');
  expect(filesWords({ files: 1, bytes: 900, oldest: '2026-10-21', newest: '2026-10-21' })).toBe('1 file, 900 B, 2026-10-21');
});
