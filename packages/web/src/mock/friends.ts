/**
 * Mock routes for friends (Settings, Friends; a friend's notes; the Inbox).
 * The busy hub starts with one friend of each state (friends-data.ts); a
 * first-run hub (?fresh=1) has none. An invite is a real link with a QR code
 * look-alike. Using a link makes a request out that the other owner accepts
 * a few seconds later, and their hub says hello. A note to Alice gets an
 * answer; Ben's hub does not answer, so notes to him wait.
 *
 * Read marks live here as on the hub, one per friend: Alice's newest two
 * notes and Ben's note are not read yet. Shares are in mock/shares.ts.
 */
import type { FriendDto, FriendInvite, FriendReachability, InboxItemDto, OutboxItemDto } from '@conclave/core/client';
import type { RemoteStatus } from '@conclave/core/types';
import type { MockCtx } from './index';
import { blockedReason, FRIEND_SEEDS } from './friends-data';
import { mockIdentity } from './identity';
import { registerShares, type FriendsMock } from './shares';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NAMES = ['Noor', 'Mateo', 'Ines', 'Kofi', 'Yuki'];

export function registerFriends(ctx: MockCtx) {
  const { on, emit, fail, sleep } = ctx;
  const now = Date.now();
  let seq = 0;
  /** Message ids sort by time, like the hub's ULIDs. */
  const msgId = (at = Date.now()) => `01${at.toString(36).toUpperCase().padStart(10, '0')}${(++seq).toString(36).toUpperCase().padStart(4, '0')}MOCK`;
  const friendId = () => `frd_${Date.now().toString(36)}${(++seq).toString(36)}`;

  const friends = new Map<string, FriendDto>();
  const inbox: InboxItemDto[] = [];
  const outbox: OutboxItemDto[] = [];

  if (!ctx.FRESH)
    for (const s of FRIEND_SEEDS) {
      const id = `frd_${s.key}`;
      friends.set(id, {
        id,
        name: s.name,
        fingerprint: s.fingerprint,
        status: s.status,
        direction: s.direction,
        verified: s.verified,
        safetyCode: s.safetyCode,
        grants: { receiveShares: true },
        addresses: s.addresses,
        createdAt: now - s.createdAgo,
        ...(s.seenAgo !== undefined ? { lastSeen: now - s.seenAgo } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
        ...(s.status === 'blocked' ? { blockedReason: blockedReason(s.name), pendingFingerprint: s.pendingFingerprint } : {}),
        queued: s.notesOut.filter((n) => n.state === 'queued').length,
      });
      for (const n of s.notesIn) inbox.push({ id: msgId(now - n.ago), friendId: id, friendName: s.name, type: 'note', state: 'received', text: n.text, receivedAt: now - n.ago });
      for (const n of s.notesOut)
        outbox.push({
          id: msgId(now - n.ago),
          friendId: id,
          type: 'note',
          state: n.state,
          attempts: n.attempts ?? 1,
          ...(n.nextTryIn ? { nextTry: now + n.nextTryIn } : {}),
          createdAt: now - n.ago,
          ...(n.state === 'delivered' ? { deliveredAt: now - n.ago + 2_000, via: 'push' as const } : {}),
          ...(n.lastError ? { lastError: n.lastError } : {}),
          preview: `note: ${n.text.length > 80 ? `${n.text.slice(0, 79)}…` : n.text}`,
          text: n.text,
        });
    }

  /** The read mark per friend, as on the hub: what came up to this time is read. Alice read her first note; Eli's is old. */
  const marks = new Map<string, number>();
  if (!ctx.FRESH) {
    const first = (key: string) => FRIEND_SEEDS.find((s) => s.key === key)?.notesIn[0];
    for (const key of ['alice', 'eli']) {
      const n = first(key);
      if (n) marks.set(`frd_${key}`, now - n.ago);
    }
  }
  const markOf = (id: string) => marks.get(id) ?? 0;
  /** Set by mock/shares.ts: the share cards from a friend that wait and came after `since`. */
  let unreadShares: (friendId: string, since: number) => number = () => 0;

  /** A friend as the hub returns it, with what is not read yet. */
  const dto = (f: FriendDto): FriendDto => {
    const mark = markOf(f.id);
    const unreadNotes = inbox.filter((n) => n.friendId === f.id && n.type === 'note' && n.state !== 'failed' && n.receivedAt > mark).length;
    const shares = unreadShares(f.id, mark);
    return structuredClone({ ...f, unread: unreadNotes + shares, unreadNotes, unreadShares: shares, ...(mark ? { readAt: mark } : {}) });
  };
  const noteDto = (n: InboxItemDto): InboxItemDto => ({ ...n, read: n.receivedAt <= markOf(n.friendId) });

  const get = (id: string) => friends.get(id) ?? fail(404, `unknown friend ${id}`);
  const queuedFor = (id: string) => outbox.filter((o) => o.friendId === id && o.state === 'queued').length;
  const update = (id: string, patch: Partial<FriendDto>) => {
    const f = { ...get(id), ...patch };
    f.queued = queuedFor(id);
    friends.set(id, f);
    const out = dto(f);
    emit({ type: 'friend.updated', friend: out });
    return structuredClone(out);
  };
  const receive = (id: string, text: string) => {
    const f = get(id);
    const item: InboxItemDto = { id: msgId(), friendId: id, friendName: f.name, type: 'note', state: 'received', text, receivedAt: Date.now() };
    inbox.unshift(item);
    emit({ type: 'friend.message', message: noteDto(item) });
    emit({ type: 'notice', notice: { id: ctx.uid('n'), title: f.name, body: text, level: 'info', link: '/settings/friends', createdAt: Date.now() } });
    update(id, { lastSeen: Date.now(), lastError: undefined });
  };

  const reachability = async (): Promise<FriendReachability> => {
    const st = (await (await ctx.request('/api/remote')).json()) as RemoteStatus;
    const outside = st.addresses.filter((a) => a.kind !== 'lan');
    const best = outside[0] ? { url: outside[0].url, kind: outside[0].kind } : undefined;
    const pulls = 'Until then your hub still fetches what friends hold for it.';
    if (st.mode === 'off') return { ok: false, mode: st.mode, reason: `Remote access is off, so a friend's hub cannot reach this one. Turn on a tunnel or add your own URL in Settings, Remote access. ${pulls}` };
    if (st.mode === 'tailscale') return { ok: false, mode: st.mode, ...(best ? { best } : {}), reason: `Tailscale serves only your tailnet, so a friend outside it cannot reach this hub. ${pulls}` };
    if (!best) return { ok: false, mode: st.mode, reason: `${st.state === 'starting' || st.state === 'installing' ? 'The tunnel is still starting.' : 'The hub has no outside address yet.'} ${pulls}` };
    return best.kind === 'quick' ? { ok: true, mode: st.mode, best, reason: 'A quick tunnel gets a new address when it restarts. Your hub sends friends the new one.' } : { ok: true, mode: st.mode, best };
  };

  on('GET', '/api/friends', () => [...friends.values()].filter((f) => f.status !== 'removed').map(dto));
  on('GET', '/api/friends/reachability', reachability);
  on('GET', '/api/friends/outbox', ({ query }) => outbox.filter((o) => !query.get('friend') || o.friendId === query.get('friend')).sort((a, b) => b.createdAt - a.createdAt));
  on('GET', '/api/friends/inbox', ({ query }) => inbox.filter((n) => !query.get('friend') || n.friendId === query.get('friend')).map(noteDto));

  // the read mark moves to the note or share card named (or to now), never back; every device sees it
  on('POST', '/api/friends/:id/read', ({ params, body }) => {
    const f = get(params[0]);
    let at = Date.now();
    if (body?.upTo) {
      const note = inbox.find((n) => n.friendId === f.id && n.id === body.upTo);
      const share = note ? undefined : shares.timeOf(f.id, String(body.upTo));
      if (note) at = note.receivedAt;
      else if (share !== undefined) at = share;
      else fail(404, `${f.name} sent nothing with the id ${body.upTo}.`);
    }
    if (at > markOf(f.id)) {
      marks.set(f.id, at);
      return update(f.id, {});
    }
    return dto(f);
  });

  on('POST', '/api/friends/invites', async ({ body }) => {
    const st = (await (await ctx.request('/api/remote')).json()) as RemoteStatus;
    const r = await reachability();
    const urls = st.addresses.filter((a) => body?.includeLan || a.kind !== 'lan').map((a) => a.url);
    if (!urls.length) fail(409, `A friend's hub could not reach this one: ${r.reason ?? 'there is no outside address.'}${st.addresses.length ? ' To invite someone on this network, include its addresses.' : ''}`);
    const { fingerprint } = await mockIdentity();
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('');
    const expiresAt = Date.now() + DAY;
    const alts = urls
      .slice(1)
      .map((u) => `&alt=${encodeURIComponent(u)}`)
      .join('');
    const link = `conclave://friend?fp=${fingerprint}&url=${encodeURIComponent(urls[0])}${alts}&s=${secret}&exp=${Math.floor(expiresAt / 1000)}`;
    const invite: FriendInvite = { link, qrSvg: ctx.qr(link), expiresAt, fingerprint, url: urls[0], addresses: urls, ...(r.ok ? {} : { warning: r.reason }) };
    return invite;
  });

  on('POST', '/api/friends/accept', async ({ body }) => {
    const link = String(body?.link ?? '');
    const q = new URLSearchParams(link.slice(link.indexOf('?') + 1));
    const fp = (q.get('fp') ?? '').toLowerCase();
    const url = q.get('url') ?? '';
    if (!link.startsWith('conclave://friend') || !/^[0-9a-f]{32}$/.test(fp) || !url) fail(400, 'That is not a friend link. It starts with conclave://friend.');
    if (Number(q.get('exp')) * 1000 <= Date.now()) fail(400, 'This invite has expired. Ask your friend for a new one.');
    if (fp === (await mockIdentity()).fingerprint) fail(400, "This is your own hub's invite. Send it to a friend.");
    const known = [...friends.values()].find((f) => f.fingerprint === fp && f.status !== 'removed');
    if (known?.status === 'active') fail(409, `You are friends with ${known.name} already.`);
    await sleep(700);
    const id = friendId();
    const f: FriendDto = {
      id,
      name: `Hub ${fp.slice(0, 4)} ${fp.slice(4, 8)}`,
      fingerprint: fp,
      status: 'pending',
      direction: 'out',
      verified: false,
      safetyCode: Array.from({ length: 4 }, (_, i) => String(parseInt(fp.slice(i * 6, i * 6 + 6), 16) % 100_000).padStart(5, '0')).join(' '),
      grants: { receiveShares: true },
      addresses: [{ url, kind: 'quick' }],
      createdAt: Date.now(),
      queued: 0,
    };
    friends.set(id, f);
    emit({ type: 'friend.updated', friend: dto(f) });
    // their owner accepts a little later, and their hub says hello
    setTimeout(() => {
      if (friends.get(id)?.status !== 'pending') return;
      const name = NAMES[seq % NAMES.length];
      update(id, { status: 'active', name, lastSeen: Date.now() });
      emit({ type: 'notice', notice: { id: ctx.uid('n'), title: `${name} accepted`, body: `You and ${name} are friends now. Compare the safety code ${f.safetyCode} to be sure.`, level: 'success', link: '/settings/friends', createdAt: Date.now() } });
      setTimeout(() => friends.get(id)?.status === 'active' && receive(id, 'Hi! Your request came through. Lunch some time?'), 3_000);
    }, 6_000);
    return dto(f);
  });

  on('POST', '/api/friends/outbox/:msgId/retry', ({ params }) => {
    const o = outbox.find((x) => x.id === params[0]) ?? fail(404, `unknown message ${params[0]}`);
    Object.assign(o, { state: 'queued', attempts: 0, nextTry: Date.now() });
    update(o.friendId, {});
    return structuredClone(o);
  });
  on('DELETE', '/api/friends/outbox/:msgId', ({ params }) => {
    const o = outbox.find((x) => x.id === params[0]) ?? fail(404, `unknown message ${params[0]}`);
    if (o.state === 'queued') Object.assign(o, { state: 'cancelled', nextTry: undefined });
    update(o.friendId, {});
    return structuredClone(o);
  });

  on('GET', '/api/friends/:id', ({ params }) => dto(get(params[0])));
  on('PATCH', '/api/friends/:id', ({ params, body }) => update(params[0], { name: String(body?.name ?? '').trim() || get(params[0]).name }));
  on('DELETE', '/api/friends/:id', ({ params }) => {
    const f = get(params[0]);
    for (const o of outbox) if (o.friendId === f.id && o.state === 'queued') o.state = 'cancelled';
    update(f.id, { status: 'removed' });
    return { ok: true };
  });
  on('POST', '/api/friends/:id/accept', ({ params }) => {
    const f = get(params[0]);
    if (f.status !== 'pending' || f.direction !== 'in') fail(409, `${f.name} has no request waiting.`);
    return update(f.id, { status: 'active', lastSeen: Date.now() });
  });
  on('POST', '/api/friends/:id/decline', ({ params }) => {
    const f = get(params[0]);
    if (f.status !== 'pending') fail(409, `${f.name} has no request waiting.`);
    update(f.id, { status: 'removed' });
    return { ok: true };
  });
  on('POST', '/api/friends/:id/verify', ({ params, body }) => update(params[0], { verified: body?.verified !== false }));
  on('PUT', '/api/friends/:id/grants', ({ params, body }) => update(params[0], { grants: { receiveShares: body?.receiveShares !== false } }));
  on('POST', '/api/friends/:id/confirm-key', async ({ params }) => {
    const f = get(params[0]);
    if (f.status !== 'blocked' || !f.pendingFingerprint) fail(409, `${f.name} has no new key waiting.`);
    await sleep(500);
    const fp = f.pendingFingerprint!;
    return update(f.id, { status: 'active', fingerprint: fp, pendingFingerprint: undefined, blockedReason: undefined, verified: false, lastSeen: Date.now(), safetyCode: '27716 03948 61205 99430' });
  });
  on('POST', '/api/friends/:id/sync', async ({ params }) => {
    const f = get(params[0]);
    await sleep(900);
    // Ben's hub sleeps while he travels
    if (f.lastError) return update(f.id, {});
    for (const o of outbox) if (o.friendId === f.id && o.state === 'queued') Object.assign(o, { state: 'delivered', deliveredAt: Date.now(), via: 'push', nextTry: undefined });
    return update(f.id, { lastSeen: Date.now() });
  });
  on('POST', '/api/friends/:id/notes', ({ params, body }) => {
    const f = get(params[0]);
    if (f.status === 'pending') fail(409, f.direction === 'out' ? `${f.name} has not accepted yet.` : `Accept ${f.name}'s request first.`);
    if (f.status === 'blocked') fail(409, `${f.name}'s hub has a new key. Confirm it in Friends first.`);
    if (f.status === 'removed') fail(409, `You are not friends with ${f.name} any more.`);
    const text = String(body?.text ?? '');
    if (!text.trim()) fail(400, 'text is required');
    const o: OutboxItemDto = { id: msgId(), friendId: f.id, type: 'note', state: 'queued', attempts: 0, nextTry: Date.now(), createdAt: Date.now(), preview: `note: ${text.replace(/\s+/g, ' ').trim().slice(0, 79)}${text.length > 80 ? '…' : ''}`, text };
    outbox.push(o);
    update(f.id, {});
    setTimeout(() => {
      if (o.state !== 'queued') return;
      if (f.lastError) {
        Object.assign(o, { attempts: 1, nextTry: Date.now() + 30_000, lastError: f.lastError });
        update(f.id, {});
        return;
      }
      Object.assign(o, { state: 'delivered', deliveredAt: Date.now(), via: 'push', nextTry: undefined });
      update(f.id, { lastSeen: Date.now() });
      if (f.id === 'frd_alice') setTimeout(() => receive(f.id, 'Got it. Friday at 12:30 then.'), 5_000);
    }, 900);
    return structuredClone(o);
  });

  // shares to and from these friends
  const host: FriendsMock = { friend: (id) => friends.get(id), emitFriend: (id) => void update(id, {}), markOf };
  const shares = registerShares(ctx, host);
  unreadShares = shares.unread;
}
