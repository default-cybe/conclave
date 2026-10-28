/**
 * The Preview of a Code session (core browser/preview.ts, routes-preview.ts):
 * the app the session runs, live, in the session's own fenced browser on the
 * hub. A toolbar starts and stops it, reloads, sets the width (390, 768,
 * 1440) and the theme, and turns on Pick: a click then picks the element
 * under it instead of clicking it, and the owner adds what should change.
 * The pick joins the comment tray over the composer (lineComments.ts) and
 * goes to the agent as page data fenced as untrusted. Take over hands the
 * page to the owner as in the live view (BrowserLive.tsx).
 *
 * PreviewDock places it: a column on wide screens (in place of the session
 * panel), a side sheet below that, a bottom sheet on a phone.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Moon, MousePointerClick, RotateCw, Sun, X } from 'lucide-react';
import type { PreviewLogDto, PreviewPickDto, PreviewStateDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useBreakpoint } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { attempt } from '@/store/store';
import { Button, IconButton } from '@/components/ui/Button';
import { Segmented, Textarea } from '@/components/ui/Field';
import { Dialog, Sheet, SideSheet } from '@/components/ui/Overlay';
import { RemotePage } from '@/features/settings/RemotePage';
import { errText } from '@/features/settings/parts';
import { addComment } from '@/features/chat/lineComments';

/** Which session's Preview is open on this device (one at a time). */
export const usePreviewOpen = create<{ id?: string }>(() => ({}));
export const togglePreview = (id: string) => usePreviewOpen.setState((s) => ({ id: s.id === id ? undefined : id }));
const closePreview = () => usePreviewOpen.setState({ id: undefined });

export const PREVIEW_W = 600;
const WIDTHS = ['390', '768', '1440'] as const;
const STATE_MS = 4_000;

export function PreviewDock({ session }: { session: Session }) {
  const open = usePreviewOpen((s) => s.id === session.id);
  const bp = useBreakpoint();
  if (!open) return null;
  if (bp === 'wide')
    return (
      <div className="flex shrink-0 flex-col border-l border-rule bg-bg anim-right" style={{ width: PREVIEW_W }} data-preview-dock="column">
        <PreviewPane session={session} />
      </div>
    );
  if (bp === 'phone')
    return (
      <Sheet open onClose={closePreview} label="Preview">
        <PreviewPane session={session} />
      </Sheet>
    );
  return (
    <SideSheet open onClose={closePreview} width={PREVIEW_W} label="Preview" modal={false}>
      <PreviewPane session={session} />
    </SideSheet>
  );
}

export function PreviewPane({ session }: { session: Session }) {
  const id = session.id;
  const phone = useBreakpoint() === 'phone';
  const [st, setSt] = useState<PreviewStateDto>();
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [width, setWidth] = useState<(typeof WIDTHS)[number]>(phone ? '390' : '1440');
  const [dark, setDark] = useState(false);
  const [picking, setPicking] = useState(false);
  const [held, setHeld] = useState(false);
  const [pick, setPick] = useState<PreviewPickDto>();
  const [confirm, setConfirm] = useState<{ name: string; command: string }>();
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [entries, setEntries] = useState<PreviewLogDto[]>([]);
  const logCount = st?.logs ?? 0;

  // the console reloads when the state poll says the log grew (it keeps the last 300)
  useEffect(() => {
    if (!consoleOpen) return;
    let on = true;
    api()
      .previewLogs(id)
      .then((r) => on && setEntries(r.entries))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [id, consoleOpen, logCount]);

  useEffect(() => {
    let on = true;
    const load = () =>
      api()
        .previewState(id)
        .then((s) => on && setSt(s))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, STATE_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [id]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setProblem(undefined);
    try {
      await fn();
    } catch (e) {
      setProblem(errText(e));
    }
    setBusy(undefined);
  };
  const start = (body: { command?: string; file?: string } = {}) =>
    run('Starting', async () => {
      const s = await api().previewStart(id, body);
      if (s.confirm) return setConfirm(s.confirm);
      setConfirm(undefined);
      setSt(s);
      await api().previewView(id, { width: Number(width), colorScheme: dark ? 'dark' : 'light' });
    });
  const view = (w: (typeof WIDTHS)[number], d: boolean) => {
    setWidth(w);
    setDark(d);
    if (st?.running) void run('Resizing', () => api().previewView(id, { width: Number(w), colorScheme: d ? 'dark' : 'light' }));
  };
  const take = (on: boolean) =>
    run(on ? 'Taking over' : 'Giving back', async () => {
      const l = await api().browserControl(id, on);
      setHeld(!!l.held);
      if (on) setPicking(false);
    });
  const onPoint = (p: { x: number; y: number }) =>
    void run('Picking', async () => {
      setPick(await api().previewPick(id, p.x, p.y));
    });

  const running = !!st?.running;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-preview-pane="">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-rule px-3 py-2">
        {/* a phone's toolbar does not fit one row: the title gets its own, the controls the next */}
        <span className={cn('t-title mr-auto min-w-0 truncate text-fg', phone && running && 'basis-full')} title={st?.url}>
          Preview{st?.name ? <span className="text-fg-3"> · {st.name}</span> : null}
        </span>
        {running && (
          <>
            <Segmented size={phone ? 'touch' : 'sm'} label="Width" value={width} onChange={(w) => view(w, dark)} options={WIDTHS.map((w) => ({ value: w, label: w }))} />
            <IconButton size={phone ? 'touch' : 'sm'} label={dark ? 'Light theme' : 'Dark theme'} onClick={() => view(width, !dark)}>
              {dark ? <Sun strokeWidth={1.75} className="size-4" /> : <Moon strokeWidth={1.75} className="size-4" />}
            </IconButton>
            <IconButton size={phone ? 'touch' : 'sm'} label="Reload" onClick={() => void run('Reloading', () => api().previewReload(id))}>
              <RotateCw strokeWidth={1.75} className="size-4" />
            </IconButton>
            <IconButton size={phone ? 'touch' : 'sm'} label={picking ? 'Stop picking' : 'Pick an element'} active={picking} disabled={held} onClick={() => setPicking(!picking)}>
              <MousePointerClick strokeWidth={1.75} className="size-4" />
            </IconButton>
          </>
        )}
        <IconButton size={phone ? 'touch' : 'sm'} label="Close the Preview" onClick={closePreview}>
          <X strokeWidth={1.75} className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {running ? (
          <RemotePage
            viewKey={`${id}:${st?.url}`}
            poll={(after) => api().browserLiveFrame(id, after)}
            send={(events) => api().browserLiveInput(id, events)}
            interactive={held}
            bare
            onPoint={picking && !held ? onPoint : undefined}
            maxHeight={phone ? (consoleOpen ? '44dvh' : '56dvh') : '70vh'}
            problem={problem}
            help={picking ? 'Click an element to pick it.' : held ? 'You have the page: clicks and scrolling go to it. Give back when you are done.' : `Live from ${st?.url ?? 'the dev server'}. The page reaches only its own dev server.`}
          />
        ) : (
          <div className="grid gap-3 py-6 text-[13px] text-fg-2">
            <p className="m-0">Run the app from .conclave/launch.json or .claude/launch.json and see it here. The agent can screenshot and click it too.</p>
            {problem && <p className="m-0 text-fault">{problem}</p>}
            <div>
              <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy === 'Starting' ? 'Starting' : false} onClick={() => void start()}>
                Start
              </Button>
            </div>
          </div>
        )}
        {pick && <PickCard session={session} pick={pick} onDone={() => setPick(undefined)} />}
      </div>
      {running && consoleOpen && (
        <div className="max-h-[30vh] shrink-0 overflow-y-auto phone:max-h-[16dvh] border-t border-rule bg-sunk px-3 py-2" data-preview-console="" aria-label="Preview console" role="log">
          {entries.length ? (
            entries.map((e) => (
              <p key={e.seq} className={cn('mono m-0 py-0.5 text-[12px] break-words', e.kind === 'pageerror' || e.level === 'error' || e.kind === 'requestfailed' || (e.status ?? 0) >= 500 ? 'text-fault' : 'text-fg-2')}>
                {e.text}
                {e.url && e.kind !== 'console' ? <span className="text-fg-3"> {e.url}</span> : null}
              </p>
            ))
          ) : (
            <p className="m-0 text-[12px] text-fg-3">No errors or warnings yet.</p>
          )}
        </div>
      )}
      {running && (
        <div className="flex shrink-0 items-center gap-2 border-t border-rule px-3 py-2">
          <Button variant="quiet" size={phone ? 'touch' : 'sm'} onClick={() => void run('Stopping', async () => setSt(await api().previewStop(id)))} busy={busy === 'Stopping' ? 'Stopping' : false}>
            Stop
          </Button>
          <Button variant="quiet" size={phone ? 'touch' : 'sm'} aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>
            Console{logCount ? ` (${logCount})` : ''}
          </Button>
          <span className="flex-1" />
          <Button size={phone ? 'touch' : 'sm'} onClick={() => void take(!held)} busy={busy === 'Taking over' || busy === 'Giving back' ? busy : false}>
            {held ? 'Give back' : 'Take over'}
          </Button>
        </div>
      )}
      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(undefined)}
          title="Run this command?"
          description={`launch.json configuration "${confirm.name}" runs this on the session's device. This folder is not trusted, so it does not run until you say so.`}
          width={560}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirm(undefined)}>
                Cancel
              </Button>
              <Button variant="solid" busy={busy === 'Starting' ? 'Starting' : false} onClick={() => void start({ command: confirm.command })}>
                Run
              </Button>
            </>
          }
        >
          <pre className="mono m-0 max-h-[30vh] overflow-auto rounded-[var(--r-1)] border border-rule bg-sunk p-3 text-[12.5px] whitespace-pre-wrap break-all text-fg">{confirm.command}</pre>
        </Dialog>
      )}
    </div>
  );
}

/** The picked element: where it is, a crop, and a box for what should change. Add puts it in the comment tray. */
function PickCard({ session, pick, onDone }: { session: Session; pick: PreviewPickDto; onDone: () => void }) {
  const [note, setNote] = useState('');
  const place = pick.pick.source || pick.pick.selector;
  const add = () => {
    if (!note.trim()) return;
    addComment(session.id, { path: place, quote: pick.text, text: note.trim(), pick: true });
    onDone();
  };
  return (
    <section aria-label="Picked element" data-pick-card="" className="mt-3 rounded-[var(--r-2)] border border-rule bg-raise p-3 text-[13px]">
      <div className="flex items-baseline gap-2">
        <span className="mono min-w-0 flex-1 truncate text-[12px] text-fg-2" title={place}>
          {place}
        </span>
        {pick.pick.components?.length ? <span className="shrink-0 truncate text-[12px] text-fg-3">{pick.pick.components.join(' < ')}</span> : null}
      </div>
      {pick.image && <img src={`data:image/png;base64,${pick.image}`} alt="The picked element" className={cn('mt-2 block max-h-40 max-w-full rounded-[var(--r-1)] border border-rule')} />}
      <Textarea
        className="mt-2"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What should change here?"
        aria-label="What should change on the picked element"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={onDone}>
          Discard
        </Button>
        <Button variant="solid" size="sm" disabled={!note.trim()} onClick={add}>
          Add to comments
        </Button>
      </div>
    </section>
  );
}
