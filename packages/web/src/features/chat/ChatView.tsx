/**
 * One session: the header (title, meta line, state, Stop, the session menu),
 * the transcript and the composer. The page places the panel of cards
 * (ContextPanel.tsx) beside it; the sidebar lists the sessions.
 *
 * Phones (the iPhone app, docs/design/MOBILE-V2.md 5): the phone bar with
 * the title, which opens the conversation's sheet (who, where, cost, Stop,
 * Rename, Archive, Details), the phone transcript and the composer's box.
 *
 * Above the composer, on both: "2 running tasks" while a workflow or a
 * subagent works in the session (RunningTasks.tsx).
 *
 * As a column of Side by side (SplitPage.tsx): a short header (title, state,
 * Remove), the same transcript with its approvals, and the composer. The
 * page's keys (Esc stops, copy the last code block) stay with the session page.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { MoreHorizontal, PanelRight, X } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, removeKey, retainTranscript, toast, upsertSession, useHub, useQuietToasts } from '@/store/store';
import { openNewChat, toggleContext, useUi } from '@/store/ui';
import { cn } from '@/lib/text';
import { countWord, folderName, hhmm, inTime } from '@/lib/format';
import { useIsMobile, useIsWide, useNow } from '@/lib/hooks';
import { harnessId, modelName } from '@/lib/models';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { MOD } from '@/components/ui/Kbd';
import { ConfirmDialog, Dialog, MenuList, Popover } from '@/components/ui/Overlay';
import { Docked } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePageHeader } from '@/components/ui/Page';
import { Elapsed, Pet, sessionPet } from '@/components/motion';
import { ModelList } from '@/components/pickers/ModelPicker';
import { isTyping } from '@/components/Shell';
import { PhoneBar } from '@/components/PhoneFrame';
import { MessageList } from './MessageList';
import { InlineModel, MetaText } from './Log';
import { canScheduleHere, scheduleHere } from '@/features/meeting/links';
import { Composer } from './Composer';
import { TodoStrip } from './TodoStrip';
import { RunningTasks } from './RunningTasks';
import { BrowserLive } from './BrowserLive';
import { ImportedLine } from '@/features/import/ImportedLine';
import { LocationBanner } from './LocationBanner';
import { modeOf } from '@/features/home/start';
import { ConversationSheet } from './ConversationSheet';
import { PhoneTranscript } from './PhoneTranscript';
import { downloadExport, isChat, lastCodeBlock, turnStartedAt } from './util';
import { canSend, SendToFriendDialog } from '@/features/friends/SendToFriend';
import { FriendShareLine } from '@/features/friends/FriendShareLine';
import { RepoBar, useArchiveRepo } from '@/features/github/RepoBar';
import { sessionRepo } from '@/lib/github';
import { isDelegated } from '@conclave/core/session/delegated';
import { DelegatedLine, FromLink, moveToMainList, MOVE_TO_MAIN, useDelegatedFrom } from './delegated';
import { useHubCopy } from './HubCopy';
import { addToSplit, saveSplit, shownSplit } from './split';

export function ChatView({ session, column }: { session: Session; /** Shown as a column of Side by side. */ column?: { onRemove: () => void } }) {
  const todos = useHub((s) => s.todos[session.id]);
  const mobile = useIsMobile();
  const [sheet, setSheet] = useState(false);
  const wide = useIsWide();
  const contextOpen = useUi((s) => s.contextOpen);
  const panelShown = wide && contextOpen;

  useEffect(() => retainTranscript(session.id), [session.id]);
  // the transcript says its notices ("Stopped", an error), so the hub's toasts for it are dropped
  useQuietToasts(session.id);

  // esc stops a running turn; mod+shift+c copies the last code block
  useEffect(() => {
    // several columns on one page: no key may reach every session at once
    if (column) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        const code = lastCodeBlock(useHub.getState().messages[session.id]);
        if (code) {
          e.preventDefault();
          void navigator.clipboard?.writeText(code).then(() => toast({ title: 'Copied the last code block.', level: 'info' }));
        }
        return;
      }
      if (e.key !== 'Escape' || isTyping(e) || document.querySelector('[role=dialog]')) return;
      const s = useHub.getState().sessions[session.id];
      if (s && (s.status === 'running' || s.status === 'waiting_approval' || s.status === 'waiting_input')) {
        e.preventDefault();
        void attempt(() => api().abort(session.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.id, !!column]); // eslint-disable-line react-hooks/exhaustive-deps

  if (column)
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ColumnHeader session={session} onRemove={column.onRemove} />
        <MessageList session={session} />
        <Docked>
          {todos && <TodoStrip todos={todos} />}
          <RunningTasks sessionId={session.id} />
          <Composer session={session} narrow />
        </Docked>
      </div>
    );

  if (mobile)
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <PhoneTitle title={session.title} />
        <PhoneBar title={session.title} onTitle={() => setSheet(true)} titleLabel={`${session.title}, details`} />
        <DelegatedLine session={session} className="shrink-0 px-5 py-1.5" />
        <ImportedLine session={session} className="shrink-0 px-5 py-1.5" />
        <FriendShareLine session={session} className="shrink-0 px-5 py-1.5" />
        <PhoneTranscript session={session} />
        <Docked>
          <RepoBar session={session} />
          <LocationBanner session={session} />
          <BrowserLive sessionId={session.id} preview={modeOf(session) === 'code'} />
          <RunningTasks sessionId={session.id} />
          <Composer session={session} />
        </Docked>
        <ConversationSheet session={session} open={sheet} onClose={() => setSheet(false)} />
      </div>
    );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ChatHeader session={session} />
      <RepoBar session={session} />
      <ImportedLine session={session} className="shrink-0 border-b border-rule px-8 py-1.5 phone:px-4" />
      <FriendShareLine session={session} className="shrink-0 border-b border-rule px-8 py-1.5 phone:px-4" />
      <MessageList session={session} />
      <Docked>
        {todos && !panelShown && <TodoStrip todos={todos} />}
        <LocationBanner session={session} />
        <BrowserLive sessionId={session.id} preview={modeOf(session) === 'code'} />
        <RunningTasks sessionId={session.id} />
        <Composer session={session} />
      </Docked>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** The state at the right of the header: a word in a fixed place (spec 11.2.2, 11.2.6). */
function HeaderState({ session }: { session: Session }) {
  // the countdown to a reset ticks once a minute, in step with the live line under the log
  const minute = useNow(60_000);
  const messages = useHub((s) => s.messages[session.id]);
  const lastAt = messages?.length ? messages[messages.length - 1].createdAt : undefined;
  switch (session.status) {
    case 'running':
      return (
        <span className="state-word whitespace-nowrap text-signal" aria-live="polite">
          Running <Elapsed since={turnStartedAt(messages, session)} />
        </span>
      );
    case 'waiting_approval':
    case 'waiting_input':
      return <span className="state-word whitespace-nowrap text-warn">Waiting on you</span>;
    case 'waiting_reset':
      return (
        <span className="whitespace-nowrap text-fg-2">
          Resumes <span className="num">{session.resumeAt ? hhmm(session.resumeAt) : 'soon'}</span>
          {session.resumeAt && <span className="num ml-2 text-fg-3">{inTime(session.resumeAt, minute)}</span>}
        </span>
      );
    case 'error':
      return <span className="state-word whitespace-nowrap text-fault">Failed</span>;
    default:
      return lastAt ? (
        <span className="state-word whitespace-nowrap text-fg-3">
          Finished <span className="num">{hhmm(lastAt)}</span>
        </span>
      ) : null;
  }
}

/** "coder, [claude] Sonnet 5.5, arch-desktop, conclave", or the jury and debate forms. The project by name, as on a phone; the path is its tooltip. */
function HeaderMeta({ session }: { session: Session }) {
  const device = useHub((s) => s.devices[session.device]?.name ?? session.device);
  const parent = useHub((s) => (session.parentId ? s.sessions[session.parentId] : undefined));
  const routine = useHub((s) => (session.routineId ? s.routines[session.routineId] : undefined));
  // delegated work (and a session moved from it) says the conversation it came from
  const from = useDelegatedFrom(session);
  // a repo session names its repository; its folder is a worktree. The
  // assistant works in the hub's own folder, which is not a project.
  const project = modeOf(session) === 'assistant' ? undefined : (sessionRepo(session)?.repo ?? folderName(session.cwd));
  const where = (
    <span>
      {device}
      {project && (
        <span className="text-fg-2" title={session.cwd}>
          , {project}
        </span>
      )}
    </span>
  );
  let parts: ReactNode[];
  if (session.mode === 'jury') {
    const j = session.modeConfig?.jury;
    parts = [`Jury of ${j?.jurors.length ?? 0}`, <span>judged by <InlineModel model={j?.judge ?? session.model} as="model" /></span>];
  } else if (session.mode === 'debate') {
    const d = session.modeConfig?.debate;
    parts = d
      ? [
          'Debate',
          <span>
            <InlineModel model={d.a} as="model" />
            {d.stanceA && ` for ${d.stanceA}`} and <InlineModel model={d.b} as="model" />
            {d.stanceB && ` for ${d.stanceB}`}
          </span>,
          d.judge && (
            <span>
              judged by <InlineModel model={d.judge} as="model" />
            </span>
          ),
        ]
      : ['Debate'];
  } else {
    const harness = harnessId(session.model);
    parts = [
      routine ? `Routine ${routine.name}` : session.agent,
      <span>
        <InlineModel model={session.model} />
        {harness && !session.model.endsWith('/default') && `, ${modelName(session.model)}`}
      </span>,
      where,
      session.mode === 'chat' ? 'chat, no tools' : session.mode === 'plan' ? 'plan only' : session.mode === 'loop' ? `loop until ${session.modeConfig?.loop?.untilCommand ?? 'done'}` : null,
    ];
  }
  if (parent && from?.words) parts.push(<FromLink parent={parent} words={from.words} className="text-[12px]" />);
  else if (parent)
    parts.push(
      <span>
        subagent of{' '}
        <Link href={`/s/${parent.id}`} className="link text-[12px]">
          {parent.title}
        </Link>
      </span>,
    );
  return (
    <div className="mt-0.5 flex min-w-0 items-center text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
      <MetaText parts={parts} />
    </div>
  );
}

/** The top of the column: title, meta line, state, the session menu and the panel toggle. The sidebar lists the sessions. */
function ChatHeader({ session }: { session: Session }) {
  const wide = useIsWide();
  const contextOpen = useUi((s) => s.contextOpen);
  const drawerOpen = useUi((s) => s.drawerOpen);

  // Stop lives on the composer: its Send button folds into Stop while a turn runs (spec 1.4)
  return (
    <header className="shrink-0 border-b border-rule bg-bg">
      <div className="mx-auto flex h-16 w-full max-w-[924px] items-center gap-4 px-8">
        <div className="min-w-0 flex-1">
          <h1 className="t-title truncate text-fg" title={session.title}>
            {session.title}
          </h1>
          <HeaderMeta session={session} />
        </div>
        {isDelegated(session) && (
          <Button variant="quiet" size="sm" onClick={() => void moveToMainList(session.id)} className="shrink-0">
            {MOVE_TO_MAIN}
          </Button>
        )}
        <div className="flex shrink-0 items-center gap-1.5 text-[13px]">
          {/* the pet says what the word says: waiting on you, asleep until the reset, failed (CHAT-AND-MOTION 1.11) */}
          {sessionPet(session.status) && <Pet state={sessionPet(session.status)} size={24} className="-my-1 text-fg-2" />}
          <HeaderState session={session} />
        </div>
        <div className="-mr-2 flex shrink-0 items-center gap-0.5">
          <SessionMenu session={session} />
          <IconButton label={wide ? (contextOpen ? 'Hide details' : 'Show details') : 'Details'} active={wide ? contextOpen : drawerOpen} onClick={toggleContext}>
            <PanelRight />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

/** A column's top: the title opens the session page, the state word, and Remove from the view. */
function ColumnHeader({ session, onRemove }: { session: Session; onRemove: () => void }) {
  return (
    <header className="shrink-0 border-b border-rule bg-bg">
      <div className="flex h-14 items-center gap-3 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <Link href={`/s/${session.id}`} className="block truncate text-[14px] font-medium text-fg hover:underline" title={`Open ${session.title}`}>
            {session.title}
          </Link>
          <HeaderMeta session={session} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[13px]">
          {sessionPet(session.status) && <Pet state={sessionPet(session.status)} size={20} className="-my-1 text-fg-2" />}
          <HeaderState session={session} />
        </div>
        <IconButton label={`Remove ${session.title} from Side by side`} onClick={onRemove}>
          <X />
        </IconButton>
      </div>
    </header>
  );
}

/** Phones: the window's title from the session (the phone bar shows it too). */
function PhoneTitle({ title }: { title: string }) {
  usePageHeader(title);
  return null;
}

/** The session menu: Rename, Fork, Second opinion, Compact, Export, Send to friend, Pin, Archive, Delete. The model picker under the composer switches models. */
function SessionMenu({ session }: { session: Session }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [pick, setPick] = useState<'opinion' | null>(null);
  const [rename, setRename] = useState(false);
  const [del, setDel] = useState(false);
  const [send, setSend] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [, navigate] = useLocation();

  const patch = async (p: Parameters<ReturnType<typeof api>['updateSession']>[1], ok?: string) => {
    const s = await attempt(() => api().updateSession(session.id, p), ok);
    if (s) upsertSession(s);
  };
  const later = (fn: () => void) => () => setTimeout(fn, 0);
  // a repo session's worktree may go with it (features/github/RepoBar.tsx)
  const arch = useArchiveRepo(session, () => patch({ archived: true }, 'Archived. It is under Show archived.'));
  // Move to hub (copy folder) and Move back to <device>
  const hub = useHubCopy(session, menu);

  return (
    <>
      <IconButton ref={ref} label="Session actions" size="md" aria-haspopup="menu" aria-expanded={menu} active={menu} onClick={() => setMenu((m) => !m)}>
        <MoreHorizontal />
      </IconButton>
      <Popover anchor={ref} open={menu} onClose={() => setMenu(false)} placement="bottom-end" width={230} label="Session actions">
        <MenuList
          onDone={() => setMenu(false)}
          label="Session actions"
          items={[
            // delegated work: a normal session of its kind from now on
            ...(isDelegated(session) ? [{ label: MOVE_TO_MAIN, onSelect: () => void moveToMainList(session.id) }, { separator: true, label: '' }] : []),
            // Pause lets the call in progress finish, then waits for Resume (kept across restarts)
            // after Stop or a restart cut the turn, Resume starts a turn that continues it
            ...(session.status === 'paused' || (session.status === 'idle' && session.meta?.stoppedTurn)
              ? [{ label: 'Resume', onSelect: () => attempt(() => api().resumeSession(session.id)) }, { separator: true, label: '' }]
              : ['running', 'waiting_approval', 'waiting_input'].includes(session.status)
                ? [{ label: 'Pause', detail: 'After the current tool call', onSelect: () => attempt(() => api().pauseSession(session.id)) }, { separator: true, label: '' }]
                : []),
            {
              label: 'Rename',
              onSelect: later(() => {
                setTitle(session.title);
                setRename(true);
              }),
            },
            {
              label: 'Fork from here',
              onSelect: async () => {
                const s = await attempt(() => api().forkSession(session.id));
                if (s) {
                  upsertSession(s);
                  navigate(`/s/${s.id}`);
                }
              },
            },
            { label: 'Second opinion…', onSelect: later(() => setPick('opinion')) },
            {
              label: 'Side by side',
              detail: 'Watch it next to others',
              onSelect: () => {
                const s = useHub.getState();
                void saveSplit(addToSplit(shownSplit(s.me?.preferences.splitView, s.sessions), session.id));
                navigate('/sessions/split');
              },
            },
            { label: 'Compact', detail: 'Summarize older messages', onSelect: () => attempt(() => api().compact(session.id)) },
            // meetings start from the Meetings page now (MEETING-MODE.md 11.1); this fills in the folder
            ...(canScheduleHere(session) ? [{ label: 'Schedule a meeting here…', onSelect: () => navigate(scheduleHere(session)) }] : []),
            ...(hub.items.length ? [{ separator: true, label: '' }, ...hub.items] : []),
            { separator: true, label: '' },
            { label: 'Export Markdown', onSelect: () => downloadExport(session, 'md') },
            { label: 'Export JSON', onSelect: () => downloadExport(session, 'json') },
            ...(canSend(session) ? [{ label: 'Send to friend…', onSelect: later(() => setSend(true)) }] : []),
            { separator: true, label: '' },
            { label: session.pinned ? 'Unpin' : 'Pin to the top', onSelect: () => patch({ pinned: !session.pinned }) },
            { label: session.archived ? 'Unarchive' : 'Archive', onSelect: session.archived ? () => patch({ archived: false }) : later(arch.archive) },
            { label: 'Delete', danger: true, onSelect: later(() => setDel(true)) },
          ]}
        />
      </Popover>
      <Popover anchor={ref} open={!!pick} onClose={() => setPick(null)} placement="bottom-end" width={380} label="Second opinion from" sheetTitle="Second opinion from">
        <p className="shrink-0 px-3 pt-2.5 text-[12px] text-fg-3 phone:hidden">Ask for a second opinion on the last reply from</p>
        <ModelList
          onChange={async (m) => {
            setPick(null);
            await attempt(() => api().secondOpinion(session.id, { reviewer: m, includeDiff: true }), `Asked ${modelName(m)} for a second opinion.`);
          }}
        />
      </Popover>
      <Dialog
        open={rename}
        onClose={() => setRename(false)}
        title="Rename session"
        footer={
          <>
            <Button variant="quiet" onClick={() => setRename(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              disabled={!title.trim()}
              onClick={() => {
                setRename(false);
                if (title.trim() && title.trim() !== session.title) void patch({ title: title.trim() });
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setRename(false);
            if (title.trim() && title.trim() !== session.title) void patch({ title: title.trim() });
          }}
        >
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Session title" />
        </form>
      </Dialog>
      {arch.dialog}
      {hub.dialogs}
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${session.title}?`}
        body={`Its ${session.stats.messages || 'saved'} messages leave the hub. Archive keeps them out of the list instead.`}
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          const ok = await attempt(() => api().deleteSession(session.id));
          if (ok) {
            removeKey('sessions', session.id);
            navigate('/sessions');
          }
        }}
      />
      <SendToFriendDialog session={session} open={send} onClose={() => setSend(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// No session picked
// ---------------------------------------------------------------------------

/** The conversation column with nothing open: a sentence built from the hub state. */
export function NoChat() {
  const sessions = useHub((s) => s.sessions);
  const approvals = useHub((s) => Object.keys(s.approvals).length + Object.keys(s.questions).length);
  const running = Object.values(sessions).filter((s) => s.status === 'running' && !s.archived && !isChat(s)).length;
  const parts: string[] = [];
  if (running) parts.push(`${countWord(running, true)} ${running === 1 ? 'session is' : 'sessions are'} running`);
  if (approvals) parts.push(`${parts.length ? countWord(approvals) : countWord(approvals, true)} ${approvals === 1 ? 'needs' : 'need'} you`);
  const lead = parts.length ? `${parts.join(' and ')}. ` : '';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[924px] px-8 pt-16">
        <EmptyState action={{ label: 'New session', onClick: () => openNewChat() }}>
          {lead}Open a session on the left, or start a new one with an agent, a model and a device.
        </EmptyState>
        <p className="mt-6 text-[12px] text-fg-3">
          <b className="font-medium text-fg-2">j</b> and <b className="font-medium text-fg-2">k</b> move through the list, <b className="font-medium text-fg-2">/</b> filters it, <b className="font-medium text-fg-2">{MOD} N</b> starts a session from anywhere.
        </p>
      </div>
    </div>
  );
}

export function MissingChat() {
  const hub = useHub((s) => s.hub?.name);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[924px] px-8 pt-16 phone:px-4">
        <EmptyState wave={false} action={<Link href="/sessions" className={cn('link text-[14px]')}>All sessions</Link>}>
          This session is not on {hub ?? 'the hub'}. It may have been deleted, or it lives on another hub.
        </EmptyState>
      </div>
    </div>
  );
}
