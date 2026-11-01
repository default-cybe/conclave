/**
 * Shares between friends (peer/shares.ts) on two real hubs, the parts the
 * walk through in friends-two-hubs.test.ts does not take: refusals, an
 * update before Accept, a payload sealed again after a key change, unsend
 * before Accept and before the offer came, decline, malformed offers, and
 * expiry on both sides.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ReceivedShareDto, SentShareDto } from '@conclave/core/client/friends.ts';
import type { Message, Session } from '@conclave/core/types.ts';
import { SHARE_TTL_MS, UNSENT_KEEP_MS, UNSENT_MAX } from '../src/peer/shares';
import { ulid } from '../src/peer/ulid';
import { befriend, makePeerHub, waitFor, type PeerHub } from './peer-helpers';

let a: PeerHub;
let b: PeerHub;
let ids: { bOnA: string; aOnB: string };

function chat(h: PeerHub, id: string, lines: string[]): void {
  const now = Date.now();
  const s: Session = {
    id, title: `Chat ${id}`, agent: 'assistant', model: 'anthropic/claude-opus-test', mode: 'agent', permissionMode: 'default', cwd: '/home/me', device: 'local', kind: 'chat', chat: { webSearch: false, memory: true },
    status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now, stats: { messages: lines.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  };
  h.engine.repos.sessions.insert(s);
  lines.forEach((text, i) => h.engine.repos.messages.insert({ id: `${id}_${i}`, sessionId: id, seq: i + 1, role: i % 2 ? 'assistant' : 'user', kind: 'normal', content: [{ type: 'text', text }], createdAt: now + i } as Message));
}

const ctx = (h: PeerHub) => h.running!.conclave.ctx;
const cards = async () => (await b.api('/api/shares/received')).body as ReceivedShareDto[];
const send = async (sessionId: string, extra: Record<string, unknown> = {}) => {
  const r = await a.api('/api/shares', { json: { sessionId, to: [ids.bOnA], ...extra } });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body as SentShareDto;
};
const cardOf = (shareId: string, pred: (c: ReceivedShareDto) => boolean = () => true) => waitFor(`the card for ${shareId}`, async () => (await cards()).find((c) => c.shareId === shareId && pred(c)));

beforeAll(async () => {
  a = makePeerHub('Alice');
  b = makePeerHub('Bob');
  ids = await befriend(a, b);
});
afterAll(async () => {
  await a?.close();
  await b?.close();
});

describe('sending', () => {
  test('refused: no friend, a stranger, a chat with code, a subagent', async () => {
    chat(a, 'ses_c1', ['What is a good name for a cat?', 'Miso.']);
    expect((await a.api('/api/shares', { json: { sessionId: 'ses_c1', to: [] } })).status).toBe(400);
    expect((await a.api('/api/shares', { json: { sessionId: 'ses_c1', to: ['frd_nobody'] } })).status).toBe(404);
    const coded = await a.api('/api/shares/preview', { json: { sessionId: 'ses_c1', code: 'diff' } });
    expect(coded.status).toBe(400);
    expect(coded.body.error).toContain('A chat has no folder');
    a.engine.repos.sessions.insert({ ...a.engine.getSession('ses_c1')!, id: 'ses_c1_sub', parentId: 'ses_c1' });
    expect((await a.api('/api/shares/preview', { json: { sessionId: 'ses_c1_sub' } })).status).toBe(400);
    // a chat has no code by default
    expect((await a.api('/api/shares/preview', { json: { sessionId: 'ses_c1' } })).body).toMatchObject({ kind: 'chat', options: { code: 'none' } });
  });
});

describe('revisions', () => {
  test('an update before Accept replaces the offer, and the old payload is gone', async () => {
    chat(a, 'ses_r1', ['First question', 'First answer']);
    const s = await send('ses_r1', { title: 'Cat names' });
    const first = await cardOf(s.id);
    expect(first).toMatchObject({ revision: 1, state: 'offered', line: "Alice sent 'Cat names' (chat, 2 messages)" });
    const oldBlob = ctx(a).peer.shares.store.send(s.id, ids.bOnA)!.blob!;

    a.engine.repos.messages.insert({ id: 'r1_x', sessionId: 'ses_r1', seq: 3, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Second question' }], createdAt: Date.now() });
    const up = (await a.api(`/api/shares/sent/${s.id}/update`, { json: { title: 'Cat names, again' } })).body as SentShareDto;
    expect(up).toMatchObject({ revision: 2, title: 'Cat names, again', summary: { messages: 3 } });
    const second = await cardOf(s.id, (c) => c.revision === 2);
    expect(second).toMatchObject({ state: 'offered', title: 'Cat names, again', updateWaiting: false, line: "Alice sent 'Cat names, again' (chat, 3 messages)" });
    expect(ctx(a).peer.store.blob(oldBlob, ids.bOnA, 'out')).toBeUndefined();
    expect(b.events.filter((e) => e.type === 'friend.share' && e.share.shareId === s.id).map((e) => (e as { change: string }).change)).toEqual(['received', 'updated']);

    // an older revision that comes late changes nothing
    const friend = ctx(b).peer.store.friend(ids.aOnB)!;
    expect(ctx(b).peer.shares.receive(friend, 'share.offer', { shareId: s.id, revision: 1, title: 'Old', kind: 'chat', summary: {}, payload: { sha256: 'a'.repeat(64), size: 10 } })).toMatchObject({ ignored: true });
    expect((await cardOf(s.id)).title).toBe('Cat names, again');

    const accepted = (await b.api(`/api/shares/received/${second.id}/accept`, { method: 'POST' })).body as ReceivedShareDto;
    expect(accepted).toMatchObject({ state: 'accepted', acceptedRevision: 2 });
    expect(JSON.stringify((await b.api(`/api/shares/received/${second.id}/view`)).body)).toContain('Second question');
  });

  test("sealed again for the same revision after the friend's key changed, it still opens", async () => {
    chat(a, 'ses_k1', ['Reseal me', 'ok']);
    const s = await send('ses_k1');
    const card = await cardOf(s.id);
    const before = ctx(a).peer.shares.store.send(s.id, ids.bOnA)!.blob!;
    expect(ctx(a).peer.shares.resealFor(ctx(a).peer.store.friend(ids.bOnA)!)).toBe(1);
    const after = ctx(a).peer.shares.store.send(s.id, ids.bOnA)!.blob!;
    expect(after).not.toBe(before);
    await waitFor('the new payload on Bob', async () => ctx(b).peer.shares.store.in(card.id)!.blob.sha256 === after);
    expect((await cardOf(s.id)).revision).toBe(1);
    expect((await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' })).body).toMatchObject({ state: 'accepted', acceptedRevision: 1 });
  });
});

describe('read marks', () => {
  test('a card counts as unread on the friend until marked, and again when a revision comes', async () => {
    await b.api(`/api/friends/${ids.aOnB}/read`, { json: {} });
    chat(a, 'ses_m1', ['Unread me', 'ok']);
    const s = await send('ses_m1');
    const card = await cardOf(s.id);
    expect(card.read).toBe(false);
    expect((await b.api(`/api/friends/${ids.aOnB}`)).body).toMatchObject({ unread: 1, unreadShares: 1, unreadNotes: 0 });
    expect((await b.api(`/api/friends/${ids.aOnB}/read`, { json: { upTo: card.id } })).body).toMatchObject({ unread: 0 });
    expect((await cardOf(s.id)).read).toBe(true);

    await a.api(`/api/shares/sent/${s.id}/update`, { json: { note: 'again' } });
    const updated = await cardOf(s.id, (c) => c.revision === 2);
    expect(updated.read).toBe(false);
    expect((await b.api(`/api/friends/${ids.aOnB}`)).body).toMatchObject({ unreadShares: 1 });
    // accepted, it waits for nothing
    await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' });
    expect((await b.api(`/api/friends/${ids.aOnB}`)).body).toMatchObject({ unreadShares: 0 });
    expect((await cardOf(s.id)).read).toBe(true);
  });
});

describe('unsend, decline, refusals', () => {
  test('unsent before Accept: the card is revoked and cannot be accepted', async () => {
    chat(a, 'ses_u1', ['Oops, wrong friend', 'ok']);
    const s = await send('ses_u1');
    const card = await cardOf(s.id);
    expect((await a.api(`/api/shares/sent/${s.id}`, { method: 'DELETE' })).body).toMatchObject({ state: 'revoked' });
    await cardOf(s.id, (c) => c.state === 'revoked');
    const r = await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('unsent');
    // unsend again is the same answer
    expect((await a.api(`/api/shares/sent/${s.id}`, { method: 'DELETE' })).body).toMatchObject({ state: 'revoked' });
    expect((await a.api(`/api/shares/sent/${s.id}/update`, { json: {} })).status).toBe(409);
  });

  test('declined, then accepted after all', async () => {
    chat(a, 'ses_d1', ['Maybe later', 'ok']);
    const s = await send('ses_d1');
    const card = await cardOf(s.id);
    expect((await b.api(`/api/shares/received/${card.id}/decline`, { method: 'POST' })).body).toMatchObject({ state: 'declined' });
    expect((await b.api(`/api/shares/received/${card.id}/view`)).status).toBe(409);
    expect((await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' })).body).toMatchObject({ state: 'accepted' });
  });

  test('a malformed or oversized offer is refused', () => {
    const friend = ctx(b).peer.store.friend(ids.aOnB)!;
    const base = { shareId: '01JA0000000000000000000000', revision: 1, title: 'x', kind: 'chat', summary: {}, payload: { sha256: 'b'.repeat(64), size: 10 } };
    const refused = (body: Record<string, unknown>) => {
      try {
        ctx(b).peer.shares.receive(friend, 'share.offer', body);
        return undefined;
      } catch (err) {
        return (err as { code?: string }).code;
      }
    };
    expect(refused({ ...base, shareId: 'nope' })).toBe('body');
    expect(refused({ ...base, payload: { sha256: 'xyz', size: 10 } })).toBe('body');
    expect(refused({ ...base, title: '   ' })).toBe('body');
    expect(refused({ ...base, payload: { sha256: 'b'.repeat(64), size: 200 * 1024 * 1024 } })).toBe('too-large');
  });

  test('without the receiveShares grant an offer is turned away', async () => {
    await b.api(`/api/friends/${ids.aOnB}/grants`, { method: 'PUT', json: { receiveShares: false } });
    try {
      chat(a, 'ses_g1', ['No thanks', 'ok']);
      const s = await send('ses_g1');
      const item = await waitFor('a refused push', async () => ((await a.api('/api/friends/outbox')).body as Array<{ preview: string; attempts: number; lastError?: string }>).find((i) => i.preview === 'share: Chat ses_g1' && i.attempts >= 1));
      expect(item.lastError).toContain('does not take notes or shares');
      expect((await cards()).some((c) => c.shareId === s.id)).toBe(false);
      await a.api(`/api/shares/sent/${s.id}`, { method: 'DELETE' });
    } finally {
      await b.api(`/api/friends/${ids.aOnB}/grants`, { method: 'PUT', json: { receiveShares: true } });
    }
  });

  test('an unsend that comes before its offer leaves no card when the offer comes', async () => {
    // the offer met a passing error on its way (its body was still to fetch), so the unsend came first
    const shares = ctx(b).peer.shares;
    const friend = ctx(b).peer.store.friend(ids.aOnB)!;
    const offer = (shareId: string, revision = 1) => shares.receive(friend, revision === 1 ? 'share.offer' : 'share.update', { shareId, revision, title: 'Too late', kind: 'chat', summary: {}, payload: { sha256: 'c'.repeat(64), size: 10 } });
    const early = ulid();
    shares.receive(friend, 'share.revoke', { shareId: early });
    expect(offer(early)).toMatchObject({ ignored: true });
    expect(offer(early, 2)).toMatchObject({ ignored: true });
    expect((await cards()).some((c) => c.shareId === early)).toBe(false);
    expect(b.engine.repos.audit.list({ limit: 20 }).some((e) => e.action === 'friend.share.revoked' && e.detail.includes('before the offer came'))).toBe(true);

    // the unsend is remembered 30 days; an offer after that is a card again
    const db = ctx(b).peer.store.db;
    const late = ulid();
    shares.receive(friend, 'share.revoke', { shareId: late });
    db.query('UPDATE friend_share_revoked SET revoked_at = ? WHERE share_id = ?').run(Date.now() - UNSENT_KEEP_MS - 1, late);
    shares.sweep();
    expect(db.query('SELECT 1 FROM friend_share_revoked WHERE share_id = ?').get(late)).toBeNull();
    expect(offer(late)).not.toMatchObject({ ignored: true });
    expect((await cards()).find((c) => c.shareId === late)?.state).toBe('offered');

    // and at most UNSENT_MAX per friend, the oldest going first
    for (let i = 0; i < UNSENT_MAX + 5; i++) shares.receive(friend, 'share.revoke', { shareId: ulid() });
    expect((db.query('SELECT COUNT(*) AS n FROM friend_share_revoked WHERE friend_id = ?').get(friend.id) as { n: number }).n).toBe(UNSENT_MAX);
    expect(db.query('SELECT 1 FROM friend_share_revoked WHERE share_id = ?').get(early)).toBeNull();
  });
});

describe('expiry', () => {
  test('an offer not accepted in 30 days expires on both sides', async () => {
    chat(a, 'ses_e1', ['Old news', 'ok']);
    const s = await send('ses_e1');
    const card = await cardOf(s.id);
    expect(card.expiresAt! - card.receivedAt).toBe(SHARE_TTL_MS);
    // 30 days later
    ctx(b).peer.shares.store.updateIn(card.id, { expiresAt: Date.now() - 1 });
    ctx(b).peer.shares.sweep();
    expect((await cardOf(s.id)).state).toBe('expired');
    expect(b.events.some((e) => e.type === 'friend.share' && e.change === 'expired' && e.share.id === card.id)).toBe(true);
    expect((await b.api(`/api/shares/received/${card.id}/accept`, { method: 'POST' })).status).toBe(409);

    a.engine.repos.db.query('UPDATE friend_share_sends SET sent_at = ? WHERE share_id = ?').run(Date.now() - SHARE_TTL_MS - 1, s.id);
    a.engine.repos.db.query('UPDATE friend_shares_out SET updated_at = ? WHERE id = ?').run(Date.now() - SHARE_TTL_MS - 1, s.id);
    ctx(a).peer.shares.sweep();
    const out = (await a.api(`/api/shares/sent/${s.id}`)).body as SentShareDto;
    expect(out.recipients[0].state).toBe('expired');
    expect(ctx(a).peer.shares.store.out(s.id)!.payload).toBeUndefined();
  });
});
