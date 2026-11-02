/**
 * The live overlay (docs/design/MEETING-MODE.md 1.3), laid out like Parakeet AI's
 * and Final Round AI's: one top bar (the recording dot, always shown while
 * listening, 8; the time; the speech provider; Answer now, Pause, Hide and a
 * "..." menu for everything else), a slim strip with the last lines said, and
 * the answer, large, filling the rest. Earlier answers are a step back with the
 * arrows in the answer's header or Ctrl or Cmd + Alt + [ and ]. Space answers
 * now. Controls call the hub over HTTP and Rust over IPC; both return at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MeetingApi } from './hub';
import { desktop as tauri, ipc } from './desktop';
import type { LevelSource } from './frame';
import { lastLatency, lastLines, seconds, shownIndex, stepAnswer, type MeetingView } from './model';
import type { DesktopMeetingStatus, SttProvider } from './wire';
import type { WsStatus } from './ws';
import { AnswerCard, paintReporter } from './AnswerCard';
import { Transcript } from './Transcript';
import { OPACITY_MAX, OPACITY_MIN, readOpacity, saveOpacity } from './opacity';
import { readTextSize, stepTextSize, TEXT_MAX, TEXT_MIN } from './textsize';
import { holdOpen, moveDisplay, setPlacement, useDock } from './dock';
import type { Mode } from './place';

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

/** The one line under the top bar: only what is wrong, most important first. Pure, for tests. */
export function statusNotes(d: DesktopMeetingStatus | undefined, ws: WsStatus): string[] {
  const out: string[] = [];
  if (ws === 'closed') out.push(`Hub offline: transcript queued (${d?.queue.upload ?? 0})`);
  if (!d) return [...out, 'Not listening on this computer'];
  if (d.stt.state === 'downloading') out.push(`Downloading speech model ${Math.round((d.stt.progress ?? 0) * 100)} %`);
  else if (d.stt.state === 'loading') out.push('Loading speech model');
  // a cloud failure: the app keeps retrying (Retry below tries at once); never a switch to local
  else if (d.stt.state === 'failed' && d.stt.provider !== 'local') out.push(`Speech to text failed, retrying${d.stt.error ? `. ${d.stt.error}` : ''}`);
  else if (d.stt.state === 'failed') out.push(`Speech model failed${d.stt.error ? `: ${d.stt.error}` : ''}`);
  if (!d.mic.ok) out.push(d.mic.error ? `no mic: ${d.mic.error}` : 'no mic');
  if (!d.system.ok) out.push(d.system.error ? `no system sound: ${d.system.error}` : 'no system sound');
  // capture runs but says something, such as "Not hearing the meeting. Check the meeting app's speaker."
  else if (d.system.error) out.push(d.system.error);
  if (d.queue.stt > 0) out.push(`${d.queue.stt} waiting for text`);
  if (ws !== 'closed' && d.queue.upload > 0) out.push(`${d.queue.upload} waiting to upload`);
  return out;
}

/** The click-through hotkey as the owner presses it: ⌘⌥T on a Mac, Ctrl+Alt+T elsewhere, with Shift for the fallback. */
export function clickKeyLabel(key: string | undefined, mac: boolean): string {
  const shift = /Shift/.test(key ?? '');
  return mac ? `⌘⌥${shift ? '⇧' : ''}T` : `Ctrl+Alt+${shift ? 'Shift+' : ''}T`;
}

const MAC = typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent);

/** What a screen share shows of the overlay, when it is not hidden from it: the share icon's tooltip. */
export function shareNote(d: DesktopMeetingStatus | undefined): string | undefined {
  if (d?.exclusion === 'unsupported') return 'Visible in screen shares';
  if (d?.exclusion === 'monitor-only') return 'Shows as a black box in shares';
  if (d?.exclusion === 'failed') return 'Not hidden from screen shares';
  return undefined;
}

const scale = (v: number) => `scaleX(${Math.min(1, Math.max(0, v))})`;

/** How see-through the panel is, saved on this device (opacity.ts). */
function Opacity() {
  const [v, setV] = useState(readOpacity);
  return (
    <label className="ov-menu-row">
      <span className="ov-menu-label">Opacity</span>
      <input
        type="range"
        min={OPACITY_MIN}
        max={OPACITY_MAX}
        step={5}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          saveOpacity(n);
        }}
      />
      <span className="ov-num">{v} %</span>
    </label>
  );
}

/** The answer's text size, A- and A+, saved on this device (textsize.ts). */
function TextSize() {
  const [v, setV] = useState(readTextSize);
  return (
    <div className="ov-menu-row" role="group" aria-label="Text size">
      <span className="ov-menu-label">Text size</span>
      <button type="button" className="ov-btn ov-quiet" aria-label="Smaller text" disabled={v <= TEXT_MIN} onClick={() => setV(stepTextSize(v, -1))}>
        A-
      </button>
      <span className="ov-num">{v} px</span>
      <button type="button" className="ov-btn ov-quiet" aria-label="Larger text" disabled={v >= TEXT_MAX} onClick={() => setV(stepTextSize(v, 1))}>
        A+
      </button>
    </div>
  );
}

const STT_NAME: Record<SttProvider, string> = { local: 'Local', assemblyai: 'AssemblyAI', deepgram: 'Deepgram' };

/**
 * What stays on screen while a docked overlay is hidden (Overlay.tsx Panel): the
 * listening dot on the edge tab, and on the notch pill the dot and a tiny level.
 */
export function Handle({ levels, paused, failed }: { levels: LevelSource; paused: boolean; failed?: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const paint = (l: { me: number; them: number }) => {
      if (bar.current) bar.current.style.transform = scale(Math.max(l.me, l.them));
    };
    paint(levels.get());
    return levels.subscribe(paint);
  }, [levels]);
  return (
    <>
      <span className={failed ? 'ov-dot ov-dot-fault' : paused ? 'ov-dot ov-dot-paused' : 'ov-dot'} />
      <span className="ov-handle-meter">
        <span ref={bar} style={{ transform: scale(0) }} />
      </span>
    </>
  );
}

/** Placement (dock.ts): Free, Dock to edge, Notch on a Mac; auto-hide; the next display. */
function Placement() {
  const d = useDock();
  if (!d.active) return null;
  const modes: [Mode, string][] = [
    ['free', 'Free'],
    ['edge', 'Edge'],
    ...(d.mac ? [['notch', 'Notch'] as [Mode, string]] : []),
  ];
  return (
    <>
      <div className="ov-menu-row ov-place" role="group" aria-label="Placement">
        <span className="ov-menu-label">Place</span>
        {modes.map(([m, label]) => (
          <button key={m} type="button" className="ov-btn ov-quiet" aria-pressed={d.mode === m} onClick={() => setPlacement({ mode: m })}>
            {label}
          </button>
        ))}
      </div>
      <button type="button" className="ov-menu-item" aria-pressed={d.saved.autoHide} onClick={() => setPlacement({ autoHide: !d.saved.autoHide })}>
        Auto-hide when docked: {d.saved.autoHide ? 'on' : 'off'}
      </button>
      {d.displays > 1 && (
        <button type="button" className="ov-menu-item" onClick={() => void moveDisplay(1)}>
          Next display
        </button>
      )}
    </>
  );
}

/** Everything that is not Answer now, Pause or Hide: the "..." menu, drawn in this window (no native menu, 7.2). */
export function Menu({ autoAnswer, latency, clickKey, onAutoAnswer, onClickThrough, onEnd }: { autoAnswer: boolean; latency?: number; clickKey?: string; onAutoAnswer: () => void; onClickThrough: () => void; onEnd: () => void }) {
  const [ending, setEnding] = useState(false);
  return (
    <div className="ov-menu" role="menu" aria-label="More">
      <TextSize />
      <Opacity />
      <Placement />
      {/* once on, clicks pass through this window: the hotkey turns it off */}
      <button type="button" className="ov-menu-item" onClick={onClickThrough}>
        Click-through {clickKey ? `(${clickKeyLabel(clickKey, MAC)} turns it off)` : '(no hotkey: off when the meeting ends)'}
      </button>
      <button type="button" className="ov-menu-item" aria-pressed={autoAnswer} onClick={onAutoAnswer}>
        Auto answers: {autoAnswer ? 'on' : 'off'}
      </button>
      {latency !== undefined && <p className="ov-menu-meta ov-num">Last answer: first word in {seconds(latency)}</p>}
      {ending ? (
        <div className="ov-menu-row">
          <button type="button" className="ov-btn ov-danger" onClick={onEnd}>
            End now
          </button>
          <button type="button" className="ov-btn ov-quiet" onClick={() => setEnding(false)}>
            Keep going
          </button>
        </div>
      ) : (
        <button type="button" className="ov-menu-item ov-menu-end" onClick={() => setEnding(true)}>
          End meeting
        </button>
      )}
    </div>
  );
}

/** Space answers now, unless a field or a button has the key (it is theirs then). */
export function isAnswerKey(e: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>, target: EventTarget | null): boolean {
  if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = target as HTMLElement | null;
  return !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName ?? '')));
}

export function Live({ api, view, desktop, ws }: { api: MeetingApi; view: MeetingView; desktop?: DesktopMeetingStatus; levels: LevelSource; ws: WsStatus }) {
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
  // a new answer shows on top, from its first line
  const newestId = newest?.id;
  const seen = useRef(newestId);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (seen.current === newestId) return;
    seen.current = newestId;
    setPinned(undefined);
    if (region.current) region.current.scrollTop = 0;
  }, [newestId]);
  useEffect(() => {
    const d = tauri();
    if (!d) return;
    let off: (() => void) | undefined;
    let alive = true;
    void d
      .listen<number>('meeting://nav', (e) => step(e.payload < 0 ? -1 : 1))
      .then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
    };
  }, [step]);
  const [menu, setMenu] = useState(false);
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
      if (!isAnswerKey(e, e.target)) return;
      e.preventDefault();
      answerNow();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answerNow]);
  const currentId = current?.id;
  const currentQuestion = current?.question;
  const onStop = useCallback(() => void (currentId && api.cancel(m.id, currentId).catch(fail)), [api, m.id, currentId, fail]);
  const onRetry = useCallback(() => answerNow(currentQuestion || undefined), [answerNow, currentQuestion]);
  const onPaint = useMemo(() => paintReporter((answerId, body) => api.paint(m.id, answerId, body)), [api, m.id]);
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
  const share = shareNote(desktop);
  const sttFailed = desktop?.stt.state === 'failed' && desktop.stt.provider !== 'local';
  // a docked overlay slides out while the newest answer streams, and back after it (dock.ts LINGER_MS)
  const streaming = newest?.state === 'streaming';
  useEffect(() => holdOpen(streaming), [streaming]);

  return (
    <div className="ov-live">
      <header className="ov-top" data-tauri-drag-region>
        <span className={paused ? 'ov-dot ov-dot-paused' : 'ov-dot'} aria-hidden />
        <span className="ov-state-live" aria-live="polite">
          {paused ? 'Paused' : 'Listening'}
        </span>
        <span className="ov-meta ov-num">{minutes} min</span>
        {desktop?.stt.provider && <span className="ov-meta ov-provider">{STT_NAME[desktop.stt.provider]}</span>}
        {share && (
          <span className="ov-tip ov-share" role="img" aria-label={share} data-tip={share}>
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="M1.5 10s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z" />
              <circle cx="10" cy="10" r="2.5" />
            </svg>
          </span>
        )}
        <span className="ov-grow" data-tauri-drag-region />
        <div className="ov-controls">
          <button type="button" className="ov-btn ov-primary" aria-keyshortcuts="Space" onClick={() => answerNow()}>
            Answer now <kbd className="ov-kbd">Space</kbd>
          </button>
          <button type="button" className="ov-btn" onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="ov-btn" onClick={() => void ipc.hide()}>
            Hide
          </button>
          <button type="button" className="ov-btn ov-more" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <svg viewBox="0 0 20 20" aria-hidden>
              <circle cx="4.5" cy="10" r="1.6" />
              <circle cx="10" cy="10" r="1.6" />
              <circle cx="15.5" cy="10" r="1.6" />
            </svg>
          </button>
        </div>
      </header>
      {(notes.length > 0 || error) && (
        <p className={error ? 'ov-notes ov-fault' : 'ov-notes'} role={error ? 'alert' : undefined}>
          {error ?? notes.join(', ')}
          {!error && sttFailed && (
            <button type="button" className="ov-link" onClick={() => void ipc.sttRetry()?.catch(fail)}>
              Retry
            </button>
          )}
        </p>
      )}
      <section className="ov-strip" aria-label="Live transcript">
        <Transcript lines={lastLines(view, 3)} />
      </section>
      <section ref={region} className="ov-answer" aria-label="Answer">
        {current ? (
          <AnswerCard
            answer={current}
            text={view.text[current.messageId] ?? ''}
            nav={nav}
            onStop={current === newest ? onStop : undefined}
            onRetry={current === newest ? onRetry : undefined}
            onPaint={onPaint}
          />
        ) : (
          <p className="ov-empty">{paused ? 'Paused. Resume to hear the meeting again.' : 'Listening. Answers appear here when someone asks you something.'}</p>
        )}
      </section>
      {/* clicks pass through the whole window now, this too: it only says how to get out */}
      {desktop?.clickThrough && (
        <p className="ov-ct-pill" role="status">
          Click-through on · {clickKeyLabel(desktop.clickKey, MAC)} to turn off
        </p>
      )}
      {menu && (
        <>
          <div className="ov-scrim" onPointerDown={() => setMenu(false)} />
          <Menu
            autoAnswer={m.autoAnswer !== 'off'}
            latency={lastLatency(answers)}
            clickKey={desktop?.clickKey}
            onAutoAnswer={() => void api.patch(m.id, { autoAnswer: m.autoAnswer === 'off' ? 'questions' : 'off' }).catch(fail)}
            onClickThrough={() => {
              setMenu(false);
              void ipc.clickThrough(true)?.catch(fail);
            }}
            onEnd={end}
          />
        </>
      )}
    </div>
  );
}
