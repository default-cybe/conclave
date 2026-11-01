/**
 * Shared chats, runtime access (docs/design/SHARED-WITH-MEMBERS.md 6). The
 * membership table drives everything: invites wait for Accept, the owner
 * changes role or history and removes people, anyone but the owner can leave.
 * Every read goes through ChatParticipantStore.require()/visible(), so a
 * stranger and a removed person read the same 404 as for an unknown chat.
 *
 *   GET    /api/chats/invites                     chats you were invited to (no transcript)
 *   GET    /api/chats/shared                      chats you are in, owned by someone else
 *   POST   /api/chats/invites/:id/accept          join; a Participant gets their own seat session
 *   POST   /api/chats/invites/:id/decline
 *   GET    /api/sessions/:id/participants         the chat's people (shown names only)
 *   POST   /api/sessions/:id/participants         (owner) invite a contact by party
 *   PATCH  /api/sessions/:id/participants/:pid    (owner) change access or history
 *   DELETE /api/sessions/:id/participants/:pid    (owner) remove
 *   POST   /api/sessions/:id/leave                a participant leaves; messages stay
 */
import type { Hono } from 'hono';
import type { ChatAccess, ChatHistory, ChatParticipant } from '@conclave/core/people/shared-chats.ts';
import { PeopleError } from '@conclave/core/people/store.ts';
import { shownName } from '@conclave/core/client/people.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, auditFor, badRequest, readJson } from './http';
import { accountOf } from './scope';
import { chatParticipants } from './route-policy';

function peopleError(err: unknown): never {
  if (err instanceof PeopleError) throw new HttpError(err.status, err.message);
  throw err;
}

/** Push a notice to one account only (the bus stamps it with that account, so nobody else's socket gets it). */
function notify(ctx: ServerContext, accountId: string, title: string, link?: string): void {
  void ctx.engine.notifier.send({ accountId, title, body: '', level: 'info', ...(link ? { link } : {}) });
}

export function registerSharedChatRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;
  const audit = auditFor(engine);
  const nameOf = (accountId: string): string => {
    const a = engine.people.get(accountId);
    return a ? (shownName(a) ?? 'Member') : 'Member';
  };
  /** No transcript, no message text: an invite carries the chat's name and who added you, nothing else. */
  const inviteCard = (p: ChatParticipant) => {
    const s = engine.getSession(p.sessionId);
    return {
      chatId: p.sessionId,
      title: s?.title ?? 'Chat',
      owner: nameOf(engine.sessionAccount(p.sessionId) ?? 'owner'),
      access: p.access,
      history: p.history,
      invitedAt: p.addedAt,
    };
  };

  app.get('/api/chats/invites', (c) => c.json(chatParticipants(ctx).forAccount(accountOf(c)).filter((p) => p.state === 'invited').map(inviteCard)));

  app.get('/api/chats/shared', (c) => c.json(chatParticipants(ctx).forAccount(accountOf(c)).filter((p) => p.state === 'active').map(inviteCard)));

  app.post('/api/chats/invites/:id/accept', async (c) => {
    const chatId = c.req.param('id');
    const caller = accountOf(c);
    const store = chatParticipants(ctx);
    let seatSession;
    if (store.get(chatId, caller)?.access === 'participant') {
      // the seat is the participant's own chat session, memory off, pointed at the shared chat; their turns will run in it
      const chat = engine.getSession(chatId);
      const s = await engine.createSession({ kind: 'chat', title: chat?.title ?? 'Chat', chat: { memory: false } }, caller, { byPerson: true });
      seatSession = { ...s, meta: { ...s.meta, seat: { chatId } } };
      engine.repos.sessions.update(seatSession);
    }
    let p: ChatParticipant;
    try {
      p = store.accept(chatId, caller, seatSession);
    } catch (err) {
      peopleError(err);
    }
    notify(ctx, engine.sessionAccount(chatId) ?? 'owner', `${nameOf(caller)} accepted your invite to "${engine.getSession(chatId)?.title ?? 'Chat'}".`);
    audit(c, 'chat.join', `${nameOf(caller)} joined ${chatId}`);
    return c.json(p);
  });

  app.post('/api/chats/invites/:id/decline', (c) => {
    const chatId = c.req.param('id');
    try {
      chatParticipants(ctx).decline(chatId, accountOf(c));
    } catch (err) {
      peopleError(err);
    }
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id/participants', (c) => {
    const chatId = c.req.param('id');
    const caller = accountOf(c);
    let rows: ChatParticipant[];
    try {
      rows = chatParticipants(ctx).list(chatId, caller);
    } catch (err) {
      peopleError(err);
    }
    // shown names only: a member's sign-in name and email never cross accounts
    return c.json(rows.map((p) => ({ accountId: p.accountId, name: nameOf(p.accountId), access: p.access, state: p.state, history: p.history, ...(p.seatId ? { seatId: p.seatId } : {}), addedAt: p.addedAt })));
  });

  app.post('/api/sessions/:id/participants', async (c) => {
    const chatId = c.req.param('id');
    const caller = accountOf(c);
    const body = await readJson<{ party?: unknown; access?: unknown; history?: unknown }>(c);
    if (typeof body.party !== 'string' || !body.party.startsWith('account:')) throw badRequest('party must be a contact, like account:<id>.');
    // friends join chats in phase 3 (SHARED-WITH-MEMBERS.md 8); a friend: party is refused here
    const accountId = body.party.slice('account:'.length);
    let p: ChatParticipant;
    try {
      p = chatParticipants(ctx).invite(chatId, caller, accountId, { access: body.access as ChatAccess | undefined, history: body.history as ChatHistory | undefined });
    } catch (err) {
      peopleError(err);
    }
    notify(ctx, accountId, `${nameOf(caller)} added you to "${engine.getSession(chatId)?.title ?? 'Chat'}" as a ${p.access === 'viewer' ? 'Viewer' : 'Participant'}.`, `/s/${chatId}`);
    audit(c, 'chat.invite', `${body.party} to ${chatId} as ${p.access}`);
    return c.json(p);
  });

  app.patch('/api/sessions/:id/participants/:pid', async (c) => {
    const chatId = c.req.param('id');
    const caller = accountOf(c);
    const body = await readJson<{ access?: unknown; history?: unknown }>(c);
    const store = chatParticipants(ctx);
    // promotion needs a seat of their own first (shared-chats.ts change()); the service makes it here
    if (body.access === 'participant') {
      const now = store.get(chatId, c.req.param('pid'));
      if (now?.state === 'active' && !now.seatId) {
        const s = await engine.createSession({ kind: 'chat', title: engine.getSession(chatId)?.title ?? 'Chat', chat: { memory: false } }, c.req.param('pid'), { byPerson: true });
        engine.repos.sessions.update({ ...s, meta: { ...s.meta, seat: { chatId } } });
        store.setSeat(chatId, c.req.param('pid'), s.id);
      }
    }
    let p: ChatParticipant;
    try {
      p = store.change(chatId, caller, c.req.param('pid'), { access: body.access as ChatAccess | undefined, history: body.history as ChatHistory | undefined });
    } catch (err) {
      peopleError(err);
    }
    // a role that no longer allows turns ends theirs before the change is acknowledged; a history change alone keeps a queued turn
    if (p.access !== 'participant') engine.revokeChatTurns(chatId, c.req.param('pid'));
    audit(c, 'chat.access', `${c.req.param('pid')} in ${chatId}: ${p.access}/${p.history}`);
    return c.json(p);
  });

  app.delete('/api/sessions/:id/participants/:pid', (c) => {
    const chatId = c.req.param('id');
    let p: ChatParticipant;
    try {
      p = chatParticipants(ctx).remove(chatId, accountOf(c), c.req.param('pid'));
    } catch (err) {
      peopleError(err);
    }
    // their running turn, if any, stops with their access
    engine.revokeChatTurns(chatId, c.req.param('pid'));
    notify(ctx, p.accountId, `${nameOf(accountOf(c))} took you out of "${engine.getSession(chatId)?.title ?? 'Chat'}".`);
    audit(c, 'chat.remove', `${c.req.param('pid')} from ${chatId}`);
    return c.json(p);
  });

  app.post('/api/sessions/:id/leave', (c) => {
    const chatId = c.req.param('id');
    let p: ChatParticipant;
    const caller = accountOf(c);
    try {
      p = chatParticipants(ctx).leave(chatId, caller);
    } catch (err) {
      peopleError(err);
    }
    engine.revokeChatTurns(chatId, caller);
    return c.json(p);
  });
}
