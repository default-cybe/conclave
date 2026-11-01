/**
 * The live overlay (docs/design/MEETING-MODE.md 1.3): the status line with
 * the recording dot (always shown while listening, 8), the answer, and the
 * last transcript lines. Idle it is a compact bar (status and the last line);
 * a new answer opens it. Earlier answers are a step back with the arrows or
 * Ctrl or Cmd + Alt + [ and ]. Controls call the hub over HTTP and Rust over
 * IPC; both return at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MeetingApi } from './hub';
import { desktop as tauri, ipc } from './desktop';
import type { LevelSource } from './frame';
import { lastLatency, lastLines, seconds, shownIndex, stepAnswer, type MeetingView } from './model';
import type { DesktopMeetingStatus, SttProvider } from './wire';
import type { WsStatus } from './ws';
import { AnswerCard } from './AnswerCard';
import { Transcript } from './Transcript';

/** Whole minutes since `since`, re-rendered once a minute (the only timer of an idle overlay). */
function useMinutes(since?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setTimeout(() => setNow(Date.now()), 60_000 - ((Date.now() - since) % 60_000));
    return () => clearTimeout(t);
  }, [since, now]);
  return since ? Math.max(0, Math.floor((now - since) / 60_000)) : 0;
}

/** The notes after the level meters, most important first. Pure, for tests. */
export function statusNotes(d: DesktopMeetingStatus | undefined, ws: WsStatus): string[] {
  const out: string[] = [];
  if (ws === 'closed') out.push(`Hub offline: transcript queued (${d?.queue.upload ?? 0})`);
  if (!d) return [...out, 'Not listening on this computer'];
  if (d.exclusion === 'unsupported') out.push('Visible in screen shares');
  else if (d.exclusion === 'monitor-only') out.push('Shows as a black box in shares');
  else if (d.exclusion === 'failed') out.push('Not hidden from screen shares');
  if (d.stt.state === 'downloading') out.push(`Downloading speech model ${Math.round((d.stt.progress ?? 0) * 100)} %`);
  else if (d.stt.state === 'loading') out.push('Loading speech model');
  else if (d.stt.state === 'failed') out.push(`Speech model failed${d.stt.error ? `: ${d.stt.error}` : ''}`);
  // the desktop app's fallback note: why speech to text moved to this computer
  else if (d.stt.error) out.push(d.stt.error);
  if (!d.mic.ok) out.push(d.mic.error ? `no mic: ${d.mic.error}` : 'no mic');
  if (!d.system.ok) out.push(d.system.error ? `no system sound: ${d.system.error}` : 'no system sound');
  if (d.queue.stt > 0) out.push(`${d.queue.stt} waiting for text`);
  if (ws !== 'closed' && d.queue.upload > 0) out.push(`${d.queue.upload} waiting to upload`);
  if (d.clickThrough) out.push('click-through, Ctrl or Cmd + Alt + T turns it off');
  return out;
}

const scale = (v: number) => `scaleX(${Math.min(1, Math.max(0, v))})`;

/** Both meters. They paint from the level source straight into the DOM, so a level never renders React. */
function Meters({ levels }: { levels: LevelSource }) {
  const me = useRef<HTMLSpanElement>(null);
  const them = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const paint = (l: { me: number; them: number }) => {
      if (me.current) me.current.style.transform = scale(l.me);
      if (them.current) them.current.style.transform = scale(l.them);
    };
    paint(levels.get());
    return levels.subscribe(paint);
  }, [levels]);
  return (
    <>
      <span className="ov-level">
        me
        <span className="ov-meter" aria-hidden>
          <span ref={me} style={{ transform: scale(0) }} />
        </span>
      </span>
      <span className="ov-level">
        them
        <span className="ov-meter" aria-hidden>
          <span ref={them} style={{ transform: scale(0) }} />
        </span>
      </span>
    </>
  );
}

const STT_NAME: Record<SttProvider, string> = { local: 'Local', assemblyai: 'AssemblyAI', deepgram: 'Deepgram' };

export function Live({ api, view, desktop, levels, ws }: { api: MeetingApi; view: MeetingView; desktop?: DesktopMeetingStatus; levels: LevelSource; ws: WsStatus }) {
  const m = view.meeting!;
  // the dot shows what the microphone does: the capture's own state when this computer captures
  const paused = desktop?.live ? desktop.paused : m.status === 'paused';
  const minutes = useMinutes(m.startedAt);
  const answers = view.answers;
  const answersRef = useRef(answers);
  answersRef.current = answers;
  // the answer the owner stepped back to; undefined follows the newest
  const [pinned, setPinned] = useState<string>();
  const index = shownIndex(answers, pinned);
  const current = answers[index];
  const newest = answers[answers.length - 1];
  const step = useCallback((dir: -1 | 1) => setPinned((p) => stepAnswer(answersRef.current, p, dir)), []);
  // compact while idle; a new answer opens it on the newest
  const [open, setOpen] = useState(false);
  const newestId = newest?.id;
  const seen = useRef(newestId);
  useEffect(() => {
    if (seen.current === newestId) return;
    seen.current = newestId;
    setPinned(undefined);
    setOpen(true);
  }, [newestId]);
  useEffect(() => {
    const d = tauri();
    if (!d) return;
    let off: (() => void) | undefined;
    let alive = true;
    void d
      .listen<number>('meeting://nav', (e) => {
        setOpen(true);
        step(e.payload < 0 ? -1 : 1);
      })
      .then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
    };
  }, [step]);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string>();
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  // the pause hotkey changes only the capture: the hub follows it (a 409 means it is already there)
  const capturePaused = desktop?.live ? desktop.paused : undefined;
  useEffect(() => {
    if (capturePaused === undefined || capturePaused === (m.status === 'paused')) return;
    if (m.status !== 'live' && m.status !== 'paused') return;
    void api.patch(m.id, { status: capturePaused ? 'paused' : 'live' }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change on the capture side syncs; a pause from the hub page stays
  }, [capturePaused]);

  const answerNow = useCallback((question?: string) => void api.answer(m.id, { reason: 'button', question }).catch(fail), [api, m.id, fail]);
  const currentId = current?.id;
  const currentQuestion = current?.question;
  const onStop = useCallback(() => void (currentId && api.cancel(m.id, currentId).catch(fail)), [api, m.id, currentId, fail]);
  const onRetry = useCallback(() => answerNow(currentQuestion || undefined), [answerNow, currentQuestion]);
  const togglePause = () => {
    void ipc.pause(!paused)?.catch(fail);
    // the hub's status follows; a 409 means it is already there
    void api.patch(m.id, { status: paused ? 'live' : 'paused' }).catch(() => undefined);
  };
  const end = () => {
    void ipc.stop()?.catch(() => undefined);
    void api.end(m.id).catch(fail);
  };
  const count = answers.length;
  const nav = useMemo(() => ({ index, count, step }), [index, count, step]);
  const notes = statusNotes(desktop, ws);
  const latency = lastLatency(answers);

  return (
    <div className="ov-stack">
      <header className="ov-status" data-tauri-drag-region>
        <span className={paused ? 'ov-dot ov-dot-paused' : 'ov-dot'} aria-hidden />
        <span className="ov-state-live" aria-live="polite">
          {paused ? 'Paused' : 'Listening'}
        </span>
        <span className="ov-num">{minutes} min</span>
        <Meters levels={levels} />
        {desktop?.stt.provider && <span className="ov-meta">{STT_NAME[desktop.stt.provider]}</span>}
        {latency !== undefined && <span className="ov-meta ov-num">first word {seconds(latency)}</span>}
        <span className="ov-grow" />
        <button type="button" className="ov-link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Less' : current ? 'Show answer' : 'More'}
        </button>
        <button type="button" className="ov-link" onClick={() => void ipc.hide()}>
          Hide
        </button>
      </header>
      {notes.length > 0 && <p className="ov-notes">{notes.join(', ')}</p>}
      {!open ? (
        <div className="ov-bar">
          <Transcript lines={lastLines(view, 1)} />
          <button type="button" className="ov-btn ov-primary" onClick={() => answerNow()}>
            Answer now
          </button>
        </div>
      ) : (
        <>
          {current ? (
            <AnswerCard
              answer={current}
              text={view.text[current.messageId] ?? ''}
              nav={nav}
              onStop={current === newest ? onStop : undefined}
              onRetry={current === newest ? onRetry : undefined}
            />
          ) : (
            <section className="ov-card">
              <p className="ov-muted">Answers show here when someone asks you a question. Ctrl or Cmd + Alt + Enter answers now.</p>
            </section>
          )}
          <Transcript lines={lastLines(view, 3)} />
        </>
      )}
      {error && (
        <p className="ov-fault" role="alert">
          {error}
        </p>
      )}
      {open && (
      <footer className="ov-row">
        <button type="button" className="ov-btn ov-primary" onClick={() => answerNow()}>
          Answer now
        </button>
        <button type="button" className="ov-btn" onClick={togglePause}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        {/* once on, clicks pass through this window: the hotkey turns it off */}
        <button type="button" className="ov-btn ov-quiet" onClick={() => void ipc.clickThrough(true)?.catch(fail)}>
          Click-through
        </button>
        <button type="button" className="ov-btn ov-quiet" onClick={() => void api.patch(m.id, { autoAnswer: m.autoAnswer === 'off' ? 'questions' : 'off' }).catch(fail)}>
          {m.autoAnswer === 'off' ? 'Auto answers off' : 'Auto answers on'}
        </button>
        <span className="ov-grow" />
        {ending ? (
          <>
            <button type="button" className="ov-btn ov-danger" onClick={end}>
              End now
            </button>
            <button type="button" className="ov-btn ov-quiet" onClick={() => setEnding(false)}>
              Keep going
            </button>
          </>
        ) : (
          <button type="button" className="ov-btn" onClick={() => setEnding(true)}>
            End meeting
          </button>
        )}
      </footer>
      )}
    </div>
  );
}
