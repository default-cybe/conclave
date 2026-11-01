/**
 * The left sidebar on a computer, like the Claude app's
 * (docs/design/SPEC.md 5.3):
 *
 *   mark Conclave              [chat assistant code] [fold]
 *   Search                                          ⌘K
 *   New session
 *   Inbox                                            3
 *   Meetings                                    in 42m
 *   Workflows, Routines, Memory, Extensions
 *   More                                   (a menu: Tasks, Usage, Devices...)
 *
 *   Sessions                                 Project v
 *   conclave                                    + ...
 *     Move auth middleware to jose      arch-desktop .
 *   ...
 *   All conversations
 *
 *   (K) Kai, Owner, madx                             .
 *
 * The sessions are the mode's (the switch in the header): Code's by
 * project, device or time, chats and the assistant's by time. Delegated
 * work (a Delegate call's sessions) is a group of its own under them, in
 * every mode; its rows' menus can move one to the main list. Folded
 * (Cmd \), it is a strip of icons. The phone's drawer reuses the list
 * (SideSessions) and the account row.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'wouter';
import { Blocks, Brain, CalendarClock, ChevronDown, ChevronRight, Ellipsis, Inbox, PanelLeft, PanelLeftClose, Plus, Presentation, Search, SquarePen, Workflow } from 'lucide-react';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, removeKey, upsertSession, useHub } from '@/store/store';
import { openPalette, toggleFolded, useUi } from '@/store/ui';
import { cn } from '@/lib/text';
import { useNow } from '@/lib/hooks';
import { askHome } from '@/lib/asks';
import { useIsOwner } from '@/lib/people';
import { DELEGATED_KEY, DELEGATED_WORDS, delegatedRows, NEW_WORDS, SIDE_GROUP_WORDS, sideGroups, sideListWord, type DelegatedRow, type SideGroupBy, type SideGroupOut, type SideMode, type SideRow } from '@/lib/sidebar';
import { isDelegated } from '@conclave/core/session/delegated';
import { moveToMainList, MOVE_TO_MAIN } from '@/features/chat/delegated';
import { setRailOpen, useChatUi } from '@/features/conversation/state';
import { openNew, ModeSwitch, useCurrentMode } from '@/features/home/ModeSwitch';
import { LazyShareProjectDialog } from '@/features/friends/ShareProject';
import { useMeetingHint } from '@/features/meeting/useMeetingHint';
import { Brand, Mark } from './brand/Mark';
import { Button } from './ui/Button';
import { Input } from './ui/Field';
import { MOD } from './ui/Kbd';
import { Tooltip } from './ui/Tooltip';
import { ConfirmDialog, Dialog, Menu, MenuList, Popover, type MenuItem } from './ui/Overlay';
import { AccountRow } from './AccountMenu';
import { isActive, MORE_PAGES, OWNER_PAGES, useInboxCount } from './nav';

export const SIDEBAR_W = 272;
export const SIDEBAR_FOLDED_W = 56;

const SEARCH_KEY = MOD === '⌘' ? '⌘K' : 'Ctrl K';

type Icon = ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;

const ROW = 'relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13.5px] transition-colors duration-[var(--dur-1)] focus-visible:-outline-offset-2';
const ROW_IDLE = 'text-fg-2 hov:bg-side-hover hov:text-fg';
const ROW_ON = 'bg-side-active text-fg';
/** A reply came after it was last opened (core session/unread.ts). */
export const UNREAD = 'font-semibold text-fg';

/** The pages with a row of their own, after Search and New. */
const ROWS: Array<{ to: string; label: string; Icon: Icon; match?: (p: string) => boolean }> = [
  { to: '/approvals', label: 'Inbox', Icon: Inbox, match: (p) => p.startsWith('/approvals') || p.startsWith('/inbox') },
  { to: '/meetings', label: 'Meetings', Icon: Presentation },
  { to: '/workflows', label: 'Workflows', Icon: Workflow },
  { to: '/routines', label: 'Routines', Icon: CalendarClock },
  { to: '/memory', label: 'Memory', Icon: Brain },
  { to: '/extensions', label: 'Extensions', Icon: Blocks },
];

/** A new conversation in the mode the switch is on. */
function useNewConversation(): { words: string; start: () => void } {
  const mode = useCurrentMode();
  const [, navigate] = useLocation();
  return { words: NEW_WORDS[mode], start: () => openNew(mode, navigate) };
}

export function Sidebar() {
  const open = useChatUi((s) => s.railOpen);
  // what floats at the bottom left (the toasts) sits past it
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--side-w', `${open ? SIDEBAR_W : SIDEBAR_FOLDED_W}px`);
    return () => void root.style.removeProperty('--side-w');
  }, [open]);
  return open ? <Expanded /> : <Folded />;
}

function Expanded() {
  const [loc] = useLocation();
  const path = loc.split('?')[0];
  const owner = useIsOwner();
  const inbox = useInboxCount();
  const meeting = useMeetingHint();
  const mode = useCurrentMode();
  const fresh = useNewConversation();
  const rows = ROWS.filter((r) => owner || !OWNER_PAGES.has(r.to));
  return (
    <aside aria-label="Sidebar" className="flex h-full shrink-0 flex-col bg-side pt-safe" style={{ width: SIDEBAR_W }}>
      <div className="flex h-[52px] shrink-0 items-center gap-2 pr-2 pl-4">
        <Link href="/" aria-label="Conclave, Home" className="flex min-w-0 items-center rounded-[var(--r-1)]">
          <Brand size={14} />
        </Link>
        <ModeSwitch compact className="ml-auto" />
        <FoldButton />
      </div>
      <nav aria-label="Main" className="shrink-0 space-y-px px-2 pt-1">
        <SideButton Icon={Search} label="Search" hint={SEARCH_KEY} onClick={() => openPalette()} />
        <SideButton Icon={SquarePen} label={fresh.words} onClick={fresh.start} />
        {rows.map((r) => {
          const on = isActive(r, path);
          return (
            <Link key={r.to} href={r.to} aria-current={on ? 'page' : undefined} className={cn(ROW, on ? ROW_ON : ROW_IDLE)}>
              <r.Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {r.to === '/approvals' && inbox > 0 && (
                <span className="num text-[12.5px] font-medium text-warn">
                  {inbox > 99 ? '99+' : inbox}
                  <span className="sr-only"> waiting on you</span>
                </span>
              )}
              {r.to === '/meetings' &&
                (meeting.live ? (
                  <span className="mr-1 size-[7px] shrink-0 rounded-full bg-fault">
                    <span className="sr-only">listening</span>
                  </span>
                ) : (
                  meeting.text && <span className="num text-[12.5px] text-fg-3">{meeting.text}</span>
                ))}
            </Link>
          );
        })}
        <MoreRow path={path} />
      </nav>
      {/* the list fades out over its last 20px above the account row, instead of a rule */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-5 [mask-image:linear-gradient(to_bottom,black_calc(100%-20px),transparent)]">
        <SideSessions mode={mode} />
      </div>
      <div className="shrink-0 px-2 pt-1 pb-2 pb-safe">
        <AccountRow />
      </div>
    </aside>
  );
}

/** The folded sidebar: a strip of icons, the account at its foot. */
function Folded() {
  const [loc] = useLocation();
  const path = loc.split('?')[0];
  const inbox = useInboxCount();
  const meeting = useMeetingHint();
  const meetingTip = meeting.live ? `Meetings, ${meeting.live.title} listening` : meeting.next ? `Meetings, ${meeting.next.title} ${meeting.text}` : 'Meetings';
  const fresh = useNewConversation();
  const icon = 'relative grid size-9 place-items-center rounded-[9px] text-fg-2 transition-colors duration-[var(--dur-1)] hov:bg-side-hover hov:text-fg';
  return (
    <aside aria-label="Sidebar" className="flex h-full shrink-0 flex-col items-center gap-1 bg-side pt-safe pb-2" style={{ width: SIDEBAR_FOLDED_W }}>
      <div className="grid h-[52px] place-items-center">
        <Link href="/" aria-label="Conclave, Home" className="grid size-9 place-items-center rounded-[9px] hov:bg-side-hover">
          <Mark size={20} />
        </Link>
      </div>
      <Tooltip content={`Open the sidebar (${MOD} \\)`} side="right">
        <button type="button" aria-label="Open the sidebar" onClick={() => setRailOpen(true)} className={icon}>
          <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content={fresh.words} side="right">
        <button type="button" aria-label={fresh.words} onClick={fresh.start} className={icon}>
          <SquarePen className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content={`Search (${SEARCH_KEY})`} side="right">
        <button type="button" aria-label="Search" onClick={() => openPalette()} className={icon}>
          <Search className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content={inbox ? `Inbox, ${inbox} waiting` : 'Inbox'} side="right">
        <Link href="/approvals" aria-label={inbox ? `Inbox, ${inbox} waiting on you` : 'Inbox'} aria-current={path.startsWith('/approvals') ? 'page' : undefined} className={cn(icon, path.startsWith('/approvals') && 'bg-side-active text-fg')}>
          <Inbox className="size-4" strokeWidth={1.75} aria-hidden />
          {inbox > 0 && <span aria-hidden className="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-warn" />}
        </Link>
      </Tooltip>
      <Tooltip content={meetingTip} side="right">
        <Link href="/meetings" aria-label={meetingTip} aria-current={path.startsWith('/meetings') ? 'page' : undefined} className={cn(icon, path.startsWith('/meetings') && 'bg-side-active text-fg')}>
          <Presentation className="size-4" strokeWidth={1.75} aria-hidden />
          {meeting.live && <span aria-hidden className="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-fault" />}
        </Link>
      </Tooltip>
      <div className="flex-1" />
      <AccountRow compact />
    </aside>
  );
}

function FoldButton() {
  return (
    <Tooltip content={`Hide the sidebar (${MOD} \\)`} side="bottom">
      <button type="button" aria-label="Hide the sidebar" onClick={() => setRailOpen(false)} className="grid size-7 shrink-0 place-items-center rounded-[7px] text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-side-hover hov:text-fg">
        <PanelLeftClose className="size-4" strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}

function SideButton({ Icon, label, hint, onClick }: { Icon: Icon; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(ROW, ROW_IDLE)}>
      <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[12px] text-fg-4">{hint}</span>}
    </button>
  );
}

/** More: the pages without a row of their own, and All conversations. */
function MoreRow({ path }: { path: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const owner = useIsOwner();
  const pages = MORE_PAGES.filter((p) => owner || !OWNER_PAGES.has(p.to));
  const on = pages.some((p) => isActive(p, path));
  const items: MenuItem[] = [
    ...pages.map((p) => ({ label: p.label, hint: p.key ? `G ${p.key.toUpperCase()}` : undefined, checked: isActive(p, path) || undefined, onSelect: () => navigate(p.to) })),
    { separator: true, label: '' },
    { label: 'All conversations', hint: 'G S', checked: path === '/sessions' || undefined, onSelect: () => navigate('/sessions') },
  ];
  return (
    <>
      <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn(ROW, on || open ? ROW_ON : ROW_IDLE)}>
        <Ellipsis className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">More</span>
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="right-start" width={232} maxHeight={520} label="More pages">
        <MenuList items={items} onDone={() => setOpen(false)} label="More pages" />
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// The sessions
// ---------------------------------------------------------------------------

/** The mode's sessions in groups, with Group by (Code) and All conversations. `phone`: the drawer's sizes. */
export function SideSessions({ mode, phone, onPick }: { mode: SideMode; phone?: boolean; onPick?: () => void }) {
  const sessions = useHub((s) => s.sessions);
  const projects = useHub((s) => s.projects);
  const devices = useHub((s) => s.devices);
  const approvals = useHub((s) => s.approvals);
  const questions = useHub((s) => s.questions);
  const by = useUi((s) => s.sideGroup);
  const folded = useUi((s) => s.foldedGroups);
  const now = useNow(60_000);
  const [loc] = useLocation();
  const path = loc.split('?')[0];
  // a subagent's request waits on you in the conversation it shows in (lib/asks.ts)
  const waiting = useMemo(() => new Set([...Object.values(approvals), ...Object.values(questions)].flatMap((x) => [x.sessionId, askHome(x)])), [approvals, questions]);
  const groups = useMemo(() => sideGroups({ sessions: Object.values(sessions), mode, by, ctx: { projects, devices }, waiting, now }), [sessions, mode, by, projects, devices, waiting, now]);
  const delegated = useMemo(() => delegatedRows({ sessions: Object.values(sessions), ctx: { projects, devices }, waiting }), [sessions, projects, devices, waiting]);
  const actions = useRowActions();
  const code = mode === 'code';
  const empty = mode === 'chat' ? 'Chats you start show up here.' : mode === 'assistant' ? 'Conversations with your assistant show up here.' : 'Sessions you start show up here, by project.';

  return (
    <section aria-label={sideListWord(mode)}>
      <div className={cn('flex items-center gap-2 pr-1 pl-2.5', phone ? 'h-11' : 'h-7')}>
        <h2 className={cn('m-0 min-w-0 flex-1 truncate font-medium text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>{sideListWord(mode)}</h2>
        {code && <GroupBy by={by} phone={phone} />}
      </div>
      {groups.length === 0 && <p className={cn('m-0 px-2.5 py-2 leading-[1.45] text-fg-3', phone ? 'text-[14px]' : 'text-[12.5px]')}>{empty}</p>}
      {groups.map((g) => (
        <Group key={g.key} g={g} folded={folded.includes(`${mode}:${g.key}`)} foldKey={`${mode}:${g.key}`} path={path} phone={phone} onPick={onPick} actions={actions} titled={g.key !== 'home' && (code || groups.length > 1 || g.key !== 'today')} />
      ))}
      {delegated.length > 0 && <DelegatedGroup rows={delegated} folded={folded.includes(DELEGATED_KEY)} path={path} phone={phone} onPick={onPick} actions={actions} />}
      <Link
        href="/sessions"
        onClick={onPick}
        className={cn('mt-2 flex items-center rounded-[8px] px-2.5 text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-side-hover hov:text-fg', phone ? 'min-h-11 text-[15px]' : 'h-8 text-[13px]', path === '/sessions' && 'bg-side-active text-fg')}
      >
        All conversations
      </Link>
      {actions.dialogs}
    </section>
  );
}

function GroupBy({ by, phone }: { by: SideGroupBy; phone?: boolean }) {
  return (
    <Menu
      label="Group by"
      width={180}
      items={[{ group: true, label: 'Group by' }, ...(['project', 'device', 'time'] as SideGroupBy[]).map((g) => ({ label: SIDE_GROUP_WORDS[g], checked: by === g, onSelect: () => useUi.getState().set({ sideGroup: g }) }))]}
      trigger={({ ref, props }) => (
        <button ref={ref} type="button" aria-label={`Group by, ${SIDE_GROUP_WORDS[by]}`} {...props} className={cn('flex items-center gap-1 rounded-[6px] px-1.5 text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-side-hover hov:text-fg', phone ? 'h-11 text-[13px]' : 'h-6 text-[12px]')}>
          {SIDE_GROUP_WORDS[by]}
          <ChevronDown className="size-3" strokeWidth={2} aria-hidden />
        </button>
      )}
    />
  );
}

function Group({ g, folded, foldKey, path, phone, onPick, actions, titled }: { g: SideGroupOut; folded: boolean; foldKey: string; path: string; phone?: boolean; onPick?: () => void; actions: RowActions; titled: boolean }) {
  const [, navigate] = useLocation();
  const [share, setShare] = useState(false);
  const owner = useIsOwner();
  const project = !!g.target || g.key.startsWith('p:') || g.key.startsWith('f:');
  const Chevron = folded ? ChevronRight : ChevronDown;
  const menu: MenuItem[] = [
    ...(g.target ? [{ label: 'New session here', onSelect: () => openNew('code', navigate, g.target) }] : []),
    { label: folded ? 'Show its sessions' : 'Fold it', onSelect: () => toggleFolded(foldKey) },
    ...(owner && g.projectId ? [{ label: 'Share with friends…', onSelect: () => setTimeout(() => setShare(true), 0) }] : []),
  ];
  return (
    <div role="group" aria-label={g.label} className={cn(titled && 'mt-2')}>
      {titled && (
        <div className={cn('group/head relative flex items-center rounded-[8px] hov:bg-side-hover', phone ? 'min-h-10' : 'h-7')}>
          <button type="button" aria-expanded={!folded} onClick={() => toggleFolded(foldKey)} className={cn('flex min-w-0 flex-1 items-center gap-1 self-stretch pl-2.5 text-left font-medium text-fg-3 hov:text-fg', phone ? 'text-[13px]' : 'text-[12px]', project && 'pr-14')}>
            <span className="min-w-0 truncate">{g.label}</span>
            <Chevron className={cn('size-3 shrink-0 text-fg-4 transition-opacity duration-[var(--dur-1)]', !folded && 'opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100')} strokeWidth={2} aria-hidden />
          </button>
          {project && (
            <span className={cn('absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 transition-opacity duration-[var(--dur-1)]', !phone && 'opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100 coarse:opacity-100')}>
              {g.target && (
                <Tooltip content={`New session in ${g.label}`}>
                  <button type="button" aria-label={`New session in ${g.label}`} onClick={() => openNew('code', navigate, g.target)} className={cn(HEAD_BTN, phone && 'size-9')}>
                    <Plus className="size-3.5" strokeWidth={2} aria-hidden />
                  </button>
                </Tooltip>
              )}
              {/* a phone folds a group with a tap on its name; its other actions are a computer's */}
              {!phone && (
                <Menu
                  label={`${g.label} actions`}
                  width={210}
                  items={menu}
                  trigger={({ ref, props }) => (
                    <button ref={ref} type="button" aria-label={`${g.label} actions`} {...props} className={HEAD_BTN}>
                      <Ellipsis className="size-3.5" strokeWidth={2} aria-hidden />
                    </button>
                  )}
                />
              )}
            </span>
          )}
        </div>
      )}
      {!folded && g.rows.map((r) => <Row key={r.id} r={r} active={path === r.href} phone={phone} onPick={onPick} actions={actions} />)}
      {g.projectId && <LazyShareProjectDialog open={share} onClose={() => setShare(false)} from={{ localProjectId: g.projectId, name: g.label }} />}
    </div>
  );
}

const HEAD_BTN = 'grid size-6 place-items-center rounded-[6px] text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-side-active hov:text-fg';

/** running: a small dot in signal that breathes. waiting: amber, still. */
export function StateDot({ state }: { state: 'running' | 'waiting' }) {
  return (
    <span className="relative inline-grid size-2 shrink-0 place-items-center" role="img" aria-label={state === 'running' ? 'Running' : 'Waiting on you'}>
      <span className={cn('size-1.5 rounded-full', state === 'running' ? 'bg-signal cv-dot-pulse' : 'bg-warn')} />
    </span>
  );
}

function Row({ r, active, phone, onPick, actions }: { r: SideRow; active: boolean; phone?: boolean; onPick?: () => void; actions: RowActions }) {
  return (
    <div className="group/row relative">
      <Link
        href={r.href}
        onClick={onPick}
        onContextMenu={(e: ReactMouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          actions.open(r.id, e.currentTarget);
        }}
        aria-current={active ? 'page' : undefined}
        className={cn(ROW, 'gap-2 pr-2', phone ? 'min-h-11 text-[15px]' : 'group-hover/row:pr-8 group-focus-within/row:pr-8', active ? ROW_ON : ROW_IDLE)}
      >
        <span className={cn('min-w-0 flex-1 truncate', r.unread && UNREAD)}>{r.title}</span>
        {r.unread && <span className="sr-only">, new reply</span>}
        {(r.device || r.state) && (
          <span className={cn('flex max-w-[45%] shrink-0 items-center gap-2', !phone && 'group-hover/row:hidden group-focus-within/row:hidden')}>
            {r.device && <span className={cn('min-w-0 truncate text-fg-4', phone ? 'text-[13px]' : 'text-[12px]')}>{r.device}</span>}
            {r.state && <StateDot state={r.state} />}
          </span>
        )}
      </Link>
      {!phone && (
        <button
          type="button"
          aria-label={`Actions for ${r.title}`}
          aria-haspopup="menu"
          onClick={(e) => actions.open(r.id, e.currentTarget)}
          className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-[6px] text-fg-3 opacity-0 transition-opacity duration-[var(--dur-1)] group-hover/row:opacity-100 group-focus-within/row:opacity-100 hov:bg-side-active hov:text-fg focus-visible:opacity-100"
        >
          <Ellipsis className="size-3.5" strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * Delegated work: a Delegate call's Code and Assistant sessions, newest
 * first, under the mode's list in every mode. It folds like a group, the
 * same on every switch. A row is the title and its dot, then a quiet second
 * line with who did it and where and the conversation it came from ("Code
 * on MadX Arch, from Capstone chat"); its menu has Move to main list.
 */
export function DelegatedGroup({ rows, folded, path, phone, onPick, actions }: { rows: DelegatedRow[]; folded: boolean; path: string; phone?: boolean; onPick?: () => void; actions: RowActions }) {
  const Chevron = folded ? ChevronRight : ChevronDown;
  return (
    <div role="group" aria-label={DELEGATED_WORDS} data-delegated-group="" className="mt-2">
      <div className={cn('group/head relative flex items-center rounded-[8px] hov:bg-side-hover', phone ? 'min-h-10' : 'h-7')}>
        <button type="button" aria-expanded={!folded} onClick={() => toggleFolded(DELEGATED_KEY)} className={cn('flex min-w-0 flex-1 items-center gap-1 self-stretch pl-2.5 text-left font-medium text-fg-3 hov:text-fg', phone ? 'text-[13px]' : 'text-[12px]')}>
          <span className="min-w-0 truncate">{DELEGATED_WORDS}</span>
          <Chevron className={cn('size-3 shrink-0 text-fg-4 transition-opacity duration-[var(--dur-1)]', !folded && 'opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100')} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {!folded && rows.map((r) => <DelegatedItem key={r.id} r={r} active={path === r.href} phone={phone} onPick={onPick} actions={actions} />)}
    </div>
  );
}

function DelegatedItem({ r, active, phone, onPick, actions }: { r: DelegatedRow; active: boolean; phone?: boolean; onPick?: () => void; actions: RowActions }) {
  return (
    <div className="group/row relative" data-delegated-row="">
      <Link
        href={r.href}
        onClick={onPick}
        onContextMenu={(e: ReactMouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          actions.open(r.id, e.currentTarget);
        }}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex w-full min-w-0 flex-col justify-center rounded-[8px] px-2.5 text-left transition-colors duration-[var(--dur-1)] focus-visible:-outline-offset-2',
          phone ? 'min-h-14 py-1.5 text-[15px]' : 'min-h-11 py-1 text-[13.5px] group-hover/row:pr-8 group-focus-within/row:pr-8',
          active ? ROW_ON : ROW_IDLE,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('min-w-0 flex-1 truncate', r.unread && UNREAD)}>{r.title}</span>
          {r.unread && <span className="sr-only">, new reply</span>}
          {r.state && (
            <span className={cn('flex shrink-0 items-center', !phone && 'group-hover/row:hidden group-focus-within/row:hidden')}>
              <StateDot state={r.state} />
            </span>
          )}
        </span>
        {/* the quiet second line: who did it and where, then the conversation it came from */}
        <span className={cn('block min-w-0 truncate leading-[1.35] text-fg-4', phone ? 'text-[13px]' : 'text-[12px]')}>
          <span className="text-fg-3">{r.who}</span>
          {r.from && `, ${r.from}`}
        </span>
      </Link>
      {!phone && (
        <button
          type="button"
          aria-label={`Actions for ${r.title}`}
          aria-haspopup="menu"
          onClick={(e) => actions.open(r.id, e.currentTarget)}
          className="absolute top-1.5 right-1 grid size-6 place-items-center rounded-[6px] text-fg-3 opacity-0 transition-opacity duration-[var(--dur-1)] group-hover/row:opacity-100 group-focus-within/row:opacity-100 hov:bg-side-active hov:text-fg focus-visible:opacity-100"
        >
          <Ellipsis className="size-3.5" strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A row's menu: Rename, Pin, Archive, Delete (delegated work: Move to main list first)
// ---------------------------------------------------------------------------

export interface RowActions {
  open: (id: string, anchor: HTMLElement) => void;
  dialogs: ReactNode;
}

function useRowActions(): RowActions {
  const anchor = useRef<HTMLElement | null>(null);
  const [id, setId] = useState<string>();
  const [rename, setRename] = useState<Session>();
  const [title, setTitle] = useState('');
  const [del, setDel] = useState<Session>();
  const session = useHub((s) => (id ? s.sessions[id] : undefined));
  const [loc, navigate] = useLocation();
  const later = (fn: () => void) => () => setTimeout(fn, 0);
  const patch = async (s: Session, p: { pinned?: boolean; archived?: boolean; title?: string }) => {
    const next = await attempt(() => api().updateSession(s.id, p));
    if (next) upsertSession(next);
  };
  const delegated = !!session && isDelegated(session);
  const items: MenuItem[] = session
    ? [
        // delegated work: Move to main list first; a pin would not show while it is in Delegated work
        ...(delegated ? [{ label: MOVE_TO_MAIN, onSelect: () => void moveToMainList(session.id) }] : []),
        {
          label: 'Rename',
          onSelect: later(() => {
            setTitle(session.title);
            setRename(session);
          }),
        },
        ...(delegated ? [] : [{ label: session.pinned ? 'Unpin' : 'Pin', onSelect: () => void patch(session, { pinned: !session.pinned }) }]),
        { label: 'Archive', onSelect: () => void patch(session, { archived: true }) },
        { separator: true, label: '' },
        { label: 'Delete', danger: true, onSelect: later(() => setDel(session)) },
      ]
    : [];
  const save = () => {
    const t = title.trim();
    if (rename && t && t !== rename.title) void patch(rename, { title: t });
    setRename(undefined);
  };
  const dialogs = (
    <>
      <Popover anchor={anchor as RefObject<HTMLElement | null>} open={!!session} onClose={() => setId(undefined)} placement="bottom-end" width={200} label="Session actions" sheetTitle={session?.title}>
        <MenuList items={items} onDone={() => setId(undefined)} label="Session actions" />
      </Popover>
      <Dialog
        open={!!rename}
        onClose={() => setRename(undefined)}
        title="Rename"
        footer={
          <>
            <Button variant="quiet" onClick={() => setRename(undefined)}>
              Cancel
            </Button>
            <Button variant="solid" disabled={!title.trim()} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(undefined)}
        title={del ? `Delete ${del.title}?` : 'Delete?'}
        body="Its messages leave the hub. Archive keeps them out of the list instead."
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          if (!del) return;
          const ok = await attempt(() => api().deleteSession(del.id));
          if (!ok) return;
          removeKey('sessions', del.id);
          if (loc.startsWith(`/s/${del.id}`) || loc.startsWith(`/chat/${del.id}`)) navigate('/', { replace: true });
        }}
      />
    </>
  );
  return {
    open: (sid, el) => {
      anchor.current = el;
      setId((cur) => (cur === sid ? undefined : sid));
    },
    dialogs,
  };
}
