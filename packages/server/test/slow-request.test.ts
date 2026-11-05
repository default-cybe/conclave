/**
 * A request slower than 250 ms gets one line with its route pattern, status,
 * time and response bytes; over 2 s it is a warning (hub stall review 2026-11-04).
 */
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { setLogTap } from '@conclave/core/util/log.ts';
import { logSlowRequest } from '../src/lag';

test('a slow route logs once with its pattern and bytes, a fast one not at all', async () => {
  const lines: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];
  const prev = setLogTap((level, scope, msg, extra) => {
    if (scope === 'http') lines.push({ level, msg, extra: extra as Record<string, unknown> });
  });
  try {
    let fake = 0;
    const app = new Hono();
    app.use('*', async (c, next) => {
      await next();
      logSlowRequest(c.req.method, c.req.routePath, c.res, fake);
    });
    app.get('/api/sessions/:id/messages', (c) => c.json({ messages: 'x'.repeat(1000) }));
    fake = 10;
    await app.request('/api/sessions/ses_1/messages?token=secret');
    fake = 400;
    await app.request('/api/sessions/ses_1/messages?token=secret');
    fake = 2500;
    await app.request('/api/sessions/ses_2/messages');
    await Bun.sleep(5);
    expect(lines).toEqual([
      { level: 'info', msg: 'slow request', extra: { method: 'GET', route: '/api/sessions/:id/messages', status: 200, durationMs: 400, bytes: 1015 } },
      { level: 'warn', msg: 'slow request', extra: { method: 'GET', route: '/api/sessions/:id/messages', status: 200, durationMs: 2500, bytes: 1015 } },
    ]);
  } finally {
    setLogTap(prev);
  }
});
