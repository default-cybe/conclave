/**
 * The phone frame (the iPhone app, docs/design/MOBILE-V2.md 1 and 2, and
 * docs/design/SPEC.md 5.3): a top bar on every screen and a drawer instead of
 * a tab bar.
 *
 * The bar is 56px with no border: the menu button (a back arrow on the
 * pages and on inner pages), the screen's title in one line, and New chat
 * (pencil on square). On a conversation the title opens its sheet; the
 * conversation draws its own bar for that.
 *
 * Home's bar has the Chat, Assistant and Code switch in place of a title
 * (features/home/ModeSwitch.tsx).
 *
 * The drawer opens from the left over a dim scrim, 85% of the width and at
 * most 360px, from the menu button or a swipe from the left edge. It is as
 * plain as the Claude app's: the switch, New and Search, the Inbox while
 * something waits on you, the mode's sessions grouped as on the desktop
 * (Code by project, device or time; chats and the assistant's by time) and
 * All conversations, with the account row at its foot. Every other page is
 * under Settings, in its More list.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, ChevronDown, Inbox, Search, SquarePen } from 'lucide-react';
import { openPalette, useUi } from '@/store/ui';
import { cn } from '@/lib/text';
import { NEW_WORDS } from '@/lib/sidebar';
import { useReducedMotion } from './motion';
import { ModeSwitch } from '@/features/home/ModeSwitch';
import { useStartMode, type StartMode } from '@/features/home/start';
import { AccountRow } from './AccountMenu';
import { SideSessions } from './Sidebar';
import { useInboxCount } from './nav';

// ---------------------------------------------------------------------------
// Places and titles
// ---------------------------------------------------------------------------

/**
 * Where a route sits on a phone. main: Home, Chats, Code and the Inbox, with
 * the menu button. conversation: a chat, a session, a friend's notes or a
 * share from a friend, which draws its own bar (its title opens its sheet).
 * page: a page behind More or Settings, with a back arrow. inner: a page
 * under one of those, back to it.
 */
export type PhonePlace = 'main' | 'conversation' | 'page' | 'inner';

/** Pages with a back arrow and their title in the bar (reached from Settings, in its More list). */
const PAGES: Array<{ to: string; label: string }> = [
  { to: '/map', label: 'Map' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/goals', label: 'Goals' },
  { to: '/routines', label: 'Routines' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/agents', label: 'Agents' },
  { to: '/extensions', label: 'Extensions' },
  { to: '/memory', label: 'Memory' },
  { to: '/usage', label: 'Usage' },
  { to: '/devices', label: 'Devices' },
  { to: '/settings', label: 'Settings' },
];

const MAIN: Record<string, string> = { '/': '', '/chats': 'Chats', '/sessions': 'Code', '/approvals': 'Inbox', '/inbox': 'Inbox' };

const under = (path: string, root: string) => path === root || path.startsWith(root + '/');

/** An inner page's title and the page it belongs to. */
function innerOf(path: string): { title: string; back: string } | undefined {
  if (path.startsWith('/settings/')) return { title: 'Settings', back: '/settings' };
  if (path === '/shares') return { title: 'Shares', back: '/settings/friends' };
  if (path === '/projects') return { title: 'Shared projects', back: '/settings/friends' };
  if (path.startsWith('/routines/')) return { title: path === '/routines/new' ? 'New routine' : 'Routine', back: '/routines' };
  if (path.startsWith('/agents/')) return { title: 'Agent', back: '/agents' };
  if (path.startsWith('/tasks/')) return { title: 'Task', back: '/tasks' };
  if (path.startsWith('/goals/')) return { title: 'Goal', back: '/goals' };
  if (path.startsWith('/devices/')) return { title: 'Files', back: '/devices' };
  if (path.startsWith('/workflows/runs/')) return { title: 'Run', back: '/workflows' };
  if (path.startsWith('/memory/')) return { title: 'Memory', back: '/memory' };
  if (path.startsWith('/extensions/')) return { title: 'Extensions', back: '/extensions' };
  return undefined;
}

export function phonePlace(path: string): PhonePlace {
  const p = path.split('?')[0];
  if (p in MAIN) return 'main';
  if (p.startsWith('/s/') || p === '/chat' || p.startsWith('/chat/') || /^\/settings\/friends\/[^/]+$/.test(p) || /^\/shares\/[^/]+$/.test(p) || /^\/projects\/[^/]+$/.test(p)) return 'conversation';
  if (PAGES.some((x) => x.to === p) || p === '/workflows/runs') return 'page';
  return 'inner';
}

/** The bar's title and, off the main screens, where back goes when there is no screen to go back to. */
export function phoneTitle(path: string): { title: string; back?: string } {
  const p = path.split('?')[0];
  if (p in MAIN) return { title: MAIN[p] };
  const page = PAGES.find((x) => x.to === p);
  // the pages are in Settings' More list: back goes there when nothing in this app came before
  if (page) return { title: page.label, back: p === '/settings' ? '/' : '/settings' };
  if (p === '/workflows/runs') return { title: 'Workflows', back: '/settings' };
  return innerOf(p) ?? { title: '', back: '/' };
}

/** The place a list or a conversation belongs to, for New chat: Code starts a session, the rest a chat. */
export function startsCode(path: string): boolean {
  return under(path, '/sessions') || path.startsWith('/s/');
}

// ---------------------------------------------------------------------------
// Back
// ---------------------------------------------------------------------------

// Screens opened in this app behind the current one. wouter announces each
// pushState; a popstate (Back, or the arrow) takes one off. Forward is rare on
// a phone and only makes the count high, which Back then corrects.
let depth = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('pushState', () => depth++);
  window.addEventListener('popstate', () => (depth = Math.max(0, depth - 1)));
}

/** Back to the screen before, or to `fallback` when this one was opened first (a link, a reload). */
export function goBack(navigate: (to: string, opts?: { replace?: boolean }) => void, fallback = '/') {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** Open Home as a new conversation in a mode: the switch's own unless one is named. */
export function newChat(navigate: (to: string) => void, mode?: StartMode) {
  useUi.setState({ panelOpen: false });
  navigate(`/?${mode ?? useStartMode.getState().mode}`);
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

const ICON_BTN = 'grid size-11 shrink-0 place-items-center rounded-full text-fg transition-colors duration-[var(--dur-1)] active:bg-hover';

/** Two lines, the lower one shorter: the menu, as the side panel's way in. */
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden>
      <path d="M4 8.5h16M4 15.5h10" />
    </svg>
  );
}

export function PhoneBar({
  lead = 'menu',
  back = '/',
  title,
  onTitle,
  titleLabel,
  code,
  heading = true,
  className,
}: {
  lead?: 'menu' | 'back';
  /** Where back goes when nothing in this app came before. */
  back?: string;
  title?: ReactNode;
  /** The title opens something (a conversation's sheet). */
  onTitle?: () => void;
  /** The title button's name for a screen reader. */
  titleLabel?: string;
  /** New starts a Code session (from the Code list). Else the switch's mode. */
  code?: boolean;
  /** The title is the screen's heading (h1). Off for a page that has its own. */
  heading?: boolean;
  className?: string;
}) {
  const [, navigate] = useLocation();
  const open = useUi((s) => s.panelOpen);
  const mode = useStartMode((s) => s.mode);
  const words = (
    <span className="min-w-0 truncate text-[17px] leading-[1.25] font-semibold tracking-[-0.01em] text-fg" style={{ fontStretch: '102%' }}>
      {title}
    </span>
  );
  const Title = heading && title ? 'h1' : 'div';
  return (
    <header className={cn('z-20 shrink-0 bg-bg pt-safe', className)}>
      <div className="grid h-14 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-1 px-2.5">
        {lead === 'menu' ? (
          <button type="button" aria-label="Open the menu" aria-expanded={open} aria-haspopup="dialog" onClick={() => useUi.setState({ panelOpen: true })} className={ICON_BTN} data-panel-button>
            <MenuIcon />
          </button>
        ) : (
          <button type="button" aria-label="Back" onClick={() => goBack(navigate, back)} className={ICON_BTN}>
            <ArrowLeft className="size-6" strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {onTitle ? (
          <Title className="m-0 flex min-w-0 justify-center">
            <button type="button" onClick={onTitle} aria-label={titleLabel} aria-haspopup="dialog" className="flex h-11 max-w-full min-w-0 items-center gap-1 rounded-full px-2 active:bg-hover">
              {words}
              <ChevronDown className="size-4 shrink-0 text-fg-3" strokeWidth={2} aria-hidden />
            </button>
          </Title>
        ) : (
          <Title className="m-0 flex min-w-0 justify-center px-2">{words}</Title>
        )}
        <button type="button" aria-label={NEW_WORDS[code ? 'code' : mode]} onClick={() => newChat(navigate, code ? 'code' : undefined)} className={ICON_BTN}>
          <SquarePen className="size-[22px]" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </header>
  );
}

/** The bar the shell draws for a screen that does not draw its own: its title from the route or the page (usePageHeader). */
export function ShellBar({ path }: { path: string }) {
  const header = useUi((s) => s.header);
  const place = phonePlace(path);
  const route = phoneTitle(path);
  // Home has the switch for a title
  if (path.split('?')[0] === '/') return <PhoneBar title={<ModeSwitch phone />} heading={false} />;
  // a main screen inside itself (the archived chats) leads back to it
  if (place === 'main' && !header?.back) return <PhoneBar title={route.title} code={startsCode(path)} />;
  const title = header?.title ?? route.title;
  // a page has its own heading (PageHeader keeps it for screen readers)
  return <PhoneBar lead="back" back={header?.back ?? route.back} title={title} heading={place === 'main'} />;
}

// ---------------------------------------------------------------------------
// The side panel
// ---------------------------------------------------------------------------

const PANEL_MAX = 360;
const EDGE = 24;
/** The panel slides 240ms; a drag lets go with the rest of that. */
const SLIDE_MS = 240;

function panelWidth() {
  return Math.min(window.innerWidth * 0.85, PANEL_MAX);
}

/** A finger from the left edge pulls the panel out; on the panel or the scrim, a swipe to the left puts it back. */
function useSwipe(setDrag: (x: number | null) => void) {
  useEffect(() => {
    let start: { x: number; y: number; t: number; open: boolean } | null = null;
    let engaged = false;
    let last = 0;
    const blocked = () => !!document.querySelector('[role=dialog][aria-modal=true]:not([data-panel])');
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const isOpen = useUi.getState().panelOpen;
      if (!isOpen && (t.clientX > EDGE || blocked())) return;
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp, open: isOpen };
      engaged = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!engaged) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          start = null;
          return;
        }
        if (start.open ? dx > -10 : dx < 10) return;
        engaged = true;
      }
      e.preventDefault();
      const w = panelWidth();
      last = dx;
      setDrag(Math.max(-w, Math.min(0, start.open ? dx : dx - w)));
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const was = start;
      start = null;
      if (!engaged) return;
      engaged = false;
      const w = panelWidth();
      const speed = last / Math.max(1, e.timeStamp - was.t);
      const open = was.open ? !(last < -w * 0.3 || speed < -0.4) : last > w * 0.35 || speed > 0.4;
      useUi.setState({ panelOpen: open });
      setDrag(null);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [setDrag]);
}

export function SidePanel() {
  const open = useUi((s) => s.panelOpen);
  const [loc] = useLocation();
  const reduced = useReducedMotion();
  const [drag, setDrag] = useState<number | null>(null);
  // mounted while open, dragged or sliding away; `shown` turns on a frame after mount so it slides in
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  useSwipe(setDrag);

  useLayoutEffect(() => {
    if (open || drag !== null) setMounted(true);
  }, [open, drag]);
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    if (drag !== null) return;
    const t = setTimeout(() => setMounted(false), reduced ? 0 : SLIDE_MS);
    return () => clearTimeout(t);
  }, [open, drag, reduced]);

  // a new screen closes it
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    useUi.setState({ panelOpen: false });
  }, [loc]);

  // Esc closes it; Tab stays inside. The panel takes the focus, not its first row, so nothing is
  // highlighted by surprise; closing gives it back to the menu button if it was inside
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    requestAnimationFrame(() => el?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        useUi.setState({ panelOpen: false });
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const list = [...el.querySelectorAll<HTMLElement>('a[href],button')];
      if (!list.length) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && at === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (el?.contains(document.activeElement)) document.querySelector<HTMLElement>('[data-panel-button]')?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;
  const w = typeof window === 'undefined' ? PANEL_MAX : panelWidth();
  const x = drag ?? (shown && open ? 0 : -w);
  const progress = 1 + x / w;
  const moving = drag !== null || reduced ? 'none' : `transform ${SLIDE_MS}ms var(--ease), opacity ${SLIDE_MS}ms var(--ease)`;
  const close = () => useUi.setState({ panelOpen: false });

  return createPortal(
    <div className="fixed inset-0 z-[60]" style={{ pointerEvents: open || drag !== null ? 'auto' : 'none' }}>
      <div aria-hidden className="absolute inset-0" style={{ background: 'var(--scrim)', opacity: progress, transition: moving }} onClick={close} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        data-panel
        tabIndex={-1}
        inert={!open || undefined}
        className="absolute inset-y-0 left-0 flex flex-col bg-side pt-safe pb-safe outline-none"
        style={{ width: w, transform: `translateX(${x}px)`, transition: moving, boxShadow: progress > 0 ? 'var(--shadow-pop)' : undefined }}
      >
        <PanelBody />
      </div>
    </div>,
    document.body,
  );
}

function PanelBody() {
  const [loc, navigate] = useLocation();
  const inbox = useInboxCount();
  const mode = useStartMode((s) => s.mode);
  const path = loc.split('?')[0];
  const close = () => useUi.setState({ panelOpen: false });
  return (
    <>
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pt-2 pb-4">
        <ModeSwitch phone className="mx-1 mb-2 w-fit" />
        <MainRow Icon={SquarePen} label={NEW_WORDS[mode]} onClick={() => newChat(navigate)} />
        <MainRow
          Icon={Search}
          label="Search"
          onClick={() => {
            close();
            openPalette();
          }}
        />
        {inbox > 0 && (
          <MainRow Icon={Inbox} label="Inbox" to="/approvals" active={path === '/approvals' || path === '/inbox'}>
            <span className="num ml-auto text-[15px] font-medium text-warn">
              {inbox}
              <span className="sr-only"> waiting on you</span>
            </span>
          </MainRow>
        )}
        <div className="mt-4">
          <SideSessions mode={mode} phone onPick={close} />
        </div>
      </nav>
      <footer className="shrink-0 px-2.5 pt-1.5 pb-1.5">
        <AccountRow phone />
      </footer>
    </>
  );
}

const ROW = 'relative flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left transition-colors duration-[var(--dur-1)] active:bg-side-hover';

function MainRow({ Icon, label, to, onClick, active, children }: { Icon: ComponentType<{ className?: string; strokeWidth?: number }>; label: string; to?: string; onClick?: () => void; active?: boolean; children?: ReactNode }) {
  const inner = (
    <>
      <Icon className="size-[22px] shrink-0 text-fg-2" strokeWidth={1.75} aria-hidden />
      <span className="text-[16px] font-medium text-fg">{label}</span>
      {children}
    </>
  );
  const cls = cn(ROW, 'min-h-12', active && 'bg-side-active');
  if (to)
    return (
      <Link href={to} aria-current={active ? 'page' : undefined} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

/**
 * iOS keeps the page's size when the keyboard opens (Safari and the iPhone
 * app's WebView ignore interactive-widget=resizes-content) and scrolls the
 * page to show the field. The frame takes the visible part's height and
 * follows its scroll instead, so the bar stays at the top and the composer
 * sits on the keyboard. Returns whether the keyboard is open.
 */
export function useVisibleViewport(on: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!on || !vv) return;
    const fit = () => {
      const covered = window.innerHeight - vv.height;
      const kb = covered > 80;
      setOpen(kb);
      if (kb) {
        root.style.setProperty('--vv-h', `${vv.height}px`);
        root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      } else {
        root.style.removeProperty('--vv-h');
        root.style.removeProperty('--vv-top');
      }
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
      root.style.removeProperty('--vv-h');
      root.style.removeProperty('--vv-top');
    };
  }, [on]);
  return on && open;
}
