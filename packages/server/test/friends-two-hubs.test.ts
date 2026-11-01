/**
 * Two real hubs (separate temp homes, keys and databases, two ports) become
 * friends over HTTP and exchange signed, sealed notes: through a hub that
 * was down, through the pull path when one cannot be reached (a note
 * refused there shows as not delivered), across an address change, and not
 * after a remove.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine } from '@conclave/core/machine/local.ts';
import { reminder } from '@conclave/core/session/transcript.ts';
import type { ReceivedShareDto, SentShareDto, SharePreview, ShareViewDto } from '@conclave/core/client/friends.ts';
import type { Message, Session } from '@conclave/core/types.ts';
import { signRequest } from '../src/peer/signing';
import { buildEnvelope } from '../src/peer/envelope';
import { ulid } from '../src/peer/ulid';
import { befriend, makePeerHub, waitFor, type PeerHub } from './peer-helpers';

let a: PeerHub;
let b: PeerHub;
let bOnA: string;
let aOnB: string;

beforeAll(() => {
  a = makePeerHub('Alice', { blobThreshold: 4096 });
  b = makePeerHub('Bob', { blobThreshold: 4096 });
});
afterAll(async () => {
  await a?.close();
  await b?.close();
});

const inbox = async (h: PeerHub) => (await h.api('/api/friends/inbox')).body as Array<{ id: string; text?: string; friendName: string; state: string }>;
const outboxItem = async (h: PeerHub, id: string) => ((await h.api('/api/friends/outbox')).body as any[]).find((i) => i.id === id);
const note = async (from: PeerHub, friendId: string, text: string) => {
  const r = await from.api(`/api/friends/${friendId}/notes`, { json: { text } });
  expect(r.status).toBe(200);
  return r.body as { id: string; state: string };
};

describe('two hubs', () => {
  test('an invite, a request and an accept make them friends with the same safety code', async () => {
    expect((await a.api('/api/friends/reachability')).body).toMatchObject({ ok: true, mode: 'custom', best: { url: a.url, kind: 'own' } });
    const invite = await a.api('/api/friends/invites', { json: { name: 'Alice' } });
    expect(invite.status).toBe(200);
    const fpA = a.running!.conclave.ctx.identity.fingerprint;
    const fpB = b.running!.conclave.ctx.identity.fingerprint;
    expect(invite.body.link).toStartWith(`conclave://friend?fp=${fpA}&url=${encodeURIComponent(a.url)}&s=`);
    expect(invite.body.qrSvg).toContain('<svg');
    expect(invite.body.expiresAt - Date.now()).toBeGreaterThan(23 * 3_600_000);

    const accepted = await b.api('/api/friends/accept', { json: { link: invite.body.link, name: 'Bob' } });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'pending', direction: 'out', fingerprint: fpA });
    aOnB = accepted.body.id;

    // sent again by the same hub (a lost answer), the request is the same request
    const again = await b.api('/api/friends/accept', { json: { link: invite.body.link } });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(aOnB);

    const list = (await a.api('/api/friends')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Bob', status: 'pending', direction: 'in', fingerprint: fpB, verified: false });
    bOnA = list[0].id;
    expect(a.events.some((e) => e.type === 'friend.updated')).toBe(true);

    expect((await a.api(`/api/friends/${bOnA}/accept`, { method: 'POST' })).body.status).toBe('active');
    const onB = await waitFor('Bob to see the accept', async () => {
      const f = (await b.api(`/api/friends/${aOnB}`)).body;
      return f.status === 'active' ? f : undefined;
    });
    const onA = (await a.api(`/api/friends/${bOnA}`)).body;
    expect(onB.name).toBe('Alice');
    expect(onB.safetyCode).toMatch(/^\d{5} \d{5} \d{5} \d{5}$/);
    expect(onB.safetyCode).toBe(onA.safetyCode);
    expect(onB.addresses[0]).toEqual({ url: a.url, kind: 'own' });
    expect(onA.addresses[0]).toEqual({ url: b.url, kind: 'own' });

    // verified is the owner's own mark
    expect((await a.api(`/api/friends/${bOnA}/verify`, { json: { verified: true } })).body.verified).toBe(true);
    const audit = a.engine.repos.audit.list({ limit: 50 }).map((e) => `${e.actor} ${e.action}`);
    expect(audit).toContain(`friend:${fpB} friend.request`);
    expect(audit).toContain('owner friend.added');
    expect(b.engine.repos.audit.list({ limit: 50 }).map((e) => `${e.actor} ${e.action}`)).toContain(`friend:${fpA} friend.added`);
  });

  test('notes go both ways, sealed, and land in the inbox with an event', async () => {
    // the envelopes as Alice's hub queues them: what goes over the wire
    const store = a.running!.conclave.ctx.peer.store;
    const queued = new Map<string, string>();
    const insert = store.insertOutbox.bind(store);
    store.insertOutbox = (item) => (queued.set(item.id, item.envelope), insert(item));
    const out = await note(a, bOnA, 'Lunch on Friday?');
    await waitFor('the note on Bob', async () => (await inbox(b)).find((n) => n.text === 'Lunch on Friday?'));
    expect(await outboxItem(a, out.id)).toMatchObject({ state: 'delivered', via: 'push' });
    const ev = b.events.find((e) => e.type === 'friend.message');
    expect(ev).toMatchObject({ type: 'friend.message', message: { friendName: 'Alice', text: 'Lunch on Friday?', type: 'note' } });

    await note(b, aOnB, 'Yes, noon.');
    await waitFor('the reply on Alice', async () => (await inbox(a)).find((n) => n.text === 'Yes, noon.' && n.friendName === 'Bob'));

    // what went over the wire was sealed: the envelope has no plain text
    expect(queued.get(out.id)).not.toContain('Lunch');
    expect(JSON.parse(queued.get(out.id)!).sealed.alg).toBe('x25519-hkdf-sha256-a256gcm');
    // and once delivered the outbox keeps neither the envelope nor the body, only the row and the note's text
    const row = store.outboxItem(out.id)!;
    expect(row).toMatchObject({ state: 'delivered', envelope: '', text: 'Lunch on Friday?' });
    expect(row.body).toBeUndefined();

    // a long note goes as a blob that Bob's hub fetches
    const long = 'x'.repeat(6000);
    const big = await note(a, bOnA, long);
    expect(JSON.parse(queued.get(big.id)!).blob.size).toBeGreaterThan(4096);
    await waitFor('the long note on Bob', async () => (await inbox(b)).find((n) => n.text === long));
    expect(b.engine.repos.audit.list({ limit: 50 }).some((e) => e.action === 'peer.message.in' && e.detail.includes('to fetch'))).toBe(true);
    store.insertOutbox = insert;
  });

  test('a sent note keeps its whole text, and read marks live on the hub', async () => {
    const out = ((await a.api('/api/friends/outbox')).body as Array<{ type: string; text?: string; preview: string }>).filter((i) => i.type === 'note');
    expect(out.find((i) => i.text === 'x'.repeat(6000))!.preview.length).toBeLessThan(100);
    expect(out.find((i) => i.text === 'Lunch on Friday?')).toBeDefined();

    expect((await b.api(`/api/friends/${aOnB}`)).body).toMatchObject({ unread: 2, unreadNotes: 2, unreadShares: 0 });
    const notes = (await inbox(b)) as Array<{ id: string; text?: string; read?: boolean }>;
    expect(notes.every((n) => n.read === false)).toBe(true);
    const first = notes.find((n) => n.text === 'Lunch on Friday?')!;
    const marked = await b.api(`/api/friends/${aOnB}/read`, { json: { upTo: first.id } });
    expect(marked.body).toMatchObject({ unread: 1, unreadNotes: 1, readAt: expect.any(Number) });
    expect(((await inbox(b)) as Array<{ id: string; read?: boolean }>).find((n) => n.id === first.id)?.read).toBe(true);
    expect(b.events.some((e) => e.type === 'friend.updated' && e.friend.unread === 1)).toBe(true);
    // everything so far, and a mark never moves back
    expect((await b.api(`/api/friends/${aOnB}/read`, { json: {} })).body).toMatchObject({ unread: 0 });
    expect((await b.api(`/api/friends/${aOnB}/read`, { json: { upTo: first.id } })).body).toMatchObject({ unread: 0 });
    expect((await b.api(`/api/friends/${aOnB}/read`, { json: { upTo: 'nope' } })).status).toBe(404);
  });

  test('a note to a hub that is down waits, and arrives when it is back', async () => {
    const port = b.port;
    await b.stop();
    const out = await note(a, bOnA, 'Are you there?');
    const waiting = await waitFor('a failed try', async () => {
      const i = await outboxItem(a, out.id);
      return i.state === 'queued' && i.attempts >= 1 ? i : undefined;
    });
    expect(waiting.lastError).toContain('Bob');
    expect((await a.api(`/api/friends/${bOnA}`)).body.queued).toBe(1);
    b.start(port);
    await waitFor('the note after Bob is back', async () => (await inbox(b)).find((n) => n.text === 'Are you there?'));
    await waitFor('delivered on Alice', async () => (await outboxItem(a, out.id)).state === 'delivered');
  });

  test("an address change reaches the friend, and the new address works", async () => {
    const moved = `http://localhost:${a.port}`;
    a.setPublicUrl(moved);
    await waitFor('Bob to learn the new address', async () => (await b.api(`/api/friends/${aOnB}`)).body.addresses[0]?.url === moved);
    const out = await note(b, aOnB, 'Got your new address');
    await waitFor('the note on Alice', async () => (await inbox(a)).find((n) => n.text === 'Got your new address'));
    expect(await outboxItem(b, out.id)).toMatchObject({ state: 'delivered', via: 'push' });
  });

  test('when Alice cannot reach Bob, Bob pulls what waits for him', async () => {
    // Bob's hub now gives an address nothing answers at
    b.setPublicUrl('http://127.0.0.1:9');
    await waitFor('Alice to learn the dead address', async () => (await a.api(`/api/friends/${bOnA}`)).body.addresses[0]?.url === 'http://127.0.0.1:9');
    const out = await note(a, bOnA, 'Pull me');
    await waitFor('a failed push', async () => (await outboxItem(a, out.id)).attempts >= 1);
    expect((await inbox(b)).some((n) => n.text === 'Pull me')).toBe(false);

    const synced = await b.api(`/api/friends/${aOnB}/sync`, { method: 'POST' });
    expect(synced.status).toBe(200);
    expect((await inbox(b)).some((n) => n.text === 'Pull me')).toBe(true);
    expect(await outboxItem(a, out.id)).toMatchObject({ state: 'delivered', via: 'pull' });

    b.setPublicUrl(b.url);
    await waitFor('Alice to learn the good address again', async () => (await a.api(`/api/friends/${bOnA}`)).body.addresses[0]?.url === b.url);
  });

  test('after a remove, both sides refuse traffic', async () => {
    expect((await a.api(`/api/friends/${bOnA}`, { method: 'DELETE' })).status).toBe(200);
    await waitFor('Bob to hear', async () => (await b.api(`/api/friends/${aOnB}`)).body.status === 'removed');
    expect((await a.api('/api/friends')).body).toEqual([]);
    expect((await a.api(`/api/friends/${bOnA}/notes`, { json: { text: 'hello?' } })).status).toBe(409);
    expect((await b.api(`/api/friends/${aOnB}/notes`, { json: { text: 'hello?' } })).status).toBe(409);

    // a signed message from Bob's hub key is turned away by Alice's hub
    const ctxB = b.running!.conclave.ctx;
    const fpA = a.running!.conclave.ctx.identity.fingerprint;
    const id = ulid();
    const { envelope } = buildEnvelope(ctxB.identity, { id, type: 'note', to: fpA, body: { text: 'let me in' }, recipientSubkey: a.running!.conclave.ctx.peer.subkey.publicKey });
    const body = JSON.stringify(envelope);
    const url = `${a.url}/peer/v1/inbox/${id}`;
    const res = await fetch(url, { method: 'PUT', body, headers: { 'content-type': 'application/json', ...signRequest(ctxB.identity, { method: 'PUT', url, body, to: fpA }) } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not-friends' });
    expect(a.engine.repos.audit.list({ limit: 80 }).map((e) => `${e.actor} ${e.action}`)).toContain('owner friend.removed');
    expect(b.engine.repos.audit.list({ limit: 80 }).map((e) => `${e.actor} ${e.action}`)).toContain(`friend:${fpA} friend.removed`);
  });
});

describe('a remove the friend cannot be told about', () => {
  test('reaches it when its hub pulls, and the ack comes back', async () => {
    const e = makePeerHub('Erin');
    const f = makePeerHub('Finn');
    try {
      const ids = await befriend(e, f);
      f.setPublicUrl('http://127.0.0.1:9');
      await waitFor('Erin to learn the dead address', async () => (await e.api(`/api/friends/${ids.bOnA}`)).body.addresses[0]?.url === 'http://127.0.0.1:9');
      expect((await e.api(`/api/friends/${ids.bOnA}`, { method: 'DELETE' })).status).toBe(200);
      const removal = await waitFor('a failed push of the removal', async () => ((await e.api('/api/friends/outbox')).body as any[]).find((i) => i.type === 'friend.remove' && i.attempts >= 1));
      expect((await f.api(`/api/friends/${ids.aOnB}`)).body.status).toBe('active');
      await f.api(`/api/friends/${ids.aOnB}/sync`, { method: 'POST' });
      expect((await f.api(`/api/friends/${ids.aOnB}`)).body.status).toBe('removed');
      expect(await outboxItem(e, removal.id)).toMatchObject({ state: 'delivered', via: 'pull' });
    } finally {
      await e.close();
      await f.close();
    }
  }, 30_000);
});

describe('a message refused when it is pulled', () => {
  test('is not delivered on the sender, says why, and does not hold up the ones after it', async () => {
    const g = makePeerHub('Gil');
    const h = makePeerHub('Hal');
    try {
      const ids = await befriend(g, h);
      // Gil's hub cannot reach Hal's, so what it sends waits until Hal's hub pulls it
      h.setPublicUrl('http://127.0.0.1:9');
      await waitFor('Gil to learn the dead address', async () => (await g.api(`/api/friends/${ids.bOnA}`)).body.addresses[0]?.url === 'http://127.0.0.1:9');
      // Hal takes no notes from Gil for now
      await h.api(`/api/friends/${ids.aOnB}/grants`, { method: 'PUT', json: { receiveShares: false } });
      const first = await note(g, ids.bOnA, 'Not now');
      await waitFor('a failed push', async () => (await outboxItem(g, first.id)).attempts >= 1);
      await h.api(`/api/friends/${ids.aOnB}/sync`, { method: 'POST' });
      expect((await inbox(h)).some((n) => n.text === 'Not now')).toBe(false);
      expect(await outboxItem(g, first.id)).toMatchObject({ state: 'failed', lastError: "Hal's hub refused it: it does not take notes or shares from this hub now." });
      expect(g.engine.repos.audit.list({ limit: 50 }).find((e) => e.action === 'peer.message.refused')?.detail).toContain(`note ${first.id}`);

      // the next note comes through, and the refused one is not served again in front of it
      await h.api(`/api/friends/${ids.aOnB}/grants`, { method: 'PUT', json: { receiveShares: true } });
      const second = await note(g, ids.bOnA, 'Now?');
      await waitFor('a failed push', async () => (await outboxItem(g, second.id)).attempts >= 1);
      await h.api(`/api/friends/${ids.aOnB}/sync`, { method: 'POST' });
      expect((await inbox(h)).map((n) => n.text)).toEqual(['Now?']);
      expect(await outboxItem(g, second.id)).toMatchObject({ state: 'delivered', via: 'pull' });
      expect((await outboxItem(g, first.id)).state).toBe('failed');

      // Retry sends it again, and now it is taken
      expect((await g.api(`/api/friends/outbox/${first.id}/retry`, { method: 'POST' })).body.state).toBe('queued');
      await h.api(`/api/friends/${ids.aOnB}/sync`, { method: 'POST' });
      expect((await inbox(h)).map((n) => n.text)).toContain('Not now');
      expect(await outboxItem(g, first.id)).toMatchObject({ state: 'delivered', via: 'pull' });
    } finally {
      await g.close();
      await h.close();
    }
  }, 30_000);
});

describe('a key change', () => {
  test("without a signed rotation it blocks the friend until the owner confirms; with one it does not", async () => {
    const c = makePeerHub('Carol');
    const d = makePeerHub('Dave');
    try {
      const ids = await befriend(c, d);
      await note(c, ids.bOnA, 'before');
      await waitFor('the first note', async () => (await inbox(d)).find((n) => n.text === 'before'));

      // Dave's hub is set up again: same database, new hub key
      const port = d.port;
      await d.stop();
      const { rmSync } = await import('node:fs');
      rmSync(`${d.engine.home}/hub-key.pem`);
      d.start(port);
      const fpNew = d.running!.conclave.ctx.identity.fingerprint;

      const out = await note(c, ids.bOnA, 'after');
      const blocked = await waitFor('Carol to block Dave', async () => {
        const f = (await c.api(`/api/friends/${ids.bOnA}`)).body;
        return f.status === 'blocked' ? f : undefined;
      });
      expect(blocked.pendingFingerprint).toBe(fpNew);
      expect(blocked.blockedReason).toContain('new key');
      expect((await outboxItem(c, out.id)).state).toBe('queued');
      expect(c.engine.repos.audit.list({ limit: 50 }).some((e) => e.action === 'key.changed')).toBe(true);
      // Dave's hub, signing with the new key, is unknown to Carol's
      expect((await d.api(`/api/friends/${ids.aOnB}/sync`, { method: 'POST' })).body.lastError).toBeTruthy();

      const confirmed = await c.api(`/api/friends/${ids.bOnA}/confirm-key`, { method: 'POST' });
      expect(confirmed.body).toMatchObject({ status: 'active', fingerprint: fpNew, verified: false });
      await waitFor('the held note', async () => (await inbox(d)).find((n) => n.text === 'after'));

      // a rotation Dave's current key signs goes through without a block
      const { HubKey } = await import('../src/identity');
      const { generateKeyPairSync } = await import('node:crypto');
      const next = new HubKey(generateKeyPairSync('ed25519').privateKey);
      expect(d.running!.conclave.ctx.peer.announceRotation(next)).toBe(1);
      await waitFor('Carol to take the rotation', async () => (await c.api(`/api/friends/${ids.bOnA}`)).body.fingerprint === next.fingerprint);
      expect((await c.api(`/api/friends/${ids.bOnA}`)).body.status).toBe('active');
    } finally {
      await c.close();
      await d.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Phases 2 and 3: a session goes from Alice's hub to Bob's
// ---------------------------------------------------------------------------

const TOKEN = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';

function sh(cwd: string, cmd: string): string {
  const r = Bun.spawnSync(['sh', '-c', cmd], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });
  if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A real folder on a device of the hub: a LocalMachine attached as a paired device. */
function device(h: PeerHub, id: string): void {
  h.engine.repos.devices.insert({ id, name: id, tokenHash: 'x' });
  h.engine.devices.attach({ id, name: id, online: true, roots: [], createdAt: Date.now() }, new LocalMachine({ id, name: id }));
}

describe('shares between two hubs', () => {
  let a: PeerHub;
  let b: PeerHub;
  let ids: { bOnA: string; aOnB: string };
  let dir: string;
  let repo: string;
  let clone: string;
  let fpA: string;
  let sent: SentShareDto;
  let card: ReceivedShareDto;
  let forkId: string;
  let refId: string;

  beforeAll(async () => {
    a = makePeerHub('Alice', { blobThreshold: 4096 });
    b = makePeerHub('Bob', { blobThreshold: 4096 });
    ids = await befriend(a, b);
    fpA = a.running!.conclave.ctx.identity.fingerprint;

    // Alice's repository: a committed base, then the session's change, a secret file and an untracked one
    dir = mkdtempSync(join(tmpdir(), 'conclave-shares-'));
    repo = join(dir, 'app');
    mkdirSync(join(repo, 'src'), { recursive: true });
    sh(repo, 'git init -q -b main');
    writeFileSync(join(repo, 'src', 'auth.ts'), 'export const wait = 0;\n');
    writeFileSync(join(repo, '.env'), 'API_KEY=old\n');
    sh(repo, 'git add -A && git commit -q -m base');
    clone = join(dir, 'bob-app');
    sh(dir, `git clone -q ${repo} ${clone}`);
    writeFileSync(join(repo, 'src', 'auth.ts'), 'export const wait = 50;\n');
    writeFileSync(join(repo, '.env'), 'API_KEY=very-secret-value\n');
    writeFileSync(join(repo, 'notes.txt'), 'untracked thoughts\n');
    device(a, 'alicedesk');
    device(b, 'bobdesk');

    const now = Date.now();
    const s: Session = {
      id: 'ses_fix', title: 'Fix flaky auth test', agent: 'assistant', model: 'anthropic/claude-opus-test', mode: 'agent', permissionMode: 'bypass', cwd: repo, device: 'alicedesk',
      status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now, stats: { messages: 4, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    };
    a.engine.repos.sessions.insert(s);
    const add = (m: Omit<Message, 'sessionId' | 'createdAt'>) => a.engine.repos.messages.insert({ ...m, sessionId: 'ses_fix', createdAt: now + m.seq });
    add({ id: 'f1', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: `Fix the flaky test in ${repo}/src/auth.ts, the CI token is ${TOKEN}` }, reminder('Relevant memories:\n- [mem_1] Alice banks with Example Bank')] });
    add({ id: 'f2', seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'thinking', thinking: 'private plan', signature: 'c2lnbmF0dXJl' }, { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: `${repo}/src/auth.ts`, old_string: '0', new_string: '50' } }] });
    add({ id: 'f3', seq: 3, role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'edited', meta: { path: `${repo}/src/auth.ts` } }] });
    add({ id: 'f4', seq: 4, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'Done: the test waits for the clock now. Ping alice@example.org if it flakes again.' }] });
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const received = async () => (await b.api('/api/shares/received')).body as ReceivedShareDto[];

  test('the review lists what the sanitizer found, and the diff without untracked or credential files', async () => {
    const r = await a.api('/api/shares/preview', { json: { sessionId: 'ses_fix' } });
    expect(r.status).toBe(200);
    const p = r.body as SharePreview;
    expect(p).toMatchObject({ kind: 'session', title: 'Fix flaky auth test', messages: 4, total: 4, sessions: 1, options: { thinking: false, toolOutput: 'full', attachments: true, code: 'diff' } });
    expect(p.items.find((i) => i.rule === 'secret')).toMatchObject({ original: TOKEN, replacement: '[redacted]', kept: false });
    expect(p.items.find((i) => i.rule === 'email')).toMatchObject({ original: 'alice@example.org' });
    expect(p.report.reminders).toBe(1);
    expect(p.code).toMatchObject({ kind: 'diff', files: ['src/auth.ts'], excluded: [{ path: '.env', reason: expect.stringContaining('credential file') }] });
    const email = p.items.find((i) => i.rule === 'email')!;
    const kept = (await a.api('/api/shares/preview', { json: { sessionId: 'ses_fix', keep: [email.id] } })).body as SharePreview;
    expect(kept.items.find((i) => i.id === email.id)?.kept).toBe(true);
    expect(kept.report.emails).toBe(0);
    // a range and summaries
    const short = (await a.api('/api/shares/preview', { json: { sessionId: 'ses_fix', upTo: 'f2', toolOutput: 'summary', code: 'none' } })).body as SharePreview;
    expect(short).toMatchObject({ messages: 2, total: 4 });
    expect(short.code).toBeUndefined();
  });

  test('send: Bob gets an Inbox card, and nothing is fetched before Accept', async () => {
    const email = ((await a.api('/api/shares/preview', { json: { sessionId: 'ses_fix' } })).body as SharePreview).items.find((i) => i.rule === 'email')!;
    const r = await a.api('/api/shares', { json: { sessionId: 'ses_fix', to: [ids.bOnA], title: 'Fix flaky auth test', note: 'Can you finish it?', keep: [email.id] } });
    expect(r.status).toBe(200);
    sent = r.body;
    expect(sent).toMatchObject({ revision: 1, state: 'active', summary: { messages: 4, sessions: 1, code: { kind: 'diff', files: 1 } }, recipients: [{ friendId: ids.bOnA, friendName: 'Bob' }] });

    card = await waitFor('the card on Bob', async () => (await received()).find((s) => s.shareId === sent.id));
    expect(card).toMatchObject({ state: 'offered', title: 'Fix flaky auth test', note: 'Can you finish it?', friendName: 'Alice', fingerprint: fpA, revision: 1, sessions: [] });
    expect(card.line).toBe("Alice sent 'Fix flaky auth test' (session, 4 messages, diff 1 file)");
    expect(card.expiresAt! - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(b.events.some((e) => e.type === 'friend.share' && e.change === 'received')).toBe(true);
    // the payload waits on Alice's hub, sealed for Bob, unfetched
    const ctxA = a.running!.conclave.ctx;
    const send = ctxA.peer.shares.store.send(sent.id, ids.bOnA)!;
    expect(ctxA.peer.store.blob(send.blob!, ids.bOnA, 'out')?.fetchedAt).toBeUndefined();
    expect(readFileSync(ctxA.peer.store.blob(send.blob!, ids.bOnA, 'out')!.path, 'utf8')).not.toContain('flaky');
    expect(existsSync(join(b.engine.home, 'peer', 'shares', 'in'))).toBe(false);
    await waitFor('delivered on Alice', async () => ((await a.api(`/api/shares/sent/${sent.id}`)).body as SentShareDto).recipients[0].state === 'delivered');
  });

  test('accept fetches it and checks the signature; the view is quoted data from Alice\'s hub', async () => {
    const r = await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'accepted', acceptedRevision: 1, updateWaiting: false });
    await waitFor('the ack on Alice', async () => ((await a.api(`/api/shares/sent/${sent.id}`)).body as SentShareDto).recipients[0].state === 'accepted');
    expect(a.events.some((e) => e.type === 'friend.share.sent' && e.change === 'accepted')).toBe(true);

    const view = (await b.api(`/api/shares/received/${card.id}/view`)).body as ShareViewDto;
    expect(view.verified).toEqual({ ok: true, fingerprint: fpA });
    expect(view.provenance).toStartWith("Shared by Alice's hub");
    expect(view.sessions[0].messages.every((m) => m.from === "Alice's hub")).toBe(true);
    const all = JSON.stringify(view);
    for (const bad of [TOKEN, 'Example Bank', 'private plan', 'c2lnbmF0dXJl', repo, 'very-secret-value', 'untracked thoughts']) expect(all).not.toContain(bad);
    // the email was kept anyway on Alice's side
    expect(all).toContain('alice@example.org');
    expect(view.code).toMatchObject({ kind: 'diff', files: ['src/auth.ts'] });
    expect(view.code!.diff).toContain('+export const wait = 50;');

    // a changed byte in the kept copy fails the check
    const row = b.running!.conclave.ctx.peer.shares.store.in(card.id)!;
    const original = readFileSync(row.payload!, 'utf8');
    writeFileSync(row.payload!, original.replace('waits for the clock', 'waits for the c1ock'));
    expect(((await b.api(`/api/shares/received/${card.id}/view`)).body as ShareViewDto).verified.ok).toBe(false);
    expect((await b.api(`/api/shares/received/${card.id}/fork`, { json: {} })).status).toBe(409);
    writeFileSync(row.payload!, original);
  });

  test('fork, reference and handoff: the friend\'s turns quoted, the fork guarded', async () => {
    const fork = await b.api(`/api/shares/received/${card.id}/fork`, { json: {} });
    expect(fork.status).toBe(200);
    const s = fork.body as Session;
    forkId = s.id;
    expect(s).toMatchObject({ title: 'Fix flaky auth test (from Alice)', tags: ['from-friend'], meta: { untrusted: true, friendShare: { role: 'fork', guard: true, fingerprint: fpA, shareId: sent.id, name: 'Alice' } } });
    const msgs = b.engine.repos.messages.list(s.id);
    expect(msgs).toHaveLength(4);
    expect(msgs.every((m) => (m.meta?.quoted as { from?: string })?.from === "Alice's hub")).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain('thinking');
    expect(b.engine.repos.kv.get(`memory.extract.${s.id}`, -1)).toBe(4);

    const ref = await b.api(`/api/shares/received/${card.id}/reference`, { method: 'POST' });
    refId = (ref.body as Session).id;
    expect(ref.body).toMatchObject({ tags: ['from-friend', 'reference'], meta: { friendShare: { role: 'reference' } } });
    expect(((await b.api(`/api/shares/received/${card.id}/reference`, { method: 'POST' })).body as Session).id).toBe(refId);

    const draft = (await b.api(`/api/shares/received/${card.id}/handoff`)).body as { brief: string; files: string[] };
    expect(draft.brief).toStartWith(`Handoff from Alice's hub: "Fix flaky auth test".`);
    expect(draft.files).toEqual(['src/auth.ts']);
    const hand = await b.api(`/api/shares/received/${card.id}/handoff`, { json: { brief: `${draft.brief}\n\nStart with the test file.` } });
    expect(hand.body).toMatchObject({ meta: { untrusted: true, friendShare: { role: 'handoff', guard: true } } });
    expect(JSON.stringify(b.engine.repos.messages.list((hand.body as Session).id))).toContain('Start with the test file.');
    expect(((await b.api(`/api/shares/received/${card.id}`)).body as ReceivedShareDto).sessions.map((x) => x.role)).toEqual(['fork', 'reference', 'handoff']);
  });

  test('the code lands on a new branch on a device Bob picks, once he approves the plan', async () => {
    writeFileSync(join(clone, 'wip.txt'), 'Bob is working here\n');
    const plan = await b.api(`/api/shares/received/${card.id}/apply-plan`, { json: { device: 'bobdesk', cwd: clone } });
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ device: 'bobdesk', kind: 'diff', branch: 'from-alice/fix-flaky-auth-test', files: ['src/auth.ts'], check: { ok: true } });
    expect(sh(clone, 'git branch --list "from-*"').trim()).toBe('');
    expect((await b.api(`/api/shares/received/${card.id}/apply`, { json: { planId: 'apl_nope' } })).status).toBe(409);
    const done = await b.api(`/api/shares/received/${card.id}/apply`, { json: { planId: plan.body.planId } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ branch: 'from-alice/fix-flaky-auth-test', commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(sh(clone, 'git show from-alice/fix-flaky-auth-test:src/auth.ts')).toBe('export const wait = 50;\n');
    expect(sh(clone, 'git rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(readFileSync(join(clone, 'src', 'auth.ts'), 'utf8')).toBe('export const wait = 0;\n');
    expect(sh(clone, 'git show from-alice/fix-flaky-auth-test:.env')).toBe('API_KEY=old\n');
    // the plan is used up
    expect((await b.api(`/api/shares/received/${card.id}/apply`, { json: { planId: plan.body.planId } })).status).toBe(409);
  });

  test('update sends a new revision; unsend asks Bob\'s hub to delete its copy', async () => {
    a.engine.repos.messages.insert({ id: 'f5', sessionId: 'ses_fix', seq: 5, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'One more thing: run it twice.' }], createdAt: Date.now() });
    const up = await a.api(`/api/shares/sent/${sent.id}/update`, { json: { note: 'Now with the last step.' } });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ revision: 2, note: 'Now with the last step.', summary: { messages: 5 } });
    const updated = await waitFor('revision 2 on Bob', async () => (await received()).find((s) => s.id === card.id && s.revision === 2));
    expect(updated).toMatchObject({ state: 'accepted', acceptedRevision: 1, updateWaiting: true, note: 'Now with the last step.' });
    expect((await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' })).body).toMatchObject({ acceptedRevision: 2, updateWaiting: false });
    expect(JSON.stringify((await b.api(`/api/shares/received/${card.id}/view`)).body)).toContain('run it twice');

    const ctxA = a.running!.conclave.ctx;
    const blob = ctxA.peer.shares.store.send(sent.id, ids.bOnA)!.blob!;
    const gone = await a.api(`/api/shares/sent/${sent.id}`, { method: 'DELETE' });
    expect(gone.body).toMatchObject({ state: 'revoked', recipients: [{ state: 'revoked' }] });
    expect(ctxA.peer.store.blob(blob, ids.bOnA, 'out')).toBeUndefined();
    const revoked = await waitFor('the unsend on Bob', async () => (await received()).find((s) => s.id === card.id && s.state === 'revoked'));
    // the copy and the reference go; the fork and the handoff are Bob's own
    expect(revoked.sessions.map((x) => x.role)).toEqual(['fork', 'handoff']);
    expect(b.running!.conclave.ctx.peer.shares.store.in(card.id)!.payload).toBeUndefined();
    await waitFor('the reference deleted', async () => !b.engine.getSession(refId));
    expect(b.engine.getSession(forkId)).toBeDefined();
    expect((await b.api(`/api/shares/received/${card.id}/view`)).status).toBe(409);
    expect(b.events.some((e) => e.type === 'friend.share' && e.change === 'revoked')).toBe(true);
    expect(a.engine.repos.audit.list({ limit: 80 }).find((e) => e.action === 'friend.share.unsend')?.detail).toContain('Bob is asked to delete their copy');
  });
});
