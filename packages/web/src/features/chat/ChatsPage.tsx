/**
 * All conversations (/sessions, at the foot of the sidebar's list and under
 * More; spec 11.2): the full list with its filters, grouping and import, in
 * a column. A session opens on the conversation page at /s/:id
 * (features/home/ConversationPage.tsx). Given an id, this page shows the
 * conversation with its panel of cards at the right on wide screens.
 * Phones have their own list, Code (PhoneChats.tsx).
 */
import { useEffect } from 'react';
import { useLocation, useParams, useSearch } from 'wouter';
import { useHub } from '@/store/store';
import { openNewChat, useUi } from '@/store/ui';
import { useBreakpoint } from '@/lib/hooks';
import { SideSheet } from '@/components/ui/Overlay';
import { SessionList } from './SessionList';
import { ChatView, MissingChat } from './ChatView';
import { ContextPanel, PANEL_W } from './ContextPanel';
import { PhoneChats } from './PhoneChats';
import { ImportSheet } from '@/features/import/ImportSheet';
import { openImportSheet } from '@/features/import/store';
import { PreviewDock, usePreviewOpen } from '@/features/preview/PreviewPane';

const SHEET_KEY = 'conclave.chat.details';

export function ChatsPage() {
  const params = useParams<{ id?: string }>();
  const search = useSearch();
  const [, navigate] = useLocation();
  const id = params.id;
  const session = useHub((s) => (id ? s.sessions[id] : undefined));
  const booted = useHub((s) => s.booted);
  const previewing = usePreviewOpen((s) => !!id && s.id === id);
  const bp = useBreakpoint();
  const contextOpen = useUi((s) => s.contextOpen);
  const drawer = useUi((s) => s.drawerOpen);
  const setDrawer = (v: boolean) => useUi.getState().set({ drawerOpen: v });

  useEffect(() => {
    const q = new URLSearchParams(search);
    if (q.has('new')) {
      openNewChat();
      navigate('/sessions', { replace: true });
    }
    // Import past chats (List options, the command palette): the shared import sheet
    if (q.has('import')) {
      const device = q.get('import');
      openImportSheet(device && device !== '1' ? device : undefined);
      navigate(id ? `/s/${id}` : '/sessions', { replace: true });
    }
  }, [search, navigate, id]);

  // desktop below 1280 remembers whether the details sheet was open; phones always start closed
  useEffect(() => {
    if (bp !== 'desktop') {
      if (bp === 'phone') useUi.getState().set({ drawerOpen: false });
      return;
    }
    try {
      if (localStorage.getItem(SHEET_KEY) === '1') useUi.getState().set({ drawerOpen: true });
    } catch {
      /* private mode */
    }
  }, [bp]);
  useEffect(() => {
    if (bp !== 'desktop') return;
    try {
      localStorage.setItem(SHEET_KEY, drawer ? '1' : '0');
    } catch {
      /* private mode */
    }
  }, [drawer, bp]);
  useEffect(() => {
    if (bp === 'phone') useUi.getState().set({ drawerOpen: false });
  }, [id, bp]);
  useEffect(() => () => useUi.getState().set({ drawerOpen: false }), []);

  const missing = !!id && !session && booted;

  if (bp === 'phone') {
    // Code on a phone: agent sessions on your devices
    if (!id) return <PhoneChats kind="code" />;
    if (missing) return <MissingChat />;
    if (!session) return null;
    // a phone's details are in the session's sheet (ConversationSheet.tsx)
    return (
      <div className="flex min-h-0 flex-1">
        <ChatView session={session} />
        <ImportSheet />
        <PreviewDock session={session} />
      </div>
    );
  }

  // All conversations: the full list in a column; the sidebar already lists the mode's latest
  if (!session)
    return (
      <div className="flex min-h-0 flex-1 justify-center">
        <div className="flex min-h-0 w-full max-w-[760px] flex-col px-4 pt-6">
          <h1 className="t-page m-0 px-4 pb-1 text-fg">All conversations</h1>
          {missing ? <MissingChat /> : <SessionList activeId={id} />}
        </div>
        <ImportSheet />
      </div>
    );
  const wide = bp === 'wide';
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1">
        <ChatView session={session} />
      </div>
      <ImportSheet />
      <PreviewDock session={session} />
      {wide && contextOpen && !previewing && (
        <div className="shrink-0 anim-right" style={{ width: PANEL_W }}>
          <ContextPanel session={session} />
        </div>
      )}
      {!wide && (
        <SideSheet open={drawer} onClose={() => setDrawer(false)} width={PANEL_W} label="Session details" modal={false}>
          <ContextPanel session={session} onClose={() => setDrawer(false)} />
        </SideSheet>
      )}
    </div>
  );
}
