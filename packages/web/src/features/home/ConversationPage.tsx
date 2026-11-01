/**
 * The conversation screen (docs/DESIGN.md 15, docs/design/SPEC.md 5.3): Home,
 * Chat and Sessions are one place. The shell's sidebar lists the mode's
 * conversations; this page is the conversation, or a new one: the greeting
 * and the box. A chat is the Chat page (conversation/ChatPage.tsx); this
 * page has the Assistant's and Code's, at / and /s/:id. A session's panel
 * of cards (ContextPanel.tsx) sits at the right on wide screens and opens as
 * a sheet below 1280.
 *
 * Phones (docs/design/MOBILE-V2.md): a new conversation is PhoneHome, a
 * session full width under its own bar; the sidebar is the drawer.
 */
import { useEffect, useState, type DragEvent } from 'react';
import { useParams } from 'wouter';
import { useHub } from '@/store/store';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/text';
import { useBreakpoint } from '@/lib/hooks';
import { SideSheet } from '@/components/ui/Overlay';
import { usePageHeader } from '@/components/ui/Page';
import { ChatView, MissingChat } from '@/features/chat/ChatView';
import { ContextPanel, PANEL_W } from '@/features/chat/ContextPanel';
import { ImportSheet } from '@/features/import/ImportSheet';
import { FILES_EVENT } from '@/features/conversation/ChatComposer';
import { PreviewSheet } from '@/features/conversation/Preview';
import { PreviewDock, usePreviewOpen } from '@/features/preview/PreviewPane';
import { EmptyConversation } from './EmptyConversation';
import { PhoneHome } from './PhoneHome';
import { modeOf, setStartMode, useStartMode } from './start';

export default function ConversationPage() {
  const { id } = useParams<{ id?: string }>();
  const session = useHub((s) => (id ? s.sessions[id] : undefined));
  const booted = useHub((s) => s.booted);
  const remembered = useStartMode((s) => s.mode);
  const fresh = useStartMode((s) => s.fresh);
  const bp = useBreakpoint();
  const phone = bp === 'phone';
  const wide = bp === 'wide';
  const contextOpen = useUi((s) => s.contextOpen);
  const drawer = useUi((s) => s.drawerOpen);
  const [drag, setDrag] = useState(false);
  const previewing = usePreviewOpen((s) => !!id && s.id === id);
  const mode = session ? modeOf(session) : remembered;
  const setDrawer = (v: boolean) => useUi.getState().set({ drawerOpen: v });

  // an open session sets the switch, so New and the sidebar stay in its mode
  useEffect(() => {
    if (session && session.kind !== 'chat') setStartMode(modeOf(session));
  }, [session?.id, session?.agent, session?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => useUi.getState().set({ drawerOpen: false }), []);

  usePageHeader(session ? session.title : undefined);

  const missing = !!id && !session && booted;

  if (phone) {
    if (!id) return <PhoneHome />;
    if (missing) return <MissingChat />;
    if (!session) return null;
    return (
      <div className="flex min-h-0 flex-1">
        <ChatView session={session} />
        <ImportSheet />
        <PreviewDock session={session} />
      </div>
    );
  }

  // the Preview column takes the panel's place
  const panel = !!session && wide && contextOpen && !previewing;
  const sideMode = mode === 'chat' ? 'assistant' : mode;

  const onDragOver = (e: DragEvent) => {
    if (session || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (!drag) setDrag(true);
  };
  const onDrop = (e: DragEvent) => {
    setDrag(false);
    if (session || !e.dataTransfer.files.length) return;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent(FILES_EVENT, { detail: Array.from(e.dataTransfer.files) }));
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn('relative flex min-w-0 flex-1 flex-col outline-offset-[-8px]', drag && 'outline-1 outline-rule-2 outline-dashed')}
        onDragOver={onDragOver}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrag(false)}
        onDrop={onDrop}
      >
        {session ? (
          <div className="flex min-h-0 flex-1">
            <ChatView session={session} />
          </div>
        ) : missing ? (
          <MissingChat />
        ) : (
          // a new conversation in a place (a project's + in the sidebar) draws the box again, so it reads the new picks
          <EmptyConversation key={fresh} mode={sideMode} />
        )}
      </div>
      <ImportSheet />
      {/* an artifact from the panel's Outputs */}
      <PreviewSheet />
      {panel && (
        <div className="shrink-0 anim-right" style={{ width: PANEL_W }}>
          <ContextPanel session={session} />
        </div>
      )}
      {session && <PreviewDock session={session} />}
      {session && !wide && (
        <SideSheet open={drawer} onClose={() => setDrawer(false)} width={PANEL_W} label="Session details" modal={false}>
          <ContextPanel session={session} onClose={() => setDrawer(false)} />
        </SideSheet>
      )}
    </div>
  );
}
