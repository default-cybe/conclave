/**
 * Chat (docs/design/CHAT-AND-MOTION.md 2): plain conversations with a model,
 * next to the agent workbench. /chat is a new chat (nothing is made until
 * the first send); /chat/:id is one chat. Desktop: the shell's sidebar
 * lists the chats (docs/design/SPEC.md 5.3); here a 720px column, a preview
 * panel at the right when one is open, else the chat's panel of cards
 * (Context, Outputs, Memory used) on wide screens. Phones
 * (docs/design/MOBILE-V2.md 5): full width under the phone bar, whose title
 * opens the chat's sheet; Home is the new chat and the list of chats is its
 * own page (/chats).
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, Redirect, useLocation, useParams, useSearch } from 'wouter';
import { MoreHorizontal, PanelRight } from 'lucide-react';
import { api } from '@/lib/api';
import { attempt, loadMessages, removeKey, useHub, useQuietToasts } from '@/store/store';
import { cn } from '@/lib/text';
import { compact, usd } from '@/lib/format';
import { worthLine } from '@/features/usage/value';
import { useBreakpoint } from '@/lib/hooks';
import { toggleContext, useUi } from '@/store/ui';
import { IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConfirmDialog, MenuList, Popover, SideSheet } from '@/components/ui/Overlay';
import { Docked } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePageHeader } from '@/components/ui/Page';
import { isTyping } from '@/components/Shell';
import { PhoneBar } from '@/components/PhoneFrame';
import { ConversationSheet } from '@/features/chat/ConversationSheet';
import { ContextPanel, PANEL_W } from '@/features/chat/ContextPanel';
import { downloadExport, isChat } from '@/features/chat/util';
import { canSend, SendToFriendDialog } from '@/features/friends/SendToFriend';
import { FriendShareLine } from '@/features/friends/FriendShareLine';
import { branchChat, patchChat, stopChat } from './actions';
import { ChatComposer, FILES_EVENT } from './ChatComposer';
import { ChatMessages } from './ChatMessages';
import { ContinueDialog } from './ContinueDialog';
import { PreviewPanel, PreviewSheet } from './Preview';
import { EmptyConversation } from '@/features/home/EmptyConversation';
import { setStartMode } from '@/features/home/start';
import { closePreview, openContinue, useChatUi } from './state';


export default function ChatPage() {
  const params = useParams<{ id?: string }>();
  const id = params.id;
  const session = useHub((s) => (id ? s.sessions[id] : undefined));
  const booted = useHub((s) => s.booted);
  const bp = useBreakpoint();
  const phone = bp === 'phone';
  const dockPreview = bp === 'desktop' || bp === 'wide';
  const contextOpen = useUi((s) => s.contextOpen);
  const drawer = useUi((s) => s.drawerOpen);
  const preview = useChatUi((s) => s.preview);
  const pendingNew = useChatUi((s) => !!s.pending.new);
  const page = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1440);
  const [drag, setDrag] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    if (id) void loadMessages(id);
  }, [id]);
  // the sidebar's switch follows the open page: a chat, or a new one
  useEffect(() => setStartMode('chat'), []);
  // the open chat says its notices in the transcript, so the hub's toasts for it are dropped
  useQuietToasts(id);
  // a preview belongs to the chat it came from
  useEffect(() => () => closePreview(), [id]);
  // "All chats" on Home: on a phone the list is its own page
  const search = useSearch();
  const [, go] = useLocation();
  useEffect(() => {
    if (id || !new URLSearchParams(search).has('list')) return;
    go(phone ? '/chats' : '/chat', { replace: true });
  }, [id, search, phone, go]);

  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => useUi.getState().set({ drawerOpen: false }), []);

  // esc stops a running reply from anywhere on the page
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e)) return;
      if (useChatUi.getState().preview || document.querySelector('[role=dialog][aria-modal=true], [role=menu]')) return;
      const st = useHub.getState().sessions[id]?.status;
      if (st !== 'running' && st !== 'waiting_approval' && st !== 'waiting_input') return;
      e.preventDefault();
      void stopChat(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  // the window's title; phones draw the header themselves (PhoneChatHeader)
  usePageHeader(id ? (session?.title ?? 'Chat') : 'Chat');

  if (session && !isChat(session)) return <Redirect to={`/s/${session.id}`} replace />;
  // a phone's new chat is Home
  if (phone && !id && !pendingNew && !new URLSearchParams(search).has('list')) return <Redirect to="/?chat" replace />;

  const previewW = dockPreview && preview ? Math.max(420, Math.round(width * 0.46)) : 0;
  // the chat's cards at the right on wide screens, unless a preview has that place
  const wide = bp === 'wide';
  const panel = !!session && wide && contextOpen && !previewW;
  const missing = !!id && !session && booted;

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files') || missing) return;
    e.preventDefault();
    if (!drag) setDrag(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDrag(false);
    window.dispatchEvent(new CustomEvent(FILES_EVENT, { detail: Array.from(e.dataTransfer.files) }));
  };

  let column;
  if (missing) column = <MissingChat />;
  else if (id && session)
    column = (
      <>
        {!phone && <ChatHeader id={id} renaming={renaming} setRenaming={setRenaming} />}
        <FriendShareLine session={session} className="mx-auto w-full max-w-[784px] shrink-0 px-8 py-1.5 phone:px-5" />
        <ChatMessages chatId={id} session={session} />
        <Docked>
          <ChatComposer chatId={id} session={session} autoFocus />
        </Docked>
      </>
    );
  else if (id) column = null;
  else if (pendingNew)
    column = (
      <>
        {!phone && <ChatHeader renaming={false} setRenaming={() => undefined} />}
        <ChatMessages chatId="new" />
        <Docked>
          <ChatComposer chatId="new" />
        </Docked>
      </>
    );
  else column = <NewChat />;

  return (
    <div ref={page} className="flex min-h-0 flex-1">
      {/* a phone's header carries the heading */}
      {!phone && <h1 className="sr-only">{session?.title ?? 'New chat'}</h1>}
      <div
        className={cn('relative flex min-w-0 flex-1 flex-col outline-offset-[-8px]', drag && 'outline-1 outline-rule-2 outline-dashed')}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {phone && <PhoneBar title={session?.title ?? (id ? 'Chat' : 'New chat')} onTitle={session ? () => setSheet(true) : undefined} titleLabel={session ? `${session.title}, details` : undefined} />}
        {column}
      </div>
      {dockPreview ? <PreviewPanel width={previewW} /> : <PreviewSheet />}
      {panel && session && (
        <div className="shrink-0 anim-right" style={{ width: PANEL_W }}>
          <ContextPanel session={session} />
        </div>
      )}
      {!phone && !wide && session && (
        <SideSheet open={drawer} onClose={() => useUi.getState().set({ drawerOpen: false })} width={PANEL_W} label="Chat details" modal={false}>
          <ContextPanel session={session} onClose={() => useUi.getState().set({ drawerOpen: false })} />
        </SideSheet>
      )}
      {phone && session && <ConversationSheet session={session} open={sheet} onClose={() => setSheet(false)} />}
      <ContinueDialog />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** 52px, sticky over the column: the title (click to rename), the chat menu and the panel toggle at the right. */
function ChatHeader({ id, renaming, setRenaming }: { id?: string; renaming: boolean; setRenaming: (v: boolean) => void }) {
  const session = useHub((s) => (id ? s.sessions[id] : undefined));
  const contextOpen = useUi((s) => s.contextOpen);
  const drawer = useUi((s) => s.drawerOpen);
  const wide = useBreakpoint() === 'wide';
  const scrolled = useChatUi((s) => s.scrolled);
  const [title, setTitle] = useState('');
  // start from the current title when renaming opens; updates while you type (status, stats) leave your words alone
  useEffect(() => {
    if (renaming) setTitle(useHub.getState().sessions[id ?? '']?.title ?? '');
  }, [renaming, id]);
  const save = () => {
    setRenaming(false);
    const t = title.trim();
    if (session && t && t !== session.title) void patchChat(session.id, { title: t });
  };
  return (
    <header className={cn('grid h-[52px] shrink-0 grid-cols-[minmax(84px,1fr)_minmax(0,720px)_minmax(84px,1fr)] items-center border-b bg-bg transition-[border-color] duration-[var(--dur-1)]', scrolled ? 'border-rule' : 'border-transparent')}>
      <div />
      <div className="flex min-w-0 justify-center">
        {session &&
          (renaming ? (
            <Input
              autoFocus
              size="sm"
              value={title}
              aria-label="Chat title"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setRenaming(false);
                }
              }}
              className="w-full max-w-[480px]"
            />
          ) : (
            <button type="button" onClick={() => setRenaming(true)} title="Rename" className="t-title min-w-0 truncate rounded-[var(--r-1)] px-2 py-0.5 text-fg hov:bg-hover">
              {session.title}
            </button>
          ))}
      </div>
      <div className="flex items-center justify-end gap-0.5 pr-3">
        {session && <ChatMenu id={session.id} onRename={() => setRenaming(true)} />}
        {session && (
          <IconButton label={wide ? (contextOpen ? 'Hide details' : 'Show details') : 'Details'} active={wide ? contextOpen : drawer} onClick={toggleContext}>
            <PanelRight />
          </IconButton>
        )}
      </div>
    </header>
  );
}

/** Rename, Branch from the last reply, Continue as a session, Export Markdown, Send to friend, Delete; and what the chat cost. */
function ChatMenu({ id, onRename }: { id: string; onRename: () => void }) {
  const session = useHub((s) => s.sessions[id]);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState(false);
  const [send, setSend] = useState(false);
  const [, navigate] = useLocation();
  if (!session) return null;
  const tokens = session.stats.inputTokens + session.stats.outputTokens;
  const later = (fn: () => void) => () => setTimeout(fn, 0);
  return (
    <>
      <IconButton ref={ref} label="Chat actions" size="md" aria-haspopup="menu" aria-expanded={open} active={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal />
      </IconButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={250} label="Chat actions" sheetTitle={session.title}>
        <MenuList
          onDone={() => setOpen(false)}
          label="Chat actions"
          items={[
            { label: 'Rename', onSelect: later(onRename) },
            { label: 'Branch from the last reply', onSelect: () => branchChat(session, undefined, navigate) },
            { label: 'Continue as a session…', onSelect: () => openContinue(session.id) },
            { separator: true, label: '' },
            { label: 'Export Markdown', onSelect: () => downloadExport(session, 'md') },
            ...(canSend(session) ? [{ label: 'Send to friend…', onSelect: later(() => setSend(true)) }] : []),
            { label: 'Delete', danger: true, onSelect: later(() => setDel(true)) },
            { separator: true, label: '' },
            { group: true, label: tokens ? `Usage, ${compact(tokens)} tokens, ${usd(session.stats.costUsd)}${worthLine(session.stats) ? `, ${worthLine(session.stats)}` : ''}` : 'No usage yet' },
          ]}
        />
      </Popover>
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${session.title}?`}
        body={session.stats.messages ? `Its ${session.stats.messages} messages leave the hub. This cannot be undone.` : 'It leaves the hub. This cannot be undone.'}
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          const ok = await attempt(() => api().deleteSession(session.id));
          if (!ok) return;
          navigate('/chat', { replace: true });
          removeKey('sessions', session.id);
        }}
      />
      <SendToFriendDialog session={session} open={send} onClose={() => setSend(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The empty chat page (spec 2.4)
// ---------------------------------------------------------------------------

function NewChat() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <EmptyConversation mode="chat" />
    </div>
  );
}

function MissingChat() {
  const hub = useHub((s) => s.hub?.name);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[784px] px-8 pt-16 phone:px-4">
        <EmptyState wave={false} action={<Link href="/chat" className="link text-[14px]">New chat</Link>}>
          This chat is not on {hub ?? 'the hub'}. It may have been deleted. Start a new one, or pick another from the list.
        </EmptyState>
      </div>
    </div>
  );
}
