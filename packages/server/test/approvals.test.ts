import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { signActionWith, ACTION_SECRET_KEY } from '../src/actions';
import { startHub, type TestHub } from './helpers';
import { approvalActionUrl } from '@conclave/core/notify/channels.ts';
import { signActionWith as coreSign } from '@conclave/core/engine/create.ts';

let hub: TestHub;

beforeAll(() => {
  hub = startHub();
});
afterAll(() => hub.stop());

const signAction = (id: string, decision: string) => hub.running.conclave.signAction(id, decision);
const actionUrl = (base: string, id: string, decision: string) => `${base}/api/approvals/${encodeURIComponent(id)}/act?decision=${decision}&sig=${signAction(id, decision)}`;

function pending(id: string) {
  hub.engine.approvals.set(id, {
    id,
    sessionId: 'ses_1',
    toolUseId: 'tu_1',
    tool: 'Bash',
    input: { command: 'rm -rf build' },
    summary: 'Run: rm -rf build',
    suggestedRule: 'Bash(rm -rf build)',
    createdAt: Date.now(),
  });
}

describe('signed approval actions', () => {
  test('signAction uses the secret stored in kv', () => {
    const secret = hub.engine.repos.kv.get<string>(ACTION_SECRET_KEY, '');
    expect(secret.length).toBeGreaterThan(20);
    expect(signAction('apr_1', 'allow')).toBe(signActionWith(secret, 'apr_1', 'allow'));
    expect(signAction('apr_1', 'allow')).not.toBe(signAction('apr_1', 'deny'));
    expect(signAction('apr_1', 'allow')).not.toBe(signAction('apr_2', 'allow'));
  });

  test('a valid signature resolves the approval without a bearer token', async () => {
    pending('apr_ok');
    const url = actionUrl(hub.url, 'apr_ok', 'allow');
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(hub.engine.resolved.at(-1)).toEqual({ id: 'apr_ok', response: { decision: 'allow', scope: 'once', rule: undefined } });
    // second tap: no longer pending
    expect((await fetch(url, { method: 'POST' })).status).toBe(404);
  });

  test('the Allow and Deny links in a Web Push notification work, and so do links in the old ?d= form', async () => {
    const secret = hub.engine.repos.kv.get<string>(ACTION_SECRET_KEY, '');
    // the hub engine signs push links with its own helper; the server must accept them
    const sign = (id: string, d: 'allow' | 'deny') => coreSign(secret, id, d);
    expect(sign('apr_push', 'allow')).toBe(signActionWith(secret, 'apr_push', 'allow'));
    pending('apr_push');
    const res = await fetch(approvalActionUrl(hub.url, 'apr_push', 'deny', sign), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(hub.engine.resolved.at(-1)).toEqual({ id: 'apr_push', response: { decision: 'deny', message: 'Denied from notification' } });
    pending('apr_old');
    const old = await fetch(`${hub.url}/api/approvals/apr_old/act?d=allow&sig=${encodeURIComponent(sign('apr_old', 'allow'))}`, { method: 'POST' });
    expect(old.status).toBe(200);
  });

  test('always carries the suggested rule, deny maps to deny', async () => {
    pending('apr_always');
    expect((await fetch(actionUrl(hub.url, 'apr_always', 'always'), { method: 'POST' })).status).toBe(200);
    expect(hub.engine.resolved.at(-1)!.response).toEqual({ decision: 'allow', scope: 'always', rule: 'Bash(rm -rf build)' });
    pending('apr_deny');
    expect((await fetch(actionUrl(hub.url, 'apr_deny', 'deny'), { method: 'POST' })).status).toBe(200);
    expect(hub.engine.resolved.at(-1)!.response.decision).toBe('deny');
  });

  test('bad, swapped or missing signatures are refused', async () => {
    pending('apr_bad');
    const allowSig = signAction('apr_bad', 'allow');
    const swapped = await fetch(`${hub.url}/api/approvals/apr_bad/act?decision=always&sig=${allowSig}`, { method: 'POST' });
    expect(swapped.status).toBe(403);
    const otherId = await fetch(`${hub.url}/api/approvals/apr_bad/act?decision=allow&sig=${signAction('apr_other', 'allow')}`, { method: 'POST' });
    expect(otherId.status).toBe(403);
    const none = await fetch(`${hub.url}/api/approvals/apr_bad/act?decision=allow`, { method: 'POST' });
    expect(none.status).toBe(403);
    const badDecision = await fetch(`${hub.url}/api/approvals/apr_bad/act?decision=yolo&sig=x`, { method: 'POST' });
    expect(badDecision.status).toBe(400);
    expect(hub.engine.approvals.has('apr_bad')).toBe(true);
  });

  test('GET never acts, it shows a confirm form', async () => {
    pending('apr_get');
    const res = await fetch(actionUrl(hub.url, 'apr_get', 'allow'), { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toContain('<form method="post"');
    expect(hub.engine.approvals.has('apr_get')).toBe(true);
    // the form posts back with a browser accept header and gets HTML
    const post = await fetch(actionUrl(hub.url, 'apr_get', 'allow'), { method: 'POST', headers: { accept: 'text/html' } });
    expect(await post.text()).toContain('allowed');
  });

  test('bearer route still works for the apps', async () => {
    pending('apr_app');
    const res = await hub.api('/api/approvals/apr_app', { method: 'POST', json: { decision: 'allow', scope: 'session' } });
    expect(res.status).toBe(200);
    expect(hub.engine.resolved.at(-1)!.response).toEqual({ decision: 'allow', scope: 'session' });
    expect((await hub.api('/api/approvals/apr_app', { method: 'POST', json: { decision: 'allow' } })).status).toBe(404);
    expect((await hub.api('/api/approvals/apr_app', { method: 'POST', json: { decision: 'maybe' } })).status).toBe(400);
  });
});
