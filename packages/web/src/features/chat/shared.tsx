/**
 * Chats with more than one person (docs/design/SHARED-WITH-MEMBERS.md 6).
 *
 * The chat header's People control opens the participant list: the owner
 * changes each person's access (Viewer, Participant) and "see earlier
 * messages", and removes them; anyone but the owner can leave. The sidebar
 * lists chats someone else owns under "Shared with you", with Accept and
 * Decline for invites. The composer's "Just talk" toggle posts a plain human
 * message without starting the sender's AI turn.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { Session } from '@conclave/core/types';
import type { ChatParticipantDto, Contact } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, removeKey, reloadSharedChats, upsertSeat, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Checkbox, Segmented } from '@/components/ui/Field';
import { ConfirmDialog, Dialog, Popover, Sheet } from '@/components/ui/Overlay';

/**
 * The shown name for another person's message, or undefined when it is your own.
 * The hub stamps a participant's messages with their name; the owner's carry only
 * their account, so a participant reads the owner's name from the chat's card.
 */
export function senderName(m: { sender?: string; author?: string; sessionId?: string }, meId?: string): string | undefined {
  if (!m.sender || m.sender === `account:${meId ?? 'owner'}`) return undefined;
  return m.author ?? useHub.getState().sharedChats[m.sessionId ?? '']?.owner ?? 'Owner';
}

export function useMeId(): string {
  return useHub((s) => s.me?.id) ?? 'owner';
}

/** Someone else's chat you are in: its settings, usage, rename and delete stay the owner's. */
export function useGuest(session: Session | undefined): boolean {
  return useHub((s) => !!session && !!s.sharedChats[session.id]);
}

/** Your row in a shared chat, whether anyone else is in it, and your seat (whose status is your own turn). */
export function useSharedChat(session: Session | undefined) {
  const meId = useMeId();
  const { rows } = useParticipants(session?.id ?? '', session?.kind === 'chat');
  const seat = useHub((s) => (session ? s.seats[session.id] : undefined));
  const mine = rows?.find((r) => r.accountId === meId && r.state === 'active');
  const shared = !!rows?.some((r) => r.state === 'active' || r.state === 'invited');
  // your own turn runs on your seat: fetch it once, the socket keeps its status after
  useEffect(() => {
    if (session && mine?.seatId) void attempt(() => api().getSession(mine.seatId!)).then((s) => s && upsertSeat(session.id, s));
  }, [mine?.seatId, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { shared, mine, seat };
}

/** The chat's people, fetched on open (GET /api/sessions/:id/participants). */
export function useParticipants(sessionId: string, enabled: boolean) {
  const [rows, setRows] = useState<ChatParticipantDto[] | undefined>(undefined);
  const load = () => {
    if (!enabled) return;
    void attempt(() => api().chatParticipants(sessionId)).then((r) => r && setRows(r));
  };
  useEffect(load, [sessionId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, reload: load };
}

const ROLE_WORDS = { viewer: 'Viewer', participant: 'Participant' } as const;
type Access = keyof typeof ROLE_WORDS;

/** Who wrote or started this, over another person's message or AI turn: a small initial, the name, then `children` ("via" a model). */
export function PersonLine({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <span className="mb-1 flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3 phone:text-[13px]">
      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full border border-rule-2 bg-sunk text-[9px] font-medium text-fg-2">
        {name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="shrink-0 font-medium text-fg-2">{name}</span>
      {children}
    </span>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border border-rule-2 bg-sunk text-[11px] font-medium text-fg-2', className)}>{name.trim().charAt(0).toUpperCase()}</span>;
}

/** The chat header control: avatars of the chat's people, opening the list. */
export function PeopleControl({ session }: { session: Session }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState(false);
  const meId = useMeId();
  const { rows, reload } = useParticipants(session.id, session.kind === 'chat');
  const shown = rows?.filter((r) => r.state === 'active' || r.state === 'invited') ?? [];
  if (session.kind !== 'chat' || !rows || shown.length === 0) return null;
  const mine = shown.some((r) => r.accountId === meId && r.state === 'active');
  return (
    <>
      <AddPeopleDialog session={session} taken={shown} open={add} onClose={() => setAdd(false)} onAdded={() => (reload(), void reloadSharedChats())} />
      {/* the avatars need more room than an icon button: a quiet pill with them and the count */}
      <button
        ref={ref}
        type="button"
        aria-label="People in this chat"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-1)] px-1.5 text-[12px] text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg', open && 'bg-hover text-fg')}
      >
        <span className="flex items-center -space-x-1.5">
          {shown.slice(0, 3).map((r) => (
            <Avatar key={r.accountId} name={r.name} className="size-5 bg-raise text-[10px]" />
          ))}
        </span>
        <span className="num">{shown.length + 1}</span>
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={340} label="People in this chat">
        {open && <PeopleList session={session} rows={shown} meId={meId} mine={mine} onChanged={reload} onAdd={() => (setOpen(false), setAdd(true))} />}
      </Popover>
    </>
  );
}

/** Phones: the same list in a sheet, opened from the chat's title. */
export function PeopleSheet({ session, open, onClose }: { session: Session; open: boolean; onClose: () => void }) {
  const meId = useMeId();
  const { rows, reload } = useParticipants(session.id, session.kind === 'chat');
  const shown = rows?.filter((r) => r.state === 'active' || r.state === 'invited') ?? [];
  const mine = shown.some((r) => r.accountId === meId && r.state === 'active');
  const [add, setAdd] = useState(false);
  return (
    <>
      <Sheet open={open} onClose={onClose} title="People in this chat">
        {open && <PeopleList session={session} rows={shown} meId={meId} mine={mine} onChanged={reload} onAdd={() => (onClose(), setAdd(true))} />}
      </Sheet>
      <AddPeopleDialog session={session} taken={shown} open={add} onClose={() => setAdd(false)} onAdded={() => (reload(), void reloadSharedChats())} />
    </>
  );
}

/** Whether a chat has anyone in it but its owner (for the phone's title sheet). */
export function useHasPeople(session: Session | undefined): boolean {
  const { rows } = useParticipants(session?.id ?? '', session?.kind === 'chat');
  return !!rows?.some((r) => r.state === 'active' || r.state === 'invited');
}

/** `onAdd`: the Add dialog opens outside the popover or sheet, which closes first so nothing sits over it. */
function PeopleList({ session, rows, meId, mine, onChanged, onAdd }: { session: Session; rows: ChatParticipantDto[]; meId: string; mine: boolean; onChanged: () => void; onAdd: () => void }) {
  const [remove, setRemove] = useState<ChatParticipantDto | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [, navigate] = useLocation();
  // the owner is not a participant row: only they see the controls and the Add button
  const ownerView = !mine;
  const refresh = () => {
    onChanged();
    void reloadSharedChats();
  };
  const owner = useHub((s) => s.sharedChats[session.id]?.owner);
  return (
    <div className="flex flex-col gap-0.5 p-2">
      {/* the owner is not a participant row: name them first, so everyone sees whose chat it is */}
      <div className="flex items-center gap-2.5 px-1.5 py-1.5">
        <Avatar name={ownerView ? 'You' : (owner ?? 'Owner')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[1.3] text-fg phone:text-[15px]">{ownerView ? 'You' : (owner ?? 'Owner')}</span>
          <span className="block text-[12px] leading-[1.3] text-fg-3 phone:text-[13px]">Owner</span>
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.accountId} className="flex flex-col gap-1 rounded-[var(--r-1)] px-1.5 py-1.5">
          <div className="flex items-center gap-2.5">
            <Avatar name={r.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-[1.3] text-fg phone:text-[15px]">
                {r.name}
                {r.accountId === meId && ' (you)'}
              </span>
              <span className="block text-[12px] leading-[1.3] text-fg-3 phone:text-[13px]">
                {r.state === 'invited' ? `Invited as ${ROLE_WORDS[r.access]}, not joined yet` : r.history === 'all' ? `${ROLE_WORDS[r.access]}, sees earlier messages` : ROLE_WORDS[r.access]}
              </span>
            </span>
            {ownerView && r.state === 'active' && (
              <Segmented
                size="sm"
                label={`Access for ${r.name}`}
                value={r.access}
                onChange={(access) => void attempt(() => api().updateChatParticipant(session.id, r.accountId, { access })).then((p) => p && refresh())}
                options={(Object.keys(ROLE_WORDS) as Access[]).map((v) => ({ value: v, label: ROLE_WORDS[v] }))}
              />
            )}
          </div>
          {ownerView && (
            <div className="flex items-center gap-2 pl-[34px]">
              {r.state === 'active' && (
                <Checkbox className="min-w-0 flex-1" checked={r.history === 'all'} onChange={(v) => void attempt(() => api().updateChatParticipant(session.id, r.accountId, { history: v ? 'all' : 'joined' })).then((p) => p && refresh())} label="Sees earlier messages" />
              )}
              <Button variant="quiet-fault" size="xs" className="ml-auto shrink-0" onClick={() => setRemove(r)}>
                {r.state === 'invited' ? 'Cancel invite…' : 'Remove…'}
              </Button>
            </div>
          )}
        </div>
      ))}
      <div className="mt-1 border-t border-rule px-1.5 pt-2">
        {ownerView ? (
          <Button variant="outline" size="sm" onClick={onAdd}>
            Add people…
          </Button>
        ) : (
          <Button variant="quiet-fault" size="sm" onClick={() => setLeaving(true)}>
            Leave this chat…
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        title={remove ? (remove.state === 'invited' ? `Cancel ${remove.name}'s invite to "${session.title}"?` : `Remove ${remove.name} from "${session.title}"?`) : ''}
        body={remove?.state === 'invited' ? 'The invite goes away. You can invite them again later.' : 'Their messages stay, with their name. They cannot rejoin without a new invite.'}
        confirm={remove?.state === 'invited' ? 'Cancel invite' : 'Remove'}
        onConfirm={() => {
          if (remove) void attempt(() => api().removeChatParticipant(session.id, remove.accountId)).then((p) => p && refresh());
          setRemove(null);
        }}
      />
      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title={`Leave "${session.title}"?`}
        body="Your messages stay, with your name. You cannot come back without a new invite."
        confirm="Leave"
        onConfirm={() => {
          void attempt(() => api().leaveChat(session.id), 'Left.').then((ok) => {
            if (!ok) return;
            removeKey('sessions', session.id);
            void reloadSharedChats();
            navigate('/chat');
          });
          setLeaving(false);
        }}
      />
    </div>
  );
}

/** Pick a contact, their access and whether they see earlier messages (SHARED-WITH-MEMBERS.md 6). */
function AddPeopleDialog({ session, taken, open, onClose, onAdded }: { session: Session; taken: ChatParticipantDto[]; open: boolean; onClose: () => void; onAdded: () => void }) {
  const [contacts, setContacts] = useState<Contact[] | undefined>(undefined);
  const [pick, setPick] = useState<string | null>(null);
  const [access, setAccess] = useState<Access>('participant');
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    void attempt(() => api().contacts()).then((c) => c && setContacts(c));
  }, [open]);
  const add = async () => {
    if (!pick) return;
    setBusy(true);
    const p = await attempt(() => api().inviteChatParticipant(session.id, pick as `account:${string}`, access, history ? 'all' : 'joined'), 'Invited. They can Accept in their sidebar.');
    setBusy(false);
    if (p) {
      onAdded();
      onClose();
      setPick(null);
      setHistory(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add people"
      description="Everyone added reads this chat. Their turns run on their own account, their models, paid by them."
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!pick} onClick={() => void add()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="Who to add">
        {(contacts ?? []).map((c) => {
          // someone already in the chat, or invited, is not picked twice
          const row = taken.find((r) => `account:${r.accountId}` === c.party);
          return (
            <button
              key={c.party}
              type="button"
              role="radio"
              aria-checked={pick === c.party}
              disabled={!!row}
              onClick={() => setPick(c.party)}
              className={cn('flex min-h-9 items-center gap-2.5 rounded-[var(--r-1)] px-2 text-left text-[13px] transition-colors duration-[var(--dur-1)] phone:min-h-11 phone:text-[15px]', row ? 'text-fg-3' : pick === c.party ? 'bg-hover text-fg' : 'text-fg-2 hov:bg-hover')}
            >
              <Avatar name={c.name} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-[12px] text-fg-3 phone:text-[13px]">{row ? (row.state === 'invited' ? 'Invited' : 'In this chat') : pick === c.party ? 'Picked' : ''}</span>
            </button>
          );
        })}
        {contacts && contacts.length === 0 && <p className="m-0 text-[13px] leading-[1.45] text-fg-3">No contacts yet. People with an account on this hub appear here.</p>}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <Segmented
          label="Access"
          value={access}
          onChange={setAccess}
          options={[
            { value: 'participant' as Access, label: 'Participant', title: 'Reads and writes; turns on their own account' },
            { value: 'viewer' as Access, label: 'Viewer', title: 'Reads only' },
          ]}
        />
        <Checkbox checked={history} onChange={setHistory} label="See earlier messages" description="Off: their history starts when they accept." />
      </div>
    </Dialog>
  );
}

/** The sidebar group: chats you are in that someone else owns, and invites with Accept and Decline. */
export function SharedChatsGroup({ phone, onPick }: { phone?: boolean; onPick?: () => void }) {
  const invites = useHub((s) => s.chatInvites);
  const shared = useHub((s) => s.sharedChats);
  const sessions = useHub((s) => s.sessions);
  const [loc] = useLocation();
  const path = loc.split('?')[0];
  const chats = Object.values(shared)
    .map((c) => ({ card: c, session: sessions[c.chatId] }))
    .filter((x) => x.session);
  if (!chats.length && !invites.length) return null;
  return (
    <section aria-label="Shared with you" className="mt-2" data-shared-group="">
      <h2 className={cn('m-0 px-2.5 font-medium text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>Shared with you</h2>
      {chats.map(({ card, session }) => (
        <Link key={card.chatId} href={`/chat/${card.chatId}`} onClick={onPick} aria-current={path === `/chat/${card.chatId}` ? 'page' : undefined} className={cn('flex w-full flex-col justify-center rounded-[8px] px-2.5 text-left transition-colors duration-[var(--dur-1)]', phone ? 'min-h-14 py-1.5 text-[15px]' : 'min-h-11 py-1 text-[13.5px]', path === `/chat/${card.chatId}` ? 'bg-side-active text-fg' : 'text-fg-2 hov:bg-side-hover hov:text-fg')}>
          <span className="min-w-0 truncate">{session!.title}</span>
          <span className={cn('block truncate leading-[1.35] text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>
            {card.owner}'s chat, {ROLE_WORDS[card.access]}
          </span>
        </Link>
      ))}
      {/* an invite: the words on their own lines, the buttons under them, so a long title never squeezes them */}
      {invites.map((card) => (
        <div key={card.chatId} className="flex flex-col gap-1.5 rounded-[8px] px-2.5 py-1.5" data-chat-invite="">
          <span className="min-w-0">
            <span className={cn('block truncate text-fg-2', phone ? 'text-[15px]' : 'text-[13.5px]')}>{card.title}</span>
            <span className={cn('block leading-[1.35] text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>
              {card.owner} invited you as a {ROLE_WORDS[card.access]}
              {card.history === 'all' ? ', with earlier messages' : ''}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
          <Button
            variant="primary"
            size="xs"
            onClick={() =>
              void attempt(() => api().acceptChatInvite(card.chatId), 'Joined.').then((ok) => {
                if (!ok) return;
                void reloadSharedChats();
              })
            }
          >
            Accept
          </Button>
          <Button variant="quiet" size="xs" onClick={() => void attempt(() => api().declineChatInvite(card.chatId), 'Declined.').then((ok) => ok && useHub.setState((s) => ({ chatInvites: s.chatInvites.filter((x) => x.chatId !== card.chatId) })))}>
            Decline
          </Button>
          </span>
        </div>
      ))}
    </section>
  );
}

