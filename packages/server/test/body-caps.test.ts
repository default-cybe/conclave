/**
 * A request body from someone without a token is read only up to a small
 * cap, also when it comes chunked with no Content-Length: the hub answers
 * 413 and stops reading, instead of holding up to Bun's 128 MB first.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RateLimiter } from '../src/auth';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
  // many refused requests from one address in a row: not what this test is about
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
});
afterAll(() => hub.stop());

const TOTAL = 48 * 1024 * 1024;
const CHUNK = 256 * 1024;

/** POST a chunked JSON body of TOTAL bytes (a huge string value); how much the hub pulled before it answered. */
async function chunked(path: string, headers: Record<string, string> = {}): Promise<{ status: number; pulled: number; text: string }> {
  let pulled = 0;
  const filler = new TextEncoder().encode('a'.repeat(CHUNK));
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (!started) {
        started = true;
        const head = new TextEncoder().encode('{"password":"');
        pulled += head.byteLength;
        ctl.enqueue(head);
        return;
      }
      if (pulled >= TOTAL) {
        ctl.enqueue(new TextEncoder().encode('"}'));
        ctl.close();
        return;
      }
      pulled += filler.byteLength;
      ctl.enqueue(filler);
    },
  });
  const res = await fetch(hub.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' } as RequestInit);
  const text = await res.text();
  return { status: res.status, pulled, text };
}

describe('a body from someone with no token', () => {
  for (const path of ['/api/login', '/api/pair', '/api/daemon/register', '/api/approvals/apr_x/act']) {
    test(`${path}: 413, and the rest is never read`, async () => {
      const r = await chunked(path);
      expect(r.status).toBe(413);
      expect(r.pulled).toBeLessThan(TOTAL / 2);
    }, 30_000);
  }

  test('an invite link that is good', async () => {
    const made = (await (await hub.api('/api/people', { method: 'POST', json: { name: 'erin' } })).json()) as { invite: { secret: string } };
    const r = await chunked(`/api/invite/${made.invite.secret}`);
    expect(r.status).toBe(413);
    expect(r.pulled).toBeLessThan(TOTAL / 2);
    // and the link still works afterwards
    expect((await fetch(`${hub.url}/api/invite/${made.invite.secret}`)).status).toBe(200);
  }, 30_000);

  test('the OAuth endpoints a connector calls before it has a token', async () => {
    for (const path of ['/oauth/token', '/oauth/revoke']) {
      const r = await chunked(path);
      expect([path, r.status]).toEqual([path, 413]);
      expect(r.pulled).toBeLessThan(TOTAL / 2);
    }
    // registration over plain http is refused before its body is read at all
    const reg = await chunked('/oauth/register');
    expect([400, 413]).toContain(reg.status);
    expect(reg.pulled).toBeLessThan(TOTAL / 2);
  }, 60_000);

  test('a Content-Length over the cap is refused before anything is read', async () => {
    const res = await fetch(`${hub.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(200_000) }) });
    expect(res.status).toBe(413);
  });

  test('ordinary bodies still work', async () => {
    const res = await fetch(`${hub.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'not the password' }) });
    expect(res.status).toBe(400);
  });
});

describe('the model gateway', () => {
  test('a call no body could let through is refused before its body is read', async () => {
    hub.engine.config.update({ providers: { gwcap: { type: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-hub-key', models: ['m'] } } } as never);
    // no credential at all: a gateway key is needed whatever the body says
    const r = await chunked('/gw/p/gwcap/v1/messages');
    expect(r.status).toBe(401);
    expect(r.text).toContain('gateway key required');
    expect(r.pulled).toBeLessThan(TOTAL / 2);
  }, 30_000);
});

describe('a signed-in app', () => {
  test('may send a larger body (a message with pictures), up to its own cap', async () => {
    const big = await hub.api('/api/memory', { method: 'POST', json: { content: 'x'.repeat(2 * 1024 * 1024), kind: 'fact' } });
    expect(big.status).not.toBe(413);
  });
});
