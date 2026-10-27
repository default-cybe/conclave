/**
 * App shell (docs/design/SPEC.md 5.3). Desktop and tablet, like the Claude
 * app: the sidebar at the left (the mark, the Chat, Assistant and Code
 * switch, Search, New, the pages, the mode's sessions and the account row)
 * and the page beside it. There is no top bar: a conversation keeps its own
 * header (title, state, its menu and the panel toggle) at the top of its
 * column. Settings opens over the page (features/settings/SettingsOverlay).
 *
 * Phone (the iPhone app, docs/design/MOBILE-V2.md): no sidebar and no tab
 * bar. A top bar on every screen and the drawer (PhoneFrame.tsx). A chat or
 * a session draws its own bar, whose title opens its sheet; its composer
 * sits at the bottom, on the keyboard while it is open.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { openNewChat, openPalette, toggleContext, toggleTheme, useUi } from '@/store/ui';
import { useBreakpoint } from '@/lib/hooks';
import { setRailOpen, useChatUi } from '@/features/conversation/state';
import { CommandPalette } from './CommandPalette';
import { ShortcutsSheet } from './ShortcutsSheet';
import { ShellBar, SidePanel, phonePlace, useVisibleViewport } from './PhoneFrame';
import { NewChatSheet } from '@/features/chat/NewChatSheet';
import { OfflineBanner } from '@/features/connect/OfflineBanner';
import { UpdateBanners } from '@/components/UpdateBanners';
import { Sidebar } from './Sidebar';
import { useMarkSeen } from '@/lib/seen';
import { isActive, NAV, SETTINGS_NAV } from './nav';

export { NAV, SETTINGS_NAV, OWNER_PAGES, useNav, useInboxCount, type NavItem } from './nav';

/** The titles of inner pages (ones with a way back), for the window's title. Pages can set their own with usePageHeader. */
function routeTitle(path: string): { title: string; back?: string } | undefined {
  if (path.startsWith('/s/')) return { title: useHub.getState().sessions[path.slice(3).split('/')[0]]?.title ?? 'Session', back: '/sessions' };
  if (path.startsWith('/settings/')) return { title: 'Settings', back: '/settings' };
  if (path.startsWith('/routines/')) return { title: path === '/routines/new' ? 'New routine' : 'Routine', back: '/routines' };
  if (path.startsWith('/agents/')) return { title: 'Agent', back: '/agents' };
  if (path.startsWith('/tasks/')) return { title: 'Task', back: '/tasks' };
  if (path.startsWith('/goals/')) return { title: 'Goal', back: '/goals' };
  if (path.startsWith('/devices/')) return { title: 'Files', back: '/devices' };
  return undefined;
}

/**
 * The window's title, "Inbox, Conclave": the page's own (usePageHeader), a
 * session's title, else the nav item the path belongs to. Home is
 * "Conclave". Browser tabs, the Dock and the taskbar, and the desktop app's
 * window (it follows document.title) tell the pages apart by it.
 */
export function pageTitle(path: string, own?: string): string {
  const name = own ?? (path === '/' ? undefined : ([...NAV, SETTINGS_NAV].find((n) => isActive(n, path))?.label ?? routeTitle(path)?.title));
  return name ? `${name}, Conclave` : 'Conclave';
}

function useDocumentTitle(path: string) {
  const header = useUi((s) => s.header?.title);
  const session = useHub((s) => (path.startsWith('/s/') ? (s.sessions[path.slice(3).split('/')[0]]?.title ?? 'Session') : undefined));
  useEffect(() => {
    document.title = pageTitle(path, header ?? session);
  }, [path, header, session]);
  useEffect(() => () => void (document.title = 'Conclave'), []);
}

export function Shell({ children }: { children: ReactNode }) {
  const bp = useBreakpoint();
  const phone = bp === 'phone';
  const [loc] = useLocation();
  const keyboardOpen = useVisibleViewport(phone);
  useGlobalKeys();
  useDocumentTitle(loc);
  useMarkSeen(loc);
  return (
    <div
      className="flex h-full w-full overflow-hidden bg-bg"
      // phones: the part the keyboard leaves, so the bar stays at the top and the composer on the keyboard
      style={phone ? { height: 'var(--vv-h, 100%)', transform: 'translateY(var(--vv-top, 0px))' } : undefined}
      // the shell never scrolls: a scrollIntoView that ran out of room in a page moved it, and the bar with it
      onScroll={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.scrollTop) e.currentTarget.scrollTop = 0;
      }}
    >
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-[var(--r-1)] focus:bg-raise focus:px-3 focus:py-2 focus:text-[13px]">
        Skip to content
      </a>
      {!phone && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {phone && phonePlace(loc) !== 'conversation' && <ShellBar path={loc} />}
        <OfflineBanner />
        <UpdateBanners />
        {/* Phones: the keyboard covers the home indicator, so pages inside never pad for it while it is open. */}
        <main id="main" className={cn('relative flex min-h-0 flex-1 flex-col', !phone && 'pt-safe', keyboardOpen && '[--safe-b:0px]')}>
          {children}
        </main>
      </div>
      {phone && <SidePanel />}
      <CommandPalette />
      <ShortcutsSheet />
      <NewChatSheet />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyboard (spec 11.14)
// ---------------------------------------------------------------------------

/** Open a new chat (⌘⇧O, the phone New button on the Chat page) and put the cursor in its composer. */
function newChat(navigate: (to: string) => void) {
  navigate('/chat');
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-composer]')?.focus());
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

function useGlobalKeys() {
  const [, navigate] = useLocation();
  const pending = useRef<string | null>(null);
  const routes = useMemo(() => Object.fromEntries([...NAV, SETTINGS_NAV].map((n) => [n.key, n.to])) as Record<string, string>, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const ui = useUi.getState();
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === 'k') {
        e.preventDefault();
        if (ui.paletteOpen) ui.set({ paletteOpen: false });
        else openPalette();
        return;
      }
      if (mod && !e.shiftKey && k === 'n') {
        e.preventDefault();
        openNewChat();
        return;
      }
      if (mod && e.shiftKey && k === 'o') {
        e.preventDefault();
        newChat(navigate);
        return;
      }
      if (mod && e.key === '.') {
        e.preventDefault();
        toggleTheme();
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        navigate('/settings');
        return;
      }
      // the sidebar; with Shift, the session panel
      if (mod && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault();
        if (e.shiftKey) toggleContext();
        else setRailOpen(!useChatUi.getState().railOpen);
        return;
      }
      if (mod && e.shiftKey && k === 'm') {
        e.preventDefault();
        openPalette('model');
        return;
      }
      if (isTyping(e) || mod || e.altKey) return;
      if (ui.paletteOpen || ui.newChatOpen || document.querySelector('[role=dialog][aria-modal=true]')) return;
      if (e.key === '?') {
        e.preventDefault();
        ui.set({ shortcutsOpen: !ui.shortcutsOpen });
        return;
      }
      if (pending.current === 'g') {
        pending.current = null;
        const to = routes[k];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
      if (k === 'g') {
        pending.current = 'g';
        clearTimeout(timer);
        timer = setTimeout(() => (pending.current = null), 1000);
        return;
      }
      if (e.key === '/') {
        const box = document.querySelector<HTMLElement>('[data-composer],[data-quickstart]');
        if (box) {
          e.preventDefault();
          box.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, routes]);
}
