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
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { UsersRound } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import type { ChatParticipantDto, Contact } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, removeKey, reloadSharedChats, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button, IconButton } from '@/components/ui/Button';
import { Checkbox, Segmented } from '@/components/ui/Field';
import { ConfirmDialog, Dialog, Popover } from '@/components/ui/Overlay';

/** The shown name for another person's message, or undefined when it is your own. */
export function senderName(m: { sender?: string; author?: string }, meId?: string): string | undefined {
  if (!m.sender || !m.author) return undefined;
  return m.sender === `account:${meId ?? 'owner'}` ? undefined : m.author;
}

export function useMeId(): string {
  return useHub((s) => s.me?.id) ?? 'owner';
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

function Avatar({ name, className }: { name: string; className?: string }) {
  return <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border border-rule-2 bg-sunk text-[11px] font-medium text-fg-2', className)}>{name.trim().charAt(0).toUpperCase()}</span>;
}

/** The chat header control: avatars of the chat's people, opening the list. */
export function PeopleControl({ session }: { session: Session }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const meId = useMeId();
  const { rows, reload } = useParticipants(session.id, session.kind === 'chat');
  const shown = rows?.filter((r) => r.state === 'active' || r.state === 'invited') ?? [];
  if (session.kind !== 'chat' || !rows || shown.length === 0) return null;
  const mine = shown.some((r) => r.accountId === meId && r.state === 'active');
  return (
    <>
      <IconButton ref={ref} label="People in this chat" size="md" active={open} onClick={() => setOpen((v) => !v)}>
        <span className="flex items-center -space-x-1">
          {shown.slice(0, 3).map((r) => (
            <Avatar key={r.accountId} name={r.name} className="size-[18px] border bg-bg" />
          ))}
          <UsersRound className="size-4 text-fg-3" aria-hidden />
        </span>
      </IconButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={330} label="People in this chat">
        {open && <PeopleList session={session} rows={shown} meId={meId} mine={mine} onChanged={reload} />}
      </Popover>
    </>
  );
}

function PeopleList({ session, rows, meId, mine, onChanged }: { session: Session; rows: ChatParticipantDto[]; meId: string; mine: boolean; onChanged: () => void }) {
  const [add, setAdd] = useState(false);
  const [remove, setRemove] = useState<ChatParticipantDto | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [, navigate] = useLocation();
  // the owner is not a participant row: only they see the controls and the Add button
  const ownerView = !mine;
  const refresh = () => {
    onChanged();
    void reloadSharedChats();
  };
  return (
    <div className="flex flex-col gap-1 p-2">
      {rows.map((r) => (
        <div key={r.accountId} className="flex items-center gap-2.5 rounded-[var(--r-1)] px-1.5 py-1.5">
          <Avatar name={r.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] leading-[1.3] text-fg">
              {r.name}
              {r.accountId === meId && ' (you)'}
            </span>
            <span className="block text-[12px] leading-[1.3] text-fg-3">
              {r.state === 'invited' ? `Invited as ${ROLE_WORDS[r.access]}` : r.history === 'all' ? `${ROLE_WORDS[r.access]} · sees earlier messages` : ROLE_WORDS[r.access]}
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
      ))}
      {ownerView && (
        <div className="mt-1 border-t border-rule pt-2">
          {rows.map(
            (r) =>
              r.state === 'active' && (
                <div key={r.accountId} className="flex flex-col gap-1 px-1.5 pb-1">
                  <Checkbox checked={r.history === 'all'} onChange={(v) => void attempt(() => api().updateChatParticipant(session.id, r.accountId, { history: v ? 'all' : 'joined' })).then((p) => p && refresh())} label={`${r.name} sees earlier messages`} description="Off: their history starts when they were added." />
                  <Button variant="quiet-fault" size="xs" className="self-start" onClick={() => setRemove(r)}>
                    Remove {r.name}…
                  </Button>
                </div>
              ),
          )}
          <Button variant="outline" size="sm" className="mt-1" onClick={() => setAdd(true)}>
            Add people…
          </Button>
        </div>
      )}
      {!ownerView && (
        <div className="mt-1 border-t border-rule pt-2">
          <Button variant="quiet-fault" size="sm" onClick={() => setLeaving(true)}>
            Leave this chat
          </Button>
        </div>
      )}
      <AddPeopleDialog session={session} open={add} onClose={() => setAdd(false)} onAdded={refresh} />
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        title={remove ? `Remove ${remove.name} from "${session.title}"?` : ''}
        body="Their messages stay, with their name. They cannot rejoin without a new invite."
        confirm="Remove"
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
function AddPeopleDialog({ session, open, onClose, onAdded }: { session: Session; open: boolean; onClose: () => void; onAdded: () => void }) {
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
        {(contacts ?? []).map((c) => (
          <button
            key={c.party}
            type="button"
            role="radio"
            aria-checked={pick === c.party}
            onClick={() => setPick(c.party)}
            className={cn('flex min-h-9 items-center gap-2.5 rounded-[var(--r-1)] px-2 text-left text-[13px] transition-colors duration-[var(--dur-1)]', pick === c.party ? 'bg-hover text-fg' : 'text-fg-2 hov:bg-hover')}
          >
            <Avatar name={c.name} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-[12px] text-fg-4">on this hub</span>
          </button>
        ))}
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
        <Link key={card.chatId} href={`/s/${card.chatId}`} onClick={onPick} aria-current={path === `/s/${card.chatId}` ? 'page' : undefined} className={cn('flex w-full flex-col rounded-[8px] px-2.5 text-left transition-colors duration-[var(--dur-1)]', phone ? 'min-h-14 py-1.5 text-[15px]' : 'min-h-11 py-1 text-[13.5px]', path === `/s/${card.chatId}` ? 'bg-side-active text-fg' : 'text-fg-2 hov:bg-side-hover hov:text-fg')}>
          <span className="min-w-0 truncate">{session!.title}</span>
          <span className="block truncate text-[12px] leading-[1.35] text-fg-4">
            <span className="text-fg-3">{card.owner}'s chat</span>
          </span>
        </Link>
      ))}
      {invites.map((card) => (
        <div key={card.chatId} className={cn('flex items-center gap-2 rounded-[8px] px-2.5 py-1', phone ? 'min-h-14' : 'min-h-11')} data-chat-invite="">
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-fg-2', phone ? 'text-[15px]' : 'text-[13.5px]')}>{card.title}</span>
            <span className="block truncate text-[12px] leading-[1.35] text-fg-4">
              {card.owner} added you as a {ROLE_WORDS[card.access]}
            </span>
          </span>
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
        </div>
      ))}
    </section>
  );
}

