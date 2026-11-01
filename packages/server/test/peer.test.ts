/**
 * The peer service against hand made friends: the verifier (replay, wrong
 * recipient, clock skew, unknown key, removed friend), invites (expiry,
 * single use, at most 3 pending), the idempotent inbox, the pull path,
 * outbox backoff and give up, a key change that blocks a friend, and
 * addresses a friend gives that are never a friend's hub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { Notice } from '@conclave/core/types.ts';
import { HubKey } from '../src/identity';
import { PeerSubkey, inviteProof, inviteSecretHash, open } from '../src/peer/crypto';
import { buildEnvelope, signRecord, type PeerEnvelope } from '../src/peer/envelope';
import { GIVE_UP_MS, OUTBOX_KEEP_MS, PeerService, inviteLink, parseInviteLink, type PeerOptions } from '../src/peer/service';
import { BodyTooLarge, readCapped } from '../src/http';
import { signRequest } from '../src/peer/signing';
import { ulid } from '../src/peer/ulid';
import { createFakeEngine, type FakeEngine } from './fake-engine';
import { startHub, type TestHub } from './helpers';

/** A friend's hub that exists only in the test: its keys, and requests it signs. */
class FakeFriend {
  readonly key = new HubKey(generateKeyPairSync('ed25519').privateKey);
  readonly subkey = PeerSubkey.generate();
  constructor(readonly url = 'http://127.0.0.1:9') {}
  get fp() {
    return this.key.fingerprint;
  }
  record(seq = 1) {
    return signRecord(this.key, this.subkey.publicKey, [{ url: this.url, kind: 'own' }], seq);
  }
  envelope(to: { fp: string; subkey: string }, type: string, body: unknown, id = ulid()): PeerEnvelope {
    return buildEnvelope(this.key, { id, type, to: to.fp, body, recipientSubkey: type === 'friend.request' ? undefined : to.subkey }).envelope;
  }
  async send(base: string, to: string, method: string, path: string, body = '', opts: { now?: number; nonce?: string; headers?: Record<string, string> } = {}) {
    const url = `${base}${path}`;
    const headers = { 'content-type': 'application/json', ...signRequest(this.key, { method, url, body, to }, { now: opts.now, nonce: opts.nonce }), ...opts.headers };
    const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
}

function hubSide(h: TestHub) {
  const ctx = h.running.conclave.ctx;
  return { fp: ctx.identity.fingerprint, subkey: ctx.peer.subkey.publicKey, peer: ctx.peer };
}

/** Put a friend straight into a hub's store. */
function addFriend(peer: PeerService, f: FakeFriend, status: 'active' | 'pending' | 'removed' | 'blocked' = 'active', direction: 'in' | 'out' = 'in') {
  const r = f.record();
  return peer.store.insertFriend({
    name: 'Frank',
    fingerprint: f.fp,
    publicKey: f.key.publicKey,
    subkey: r.subkey,
    subkeySig: r.subkeySig,
    addresses: { addrs: r.addrs, seq: r.seq, record: r },
    status,
    direction,
    verified: false,
    grants: { receiveShares: true },
  });
}

let hub: TestHub;
beforeAll(() => {
  hub = startHub();
  hub.engine.config.update({ server: { publicUrl: hub.url } } as never);
});
afterAll(() => hub.stop());

describe('the peer verifier', () => {
  test('a note from a friend lands once; the same id again changes nothing', async () => {
    const me = hubSide(hub);
    const f = new FakeFriend();
    const row = addFriend(me.peer, f);
    const env = f.envelope(me, 'note', { text: 'once' });
    const body = JSON.stringify(env);
    const events: unknown[] = [];
    const off = hub.engine.bus.on((e) => void (e.type === 'friend.message' && events.push(e)));
    const first = await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env.id}`, body);
    expect(first).toEqual({ status: 202, body: { ok: true, duplicate: false } });
    const second = await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env.id}`, body);
    expect(second).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    off();
    expect(events).toHaveLength(1);
    const inbox = (await hub.api(`/api/friends/inbox?friend=${row.id}`).then((r) => r.json())) as any[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: env.id, text: 'once', friendName: 'Frank', state: 'received' });
    // the hub's own audit names the friend
    expect(hub.engine.repos.audit.list({ limit: 20 }).some((e) => e.actor === `friend:${f.fp}` && e.action === 'peer.message.in')).toBe(true);
  });

  test('replay, wrong recipient, skew, unknown key and a removed friend are refused', async () => {
    const me = hubSide(hub);
    const f = new FakeFriend();
    addFriend(me.peer, f);
    const env = f.envelope(me, 'note', { text: 'hi' });
    const body = JSON.stringify(env);
    const path = `/peer/v1/inbox/${env.id}`;

    const ok = await f.send(hub.url, me.fp, 'PUT', path, body, { nonce: 'the-same-nonce-0001' });
    expect(ok.status).toBe(202);
    const replay = await f.send(hub.url, me.fp, 'PUT', path, body, { nonce: 'the-same-nonce-0001' });
    expect(replay).toMatchObject({ status: 401, body: { code: 'replay' } });

    const other = new FakeFriend();
    expect(await f.send(hub.url, other.fp, 'PUT', path, body)).toMatchObject({ status: 401, body: { code: 'recipient' } });
    expect(await f.send(hub.url, me.fp, 'PUT', path, body, { now: Date.now() + 10 * 60_000 })).toMatchObject({ status: 401, body: { code: 'skew' } });
    expect(await f.send(hub.url, me.fp, 'PUT', path, body, { now: Date.now() - 10 * 60_000 })).toMatchObject({ status: 401, body: { code: 'expired' } });

    const stranger = new FakeFriend();
    const env2 = stranger.envelope(me, 'note', { text: 'let me in' });
    expect(await stranger.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env2.id}`, JSON.stringify(env2))).toMatchObject({ status: 401, body: { code: 'unknown-key' } });

    const gone = new FakeFriend();
    addFriend(me.peer, gone, 'removed');
    const env3 = gone.envelope(me, 'note', { text: 'still here?' });
    expect(await gone.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env3.id}`, JSON.stringify(env3))).toMatchObject({ status: 403, body: { code: 'not-friends' } });
    expect(await gone.send(hub.url, me.fp, 'GET', '/peer/v1/addresses')).toMatchObject({ status: 403, body: { code: 'not-friends' } });
    // the pull path stays open to a removed friend, with nothing in it but a removal notice
    expect(await gone.send(hub.url, me.fp, 'GET', '/peer/v1/outbox')).toEqual({ status: 200, body: { messages: [] } });

    // no signature at all, and a body that is not what was signed
    expect((await fetch(`${hub.url}${path}`, { method: 'PUT', body })).status).toBe(401);
    const headers = { 'content-type': 'application/json', ...signRequest(f.key, { method: 'PUT', url: `${hub.url}${path}`, body, to: me.fp }) };
    expect((await fetch(`${hub.url}${path}`, { method: 'PUT', headers, body: body.replace('"v":1', '"v":1 ') })).status).toBe(400);
  });

  test('an address that keeps sending bad signatures is blocked like one that keeps sending wrong tokens', async () => {
    const me = hubSide(hub);
    const stranger = new FakeFriend();
    const env = stranger.envelope(me, 'note', { text: 'x' });
    const send = () => stranger.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env.id}`, JSON.stringify(env), { headers: { 'x-forwarded-for': '203.0.113.77' } });
    for (let i = 0; i < 20; i++) expect((await send()).status).toBe(401);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('Too many failed attempts');
    expect(hub.engine.repos.audit.list({ limit: 30 }).some((e) => e.action === 'auth.blocked' && e.actor === 'ip:203.0.113.77')).toBe(true);
  });

  test('message rules: the path id, the size cap, grants, pending friends and unknown types', async () => {
    const me = hubSide(hub);
    const f = new FakeFriend();
    const row = addFriend(me.peer, f);
    const env = f.envelope(me, 'note', { text: 'x' });
    expect(await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${ulid()}`, JSON.stringify(env))).toMatchObject({ status: 400, body: { code: 'id' } });
    expect(await f.send(hub.url, me.fp, 'PUT', '/peer/v1/inbox/not-a-ulid', JSON.stringify(env))).toMatchObject({ status: 400 });
    const huge = JSON.stringify({ ...env, pad: 'x'.repeat(1024 * 1024) });
    expect((await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env.id}`, huge)).status).toBe(413);

    await hub.api(`/api/friends/${row.id}/grants`, { method: 'PUT', json: { receiveShares: false } });
    expect(await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env.id}`, JSON.stringify(env))).toMatchObject({ status: 403, body: { code: 'grant' } });
    await hub.api(`/api/friends/${row.id}/grants`, { method: 'PUT', json: { receiveShares: true } });

    const later = f.envelope(me, 'agent.task.send', {});
    expect(await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${later.id}`, JSON.stringify(later))).toMatchObject({ status: 422, body: { code: 'type' } });
    // a share offer is taken now, and checked
    const offer = f.envelope(me, 'share.offer', {});
    expect(await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${offer.id}`, JSON.stringify(offer))).toMatchObject({ status: 400, body: { code: 'body' } });

    const p = new FakeFriend();
    addFriend(me.peer, p, 'pending', 'in');
    const early = p.envelope(me, 'note', { text: 'before you accepted' });
    expect(await p.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${early.id}`, JSON.stringify(early))).toMatchObject({ status: 403, body: { code: 'not-yet' } });

    // a body sealed for another hub does not open here
    const elsewhere = f.envelope({ fp: me.fp, subkey: PeerSubkey.generate().publicKey }, 'note', { text: 'x' });
    expect(await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${elsewhere.id}`, JSON.stringify(elsewhere))).toMatchObject({ status: 400, body: { code: 'seal' } });
  });

  test('a body sent without a length is cut off at the cap, not read whole first', async () => {
    // anyone can reach these routes before a key is checked: a chunked body has no Content-Length to refuse up front
    let pulled = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (pulled >= 256 * 1024 * 1024) return ctl.close();
          pulled += 64 * 1024;
          ctl.enqueue(new Uint8Array(64 * 1024));
        },
      });
    const res = await fetch(`${hub.url}/peer/v1/inbox/${ulid()}`, { method: 'PUT', body: endless(), headers: { 'content-type': 'application/json' } }).catch(() => undefined);
    if (res) expect(res.status).toBe(413);
    // the hub stopped reading a little past 1 MB, instead of taking the 256 MB the sender had
    expect(pulled).toBeLessThan(64 * 1024 * 1024);
    pulled = 0;
    const req = await fetch(`${hub.url}/peer/v1/friend-request`, { method: 'POST', body: endless(), headers: { 'content-type': 'application/json' } }).catch(() => undefined);
    if (req) expect(req.status).toBe(413);
    expect(pulled).toBeLessThan(64 * 1024 * 1024);

    // the reader itself: it stops at the cap and says so
    let read = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(ctl) {
        read += 1024;
        ctl.enqueue(new Uint8Array(1024));
      },
    });
    await expect(readCapped(big, 10 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(read).toBeLessThanOrEqual(12 * 1024);
    expect((await readCapped(new Response('hello').body, 5)).length).toBe(5);
  });

  test('a hub whose request waits learns none of the addresses until the owner accepts', async () => {
    const me = hubSide(hub);
    const asking = new FakeFriend();
    addFriend(me.peer, asking, 'pending', 'in');
    expect(await asking.send(hub.url, me.fp, 'GET', '/peer/v1/addresses')).toMatchObject({ status: 403, body: { code: 'not-yet' } });
    // a hub this one asked may, and a friend may
    const asked = new FakeFriend();
    addFriend(me.peer, asked, 'pending', 'out');
    expect(await asked.send(hub.url, me.fp, 'GET', '/peer/v1/addresses')).toMatchObject({ status: 200, body: { fp: me.fp } });
    const friend = new FakeFriend();
    addFriend(me.peer, friend);
    expect((await friend.send(hub.url, me.fp, 'GET', '/peer/v1/addresses')).status).toBe(200);
  });
});

describe('invites', () => {
  const request = async (f: FakeFriend, link: string, over: { proof?: string } = {}) => {
    const me = hubSide(hub);
    const inv = parseInviteLink(link)!;
    const id = ulid();
    const proof = over.proof ?? inviteProof(inviteSecretHash(inv.secret), f.fp, me.fp, id);
    const env = f.envelope(me, 'friend.request', { name: 'Fay', publicKey: f.key.publicKey, record: f.record(), invite: proof }, id);
    return f.send(hub.url, me.fp, 'POST', '/peer/v1/friend-request', JSON.stringify(env));
  };
  const invite = async () => (await hub.api('/api/friends/invites', { method: 'POST', json: {} }).then((r) => r.json())).link as string;

  test('an invite works once, and a wrong or expired one is refused', async () => {
    const link = await invite();
    expect(link).toMatch(/^conclave:\/\/friend\?fp=[0-9a-f]{32}&url=.+&s=[A-Za-z0-9_-]{22}&exp=\d+$/);
    const a = new FakeFriend();
    expect(await request(a, link)).toMatchObject({ status: 202, body: { status: 'pending' } });
    // the same hub again (a lost answer) is the same request
    expect(await request(a, link)).toMatchObject({ status: 202 });
    // anyone else with the link is too late
    expect(await request(new FakeFriend(), link)).toMatchObject({ status: 403, body: { code: 'invite' } });
    expect(await request(new FakeFriend(), await invite(), { proof: 'x'.repeat(43) })).toMatchObject({ status: 403, body: { code: 'invite' } });

    const old = await invite();
    hub.running.conclave.ctx.peer.store.db.query('UPDATE friend_invites SET expires_at = ? WHERE used_at IS NULL').run(Date.now() - 1);
    expect(await request(new FakeFriend(), old)).toMatchObject({ status: 403, body: { code: 'invite' } });

    const list = (await hub.api('/api/friends').then((r) => r.json())) as any[];
    const fay = list.find((x) => x.fingerprint === a.fp);
    expect(fay).toMatchObject({ name: 'Fay', status: 'pending', direction: 'in' });
    // the owner declines: nothing is sent, and the request is gone from the list
    expect((await hub.api(`/api/friends/${fay.id}/decline`, { method: 'POST' })).status).toBe(200);
    expect(((await hub.api('/api/friends').then((r) => r.json())) as any[]).some((x) => x.fingerprint === a.fp)).toBe(false);
    // and the used link does not bring the request back
    expect(await request(a, link)).toMatchObject({ status: 403, body: { code: 'invite' } });
  });

  test('at most 3 requests wait at once', async () => {
    const peer = hubSide(hub).peer;
    for (const f of peer.store.friends()) if (f.status === 'pending' && f.direction === 'in') peer.store.updateFriend(f.id, { status: 'removed' });
    for (let i = 0; i < 3; i++) expect((await request(new FakeFriend(), await invite())).status).toBe(202);
    expect(await request(new FakeFriend(), await invite())).toMatchObject({ status: 429, body: { code: 'pending' } });
  });

  test('an invite needs an outside address, and the link carries only those unless asked', async () => {
    const lonely = startHub();
    try {
      const res = await lonely.api('/api/friends/invites', { method: 'POST', json: {} });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('Remote access is off');
      const reach = await lonely.api('/api/friends/reachability').then((r) => r.json());
      expect(reach).toMatchObject({ ok: false, mode: 'off' });
      lonely.engine.config.update({ server: { publicUrl: 'https://me.ts.net' } } as never);
      expect(await lonely.api('/api/friends/reachability').then((r) => r.json())).toMatchObject({ ok: false, mode: 'tailscale', reason: expect.stringContaining('tailnet') });
    } finally {
      await lonely.stop();
    }
  });
});

describe('the pull path', () => {
  test('a friend that cannot be reached takes what waits, and its acks mark it delivered', async () => {
    const me = hubSide(hub);
    const f = new FakeFriend('http://127.0.0.1:9');
    const row = addFriend(me.peer, f);
    const sent = await hub.api(`/api/friends/${row.id}/notes`, { method: 'POST', json: { text: 'come and get it' } }).then((r) => r.json());
    expect(sent.state).toBe('queued');
    await me.peer.deliver(row.id);
    const waiting = me.peer.store.outboxItem(sent.id)!;
    expect(waiting).toMatchObject({ state: 'queued', attempts: 1 });
    expect(waiting.lastError).toContain('127.0.0.1:9');

    const page = await f.send(hub.url, me.fp, 'GET', '/peer/v1/outbox');
    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(1);
    const env = page.body.messages[0] as PeerEnvelope;
    expect(env.id).toBe(sent.id);
    expect(JSON.parse(open(f.subkey, env.sealed!, { from: me.fp, to: f.fp, id: env.id, type: 'note' }).toString())).toEqual({ text: 'come and get it' });

    const acked = await f.send(hub.url, me.fp, 'GET', `/peer/v1/outbox?ack=${env.id}`);
    expect(acked.body.messages).toEqual([]);
    expect(me.peer.store.outboxItem(sent.id)).toMatchObject({ state: 'delivered', via: 'pull' });
    // an ack for someone else's message changes nothing
    const g = new FakeFriend();
    const rowG = addFriend(me.peer, g);
    const other = await hub.api(`/api/friends/${rowG.id}/notes`, { method: 'POST', json: { text: 'for g' } }).then((r) => r.json());
    await f.send(hub.url, me.fp, 'GET', `/peer/v1/outbox?ack=${other.id}`);
    expect(me.peer.store.outboxItem(other.id)!.state).toBe('queued');
  });

  test('a removed friend that cannot be reached still fetches the removal, and only that', async () => {
    const me = hubSide(hub);
    const f = new FakeFriend('http://127.0.0.1:9');
    const row = addFriend(me.peer, f);
    const note = await hub.api(`/api/friends/${row.id}/notes`, { method: 'POST', json: { text: 'never mind' } }).then((r) => r.json());
    expect((await hub.api(`/api/friends/${row.id}`, { method: 'DELETE' })).status).toBe(200);
    await me.peer.deliver(row.id);
    expect(me.peer.store.outboxItem(note.id)!.state).toBe('cancelled');
    const page = await f.send(hub.url, me.fp, 'GET', '/peer/v1/outbox');
    expect(page.body.messages.map((m: PeerEnvelope) => m.type)).toEqual(['friend.remove']);
    await f.send(hub.url, me.fp, 'GET', `/peer/v1/outbox?ack=${page.body.messages[0].id}`);
    expect(me.peer.store.outbox({ friendId: row.id }).find((i) => i.type === 'friend.remove')).toMatchObject({ state: 'delivered', via: 'pull' });
    const env = f.envelope(me, 'note', { text: 'but why' });
    expect(await f.send(hub.url, me.fp, 'PUT', `/peer/v1/inbox/${env.id}`, JSON.stringify(env))).toMatchObject({ status: 403, body: { code: 'not-friends' } });
  });
});

describe('the outbox', () => {
  let engine: FakeEngine;
  beforeAll(() => {
    engine = createFakeEngine();
  });
  afterAll(() => engine.cleanup());

  function service(fetchFn: typeof fetch, clock: { t: number }, addrs = [{ url: 'https://me.example.com', kind: 'stable' as const, label: '' }], opts: PeerOptions = {}) {
    const jobs: Array<{ kind: string; runAt: number; dedupe?: string }> = [];
    const scheduler = {
      start() {},
      stop() {},
      enqueue: (kind: string, runAt: number, _p?: Record<string, unknown>, dedupe?: string) => (jobs.push({ kind, runAt, dedupe }), 'job'),
      cancel() {},
      handle() {},
      poke() {},
    };
    const identity = new HubKey(generateKeyPairSync('ed25519').privateKey);
    const remote = { addresses: () => addrs, status: () => ({ mode: 'stable', state: 'on', addresses: addrs, since: 0, lan: { on: false, listening: false }, cloudflareToken: false }) as never };
    // names answer at once with a public test address, so no test waits on real DNS (a slow runner timed one out)
    const peer = new PeerService({ engine, identity, remote }, { fetch: fetchFn, now: () => clock.t, scheduler, addressDelayMs: 0, lookup: async () => ['203.0.113.10'], ...opts });
    return { peer, jobs, identity };
  }

  test('a friend that does not answer gets tries further and further apart, then the item fails and the owner hears', async () => {
    const clock = { t: Date.now() };
    const notices: Array<Omit<Notice, 'id' | 'createdAt' | 'alert'>> = [];
    const send = engine.notifier.send;
    engine.notifier.send = async (n) => (notices.push(n), send(n));
    const down = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const { peer, jobs } = service(down, clock);
    const f = new FakeFriend('https://frank.example.com');
    const row = addFriend(peer, f);
    const item = peer.sendNote(row.id, 'are you there?');
    await peer.deliver(row.id);

    const delays: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const now = peer.store.outboxItem(item.id)!;
      expect(now.state).toBe('queued');
      expect(now.attempts).toBe(i);
      const delay = now.nextTry - clock.t;
      const base = Math.min(30_000 * 2 ** (i - 1), 3_600_000);
      expect(delay).toBeGreaterThanOrEqual(base * 0.8 - 1);
      expect(delay).toBeLessThanOrEqual(base * 1.2 + 1);
      delays.push(delay);
      // the job is armed for the next try
      expect(jobs.filter((j) => j.kind === 'peer.deliver').at(-1)!.runAt).toBe(now.nextTry);
      clock.t = now.nextTry;
      await peer.deliver(row.id);
    }
    expect(delays.at(-1)!).toBeLessThanOrEqual(3_600_000 * 1.2);
    expect(peer.store.outboxItem(item.id)!.lastError).toContain('frank.example.com');

    clock.t = item.createdAt + GIVE_UP_MS + 1;
    await peer.deliver(row.id);
    const failed = peer.store.outboxItem(item.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.lastError).toContain('Not delivered in 7 days');
    expect(notices.some((n) => n.title === 'Not delivered to Frank')).toBe(true);

    // Retry puts it back with a new week
    const again = peer.retry(item.id);
    expect(again).toMatchObject({ state: 'queued', attempts: 0 });
    expect(peer.cancel(item.id).state).toBe('cancelled');
    engine.notifier.send = send;
  });

  test('addresses are tried in order with the identity check first, and a new key at a stable address blocks', async () => {
    const clock = { t: Date.now() };
    const f = new FakeFriend();
    const other = new HubKey(generateKeyPairSync('ed25519').privateKey);
    const calls: string[] = [];
    let keyAtStable = f.key;
    const net = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
      if (url.host === 'dead.example.com') throw new Error('connection refused');
      if (url.pathname === '/api/identity') {
        const key = url.host === 'moved.example.com' ? other : keyAtStable;
        return Response.json(key.prove(url.searchParams.get('nonce')!));
      }
      return Response.json({ ok: true }, { status: 202 });
    }) as unknown as typeof fetch;
    const { peer } = service(net, clock);
    const row = addFriend(peer, f);
    const r = signRecord(f.key, f.subkey.publicKey, [
      { url: 'https://dead.example.com', kind: 'quick' },
      { url: 'https://moved.example.com', kind: 'quick' },
      { url: 'https://frank.example.com', kind: 'stable' },
    ], 2);
    peer.store.updateFriend(row.id, { addresses: { addrs: r.addrs, seq: 2, record: r } });

    const item = peer.sendNote(row.id, 'hello');
    await peer.deliver(row.id);
    expect(peer.store.outboxItem(item.id)).toMatchObject({ state: 'delivered', via: 'push' });
    expect(calls.slice(0, 4)).toEqual(['GET dead.example.com/api/identity', 'GET moved.example.com/api/identity', 'GET frank.example.com/api/identity', `PUT frank.example.com/peer/v1/inbox/${item.id}`]);

    // another key at the stable address: a key change, not a moved address
    keyAtStable = other;
    calls.length = 0;
    const next = peer.sendNote(row.id, 'still you?');
    await peer.deliver(row.id);
    const blocked = peer.get(row.id);
    expect(blocked).toMatchObject({ status: 'blocked', pendingFingerprint: other.fingerprint });
    expect(peer.store.outboxItem(next.id)!.state).toBe('queued');
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(false);
    expect(() => peer.sendNote(row.id, 'more')).toThrow('new key');
  });

  test('a message that is done keeps no envelope, its row goes after a while (a note stays), and a cancelled one is not sent again', async () => {
    const clock = { t: Date.now() };
    const f = new FakeFriend('https://frank.example.com');
    let up = true;
    const net = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!up) throw new Error('connection refused');
      if (url.pathname === '/api/identity') return Response.json(f.key.prove(url.searchParams.get('nonce')!));
      return Response.json({ ok: true }, { status: 202 });
    }) as unknown as typeof fetch;
    const { peer } = service(net, clock);
    const row = addFriend(peer, f);
    const friend = peer.store.friend(row.id)!;
    const note = peer.sendNote(row.id, 'kept for the thread');
    const update = peer.queue(friend, 'address.update', { record: peer.record() }, { preview: 'address update' });
    expect(peer.store.outboxItem(update.id)!.envelope).toContain('"sealed"');
    await peer.deliver(row.id);
    for (const id of [note.id, update.id]) {
      const done = peer.store.outboxItem(id)!;
      expect(done).toMatchObject({ state: 'delivered', envelope: '' });
      expect(done.body).toBeUndefined();
    }
    expect(peer.store.outboxItem(note.id)!.text).toBe('kept for the thread');

    // cancelled: nothing of it stays to send, so Retry says to send it again
    up = false;
    const waiting = peer.sendNote(row.id, 'never mind');
    await peer.deliver(row.id);
    peer.cancel(waiting.id);
    expect(peer.store.outboxItem(waiting.id)).toMatchObject({ state: 'cancelled', envelope: '' });
    expect(() => peer.retry(waiting.id)).toThrow('cancelled');

    // an older hub's done rows lose their envelopes; done rows past the keep time go, a note's stays
    peer.store.db.query(`UPDATE peer_outbox SET envelope = '{"old":true}' WHERE id = ?`).run(update.id);
    expect(peer.store.pruneOutbox(clock.t - OUTBOX_KEEP_MS)).toBe(0);
    expect(peer.store.outboxItem(update.id)!.envelope).toBe('');
    expect(peer.store.pruneOutbox(clock.t + OUTBOX_KEEP_MS)).toBe(1);
    expect(peer.store.outboxItem(update.id)).toBeUndefined();
    expect(peer.store.outboxItem(note.id)).toMatchObject({ state: 'delivered', text: 'kept for the thread' });
    expect(peer.store.outboxItem(waiting.id)).toMatchObject({ state: 'cancelled' });
  });

  test("a friend's hub that sends more than an offer said is cut off at its size", async () => {
    const clock = { t: Date.now() };
    const f = new FakeFriend('https://frank.example.com');
    let sent = 0;
    const net = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/identity') return Response.json(f.key.prove(url.searchParams.get('nonce')!));
      // a body with no length that does not stop
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(ctl) {
            sent += 64 * 1024;
            ctl.enqueue(new Uint8Array(64 * 1024));
          },
        }),
      );
    }) as unknown as typeof fetch;
    const { peer } = service(net, clock);
    const row = addFriend(peer, f);
    await expect(peer.fetchOffered(row.id, 'a'.repeat(64), 1000)).rejects.toThrow('does not match the offer');
    expect(sent).toBeLessThan(1024 * 1024);
  });

  /** A friend's hub on a made up network: it proves its key at every address, takes what is put, and each call is noted. */
  function fakeNet(f: FakeFriend, down = new Set<string>()) {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
      if (down.has(url.host)) throw new Error('connection refused');
      if (url.pathname === '/api/identity') return Response.json(f.key.prove(url.searchParams.get('nonce')!));
      return Response.json({ ok: true }, { status: 202 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  const lookupIn = (names: Record<string, string[]>) => async (host: string) => names[host] ?? Promise.reject(new Error(`${host} not found`));

  test("a friend's record never points this hub at loopback, link local, metadata, multicast or itself; same network addresses stay", async () => {
    const clock = { t: Date.now() };
    const f = new FakeFriend('https://frank.example.com');
    const down = new Set<string>();
    const { calls, fetchFn } = fakeNet(f, down);
    const names: Record<string, string[]> = { 'frank.example.com': ['203.0.113.10'], 'lan.frank.example': ['192.168.1.20'], 'meta.frank.example': ['169.254.169.254'], 'two.frank.example': ['10.0.0.8', '127.0.0.1'] };
    const { peer } = service(fetchFn, clock, undefined, { lookup: lookupIn(names) });
    const row = addFriend(peer, f);
    const me = { fp: peer.fingerprint, subkey: peer.subkey.publicKey };
    const refused: Array<[string, string]> = [
      ['http://127.0.0.1:7717', 'loopback'],
      ['http://localhost:7717', 'loopback'],
      ['http://169.254.169.254', 'link local'],
      ['http://[::ffff:a9fe:a9fe]', 'link local'],
      ['http://[fe80::1]:7717', 'link local'],
      ['http://0.0.0.0:7717', 'unspecified'],
      ['http://[::]:7717', 'unspecified'],
      ['http://224.0.0.251:7717', 'multicast'],
      ['http://255.255.255.255:7717', 'broadcast'],
      ['https://meta.frank.example', 'link local'],
      ['https://two.frank.example', 'loopback'],
      ['https://me.example.com', 'this hub'],
    ];
    const kept = ['http://192.168.1.20:7717', 'https://lan.frank.example', 'https://frank.example.com'];
    const record = signRecord(f.key, f.subkey.publicKey, [...refused.map(([url]) => url), ...kept].map((url) => ({ url, kind: 'quick' as const })), 2);
    expect(await peer.receive(peer.store.friend(row.id)!, f.envelope(me, 'address.update', { record }), 'push')).toBe('accepted');

    // the refused ones are kept nowhere, not even in the signed record, and named in one audit line
    const stored = peer.store.friend(row.id)!;
    expect(stored.addresses.addrs.map((a) => a.url)).toEqual(kept);
    expect(stored.addresses.record).toBeUndefined();
    const rowText = JSON.stringify(peer.store.db.query('SELECT * FROM friends WHERE id = ?').get(row.id));
    for (const [url] of refused) expect(rowText).not.toContain(url);
    const lines = engine.repos.audit.list({ limit: 50 }).filter((e) => e.action === 'friend.address.refused');
    expect(lines).toHaveLength(1);
    expect(lines[0].actor).toBe(`friend:${f.fp}`);
    for (const [url, why] of refused) expect(lines[0].detail).toContain(`${url} (${why})`);

    // only the kept addresses are ever called
    const item = peer.sendNote(row.id, 'hello');
    await peer.deliver(row.id);
    expect(peer.store.outboxItem(item.id)!.state).toBe('delivered');
    expect(calls).toEqual(['GET 192.168.1.20:7717/api/identity', `PUT 192.168.1.20:7717/peer/v1/inbox/${item.id}`]);

    // a name is looked up again before each call: one that points at the metadata service now is passed over
    names['lan.frank.example'] = ['169.254.169.254'];
    down.add('192.168.1.20:7717');
    calls.length = 0;
    const next = peer.sendNote(row.id, 'again');
    await peer.deliver(row.id);
    expect(peer.store.outboxItem(next.id)!.state).toBe('delivered');
    expect(calls).toEqual(['GET 192.168.1.20:7717/api/identity', 'GET frank.example.com/api/identity', `PUT frank.example.com/peer/v1/inbox/${next.id}`]);
  });

  test('an invite link, an address to add a friend by and a friend request are checked the same way', async () => {
    const clock = { t: Date.now() };
    const f = new FakeFriend('https://frank.example.com');
    const { calls, fetchFn } = fakeNet(f);
    const { peer } = service(fetchFn, clock, undefined, { lookup: lookupIn({ 'frank.example.com': ['203.0.113.10'], 'meta.example.net': ['169.254.169.254'] }) });
    const link = (fp: string, url: string, alts: string[]) => inviteLink({ fp, url, alts, secret: 'A'.repeat(22), expiresAt: clock.t + 3_600_000 });

    // the link's first address is the metadata service: it is never called, and not kept as a hint
    const added = await peer.acceptInvite(link(f.fp, 'http://169.254.169.254', ['https://meta.example.net', 'https://frank.example.com']), 'Me');
    expect(added.addresses.map((a) => a.url)).toEqual(['https://frank.example.com']);
    expect(calls).toEqual(['GET frank.example.com/api/identity', 'POST frank.example.com/peer/v1/friend-request']);
    const fromLink = engine.repos.audit.list({ limit: 50 }).filter((e) => e.action === 'friend.address.refused' && e.detail.includes('invite link'));
    expect(fromLink).toHaveLength(1);
    expect(fromLink[0].detail).toContain('http://169.254.169.254 (link local), https://meta.example.net (link local)');
    // a link with no other address is turned down before anything is called
    calls.length = 0;
    await expect(peer.acceptInvite(link(new FakeFriend().fp, 'http://[::1]:7717', ['http://127.0.0.1:7717']), 'Me')).rejects.toThrow("no address a friend's hub can have");

    // by address: refused before anything is called; this hub's own address says so
    for (const address of ['http://169.254.169.254', 'https://meta.example.net', 'http://localhost:7717', 'http://[fe80::1]', 'http://0.0.0.0:7717', 'http://224.0.0.1']) {
      await expect(peer.addByAddress({ address })).rejects.toThrow("is never a friend's hub");
    }
    await expect(peer.addByAddress({ address: 'https://me.example.com' })).rejects.toThrow('your own hub');
    expect(calls).toEqual([]);
    // one on the same network is a friend's hub like any other
    expect(await peer.addByAddress({ address: 'http://192.168.1.30:7717' })).toMatchObject({ sent: true });
    expect(calls).toEqual(['GET 192.168.1.30:7717/api/identity', 'POST 192.168.1.30:7717/peer/v1/friend-request']);

    // a friend request's record: what is never a friend's hub is not kept
    const s = new FakeFriend();
    const record = signRecord(s.key, s.subkey.publicKey, [{ url: 'http://127.0.0.1:7717', kind: 'own' }, { url: 'https://meta.example.net', kind: 'quick' }, { url: 'http://192.168.1.40:7717', kind: 'lan' }], 1);
    const text = JSON.stringify(s.envelope({ fp: peer.fingerprint, subkey: '' }, 'friend.request', { name: 'Sam', publicKey: s.key.publicKey, record, via: 'address' }));
    const url = 'https://me.example.com/peer/v1/friend-request';
    const headers = new Headers({ 'content-type': 'application/json', ...signRequest(s.key, { method: 'POST', url, body: text, to: peer.fingerprint }) });
    const { friend } = await peer.friendRequest({ method: 'POST', url, headers, body: new TextEncoder().encode(text) }, { local: true });
    expect(friend.addresses.addrs.map((a) => a.url)).toEqual(['http://192.168.1.40:7717']);
    expect(engine.repos.audit.list({ limit: 50 }).find((e) => e.action === 'friend.address.refused' && e.actor === `friend:${s.fp}`)?.detail).toContain('http://127.0.0.1:7717 (loopback), https://meta.example.net (link local)');
  });
});

describe('this hub as a friend', () => {
  test('is refused at its own addresses and at its port on this machine; another port there is not', async () => {
    const me = hubSide(hub);
    const port = Number(new URL(hub.url).port);
    expect(await me.peer.addressRefused(hub.url)).toBe('this hub');
    const ip = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && !a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.'))?.address;
    if (ip) {
      expect(await me.peer.addressRefused(`http://${ip}:${port}`)).toBe('this hub');
      expect(await me.peer.addressRefused(`http://${ip}:${port + 1}`)).toBeUndefined();
    }
  });
});

describe('the outbox of an older hub', () => {
  test('gets the note text column, and keeps its rows', async () => {
    const { openDb } = await import('@conclave/core/storage/db.ts');
    const { PeerStore } = await import('../src/peer/store');
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE peer_outbox (id TEXT PRIMARY KEY, friend_id TEXT NOT NULL, type TEXT NOT NULL, envelope TEXT NOT NULL, blob TEXT, body TEXT, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, via TEXT, last_error TEXT, preview TEXT NOT NULL DEFAULT '')`);
    db.query(`INSERT INTO peer_outbox (id, friend_id, type, envelope, state, next_try, expires_at, created_at, preview) VALUES ('01JA0000000000000000000000', 'frd_1', 'note', '{}', 'delivered', 1, 2, 1, 'note: hi')`).run();
    const store = new PeerStore(db);
    expect((db.query('PRAGMA table_info(peer_outbox)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('text');
    expect(store.outboxItem('01JA0000000000000000000000')).toMatchObject({ preview: 'note: hi' });
    expect(store.outboxItem('01JA0000000000000000000000')!.text).toBeUndefined();
  });
});
