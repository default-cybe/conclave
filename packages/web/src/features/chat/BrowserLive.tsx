/**
 * The live view of a session's browser: while one of its browser tool calls
 * runs, or its page is open on the hub, one small line above the composer,
 * "Browser, working on example.com", with Watch. Watch opens the page live
 * (a dialog; a sheet on a phone). Take over hands the owner the page: clicks,
 * scrolling, keys and text go to it, and the session's next browser tool
 * call waits until Give back (routes-browser.ts, BrowserManager.waitForOwner).
 * Closing the view gives the browser back too.
 *
 * The rules of when it shows are in liveBrowser.ts (test/browser-live.test.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import { Globe, Monitor } from 'lucide-react';
import type { BrowserLiveDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { attempt, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { RemotePage } from '@/features/settings/RemotePage';
import { browserCalls, liveWords, showLive } from './liveBrowser';
import { usePreviewOpen, togglePreview } from '@/features/preview/PreviewPane';

/** How often the line asks the hub whether the session's page is open, while the session has used the browser. */
const STATUS_MS = 3_000;

/** The Preview pane's switch (features/preview), on the live line's row; Code sessions only. */
export function PreviewButton({ sessionId }: { sessionId: string }) {
  const open = usePreviewOpen((s) => s.id === sessionId);
  return (
    <button
      type="button"
      data-preview-button=""
      aria-pressed={open}
      onClick={() => togglePreview(sessionId)}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-rule-2 bg-raise px-2.5 text-[12.5px] transition-colors duration-[var(--dur-1)] hov:text-fg phone:h-9 phone:px-3.5 phone:text-[14px]',
        open ? 'text-fg' : 'text-fg-2',
      )}
    >
      <Monitor aria-hidden strokeWidth={1.75} className={cn('size-3.5', open ? 'text-signal' : 'text-fg-3')} />
      Preview
    </button>
  );
}

/** narrow: the Chat page's column (784px), else the session view's (924px). preview: show the Preview switch on the row. */
export function BrowserLive({ sessionId, narrow = false, preview = false }: { sessionId: string; narrow?: boolean; preview?: boolean }) {
  const messages = useHub((s) => s.messages[sessionId]);
  const tools = useHub((s) => s.tools);
  const calls = useMemo(() => browserCalls(messages, (id) => tools[id]?.status === 'running'), [messages, tools]);
  const [live, setLive] = useState<BrowserLiveDto>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!calls.used) return;
    let on = true;
    const load = () =>
      api()
        .browserLive(sessionId)
        .then((l) => on && setLive(l))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, STATUS_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [sessionId, calls.used]);

  const shown = showLive(calls, live) || open;
  if (!shown && !preview) return null;
  const words = liveWords(live, calls.running);
  return (
    <div className={cn('mx-auto flex w-full gap-2 px-8 pb-1.5 anim-fade phone:px-4 phone:pb-1', narrow ? 'max-w-[784px]' : 'max-w-[924px]')}>
      {preview && <PreviewButton sessionId={sessionId} />}
      {shown && (
      <button
        type="button"
        data-browser-live=""
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 min-w-0 items-center gap-2 rounded-full border border-rule-2 bg-raise px-2.5 text-[12.5px] text-fg-2 transition-colors duration-[var(--dur-1)] hov:text-fg phone:h-9 phone:px-3.5 phone:text-[14px]"
      >
        <Globe aria-hidden strokeWidth={1.75} className={cn('size-3.5 shrink-0', live?.held ? 'text-warn' : calls.running ? 'text-signal' : 'text-fg-3')} />
        <span className={cn('truncate', live?.held && 'text-warn')}>{words}</span>
        <span className="shrink-0 text-fg-3">Watch</span>
      </button>
      )}
      {open && <LiveDialog sessionId={sessionId} live={live} onLive={setLive} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LiveDialog({ sessionId, live, onLive, onClose }: { sessionId: string; live?: BrowserLiveDto; onLive: (l: BrowserLiveDto) => void; onClose: () => void }) {
  const phone = useIsMobile();
  const held = !!live?.held;
  const [busy, setBusy] = useState(false);
  const control = async (take: boolean) => {
    setBusy(true);
    const l = await attempt(() => api().browserControl(sessionId, take));
    if (l) onLive(l);
    setBusy(false);
  };
  const close = () => {
    // the frames stop and a held browser goes back to the assistant
    void api()
      .closeBrowserLive(sessionId)
      .catch(() => undefined);
    if (held) onLive({ ...live!, held: false });
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={held ? 'You have the browser' : 'The assistant\u2019s browser'}
      description={held ? 'The assistant waits until you give it back.' : 'Live. Take over to click and type yourself; the assistant waits meanwhile.'}
      width={980}
      top="5vh"
      bodyClassName="px-4 pb-4 phone:px-3"
      footer={
        <>
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={close}>
            Close
          </Button>
          <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy ? (held ? 'Giving back' : 'Taking over') : false} disabled={!held && live?.open === false} onClick={() => void control(!held)}>
            {held ? 'Give back' : 'Take over'}
          </Button>
        </>
      }
    >
      <RemotePage
        viewKey={sessionId}
        poll={(after) => api().browserLiveFrame(sessionId, after)}
        send={(events) => api().browserLiveInput(sessionId, events)}
        interactive={held}
        help={held ? 'Click the page, then type, or type in the box and press Send. Give back when you are done.' : 'Watching. The picture follows the page about twice a second.'}
      />
    </Dialog>
  );
}
