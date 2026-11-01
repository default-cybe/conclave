/** Local chat membership. Execution remains in each person's own session. */
import type { Db } from '../storage/db';
import type { Message, Session } from '../types';
import { OWNER_ID } from './context';
import { PeopleError } from './store';
import { ensureColumn } from './tables';

export type ChatAccess = 'viewer' | 'participant';
export type ChatHistory = 'joined' | 'all';
export type ParticipantState = 'invited' | 'active' | 'declined' | 'left' | 'removed';

export interface ChatParticipant {
  sessionId: string;
  accountId: string;
  access: ChatAccess;
  state: ParticipantState;
  history: ChatHistory;
  joinedSeq: number;
  seatId?: string;
  readUptoSeq: number;
  muted: boolean;
  useMyMemory: boolean;
  addedBy: string;
  addedAt: number;
  updatedAt: number;
}

/** Additive and idempotent, like the accounts migration; old messages still belong to the session owner. */
export function migrateSharedChats(db: Db): void {
  db.transaction(() => {
    ensureColumn(db, 'messages', 'sender', 'TEXT');
    ensureColumn(db, 'turns', 'started_by', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_participants (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
        friend_id TEXT NOT NULL DEFAULT '' CHECK (friend_id = ''),
        access TEXT NOT NULL CHECK (access IN ('viewer', 'participant')),
        state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'declined', 'left', 'removed')),
        history TEXT NOT NULL DEFAULT 'joined' CHECK (history IN ('joined', 'all')),
        joined_seq INTEGER NOT NULL CHECK (joined_seq >= 1),
        seat_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        read_upto_seq INTEGER NOT NULL DEFAULT 0 CHECK (read_upto_seq >= 0),
        muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
        use_my_memory INTEGER NOT NULL DEFAULT 0 CHECK (use_my_memory IN (0, 1)),
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, account_id, friend_id)
      );
      CREATE INDEX IF NOT EXISTS chat_participants_account ON chat_participants(account_id, state);
      CREATE UNIQUE INDEX IF NOT EXISTS chat_participants_seat ON chat_participants(seat_id) WHERE seat_id IS NOT NULL;
    `);
  })();
}

type Row = Record<string, any>;
const participant = (r: Row): ChatParticipant => ({
  sessionId: r.session_id,
  accountId: r.account_id,
  access: r.access,
  state: r.state,
  history: r.history,
  joinedSeq: r.joined_seq,
  ...(r.seat_id ? { seatId: r.seat_id } : {}),
  readUptoSeq: r.read_upto_seq,
  muted: !!r.muted,
  useMyMemory: !!r.use_my_memory,
  addedBy: r.added_by,
  addedAt: r.added_at,
  updatedAt: r.updated_at,
});

export class ChatParticipantStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  get(chatId: string, accountId: string): ChatParticipant | undefined {
    const r = this.db.query("SELECT * FROM chat_participants WHERE session_id = ? AND account_id = ? AND friend_id = ''").get(chatId, accountId) as Row | null;
    return r ? participant(r) : undefined;
  }

  private chat(chatId: string): { account_id: string } {
    const r = this.db.query("SELECT account_id FROM sessions WHERE id = ? AND kind = 'chat' AND json_extract(meta, '$.seat') IS NULL").get(chatId) as { account_id: string } | null;
    if (!r) throw new PeopleError(404, 'Chat not found.');
    return r;
  }

  owner(chatId: string, caller: string): void {
    if (this.chat(chatId).account_id !== caller) {
      this.require(chatId, caller);
      throw new PeopleError(403, 'Only the chat owner can do that.');
    }
  }

  /** Unknown chats and someone else's chats are indistinguishable. Invites grant no read access. */
  require(chatId: string, caller: string, write = false): ChatParticipant | undefined {
    if (!this.db.query('SELECT 1 FROM hub_accounts WHERE id = ?').get(caller)) throw new PeopleError(404, 'Chat not found.');
    if (this.chat(chatId).account_id === caller) return undefined;
    const p = this.get(chatId, caller);
    if (p?.state !== 'active') throw new PeopleError(404, 'Chat not found.');
    if (write && p.access === 'viewer') throw new PeopleError(403, 'Viewers cannot post or start turns.');
    return p;
  }

  list(chatId: string, caller: string): ChatParticipant[] {
    this.require(chatId, caller);
    return (this.db.query('SELECT * FROM chat_participants WHERE session_id = ? ORDER BY added_at, account_id').all(chatId) as Row[]).map(participant);
  }

  /** The membership table drives this list, never a scan of someone else's sessions. */
  forAccount(accountId: string): ChatParticipant[] {
    return (this.db.query("SELECT * FROM chat_participants WHERE account_id = ? AND state IN ('invited', 'active') ORDER BY updated_at DESC, session_id").all(accountId) as Row[]).map(participant);
  }

  invite(chatId: string, caller: string, accountId: string, input: { access?: ChatAccess; history?: ChatHistory } = {}): ChatParticipant {
    this.owner(chatId, caller);
    if (!this.db.query('SELECT 1 FROM hub_accounts WHERE id = ?').get(accountId)) throw new PeopleError(404, 'Person not found.');
    if (accountId === caller) throw new PeopleError(400, 'The chat owner is already in the chat.');
    const access = input.access ?? 'participant';
    const history = input.history ?? 'joined';
    checkAccess(access);
    checkHistory(history);
    const old = this.get(chatId, accountId);
    if (old?.state === 'active' || old?.state === 'invited') throw new PeopleError(409, 'This person is already invited or in the chat.');
    const seq = this.nextSeq(chatId);
    const now = this.now();
    this.db.query(`INSERT INTO chat_participants (session_id, account_id, access, state, history, joined_seq, added_by, added_at, updated_at)
      VALUES (?, ?, ?, 'invited', ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, account_id, friend_id) DO UPDATE SET access = excluded.access, state = 'invited', history = excluded.history,
        joined_seq = excluded.joined_seq, seat_id = NULL, read_upto_seq = 0, muted = 0, use_my_memory = 0,
        added_by = excluded.added_by, added_at = excluded.added_at, updated_at = excluded.updated_at`).run(chatId, accountId, access, history, seq, caller, now, now);
    return this.get(chatId, accountId)!;
  }

  /** The caller provisions a seat with the recipient's own defaults, never the chat owner's model. */
  accept(chatId: string, caller: string, seat?: Session): ChatParticipant {
    return this.db.transaction(() => {
      this.chat(chatId);
      const p = this.get(chatId, caller);
      if (p?.state !== 'invited') throw new PeopleError(404, 'Chat invitation not found.');
      if (p.access === 'participant') {
        const stored = seat && this.db.query('SELECT account_id, kind, meta, chat FROM sessions WHERE id = ?').get(seat.id) as Row | undefined;
        let meta: Record<string, any> = {};
        let settings: Record<string, any> = {};
        try {
          meta = JSON.parse(stored?.meta ?? '{}');
          settings = JSON.parse(stored?.chat ?? '{}');
        } catch {
          throw new PeopleError(400, 'Invalid seat session.');
        }
        if (!stored || stored.account_id !== caller || stored.kind !== 'chat' || meta?.seat?.chatId !== chatId || settings?.memory !== false) throw new PeopleError(400, 'A participant needs their own chat seat with memory off.');
        if (this.db.query('SELECT 1 FROM messages WHERE session_id = ? LIMIT 1').get(seat!.id)) throw new PeopleError(400, 'A seat must not hold a transcript.');
      } else if (seat) throw new PeopleError(400, 'A viewer has no seat.');
      this.db.query("UPDATE chat_participants SET state = 'active', seat_id = ?, updated_at = ? WHERE session_id = ? AND account_id = ?").run(seat?.id ?? null, this.now(), chatId, caller);
      return this.get(chatId, caller)!;
    })();
  }

  decline(chatId: string, caller: string): void {
    if (this.get(chatId, caller)?.state !== 'invited') throw new PeopleError(404, 'Chat invitation not found.');
    this.db.query("UPDATE chat_participants SET state = 'declined', updated_at = ? WHERE session_id = ? AND account_id = ?").run(this.now(), chatId, caller);
  }

  /** Return the seat to stop before acknowledging the new access to clients. */
  change(chatId: string, caller: string, accountId: string, patch: { access?: ChatAccess; history?: ChatHistory }): ChatParticipant {
    this.owner(chatId, caller);
    const p = this.get(chatId, accountId);
    if (!p || (p.state !== 'active' && p.state !== 'invited')) throw new PeopleError(404, 'Participant not found.');
    const access = patch.access ?? p.access;
    const history = patch.history ?? p.history;
    checkAccess(access);
    checkHistory(history);
    // Promotion needs seat provisioning in the service, not a seat copied from another person.
    if (access === 'participant' && p.state === 'active' && !p.seatId) throw new PeopleError(409, 'This person needs their own seat before promotion.');
    this.db.query('UPDATE chat_participants SET access = ?, history = ?, updated_at = ? WHERE session_id = ? AND account_id = ?').run(access, history, this.now(), chatId, accountId);
    return this.get(chatId, accountId)!;
  }

  leave(chatId: string, caller: string): ChatParticipant {
    const p = this.require(chatId, caller);
    if (!p) throw new PeopleError(400, 'The chat owner cannot leave their own chat.');
    return this.end(chatId, caller, 'left');
  }

  remove(chatId: string, caller: string, accountId: string): ChatParticipant {
    this.owner(chatId, caller);
    const p = this.get(chatId, accountId);
    if (!p || (p.state !== 'active' && p.state !== 'invited')) throw new PeopleError(404, 'Participant not found.');
    return this.end(chatId, accountId, 'removed');
  }

  preferences(chatId: string, caller: string, patch: { useMyMemory?: boolean; muted?: boolean; readUptoSeq?: number }): ChatParticipant {
    const p = this.require(chatId, caller);
    if (!p) throw new PeopleError(400, 'Use the chat settings for your own chat.');
    for (const key of ['useMyMemory', 'muted'] as const) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new PeopleError(400, `${key} must be true or false.`);
    const read = patch.readUptoSeq ?? p.readUptoSeq;
    if (!Number.isSafeInteger(read) || read < 0 || read >= this.nextSeq(chatId)) throw new PeopleError(400, 'Invalid read mark.');
    this.db.query('UPDATE chat_participants SET use_my_memory = ?, muted = ?, read_upto_seq = ?, updated_at = ? WHERE session_id = ? AND account_id = ?').run(Number(patch.useMyMemory ?? p.useMyMemory), Number(patch.muted ?? p.muted), Math.max(read, p.readUptoSeq), this.now(), chatId, caller);
    return this.get(chatId, caller)!;
  }

  /** Check current membership on every read; cached socket recipients must not grant access. */
  visible(chatId: string, caller: string, messages: Message[]): Message[] {
    const p = this.require(chatId, caller);
    const owner = this.chat(chatId).account_id;
    return messages.filter((m) => m.sessionId === chatId && (!p || p.history === 'all' || m.seq >= p.joinedSeq)).map((m) => sharedMessageView(m, caller, owner));
  }

  private end(chatId: string, accountId: string, state: 'left' | 'removed'): ChatParticipant {
    this.db.query('UPDATE chat_participants SET state = ?, use_my_memory = 0, updated_at = ? WHERE session_id = ? AND account_id = ?').run(state, this.now(), chatId, accountId);
    return this.get(chatId, accountId)!;
  }

  private nextSeq(chatId: string): number {
    const r = this.db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?').get(chatId) as { seq: number };
    return r.seq;
  }
}

function checkAccess(value: unknown): asserts value is ChatAccess {
  if (value !== 'viewer' && value !== 'participant') throw new PeopleError(400, 'access must be viewer or participant.');
}
function checkHistory(value: unknown): asserts value is ChatHistory {
  if (value !== 'joined' && value !== 'all') throw new PeopleError(400, 'history must be joined or all.');
}

/** Saved sender names survive rename/removal. Legacy NULL senders are always the chat owner's. */
export function messageAccount(m: Pick<Message, 'sender'>, owner = OWNER_ID): string | undefined {
  if (!m.sender) return owner;
  return m.sender.startsWith('account:') ? m.sender.slice('account:'.length) : undefined;
}

/** Only the starter reads full calls, results, thinking and reminders, including when the reader owns the chat. */
export function sharedMessageView(m: Message, caller: string, owner: string): Message {
  if (messageAccount(m, owner) === caller) return m;
  return {
    id: m.id, sessionId: m.sessionId, seq: m.seq, role: m.role,
    // Another person's compaction must not truncate this person's view.
    kind: m.kind === 'summary' ? 'notice' : m.kind,
    sender: m.sender ?? `account:${owner}`, author: m.author, model: m.model, createdAt: m.createdAt,
    content: m.kind === 'summary' ? [] : m.content.flatMap((b) => {
      if (b.type === 'text' && !b.text.startsWith('<system-reminder>')) return [{ type: 'text' as const, text: b.text }];
      if (b.type === 'tool_use') return [{ type: 'text' as const, text: `[Called ${b.name.replace(/[\r\n]/g, ' ')}]` }];
      if (b.type === 'tool_result') return [{ type: 'text' as const, text: b.isError ? '[Tool failed]' : '[Tool completed]' }];
      return [];
    }),
  };
}
