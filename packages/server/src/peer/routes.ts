/**
 * Friends over HTTP (docs/design/FRIENDS.md).
 *
 *   /peer/v1/*      other hubs. No bearer token: each request is checked by
 *                   the peer verifier (service.ts verify) against a friend's
 *                   key, or by an invite for friend-request. app.ts keeps
 *                   these out of Auth.check.
 *   /api/friends/*  the owner's apps, with the usual token.
 *   /api/shares/*   shares to and from friends, for the owner's apps too.
 */
import type { Context, Hono } from 'hono';
import type { ForkShareInput, HandoffShareInput, SendShareInput, ShareContentOptions } from '@conclave/core/client/friends.ts';
import type { HonoEnv, ServerContext } from '../context';
import { RateLimiter } from '../auth';
import { BodyTooLarge, HttpError, actorOf, auditFor, badRequest, clientIp, isDirectLocal, optBool, optString, readCapped, readJson, requireString } from '../http';
import { INBOX_MAX_BYTES, PeerRefusal } from './service';
import type { IncomingRequest } from './signing';
import { ULID } from './ulid';

const ok = { ok: true as const };
/** Largest POST /peer/v1/friend-request body. */
const FRIEND_REQUEST_MAX_BYTES = 64 * 1024;

/**
 * The request as the verifier needs it, with the body read up to `max`
 * bytes. These routes take requests from anyone before a key is checked, so
 * a body with no Content-Length (chunked) is cut off at `max` too instead of
 * being read whole first.
 */
async function incoming(c: Context, max: number): Promise<IncomingRequest> {
  const tooLarge = () => new PeerRefusal(413, 'too-large', `A message is ${Math.round(max / 1024)} KB at most.`);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > max) throw tooLarge();
  let body: Uint8Array;
  try {
    body = await readCapped(c.req.raw.body, max);
  } catch (err) {
    if (err instanceof BodyTooLarge) throw tooLarge();
    throw err;
  }
  return { method: c.req.method, url: c.req.url, headers: c.req.raw.headers, body };
}

function refused(c: Context, err: unknown): Response {
  if (err instanceof PeerRefusal) return c.json({ error: err.message, code: err.code }, err.status as 400);
  throw err;
}

export function registerPeerRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const audit = auditFor(ctx.engine);
  /** Friend requests per address: 10 a minute. */
  const requests = new RateLimiter(10, 60_000);

  app.post('/peer/v1/friend-request', async (c) => {
    const ip = clientIp(c);
    const local = isDirectLocal(c);
    if (!local) {
      if (!requests.hit(ip)) {
        const wait = requests.retryAfterSec(ip);
        return c.json({ error: `Too many friend requests from this address. Try again in ${wait} seconds.`, code: 'rate' }, 429, { 'retry-after': String(wait) });
      }
      const wait = ctx.pairGuard.blocked(ip);
      if (wait) return c.json({ error: `Too many wrong invites from this address. Try again in ${wait} seconds.`, code: 'rate' }, 429, { 'retry-after': String(wait) });
    }
    try {
      // a request holds a name, a key and an address record: 64 KB is plenty (16 KB for one by address)
      const { status } = await ctx.peer.friendRequest(await incoming(c, FRIEND_REQUEST_MAX_BYTES), { ip, local });
      return c.json({ status }, status === 'pending' ? 202 : 200);
    } catch (err) {
      if (err instanceof PeerRefusal && err.code === 'invite') {
        audit(c, 'friend.request.refused', 'wrong, used or expired invite');
        const block = local ? 0 : ctx.pairGuard.fail(ip, Date.now());
        if (block) audit(c, 'friend.request.blocked', `${ip} for ${block}s after repeated wrong invites`);
      }
      return refused(c, err);
    }
  });

  app.put('/peer/v1/inbox/:msgId', async (c) => {
    try {
      const id = c.req.param('msgId');
      if (!ULID.test(id)) throw new PeerRefusal(400, 'id', 'A message id is a ULID.');
      const req = await incoming(c, INBOX_MAX_BYTES);
      const friend = ctx.peer.verify(req, ['pending', 'active']);
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(req.body).toString('utf8'));
      } catch {
        throw new PeerRefusal(400, 'malformed', 'The body is not JSON.');
      }
      if ((raw as { id?: unknown })?.id !== id) throw new PeerRefusal(400, 'id', 'The path and the message id differ.');
      const result = await ctx.peer.receive(friend, raw, 'push');
      return c.json({ ok: true, duplicate: result === 'duplicate' }, result === 'duplicate' ? 200 : 202);
    } catch (err) {
      return refused(c, err);
    }
  });

  /**
   * The pull path: messages waiting for the caller. ?ack= lists ids from the
   * last page it took, and ?refused= the ones of those it refused, each as
   * <id>.<code>. A removed friend may still fetch the one message that tells
   * it so (friend.remove), and nothing else.
   */
  app.get('/peer/v1/outbox', async (c) => {
    try {
      const friend = ctx.peer.verify(await incoming(c, 1024), ['pending', 'active', 'removed']);
      const ack = (c.req.query('ack') ?? '').split(',').filter(Boolean);
      const refused = (c.req.query('refused') ?? '').split(',').filter(Boolean);
      return c.json(ctx.peer.outboxFor(friend, ack, refused), 200, { 'cache-control': 'no-store' });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.get('/peer/v1/blobs/:sha256', async (c) => {
    try {
      const friend = ctx.peer.verify(await incoming(c, 1024), ['active']);
      const bytes = ctx.peer.blobFor(friend, c.req.param('sha256'));
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.get('/peer/v1/addresses', async (c) => {
    try {
      const friend = ctx.peer.verify(await incoming(c, 1024), ['pending', 'active']);
      // a hub whose request waits for the owner learns nothing more of this hub (every address it has) until the owner accepts
      if (friend.status === 'pending' && friend.direction === 'in') throw new PeerRefusal(403, 'not-yet', 'Not until the friend request is accepted.');
      return c.json(ctx.peer.record(), 200, { 'cache-control': 'no-store' });
    } catch (err) {
      return refused(c, err);
    }
  });
}

/** The review's choices from a request body: what goes in a share. */
function contentOptions(body: Record<string, unknown>): ShareContentOptions {
  const pick = <T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || !allowed.includes(v as T)) throw badRequest(`${name} must be one of ${allowed.join(', ')}`);
    return v as T;
  };
  let keep: string[] | undefined;
  if (body.keep !== undefined) {
    if (!Array.isArray(body.keep) || body.keep.length > 2000 || body.keep.some((k) => typeof k !== 'string' || k.length > 64)) throw badRequest('keep must be a list of item ids');
    keep = body.keep as string[];
  }
  const thinking = optBool(body.thinking, 'thinking');
  const attachments = optBool(body.attachments, 'attachments');
  const toolOutput = pick(body.toolOutput, 'toolOutput', ['full', 'summary', 'none'] as const);
  const code = pick(body.code, 'code', ['none', 'diff', 'git-bundle'] as const);
  const upTo = optString(body.upTo, 'upTo', 100);
  return { ...(thinking !== undefined ? { thinking } : {}), ...(attachments !== undefined ? { attachments } : {}), ...(toolOutput ? { toolOutput } : {}), ...(code ? { code } : {}), ...(upTo ? { upTo } : {}), ...(keep ? { keep } : {}) };
}

/**
 * Shares to and from friends (phases 2 and 3), for the owner's apps:
 *
 *   POST   /api/shares/preview            the review: what goes, what the sanitizer found
 *   POST   /api/shares                    send to friends
 *   GET    /api/shares/sent[/:id]         what this hub sent
 *   POST   /api/shares/sent/:id/update    a new revision
 *   DELETE /api/shares/sent/:id           unsend
 *   GET    /api/shares/received[/:id]     what friends sent (the Inbox cards)
 *   POST   /api/shares/received/:id/accept|decline
 *   GET    /api/shares/received/:id/view  read only, quoted
 *   POST   /api/shares/received/:id/fork|reference
 *   GET    /api/shares/received/:id/handoff   the brief to edit
 *   POST   /api/shares/received/:id/handoff   start the session from it
 *   POST   /api/shares/received/:id/apply-plan, /apply   code onto a new branch, approved
 */
export function registerShareRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const shares = ctx.peer.shares;
  const id = (c: Context) => c.req.param('id') ?? '';

  app.post('/api/shares/preview', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await shares.preview({ sessionId: requireString(body.sessionId, 'sessionId'), ...contentOptions(body) }));
  });
  app.post('/api/shares', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const input: SendShareInput = {
      sessionId: requireString(body.sessionId, 'sessionId'),
      to: body.to as string[],
      ...contentOptions(body),
      ...(body.title !== undefined ? { title: optString(body.title, 'title', 1000) } : {}),
      ...(body.note !== undefined ? { note: optString(body.note, 'note', 10_000) } : {}),
    };
    return c.json(await shares.send(input, actorOf(c)));
  });

  app.get('/api/shares/sent', (c) => c.json(shares.sent()));
  app.get('/api/shares/sent/:id', (c) => c.json(shares.sentOne(id(c))));
  app.post('/api/shares/sent/:id/update', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await shares.update(id(c), { ...contentOptions(body), ...(body.title !== undefined ? { title: optString(body.title, 'title', 1000) } : {}), ...(body.note !== undefined ? { note: optString(body.note, 'note', 10_000) ?? '' } : {}) }, actorOf(c)));
  });
  app.delete('/api/shares/sent/:id', (c) => c.json(shares.unsend(id(c), actorOf(c))));

  app.get('/api/shares/received', (c) => c.json(shares.received()));
  app.get('/api/shares/received/:id', (c) => c.json(shares.receivedOne(id(c))));
  app.post('/api/shares/received/:id/accept', async (c) => c.json(await shares.accept(id(c), actorOf(c))));
  app.post('/api/shares/received/:id/decline', (c) => c.json(shares.decline(id(c), actorOf(c))));
  app.get('/api/shares/received/:id/view', (c) => c.json(shares.view(id(c))));
  app.post('/api/shares/received/:id/fork', async (c) => {
    const body = await readJson<ForkShareInput>(c);
    if (body.kind !== undefined && body.kind !== 'chat' && body.kind !== 'agent') throw badRequest('kind must be chat or agent');
    return c.json(await shares.fork(id(c), { ...body, title: optString(body.title, 'title', 1000), prompt: optString(body.prompt, 'prompt', 100_000) }, actorOf(c)));
  });
  app.get('/api/shares/received/:id/handoff', (c) => c.json(shares.handoffDraft(id(c))));
  app.post('/api/shares/received/:id/handoff', async (c) => {
    const body = await readJson<HandoffShareInput>(c);
    return c.json(await shares.handoff(id(c), { ...body, brief: requireString(body.brief, 'brief'), title: optString(body.title, 'title', 1000) }, actorOf(c)));
  });
  app.post('/api/shares/received/:id/reference', async (c) => c.json(await shares.reference(id(c), actorOf(c))));
  app.post('/api/shares/received/:id/apply-plan', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await shares.planApply(id(c), { device: requireString(body.device, 'device'), cwd: requireString(body.cwd, 'cwd'), ...(body.branch !== undefined ? { branch: optString(body.branch, 'branch', 200) } : {}) }));
  });
  app.post('/api/shares/received/:id/apply', async (c) => {
    const body = await readJson<{ planId?: unknown }>(c);
    return c.json(await shares.apply(id(c), requireString(body.planId, 'planId'), actorOf(c)));
  });
}

export function registerFriendRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const peer = ctx.peer;
  const id = (c: Context) => c.req.param('id') ?? '';
  const msgId = (c: Context) => c.req.param('msgId') ?? '';

  // fixed paths before /api/friends/:id
  app.get('/api/friends', (c) => c.json(peer.list()));
  app.get('/api/friends/reachability', (c) => c.json(peer.reachability()));
  app.get('/api/friends/outbox', (c) => c.json(peer.outbox(c.req.query('friend') || undefined)));
  app.get('/api/friends/inbox', (c) => c.json(peer.inbox(c.req.query('friend') || undefined)));

  app.post('/api/friends/invites', async (c) => {
    const body = await readJson<{ includeLan?: unknown; name?: unknown }>(c);
    return c.json(await peer.createInvite({ includeLan: optBool(body.includeLan, 'includeLan'), name: optString(body.name, 'name', 60) }, actorOf(c)));
  });

  app.post('/api/friends/accept', async (c) => {
    const body = await readJson<{ link?: unknown; name?: unknown }>(c);
    return c.json(await peer.acceptInvite(requireString(body.link, 'link'), optString(body.name, 'name', 60), actorOf(c)));
  });

  // add a friend by their hub's address; an invite by email as the way round
  app.post('/api/friends/add', async (c) => {
    const body = await readJson<{ address?: unknown; email?: unknown; name?: unknown }>(c);
    return c.json(await peer.addByAddress({ address: requireString(body.address, 'address'), email: optString(body.email, 'email', 254), name: optString(body.name, 'name', 60) }, actorOf(c)));
  });
  app.post('/api/friends/mail-invite', async (c) => {
    const body = await readJson<{ email?: unknown }>(c);
    return c.json(await peer.mailInvite(requireString(body.email, 'email'), actorOf(c)));
  });
  app.get('/api/friends/settings', (c) => c.json(peer.settings()));
  app.put('/api/friends/settings', async (c) => {
    const body = await readJson<{ requestsByAddress?: unknown }>(c);
    return c.json(peer.setSettings({ requestsByAddress: optBool(body.requestsByAddress, 'requestsByAddress') }, actorOf(c)));
  });
  app.delete('/api/friends/blocked/:fp', (c) => c.json(peer.unblock(c.req.param('fp') ?? '', actorOf(c))));

  app.post('/api/friends/outbox/:msgId/retry', (c) => c.json(peer.retry(msgId(c), actorOf(c))));
  app.delete('/api/friends/outbox/:msgId', (c) => c.json(peer.cancel(msgId(c), actorOf(c))));

  app.get('/api/friends/:id', (c) => c.json(peer.get(id(c))));
  app.patch('/api/friends/:id', async (c) => {
    const body = await readJson<{ name?: unknown; email?: unknown }>(c);
    if (body.email === undefined) return c.json(peer.rename(id(c), requireString(body.name, 'name'), actorOf(c)));
    return c.json(peer.updateFriend(id(c), { name: optString(body.name, 'name', 60), email: optString(body.email, 'email', 254) ?? '' }, actorOf(c)));
  });
  app.post('/api/friends/:id/block', (c) => c.json(peer.block(id(c), actorOf(c))));
  app.delete('/api/friends/:id', (c) => {
    peer.remove(id(c), actorOf(c));
    return c.json(ok);
  });
  app.post('/api/friends/:id/accept', (c) => c.json(peer.accept(id(c), actorOf(c))));
  app.post('/api/friends/:id/decline', (c) => {
    peer.decline(id(c), actorOf(c));
    return c.json(ok);
  });
  app.post('/api/friends/:id/verify', async (c) => {
    const body = await readJson<{ verified?: unknown }>(c);
    return c.json(peer.markVerified(id(c), optBool(body.verified, 'verified') ?? true, actorOf(c)));
  });
  app.put('/api/friends/:id/grants', async (c) => {
    const body = await readJson<{ receiveShares?: unknown }>(c);
    const receiveShares = optBool(body.receiveShares, 'receiveShares');
    peer.get(id(c));
    if (receiveShares === undefined) throw badRequest('receiveShares must be true or false');
    return c.json(peer.setGrants(id(c), { receiveShares }, actorOf(c)));
  });
  app.post('/api/friends/:id/confirm-key', async (c) => c.json(await peer.confirmKey(id(c), actorOf(c))));
  app.post('/api/friends/:id/sync', async (c) => c.json(await peer.sync(id(c))));
  app.post('/api/friends/:id/read', async (c) => {
    const body = await readJson<{ upTo?: unknown }>(c);
    return c.json(peer.markRead(id(c), optString(body.upTo, 'upTo', 100)));
  });
  app.post('/api/friends/:id/notes', async (c) => {
    const body = await readJson<{ text?: unknown }>(c);
    peer.get(id(c));
    if (body.text === undefined) throw new HttpError(400, 'text is required');
    return c.json(peer.sendNote(id(c), body.text, actorOf(c)));
  });
}
