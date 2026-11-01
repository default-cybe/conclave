/**
 * Shared chats in the mock app (docs/design/SHARED-WITH-MEMBERS.md 6): a chat
 * Nihir owns and you are in, an invite to another of his chats, and your own
 * chat shared with Nihir and Mira. The hub's seatView shapes what you read of
 * other people's turns: text and one-line "[Called X]" tool summaries, never
 * their tool output. The seeds are stored already shaped for the owner's view.
 */
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import type { ChatParticipantDto, ChatInviteCard } from '@conclave/core/client';
import type { MockCtx } from './index';

const MIN = 60_000;
const HOUR = 60 * MIN;
const GLM = 'zai/glm-5';
const SONNET = 'anthropic/claude-sonnet-5-5';

const ME = 'owner';
const NAMES: Record<string, string> = { owner: 'Kai', acc_nihir: 'Nihir', acc_mira: 'Mira' };

interface Row extends ChatParticipantDto {
  chatId: string;
}
interface Card extends ChatInviteCard {}

export function registerSharedChats(ctx: MockCtx) {
  const { db, emit, uid, sleep } = ctx;
  const now = Date.now();
  const at = (ago: number) => now - ago;

  const rows = new Map<string, Row>();
  const add = (r: Omit<Row, 'name'>) => rows.set(`${r.chatId}:${r.accountId}`, { ...r, name: NAMES[r.accountId] ?? r.accountId });
  const invites = new Map<string, Card>();
  const card = (c: Card, invited = true) => {
    if (invited) invites.set(c.chatId, c);
    else invites.delete(c.chatId);
  };

  const msg = (sessionId: string, seq: number, role: 'user' | 'assistant', content: ContentBlock[], o: Partial<Message> = {}): Message => ({
    id: uid('m'),
    sessionId,
    seq,
    role,
    kind: 'normal',
    content,
    createdAt: at((20 - seq) * 3 * MIN),
    ...o,
  });
  const t = (text: string): ContentBlock => ({ type: 'text', text });

  // Nihir's chat you are in. His turn is shaped as you read it: text and a one-line tool summary, "via" his model.
  const trip: Session = {
    id: 'c_trip',
    accountId: 'acc_nihir',
    title: 'Lisbon weekend',
    agent: 'chat',
    model: GLM,
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: at(2 * HOUR),
    updatedAt: at(12 * MIN),
    stats: { messages: 5, inputTokens: 9_400, outputTokens: 1_020, cacheReadTokens: 6_200, costUsd: 0.03 },
  };
  add({ chatId: 'c_trip', accountId: ME, access: 'participant', state: 'active', history: 'all', addedAt: at(90 * MIN), seatId: 'seat_kai_trip' });
  add({ chatId: 'c_trip', accountId: 'acc_mira', access: 'participant', state: 'active', history: 'joined', addedAt: at(30 * MIN) });

  // your own chat, shared: Nihir writes and his turns run on his account, Mira waits on the invite
  const secu: Session = {
    id: 'c_secu',
    title: 'SECU2002 study group',
    agent: 'chat',
    model: SONNET,
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: at(3 * HOUR),
    updatedAt: at(20 * MIN),
    stats: { messages: 4, inputTokens: 7_100, outputTokens: 860, cacheReadTokens: 4_400, costUsd: 0.02 },
    chat: { webSearch: true, memory: true },
  };
  add({ chatId: 'c_secu', accountId: 'acc_nihir', access: 'participant', state: 'active', history: 'joined', addedAt: at(80 * MIN), seatId: 'seat_nihir_secu' });
  add({ chatId: 'c_secu', accountId: 'acc_mira', access: 'viewer', state: 'invited', history: 'joined', addedAt: at(4 * MIN) });

  // an invite to a third chat of Nihir's
  card({ chatId: 'c_homeserver', title: 'Homelab upgrade plan', owner: 'Nihir', access: 'participant', history: 'joined', invitedAt: at(9 * MIN) });
  add({ chatId: 'c_homeserver', accountId: ME, access: 'participant', state: 'invited', history: 'joined', addedAt: at(9 * MIN) });

  if (!ctx.FRESH) {
    db.sessions.set('c_trip', trip);
    db.messages.set('c_trip', [
      msg('c_trip', 1, 'user', [t('Three days in Lisbon in April: what should we not miss?')], { sender: 'account:acc_nihir', author: 'Nihir' }),
      msg('c_trip', 2, 'assistant', [t('[Called WebSearch]')], { sender: 'account:acc_nihir', author: 'Nihir', model: GLM, kind: 'aside' }),
      msg('c_trip', 3, 'assistant', [t('Skip Alfama at noon. Take tram 15 to Belém in the morning, then the Gulbenkian after lunch, and keep the evening for the old town once the day-trippers leave.')], { sender: 'account:acc_nihir', author: 'Nihir', model: GLM }),
      msg('c_trip', 4, 'user', [t('Works for me. Mira, does the Saturday flight work?')], { sender: `account:${ME}`, author: 'Kai' }),
    ]);
    db.sessions.set('c_secu', secu);
    db.messages.set('c_secu', [
      msg('c_secu', 1, 'user', [t('For the secure coding review, I want to cover integer overflow with the PDF activity as the example.')], { sender: `account:${ME}` }),
      msg('c_secu', 2, 'user', [t('I can take the CSRF part. I already have slides from last year.')], { sender: 'account:acc_nihir', author: 'Nihir' }),
      msg('c_secu', 3, 'assistant', [t('[Called WebSearch]')], { sender: 'account:acc_nihir', author: 'Nihir', model: GLM, kind: 'aside' }),
      msg('c_secu', 4, 'assistant', [t('CSRF slides are in. The OWASP cheat sheet changed its double-submit guidance this year, so slide 4 needs a re-read before you present it.')], { sender: 'account:acc_nihir', author: 'Nihir', model: GLM }),
    ]);
  }

  const myCards = () =>
    [...rows.values()].filter((r) => r.accountId === ME && r.state === 'active').map((r) => {
      const s = db.sessions.get(r.chatId);
      return { chatId: r.chatId, title: s?.title ?? 'Shared chat', owner: NAMES[s?.accountId as string] ?? 'Nihir', access: r.access, history: r.history, invitedAt: r.addedAt };
    });
  const of = (chatId: string) =>
    [...rows.values()].filter((r) => r.chatId === chatId && r.state !== 'declined').map(({ name: _n, ...r }) => r);

  const { on } = ctx;
  on('GET', '/api/contacts', () => [NAMES.acc_nihir, NAMES.acc_mira].map((name, i) => ({ party: `account:${i === 0 ? 'acc_nihir' : 'acc_mira'}` as const, name })));
  on('GET', '/api/chats/invites', () => [...invites.values()]);
  on('GET', '/api/chats/shared', () => myCards());
  on('GET', '/api/sessions/:id', ({ params }) => db.sessions.get(params[0]) ?? ctx.notFound());
  on('GET', '/api/sessions/:id/participants', ({ params }) => of(params[0]));
  on('POST', '/api/chats/invites/:id/accept', ({ params }) => {
    const key = `${params[0]}:${ME}`;
    const r = rows.get(key);
    if (!r) return ctx.fail(404, 'No such invite');
    r.state = 'active';
    card(invites.get(params[0])!, false);
    return r;
  });
  on('POST', '/api/chats/invites/:id/decline', ({ params }) => {
    const key = `${params[0]}:${ME}`;
    const r = rows.get(key);
    if (!r) return ctx.fail(404, 'No such invite');
    r.state = 'declined';
    card(invites.get(params[0])!, false);
    return { ok: true as const };
  });
  on('POST', '/api/sessions/:id/participants', ({ params, body }) => {
    const accountId = String(body?.party ?? '').replace(/^account:/, '');
    if (!NAMES[accountId]) return ctx.fail(404, 'No such contact');
    const r: Omit<Row, 'name'> = { chatId: params[0], accountId, access: body?.access === 'viewer' ? 'viewer' : 'participant', state: 'invited', history: body?.history === 'all' ? 'all' : 'joined', addedAt: Date.now() };
    add(r);
    return { ...r, name: NAMES[accountId] };
  });
  on('PATCH', '/api/sessions/:id/participants/:pid', ({ params, body }) => {
    const r = rows.get(`${params[0]}:${params[1]}`);
    if (!r) return ctx.fail(404, 'Not in this chat');
    if (body?.access) r.access = body.access === 'viewer' ? 'viewer' : 'participant';
    if (body?.history) r.history = body.history === 'all' ? 'all' : 'joined';
    return r;
  });
  on('DELETE', '/api/sessions/:id/participants/:pid', ({ params }) => {
    const r = rows.get(`${params[0]}:${params[1]}`);
    if (!r) return ctx.fail(404, 'Not in this chat');
    r.state = 'removed';
    return r;
  });
  on('POST', '/api/sessions/:id/leave', ({ params }) => {
    const r = rows.get(`${params[0]}:${ME}`);
    if (!r) return ctx.fail(404, 'Not in this chat');
    r.state = 'left';
    return r;
  });

  // a post in someone else's chat: your message, then your turn on your own account
  on('POST', '/api/sessions/:id/messages', async ({ params, body }) => {
    const mine = rows.get(`${params[0]}:${ME}`);
    if (!mine || db.sessions.get(params[0])?.accountId == null) return ctx.pass;
    if (mine.state !== 'active') return ctx.fail(403, 'You are no longer in this chat.');
    if (mine.access === 'viewer') return ctx.fail(403, 'Read only: the chat owner gave you read access.');
    const list = db.messages.get(params[0]) ?? [];
    const seq = list.length + 1;
    const m = msg(params[0], seq, 'user', [t(String(body?.text ?? ''))], { sender: `account:${ME}`, author: 'Kai', createdAt: Date.now() });
    db.messages.set(params[0], [...list, m]);
    emit({ type: 'message.created', message: structuredClone(m) });
    if (body?.justTalk) return { message: structuredClone(m), queued: false as const };
    const s = db.sessions.get(params[0])!;
    patch({ ...s, status: 'running' });
    await sleep(2_500);
    const a = msg(params[0], seq + 1, 'assistant', [t('On it from my own account. Two options that fit, and one to avoid: the Saturday ferry books out, so lock that first.')], { sender: `account:${ME}`, author: 'Kai', model: s.model, createdAt: Date.now() });
    db.messages.set(params[0], [...(db.messages.get(params[0]) ?? []), a]);
    emit({ type: 'message.created', message: structuredClone(a) });
    patch({ ...s, status: 'idle' });
    return { message: structuredClone(a), queued: false as const };
  });

  function patch(s: Session) {
    db.sessions.set(s.id, { ...s, updatedAt: Date.now() });
    emit({ type: 'session.updated', session: structuredClone(db.sessions.get(s.id)!) });
  }
}
