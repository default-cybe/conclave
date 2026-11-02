/**
 * The meeting overlay (docs/design/MEETING-MODE.md 1.3, 3.4): setup, the
 * brief with "Start listening", the live view, and the end. Events come over
 * the WebSocket and are applied once per animation frame (frame.ts); the
 * page schedules nothing while nothing arrives, except one wake a minute for
 * the elapsed time and the socket's ping.
 *
 * Rules for this window (7.2): no <select>, no title= tooltips, no native
 * context menu, no alert or confirm, no file pickers. Each of those opens a
 * separate window that screen sharing captures.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { frameBuffer, levelSource, statusOrSame, type Levels } from './frame';
import { useFitAndStick } from './fit';
import { connectWs, type WsStatus } from './ws';
import { meetingApi, type MeetingApi, type Req } from './hub';
import { desktop, ipc } from './desktop';
import { applyEvent, emptyView, loadDetail, type MeetingView } from './model';
import type { DesktopMeetingStatus, MeetingEvent } from './wire';
import { Ready, Setup } from './Setup';
import { Handle, Live } from './Live';
import { setHover, setLive, startDock, useDock } from './dock';

export interface Conn {
  req: Req;
  baseUrl: string;
  token: string;
  WebSocketImpl?: typeof WebSocket;
}

export function Overlay({ conn, meetingId: first, signedIn }: { conn: Conn; meetingId?: string; signedIn: boolean }) {
  const api = useMemo(() => meetingApi(conn.req), [conn]);
  const [meetingId, setMeetingId] = useState(first);
  if (!signedIn)
    return (
      <Panel>
        <p className="ov-muted">Open meeting mode from the Conclave desktop app.</p>
      </Panel>
    );
  if (!meetingId)
    return (
      <Panel>
        <Setup
          api={api}
          req={conn.req}
          onCreated={(id) => {
            history.replaceState(null, '', `${location.pathname}?meeting=${encodeURIComponent(id)}`);
            setMeetingId(id);
          }}
        />
      </Panel>
    );
  return <MeetingScreen conn={conn} api={api} meetingId={meetingId} />;
}

/**
 * The window's height follows what the panel holds (fit.ts). Docked (dock.ts), the
 * panel slides out from its edge or grows down from the notch; `handle` is what
 * stays on screen while it is hidden (the live screen's tab or pill), and only
 * the live screen hides.
 */
export function Panel({ children, handle }: { children: React.ReactNode; handle?: React.ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useFitAndStick(panel, content);
  const dock = useDock();
  const live = !!handle;
  useEffect(() => {
    startDock();
    setLive(live);
  }, [live]);
  const hidden = dock.active && dock.hidden && live;
  const notch = dock.active && dock.mode === 'notch';
  const style = notch && dock.pill ? ({ '--ov-pill-w': `${dock.pill.w}px`, '--ov-pill-h': `${dock.pill.h}px`, '--ov-notch-w': `${dock.notch?.w ?? 0}px` } as React.CSSProperties) : undefined;
  return (
    <div className="ov-dock" data-mode={dock.active ? dock.mode : 'free'} data-edge={dock.edge} data-hidden={hidden ? '' : undefined} style={style} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {live && (
        <div className="ov-handle" aria-hidden={!hidden}>
          {handle}
        </div>
      )}
      <main ref={panel} className="ov-panel" inert={hidden || undefined}>
        <div ref={content}>{children}</div>
      </main>
    </div>
  );
}

/** The meeting's view, kept up to date from the socket, one render per frame at most. */
function useMeetingView(conn: Conn, api: MeetingApi, meetingId: string) {
  const view = useRef<MeetingView>(emptyView()).current;
  const listeners = useRef(new Set<() => void>()).current;
  const [ws, setWs] = useState<WsStatus>('connecting');
  const [error, setError] = useState<string>();
  const notify = useCallback(() => {
    for (const fn of listeners) fn();
  }, [listeners]);

  useEffect(() => {
    let stop = false;
    let sock: ReturnType<typeof connectWs> | undefined;
    const load = async () => {
      try {
        const d = await api.get(meetingId);
        const msgs = await api.messages(d.sessionId).catch(() => []);
        if (stop) return;
        loadDetail(view, d, msgs);
        if (d.status === 'ended') view.notes = await api.notes(meetingId).catch(() => undefined);
        setError(undefined);
        sock?.resubscribe();
        notify();
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    const frame = frameBuffer<MeetingEvent>((events) => {
      let changed = false;
      for (const e of events) changed = applyEvent(view, e) || changed;
      if (changed) notify();
    });
    void load();
    sock = connectWs({
      baseUrl: conn.baseUrl,
      token: conn.token,
      WebSocketImpl: conn.WebSocketImpl,
      sessions: () => (view.meeting ? [view.meeting.sessionId] : []),
      onEvent: (e) => {
        if (e.type.startsWith('meeting.') || e.type.startsWith('message.')) frame.push(e as unknown as MeetingEvent);
      },
      onStatus: setWs,
      onResync: () => void load(),
    });
    return () => {
      stop = true;
      frame.cancel();
      sock?.close();
    };
  }, [conn, api, meetingId, view, notify]);

  const version = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => view.version,
  );
  return { view, version, ws, error };
}

const OFF: DesktopMeetingStatus = {
  live: false,
  paused: false,
  clickThrough: false,
  hiddenForShare: false,
  exclusion: 'unsupported',
  mic: { ok: false },
  system: { ok: false },
  stt: { state: 'loading' },
  queue: { stt: 0, upload: 0, dropped: 0 },
};

/** The desktop's status and channel levels; undefined status outside the desktop app. Levels paint at most once a frame. */
function useDesktop() {
  const [status, setStatus] = useState<DesktopMeetingStatus | undefined>(desktop() ? OFF : undefined);
  const [levels] = useState(levelSource);
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    let alive = true;
    const offs: (() => void)[] = [];
    void ipc.status()?.then((s) => alive && s && setStatus((p) => statusOrSame(p, s)), () => undefined);
    const lv = frameBuffer<Levels>((all) => levels.set(all[all.length - 1]!));
    void d.listen<DesktopMeetingStatus>('meeting://status', (e) => setStatus((p) => statusOrSame(p, e.payload))).then((off) => (alive ? offs.push(off) : off()));
    void d.listen<{ me: number; them: number }>('meeting://level', (e) => lv.push(e.payload)).then((off) => (alive ? offs.push(off) : off()));
    return () => {
      alive = false;
      lv.cancel();
      for (const off of offs) off();
    };
  }, [levels]);
  return { status, levels };
}

function MeetingScreen({ conn, api, meetingId }: { conn: Conn; api: MeetingApi; meetingId: string }) {
  const { view, ws, error } = useMeetingView(conn, api, meetingId);
  const { status, levels } = useDesktop();
  const m = view.meeting;
  if (!m)
    return (
      <Panel>
        <p className={error ? 'ov-fault' : 'ov-muted'}>{error ?? 'Loading the meeting'}</p>
      </Panel>
    );
  const listening = !!status?.live && status.meetingId === m.id;
  if ((m.status === 'preparing' || m.status === 'ready') && !listening)
    return (
      <Panel>
        <Ready api={api} view={view} desktop={status} />
      </Panel>
    );
  if (m.status === 'ending' || m.status === 'ended' || m.status === 'failed')
    return (
      <Panel>
        <Ended api={api} view={view} wasListening={listening} />
      </Panel>
    );
  return (
    <Panel handle={<Handle levels={levels} paused={status?.live ? status.paused : m.status === 'paused'} failed={status?.stt.state === 'failed'} />}>
      <Live api={api} view={view} desktop={status} levels={levels} ws={ws} />
    </Panel>
  );
}

function Ended({ api, view, wasListening }: { api: MeetingApi; view: MeetingView; wasListening: boolean }) {
  const m = view.meeting!;
  const [saved, setSaved] = useState<'saving' | 'saved' | string>(m.memoryId ? 'saved' : '');
  // the hub ended it while this app still listened (a 409 on segments): Rust stops on its own (3.5)
  useEffect(() => {
    if (wasListening) void ipc.stop()?.catch(() => undefined);
  }, [wasListening]);
  const words = m.status === 'failed' ? `Meeting failed${m.error ? `: ${m.error}` : ''}` : m.status === 'ending' ? 'Writing the notes' : 'Meeting ended';
  return (
    <div className="ov-stack">
      <p className={m.status === 'failed' ? 'ov-fault' : 'ov-state'} aria-live="polite">
        {wasListening && m.status !== 'ending' ? 'Meeting ended on the hub' : words}
      </p>
      <h1 className="ov-title">{m.title}</h1>
      {view.notes ? (
        <>
          <p className="ov-body">{view.notes.summary}</p>
          {view.notes.actionItems.some((a) => a.who === 'me') && (
            <ul className="ov-list">
              {view.notes.actionItems
                .filter((a) => a.who === 'me')
                .map((a, i) => (
                  <li key={i}>
                    {a.what}
                    {a.due ? `, by ${a.due}` : ''}
                  </li>
                ))}
            </ul>
          )}
          <p className="ov-muted">Full notes are on the meeting page in Conclave.</p>
        </>
      ) : (
        m.status === 'ended' && <p className="ov-muted">The notes are on the meeting page in Conclave.</p>
      )}
      {saved !== '' && saved !== 'saving' && saved !== 'saved' && <p className="ov-fault">{saved}</p>}
      <div className="ov-row">
        {view.notes &&
          (saved === 'saved' ? (
            <span className="ov-muted">Saved to memory</span>
          ) : (
            <button
              type="button"
              className="ov-btn ov-primary"
              disabled={saved === 'saving'}
              onClick={() => {
                setSaved('saving');
                api.saveMemory(m.id).then(
                  () => setSaved('saved'),
                  (e: Error) => setSaved(e.message),
                );
              }}
            >
              {saved === 'saving' ? 'Saving' : 'Save to memory'}
            </button>
          ))}
        <button type="button" className="ov-btn" onClick={() => void ipc.hide()}>
          Close
        </button>
      </div>
    </div>
  );
}
