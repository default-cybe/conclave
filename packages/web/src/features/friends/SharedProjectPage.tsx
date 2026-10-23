/**
 * One shared project (/projects/:id, docs/design/FRIENDS.md, "Shared
 * projects as built"): an invite with Accept and Decline, or the project:
 * notes, the memories members picked, the chats they shared, the code on
 * GitHub with each member's branches and pull requests, the members, and
 * this hub's own settings for it (the project of this hub it is linked to,
 * sharing new sessions, leave or end).
 *
 * What a friend wrote says so, item by item: it is their data, and this
 * hub's agents read it fenced as from their hub. Only an item's author edits
 * or deletes it. A desktop puts members, code and settings at the right
 * (below at narrower widths); a phone draws its own bar and stacks them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { SharedItemDto, SharedItemVersionDto, SharedMemoryCandidate, SharedProjectCodeDto, SharedProjectView } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { friendHref, shareHref } from '@/lib/friendInbox';
import { summaryText, shareTargets } from '@/lib/shares';
import { hrefOf } from '@/lib/recents';
import { byLine, itemsOf, ownerLine, PROJECTS, projectClosed, projectInvite, repoOf } from '@/lib/sharedProjects';
import { attempt, onHubEvent, upsertSession, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, OnOff, Select, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { PhoneBar } from '@/components/PhoneFrame';
import { isChat } from '@/features/chat/util';
import { addNote, deleteItem, editItem, forgetProject, inviteToProject, leaveProject, markProjectRead, removeMember, shareChats, shareMemories, updateProject } from './projectActions';
import { useProjectAnswer } from './ProjectCards';
import { TONE } from './parts';

// ---------------------------------------------------------------------------
// Data: the project with its items, again on each change the hub reports
// ---------------------------------------------------------------------------

function useProjectView(id: string) {
  const [view, setView] = useState<SharedProjectView>();
  const [missing, setMissing] = useState(false);
  const load = useCallback(() => {
    api()
      .sharedProject(id)
      .then((v) => {
        setView(v);
        setMissing(false);
      })
      .catch(() => setMissing(true));
  }, [id]);
  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onHubEvent((e) => {
      if (e.type !== 'friend.project' || e.project.id !== id) return;
      clearTimeout(t);
      t = setTimeout(load, 80);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [id, load]);
  return { view, missing, reload: load };
}

export default function SharedProjectPage({ id }: { id: string }) {
  const phone = useIsMobile();
  const stored = useHub((s) => s.sharedProjects?.[id]);
  const { view, missing, reload } = useProjectView(id);
  usePageHeader(view?.name ?? stored?.name ?? 'Shared project', PROJECTS);

  // what members added is read once it is on screen, on every device of the owner
  const unread = view?.state === 'active' ? view.unread : 0;
  useEffect(() => {
    if (unread > 0) void markProjectRead(id);
  }, [id, unread]);

  if (missing && !view) {
    const words = (
      <p className="m-0 px-[var(--gutter)] pt-6 text-[14px] text-fg-2 phone:px-5 phone:text-[15px]">
        This project is not on this hub.{' '}
        <Link href={PROJECTS} className="link">
          All shared projects
        </Link>
      </p>
    );
    return phone ? (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <PhoneBar lead="back" back={PROJECTS} title="Shared project" />
        {words}
      </div>
    ) : (
      words
    );
  }
  if (!view) return phone ? <PhoneBar lead="back" back={PROJECTS} title={stored?.name ?? ''} /> : <LoadingRows loading rows={5} className="px-[var(--gutter)] pt-6" />;

  if (phone)
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <PhoneBar lead="back" back={PROJECTS} title={view.name} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-12">
          <Body p={view} reload={reload} />
        </div>
      </div>
    );
  return (
    <Page width="column" innerClassName="max-w-[calc(1040px+2*var(--gutter))]">
      <nav aria-label="Where this is" className="flex items-baseline gap-1.5 pt-6 text-[13px]">
        <Link href="/settings/friends" className="link">
          Friends
        </Link>
        <span aria-hidden className="text-fg-4">
          /
        </span>
        <Link href={PROJECTS} className="link">
          Shared projects
        </Link>
      </nav>
      <PageHeader title={view.name} className="pt-2 pb-3" />
      <Body p={view} reload={reload} />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// The page's body: the same on both, laid out in one or two columns
// ---------------------------------------------------------------------------

function Body({ p, reload }: { p: SharedProjectView; reload: () => void }) {
  const phone = useIsMobile();
  const invite = projectInvite(p);
  return (
    <div className="flex flex-col gap-7 phone:gap-8">
      <header className="flex flex-col gap-1">
        <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
          {ownerLine(p)}
          {p.repo && (
            <>
              {' '}
              Code on{' '}
              <a href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" className="link font-mono">
                {p.repo}
              </a>
              .
            </>
          )}
        </p>
        {p.description && <p className="m-0 text-[14px] leading-[1.55] whitespace-pre-wrap text-fg phone:text-[16px]">{p.description}</p>}
      </header>
      {invite ? (
        <InviteBlock p={p} />
      ) : (
        <>
          {projectClosed(p) && <ClosedBlock p={p} />}
          <div className={cn('grid gap-x-12 gap-y-9', !phone && 'xl:grid-cols-[minmax(0,1fr)_300px]')}>
            <div className="flex min-w-0 flex-col gap-9">
              <Provenance p={p} />
              <Notes p={p} reload={reload} />
              <Memories p={p} reload={reload} />
              <Chats p={p} reload={reload} />
            </div>
            <aside aria-label="About the project" className="flex min-w-0 flex-col gap-9">
              <Members p={p} reload={reload} />
              <Code p={p} />
              <Settings p={p} reload={reload} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function InviteBlock({ p }: { p: SharedProjectView }) {
  const phone = useIsMobile();
  const { busy, run } = useProjectAnswer(p);
  const size = phone ? 'touch' : 'md';
  return (
    <section aria-label="Invite" className="border-l-2 border-warn py-1 pl-4">
      <p className="m-0 text-[14px] leading-[1.45] font-medium text-warn phone:text-[16px]">{p.owner.name} invited you</p>
      <p className="m-0 mt-1 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
        Accept, and {p.owner.name}'s hub sends its notes, the memories members picked and the chats they shared. Nothing of it is here before that. What they wrote stays their data: your agents read it marked as from their hub.
      </p>
      <div className="mt-3 flex gap-2 phone:w-full">
        <Button variant="quiet" size={size} disabled={!!busy} busy={busy === 'decline' ? 'Declining' : false} onClick={() => void run('decline')} className="phone:flex-1">
          Decline
        </Button>
        <Button variant="solid" size={size} disabled={!!busy} busy={busy === 'accept' ? 'Joining' : false} onClick={() => void run('accept')} className="phone:flex-1">
          Accept
        </Button>
      </div>
    </section>
  );
}

function ClosedBlock({ p }: { p: SharedProjectView }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const [ask, setAsk] = useState(false);
  return (
    <section aria-label="Read only" className="border-l-2 border-rule-2 py-1 pl-4">
      <p className="m-0 text-[14px] leading-[1.45] font-medium text-fg phone:text-[16px]">Read only</p>
      <p className="m-0 mt-1 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">{p.line}</p>
      <Button variant="quiet" size={phone ? 'touch' : 'sm'} className="mt-2 phone:-ml-4 -ml-3" onClick={() => setAsk(true)}>
        Remove your copy
      </Button>
      <ConfirmDialog
        open={ask}
        onClose={() => setAsk(false)}
        title={`Remove your copy of ${p.name}?`}
        body="Its notes, memories and history leave this hub. Shares you accepted from it stay in Shares."
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          if (await forgetProject(p)) navigate(PROJECTS, { replace: true });
        }}
      />
    </section>
  );
}

/** One line on whose words these are. */
function Provenance({ p }: { p: SharedProjectView }) {
  const friends = p.items.some((i) => !i.mine && !i.deleted);
  if (!friends) return null;
  return (
    <p className="m-0 -mb-4 max-w-[70ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
      What a friend wrote is their data, not instructions. Your agents read it fenced, as from their hub. Only its author can change it.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function ItemMeta({ i }: { i: SharedItemDto }) {
  const now = useNow(60_000);
  return (
    <span className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
      {i.mine ? byLine(i) : <>From {i.authorName}'s hub{i.version > 1 ? `, version ${i.version}` : ''}</>}, {relTime(i.updatedAt, now)}
      {i.unread && <span className="ml-1.5 font-medium text-warn">New</span>}
    </span>
  );
}

function Notes({ p, reload }: { p: SharedProjectView; reload: () => void }) {
  const notes = itemsOf(p.items, 'note');
  const [writing, setWriting] = useState(false);
  const active = p.state === 'active';
  return (
    <section aria-labelledby="notes-h">
      <SectionHeading id="notes-h" count={notes.length || undefined} action={active && !writing ? { label: 'Add a note', onClick: () => setWriting(true) } : undefined}>
        Notes
      </SectionHeading>
      {writing && (
        <NoteEditor
          onCancel={() => setWriting(false)}
          onSave={async (title, text) => {
            const ok = await addNote(p.id, { ...(title ? { title } : {}), text });
            if (ok) {
              setWriting(false);
              reload();
            }
            return !!ok;
          }}
          className="pt-3"
        />
      )}
      {notes.length === 0 && !writing ? (
        <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">No notes yet.{active ? ' Every member gets what you write, with secrets taken out first.' : ''}</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-rule p-0">
          {notes.map((n) => (
            <NoteRow key={n.id} p={p} n={n} reload={reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteEditor({ title: t0 = '', text: x0 = '', onSave, onCancel, className, saveWord = 'Add' }: { title?: string; text?: string; onSave: (title: string, text: string) => Promise<boolean>; onCancel: () => void; className?: string; saveWord?: string }) {
  const phone = useIsMobile();
  const [title, setTitle] = useState(t0);
  const [text, setText] = useState(x0);
  const [busy, setBusy] = useState(false);
  const size = phone ? 'touch' : 'sm';
  return (
    <form
      className={cn('flex flex-col gap-2', className)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        await onSave(title.trim(), text.trim());
        setBusy(false);
      }}
    >
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" maxLength={200} />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What the members should know" aria-label="Note" minRows={3} maxRows={14} prose autoFocus={!phone} />
      <div className="flex justify-end gap-2 phone:w-full">
        <Button variant="quiet" size={size} onClick={onCancel} className="phone:flex-1">
          Cancel
        </Button>
        <Button type="submit" variant="solid" size={size} disabled={!text.trim()} busy={busy ? 'Saving' : false} className="phone:flex-1">
          {saveWord}
        </Button>
      </div>
    </form>
  );
}

function NoteRow({ p, n, reload }: { p: SharedProjectView; n: SharedItemDto; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [del, setDel] = useState(false);
  const own = n.mine && p.state === 'active';
  if (editing)
    return (
      <li className="py-3">
        <NoteEditor
          title={n.title}
          text={n.text}
          saveWord="Save"
          onCancel={() => setEditing(false)}
          onSave={async (title, text) => {
            const ok = await editItem(p.id, n.id, { title, text });
            if (ok) {
              setEditing(false);
              reload();
            }
            return !!ok;
          }}
        />
      </li>
    );
  return (
    <li className="flex flex-col gap-1 py-3">
      {n.title && <h3 className="m-0 text-[14px] leading-[1.4] font-semibold text-fg phone:text-[16px]">{n.title}</h3>}
      <p className={cn('m-0 text-[14px] leading-[1.55] whitespace-pre-wrap break-words text-fg phone:text-[16px]', !n.mine && 'border-l-2 border-rule-2 pl-3')}>{n.text}</p>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <ItemMeta i={n} />
        <span className="ml-auto flex gap-4">
          {n.version > 1 && <TextAction label="History" onClick={() => setHistory(true)} />}
          {own && <TextAction label="Edit" onClick={() => setEditing(true)} />}
          {own && <TextAction label="Delete" onClick={() => setDel(true)} />}
        </span>
      </div>
      <HistoryDialog p={p} item={n} open={history} onClose={() => setHistory(false)} />
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${n.title ? `'${n.title}'` : 'this note'}?`}
        body="It goes from every member's copy of the project. Their hubs keep its history, so say it is asked to go, not gone."
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          if (await deleteItem(p.id, n.id)) reload();
        }}
      />
    </li>
  );
}

function HistoryDialog({ p, item, open, onClose }: { p: SharedProjectView; item: SharedItemDto; open: boolean; onClose: () => void }) {
  const [list, setList] = useState<SharedItemVersionDto[]>();
  const now = useNow(60_000);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api()
      .sharedItemHistory(p.id, item.id)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [open, p.id, item.id]);
  return (
    <Dialog open={open} onClose={onClose} title={item.title ?? 'History'} description={`The last 50 versions ${item.mine ? 'you' : item.authorName} saved, newest first.`} width={560}>
      {!list ? (
        <LoadingRows loading rows={3} />
      ) : (
        <ol className="m-0 flex list-none flex-col divide-y divide-rule p-0">
          {list.map((v) => (
            <li key={v.version} className="py-3">
              <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">
                Version {v.version}, {relTime(v.updatedAt, now)}
                {v.deleted ? ', deleted' : ''}
              </p>
              {!v.deleted && <p className="m-0 mt-1 text-[14px] leading-[1.55] whitespace-pre-wrap break-words text-fg phone:text-[15px]">{v.text}</p>}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

function Memories({ p, reload }: { p: SharedProjectView; reload: () => void }) {
  const list = itemsOf(p.items, 'memory');
  const [pick, setPick] = useState(false);
  const active = p.state === 'active';
  return (
    <section aria-labelledby="memories-h">
      <SectionHeading id="memories-h" count={list.length || undefined} action={active ? { label: 'Share memories', onClick: () => setPick(true) } : undefined}>
        Memories
      </SectionHeading>
      {list.length === 0 ? (
        <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">None shared. Your memories stay home unless you pick them one by one.</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-rule p-0">
          {list.map((m) => (
            <MemoryRow key={m.id} p={p} m={m} reload={reload} />
          ))}
        </ul>
      )}
      <MemoryPicker p={p} open={pick} onClose={() => setPick(false)} onDone={reload} />
    </section>
  );
}

function MemoryRow({ p, m, reload }: { p: SharedProjectView; m: SharedItemDto; reload: () => void }) {
  const [del, setDel] = useState(false);
  return (
    <li className="flex flex-col gap-1 py-3">
      <p className={cn('m-0 text-[14px] leading-[1.55] whitespace-pre-wrap break-words text-fg phone:text-[15px]', !m.mine && 'border-l-2 border-rule-2 pl-3')}>{m.text}</p>
      <div className="flex items-baseline gap-4">
        <ItemMeta i={m} />
        {m.mine && p.state === 'active' && <TextAction label="Take back" onClick={() => setDel(true)} className="ml-auto" />}
      </div>
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title="Take this memory back?"
        body="The members' hubs are asked to drop it. It stays in your own memory."
        confirm="Take back"
        busy="Taking back"
        onConfirm={async () => {
          if (await deleteItem(p.id, m.id)) reload();
        }}
      />
    </li>
  );
}

function MemoryPicker({ p, open, onClose, onDone }: { p: SharedProjectView; open: boolean; onClose: () => void; onDone: () => void }) {
  const phone = useIsMobile();
  const [list, setList] = useState<SharedMemoryCandidate[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setList(undefined);
    let alive = true;
    api()
      .sharedMemoryCandidates(p.id)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [open, p.id]);
  const size = phone ? 'touch' : 'md';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share memories"
      description="Pick each one that should go. Secrets are taken out first; the rest of your memory stays home."
      width={560}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose} className="phone:flex-1">
            Cancel
          </Button>
          <Button
            variant="solid"
            size={size}
            disabled={!picked.length}
            busy={busy ? 'Sharing' : false}
            className="phone:flex-1"
            onClick={async () => {
              setBusy(true);
              const ok = await shareMemories(p.id, picked);
              setBusy(false);
              if (ok) {
                onClose();
                onDone();
              }
            }}
          >
            {picked.length > 1 ? `Share ${picked.length}` : 'Share'}
          </Button>
        </>
      }
    >
      {!list ? (
        <LoadingRows loading rows={3} />
      ) : list.length === 0 ? (
        <p className="m-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">No memories of this project on your hub yet. Link it to a project of yours in its settings to find them.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {list.map((m) => (
            <Checkbox
              key={m.id}
              checked={m.shared || picked.includes(m.id)}
              disabled={m.shared}
              onChange={(on) => setPicked((x) => (on ? [...x, m.id] : x.filter((y) => y !== m.id)))}
              label={m.content}
              description={m.shared ? 'Shared already' : m.kind}
              className="phone:min-h-11"
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}

function Chats({ p, reload }: { p: SharedProjectView; reload: () => void }) {
  const list = itemsOf(p.items, 'chat');
  const sessions = useHub((s) => s.sessions);
  const [pick, setPick] = useState(false);
  const now = useNow(60_000);
  const active = p.state === 'active';
  return (
    <section aria-labelledby="chats-h">
      <SectionHeading id="chats-h" count={list.length || undefined} action={active ? { label: 'Share chats', onClick: () => setPick(true) } : undefined}>
        Chats and sessions
      </SectionHeading>
      {list.length === 0 ? (
        <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">None shared. Each one goes as a share that members accept, without code.</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-rule p-0">
          {list.map((c) => {
            const own = c.chat?.sessionId ? sessions[c.chat.sessionId] : undefined;
            const href = c.chat?.receivedId ? shareHref(c.chat.receivedId) : own ? hrefOf(own) : undefined;
            return (
              <li key={c.id} className="flex min-h-[56px] items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  {href ? (
                    <Link href={href} className="t-row block truncate text-fg underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2">
                      {c.title ?? 'Shared chat'}
                    </Link>
                  ) : (
                    <span className="t-row block truncate text-fg">{c.title ?? 'Shared chat'}</span>
                  )}
                  <span className="mt-0.5 block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                    {c.chat ? `${summaryText(c.chat.kind, c.chat.summary)}. ` : 'Waits for a member to join. '}
                    {c.mine ? 'You' : c.authorName}, {relTime(c.updatedAt, now)}
                    {!c.mine && c.chat && !c.chat.receivedId ? `. ${c.authorName} sends it only to friends; ask them for it.` : ''}
                  </span>
                </div>
                {c.chat?.receivedId && <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">Open</span>}
              </li>
            );
          })}
        </ul>
      )}
      <ChatPicker p={p} open={pick} onClose={() => setPick(false)} onDone={reload} />
    </section>
  );
}

function ChatPicker({ p, open, onClose, onDone }: { p: SharedProjectView; open: boolean; onClose: () => void; onDone: () => void }) {
  const phone = useIsMobile();
  const sessions = useHub((s) => s.sessions);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const shared = useMemo(() => new Set(p.items.map((i) => i.chat?.sessionId).filter(Boolean)), [p.items]);
  const list = useMemo(() => {
    const word = q.trim().toLowerCase();
    return Object.values(sessions)
      .filter((s) => !s.parentId && !s.archived && !(s.meta?.friendShare as { role?: string } | undefined) && (!word || s.title.toLowerCase().includes(word)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30);
  }, [sessions, q]);
  useEffect(() => {
    if (open) {
      setPicked([]);
      setQ('');
    }
  }, [open]);
  const size = phone ? 'touch' : 'md';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share chats"
      description="Each goes to the members who are your friends, as a share they accept. The review's rules apply: secrets and your paths come out. No code goes; it is on GitHub."
      width={560}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose} className="phone:flex-1">
            Cancel
          </Button>
          <Button
            variant="solid"
            size={size}
            disabled={!picked.length}
            busy={busy ? 'Sharing' : false}
            className="phone:flex-1"
            onClick={async () => {
              setBusy(true);
              const ok = await shareChats(p.id, picked);
              setBusy(false);
              if (ok) {
                onClose();
                onDone();
              }
            }}
          >
            {picked.length > 1 ? `Share ${picked.length}` : 'Share'}
          </Button>
        </>
      }
    >
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter chats and sessions" className="mb-2" />
      <div className="flex flex-col gap-1">
        {list.map((s: Session) => (
          <Checkbox
            key={s.id}
            checked={shared.has(s.id) || picked.includes(s.id)}
            disabled={shared.has(s.id)}
            onChange={(on) => setPicked((x) => (on ? [...x, s.id] : x.filter((y) => y !== s.id)))}
            label={s.title}
            description={shared.has(s.id) ? 'Shared already' : isChat(s) ? 'Chat' : 'Session'}
            className="phone:min-h-11"
          />
        ))}
        {list.length === 0 && <p className="m-0 text-[13px] text-fg-3 phone:text-[15px]">Nothing matches.</p>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Members, code, settings
// ---------------------------------------------------------------------------

const STATE_WORD: Record<string, string> = { invited: 'Invited', active: '', declined: 'Declined', left: 'Left', removed: 'Taken out' };

function Members({ p, reload }: { p: SharedProjectView; reload: () => void }) {
  const owner = p.role === 'owner' && p.state === 'active';
  const [invite, setInvite] = useState(false);
  const [out, setOut] = useState<{ fingerprint: string; name: string }>();
  return (
    <section aria-labelledby="members-h">
      <SectionHeading id="members-h" count={p.members.filter((m) => m.state === 'active').length} action={owner ? { label: 'Invite', onClick: () => setInvite(true) } : undefined}>
        Members
      </SectionHeading>
      <ul className="m-0 list-none divide-y divide-rule p-0">
        {p.members.map((m) => (
          <li key={m.fingerprint} className="flex min-h-11 items-center gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-fg phone:text-[15px]">
                {m.friendId ? (
                  <Link href={friendHref(m.friendId)} className="underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2">
                    {m.name}
                  </Link>
                ) : (
                  m.name
                )}
                {m.you && <span className="text-fg-3"> (you)</span>}
              </span>
              <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">
                {m.role === 'owner' ? 'Owner' : 'Member'}
                {STATE_WORD[m.state] ? `, ${STATE_WORD[m.state].toLowerCase()}` : ''}
                {m.github ? `, @${m.github}` : ''}
                {!m.you && !m.friendId ? ', through the owner' : ''}
              </span>
            </span>
            {owner && !m.you && (m.state === 'active' || m.state === 'invited') && <TextAction label="Remove" onClick={() => setOut(m)} />}
          </li>
        ))}
      </ul>
      <InviteDialog p={p} open={invite} onClose={() => setInvite(false)} onDone={reload} />
      <ConfirmDialog
        open={!!out}
        onClose={() => setOut(undefined)}
        title={`Take ${out?.name ?? 'them'} out of ${p.name}?`}
        body="Their hub keeps its copy, read only, and gets nothing more. Their items stay here."
        confirm="Take out"
        busy="Taking out"
        onConfirm={async () => {
          if (out && (await removeMember(p.id, out))) reload();
        }}
      />
    </section>
  );
}

function InviteDialog({ p, open, onClose, onDone }: { p: SharedProjectView; open: boolean; onClose: () => void; onDone: () => void }) {
  const phone = useIsMobile();
  const friends = useHub((s) => s.friends);
  const inIt = new Set(p.members.filter((m) => m.state === 'active' || m.state === 'invited').map((m) => m.fingerprint));
  const targets = shareTargets(Object.values(friends)).filter((f) => !inIt.has(f.fingerprint));
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);
  const size = phone ? 'touch' : 'md';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Invite to ${p.name}`}
      description="They get an invite in their Inbox and nothing else until they accept."
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onClose} className="phone:flex-1">
            Cancel
          </Button>
          <Button
            variant="solid"
            size={size}
            disabled={!picked.length}
            busy={busy ? 'Inviting' : false}
            className="phone:flex-1"
            onClick={async () => {
              setBusy(true);
              const ok = await inviteToProject(p.id, picked);
              setBusy(false);
              if (ok) {
                onClose();
                onDone();
              }
            }}
          >
            Invite
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="m-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">Every friend is in it or invited. Add a friend in Settings, Friends.</p>
      ) : (
        targets.map((f) => <Checkbox key={f.id} checked={picked.includes(f.id)} onChange={(on) => setPicked((x) => (on ? [...x, f.id] : x.filter((y) => y !== f.id)))} label={f.name} className="phone:min-h-11" />)
      )}
    </Dialog>
  );
}

function Code({ p }: { p: SharedProjectView }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const [code, setCode] = useState<SharedProjectCodeDto>();
  const [starting, setStarting] = useState(false);
  const asked = useRef('');
  useEffect(() => {
    if (!p.repo || asked.current === p.repo) return;
    asked.current = p.repo;
    let alive = true;
    api()
      .sharedProjectCode(p.id)
      .then((c) => alive && setCode(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [p.id, p.repo]);
  const start = async () => {
    if (!p.repo) return;
    setStarting(true);
    const s = await attempt(() => api().createRepoSession({ repo: p.repo!, title: `${p.name}: new work` }));
    setStarting(false);
    if (s) {
      upsertSession(s);
      navigate(hrefOf(s));
    }
  };
  return (
    <section aria-labelledby="code-h">
      <SectionHeading id="code-h">Code</SectionHeading>
      {!p.repo ? (
        <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">{p.role === 'owner' ? 'Link a GitHub repository in Settings below. Code goes through GitHub only, never hub to hub.' : 'No repository yet. Code goes through GitHub only, never hub to hub.'}</p>
      ) : (
        <div className="flex flex-col gap-3 pt-3">
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[15px]">
            <a href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" className="link font-mono">
              {p.repo}
            </a>
            {code?.defaultBranch ? <span className="text-fg-3">, {code.defaultBranch}</span> : null}. Everyone works from it; nothing of the code goes hub to hub.
          </p>
          {code?.connected && p.state === 'active' && (
            <div>
              <Button variant="outline" size={phone ? 'touch' : 'sm'} busy={starting ? 'Starting' : false} onClick={() => void start()} className="phone:w-full">
                New session from the repository
              </Button>
            </div>
          )}
          {!code ? (
            <LoadingRows loading rows={2} />
          ) : !code.connected ? (
            <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
              {code.reason}{' '}
              <Link href="/settings/github" className="link">
                Open GitHub settings
              </Link>
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {code.members.map((m) => (
                <li key={m.fingerprint}>
                  <p className="m-0 text-[13px] font-medium text-fg phone:text-[15px]">
                    {m.you ? 'You' : m.name}
                    {m.github ? <span className="font-normal text-fg-3"> @{m.github}</span> : null}
                  </p>
                  {m.pulls.length ? (
                    m.pulls.map((x) => (
                      <a key={x.number} href={x.url} target="_blank" rel="noreferrer" className="block truncate text-[12.5px] leading-[1.6] text-fg-2 hover:text-fg phone:py-1.5 phone:text-[14px]">
                        #{x.number} {x.title}
                        <span className="font-mono text-fg-3"> {x.branch}</span>
                        {x.draft ? <span className="text-fg-3">, draft</span> : null}
                      </a>
                    ))
                  ) : (
                    <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">{m.github ? 'No open pull requests.' : 'Their GitHub login is not known here.'}</p>
                  )}
                </li>
              ))}
              {code.others.length > 0 && (
                <li>
                  <p className="m-0 text-[13px] font-medium text-fg phone:text-[15px]">Others</p>
                  {code.others.slice(0, 10).map((x) => (
                    <a key={x.number} href={x.url} target="_blank" rel="noreferrer" className="block truncate text-[12.5px] leading-[1.6] text-fg-2 hover:text-fg phone:py-1.5 phone:text-[14px]">
                      #{x.number} {x.title} <span className="text-fg-3">@{x.author}</span>
                    </a>
                  ))}
                </li>
              )}
              {code.branches.length > 0 && (
                <li className="text-[12px] leading-[1.6] text-fg-3 phone:text-[13px]">
                  Other branches: <span className="font-mono">{code.branches.slice(0, 8).join(', ')}</span>
                  {code.branches.length > 8 ? `, and ${code.branches.length - 8} more` : ''}
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Settings({ p, reload }: { p: SharedProjectView; reload: () => void }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const locals = useHub((s) => s.projects);
  const [repo, setRepo] = useState(p.repo ?? '');
  const [leave, setLeave] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => setRepo(p.repo ?? ''), [p.repo]);
  if (p.state !== 'active') return null;
  const size = phone ? 'touch' : 'sm';
  const repoOk = !repo.trim() || !!repoOf(repo);
  const repoChanged = (repoOf(repo) ?? '') !== (p.repo ?? '') && repoOk;
  const localList = Object.values(locals).sort((a, b) => a.name.localeCompare(b.name));
  const linked = !!p.localProjectId || !!p.repo;
  return (
    <section aria-labelledby="settings-h">
      <SectionHeading id="settings-h">Settings</SectionHeading>
      <div className="flex flex-col gap-4 pt-3">
        {p.role === 'owner' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg phone:text-[15px]">GitHub repository</span>
            <span className="flex gap-2">
              <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" mono spellCheck={false} autoCapitalize="off" invalid={!repoOk} className="min-w-0 flex-1" />
              {repoChanged && (
                <Button variant="outline" size={size} onClick={async () => (await updateProject(p.id, { repo: repoOf(repo) ?? null })) && reload()}>
                  Save
                </Button>
              )}
            </span>
          </label>
        )}
        {localList.length > 0 && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg phone:text-[15px]">Your project</span>
            <Select value={p.localProjectId ?? ''} onChange={async (e) => (await updateProject(p.id, { localProjectId: e.target.value || null })) && reload()} aria-label="Your project">
              <option value="">Not linked</option>
              {localList.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <span className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Its sessions can read the shared notes, and its memories are the ones to pick from.</span>
          </label>
        )}
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-fg phone:text-[15px]">Share my new sessions in it</span>
            <span className="block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{linked ? 'Each goes after its first turn, as a share members accept.' : 'Link your project or a repository first.'}</span>
          </span>
          <OnOff checked={p.shareNewSessions} disabled={!linked} onChange={async (v) => (await updateProject(p.id, { shareNewSessions: v })) && reload()} label="Share my new sessions" size={phone ? 'touch' : 'sm'} />
        </div>
        <div className="flex flex-wrap gap-2 phone:w-full">
          <Button
            variant="quiet"
            size={size}
            busy={syncing ? 'Syncing' : false}
            className="phone:flex-1 -ml-3 phone:-ml-0"
            onClick={async () => {
              setSyncing(true);
              await attempt(() => api().syncSharedProject(p.id));
              setSyncing(false);
              reload();
            }}
          >
            Sync
          </Button>
          <Button variant="quiet-fault" size={size} onClick={() => setLeave(true)} className="phone:flex-1">
            {p.role === 'owner' ? 'End the project' : 'Leave'}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={leave}
        onClose={() => setLeave(false)}
        title={p.role === 'owner' ? `End ${p.name} for everyone?` : `Leave ${p.name}?`}
        body={p.role === 'owner' ? 'Each member keeps a read only copy. Nothing more goes between your hubs for it.' : `Your copy stays here, read only. ${p.owner.name}'s hub is told, and nothing more comes.`}
        confirm={p.role === 'owner' ? 'End it' : 'Leave'}
        busy={p.role === 'owner' ? 'Ending' : 'Leaving'}
        onConfirm={async () => {
          if (await leaveProject(p)) {
            reload();
            if (p.role !== 'owner') navigate(PROJECTS);
          }
        }}
      />
    </section>
  );
}
