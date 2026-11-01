/** Shared chats serialize turns, but every runner keeps its starter's account and private state. */
import type { Engine } from '../engine/engine';
import type { SendInput } from '../client';
import { shownName } from '../client/people';
import type { Message } from '../types';
import { OWNER_ID } from './context';
import { PeopleError } from './store';
import { ChatParticipantStore, messageAccount } from './shared-chats';

export class SharedChatTurns {
  private readonly tail = new Map<string, Promise<void>>();
  private readonly running = new Map<string, { accountId: string; seatId: string }>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly engine: Engine) {}

  turn(chatId: string, accountId: string, input: SendInput): Promise<void> {
    const store = new ChatParticipantStore(this.engine.repos.db);
    store.require(chatId, accountId, true);
    const key = `${chatId}:${accountId}`;
    const epoch = this.epochs.get(key) ?? 0;
    const job = (this.tail.get(chatId) ?? Promise.resolve()).then(async () => {
      if ((this.epochs.get(key) ?? 0) !== epoch) return;
      // Recheck after waiting: removal, demotion and history changes take effect before inference.
      let p;
      try { p = store.require(chatId, accountId, true); } catch { return; }
      const seatId = p?.seatId ?? chatId;
      const seat = this.engine.requireSession(seatId);
      if (p && (seat.accountId !== accountId || seat.kind !== 'chat' || (seat.meta?.seat as { chatId?: string })?.chatId !== chatId)) throw new PeopleError(400, 'Invalid seat session.');
      // An owner's turn already running when the first person joined must finish first.
      await this.engine.runnerFor(chatId).waitIdle();
      if ((this.epochs.get(key) ?? 0) !== epoch) return;
      store.require(chatId, accountId, true);
      if (p) this.engine.updateSession(seatId, { chat: { ...seat.chat, memory: p.useMyMemory } });
      const runner = this.engine.runnerFor(seatId);
      this.running.set(chatId, { accountId, seatId });
      try {
        await runner.enqueue({ ...input, mode: p ? 'agent' : input.mode, whenBusy: 'queue' });
        await runner.waitIdle();
        // A parked seat cannot resume outside this chat's FIFO queue.
        if (p && this.engine.getSession(seatId)?.status === 'waiting_reset') {
          this.engine.scheduler.cancel(`resume:${seatId}`);
          this.engine.setStatus(seatId, 'error', 'Your plan reached its limit. Send again when it resets.');
        }
      } finally {
        this.running.delete(chatId);
      }
    });
    // One failed turn must not poison the next person's turn or create an unhandled rejection.
    const tail = job.catch(() => {});
    this.tail.set(chatId, tail);
    void tail.then(() => { if (this.tail.get(chatId) === tail) this.tail.delete(chatId); });
    return job;
  }

  stop(chatId: string, caller: string): void {
    const store = new ChatParticipantStore(this.engine.repos.db);
    store.require(chatId, caller);
    const owner = this.engine.sessionAccount(chatId) ?? OWNER_ID;
    const running = this.running.get(chatId);
    if (caller !== owner && running?.accountId !== caller) throw new PeopleError(403, 'You can stop only your own running turn.');
    if (running) this.engine.abort(running.seatId);
    else if (caller === owner) this.engine.abort(chatId);
  }

  /** Access changes cancel pending work and abort active inference before the route acknowledges them. */
  revoke(chatId: string, accountId: string): void {
    const key = `${chatId}:${accountId}`;
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    const running = this.running.get(chatId);
    if (running?.accountId === accountId) this.engine.abort(running.seatId);
    const seat = new ChatParticipantStore(this.engine.repos.db).get(chatId, accountId)?.seatId;
    if (seat) this.engine.scheduler.cancel(`resume:${seat}`);
  }

  /**
   * History went from all to joined: the seat's own summaries may describe
   * messages it can no longer read, so they go, and a running turn of theirs
   * that already holds that context stops. A queued turn reads the new view.
   */
  historyNarrowed(chatId: string, accountId: string): void {
    const seat = new ChatParticipantStore(this.engine.repos.db).get(chatId, accountId)?.seatId;
    if (!seat) return;
    const running = this.running.get(chatId);
    if (running?.accountId === accountId) this.engine.abort(running.seatId);
    for (const m of this.engine.repos.messages.list(seat)) if (m.kind === 'summary') this.engine.repos.messages.delete(m.id);
  }

  /** A seat, or a chat that has (or had) other people in it: its turns read through messages() below. */
  shared(sessionId: string): boolean {
    const session = this.engine.requireSession(sessionId);
    if ((session.meta?.seat as { chatId?: string } | undefined)?.chatId) return true;
    // any row, left or removed too: their messages stay in the chat and must still reach the owner's turns as quoted data
    return session.kind === 'chat' && !!this.engine.repos.db.query('SELECT 1 FROM chat_participants WHERE session_id = ? LIMIT 1').get(sessionId);
  }

  /** No transcript copies: each inference reads the shared chat through the starter's current visibility. */
  messages(sessionId: string): Message[] {
    const engine = this.engine;
    if (!this.shared(sessionId)) return engine.repos.messages.list(sessionId);
    const session = engine.requireSession(sessionId);
    const chatId = (session.meta?.seat as { chatId?: string } | undefined)?.chatId;
    const transcriptId = chatId ?? sessionId;
    const accountId = session.accountId ?? OWNER_ID;
    const store = new ChatParticipantStore(engine.repos.db);
    // a read, not a post: a turn already running when its starter was demoted still reads what it may
    store.require(transcriptId, accountId);
    const owner = engine.sessionAccount(transcriptId) ?? OWNER_ID;
    const shared = store.visible(transcriptId, accountId, engine.repos.messages.list(transcriptId)).map((m) => {
      if (messageAccount(m, owner) === accountId) return m;
      return { ...m, meta: { quoted: { from: m.author ?? 'another chat participant', fingerprint: '', shareId: transcriptId, role: m.role, kind: m.kind, author: m.author } } };
    });
    // Compaction belongs to this seat only; a narrower history drops it (historyNarrowed).
    return [...shared, ...(chatId ? engine.repos.messages.list(sessionId) : [])].sort((a, b) => a.seq - b.seq);
  }

  /** Only normal conversation messages cross the seat boundary. Notices and summaries remain private. */
  destination(sessionId: string, message: Pick<Message, 'kind'>): { sessionId: string; sender?: string; author?: string } {
    const seat = this.engine.getSession(sessionId);
    const chatId = (seat?.meta?.seat as { chatId?: string } | undefined)?.chatId;
    if (!chatId || message.kind !== 'normal') return { sessionId };
    const accountId = seat!.accountId ?? OWNER_ID;
    new ChatParticipantStore(this.engine.repos.db).require(chatId, accountId, true);
    const person = this.engine.people.get(accountId);
    return { sessionId: chatId, sender: `account:${accountId}`, author: person ? shownName(person) ?? 'Member' : 'Member' };
  }
}
