/**
 * The live overlay (docs/design/MEETING-MODE.md 1.3): the status line with
 * the recording dot (always shown while listening, 8), the current answer,
 * the last 6 transcript lines and up to 5 earlier answers. Controls call the
 * hub over HTTP and Rust over IPC; both return at once.
 */
import { useEffect, useState } from 'react';
import type { MeetingApi } from './hub';
import { ipc } from './desktop';
import { answerStack, lastLines, type MeetingView } from './model';
import type { DesktopMeetingStatus } from './wire';
import type { WsStatus } from './ws';
import { AnswerCard, PreviousAnswer } from './AnswerCard';
import { Transcript } from './Transcript';
import { CopyConsent } from './Setup';

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
  if (!d.mic.ok) out.push('no mic');
  if (!d.system.ok) out.push('no system sound');
  if (d.queue.stt > 0) out.push(`${d.queue.stt} waiting for text`);
  if (d.clickThrough) out.push('click-through, Ctrl or Cmd + Alt + T turns it off');
  return out;
}

function Level({ label, value }: { label: string; value: number }) {
  return (
    <span className="ov-level">
      {label}
      <span className="ov-meter" aria-hidden>
        <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, value))})` }} />
      </span>
    </span>
  );
}

export function Live({ api, view, desktop, levels, ws }: { api: MeetingApi; view: MeetingView; desktop?: DesktopMeetingStatus; levels: { me: number; them: number }; ws: WsStatus }) {
  const m = view.meeting!;
  const paused = m.status === 'paused' || !!desktop?.paused;
  const minutes = useMinutes(m.startedAt);
  const { current, previous } = answerStack(view);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const answerNow = (question?: string) => void api.answer(m.id, { reason: 'button', question }).catch(fail);
  const togglePause = () => {
    void ipc.pause(!paused)?.catch(fail);
    // the hub's status follows; a 409 means it is already there
    void api.patch(m.id, { status: paused ? 'live' : 'paused' }).catch(() => undefined);
  };
  const end = () => {
    void ipc.stop()?.catch(() => undefined);
    void api.end(m.id).catch(fail);
  };

  return (
    <div className="ov-stack">
      <header className="ov-status" data-tauri-drag-region>
        <span className={paused ? 'ov-dot ov-dot-paused' : 'ov-dot'} aria-hidden />
        <span className="ov-state-live" aria-live="polite">
          {paused ? 'Paused' : 'Listening'}
        </span>
        <span className="ov-num">{minutes} min</span>
        <Level label="me" value={levels.me} />
        <Level label="them" value={levels.them} />
        <span className="ov-grow" />
        <button type="button" className="ov-link" onClick={() => void ipc.hide()}>
          Hide
        </button>
      </header>
      {statusNotes(desktop, ws).length > 0 && <p className="ov-notes">{statusNotes(desktop, ws).join(', ')}</p>}
      {current ? (
        <AnswerCard
          answer={current}
          text={view.text[current.messageId] ?? ''}
          onStop={() => void api.cancel(m.id, current.id).catch(fail)}
          onRetry={() => answerNow(current.question || undefined)}
        />
      ) : (
        <section className="ov-card">
          <p className="ov-muted">Answers show here when someone asks you a question. Ctrl or Cmd + Alt + Enter answers now.</p>
        </section>
      )}
      <Transcript lines={lastLines(view)} />
      {previous.length > 0 && (
        <ul className="ov-prevs" aria-label="Earlier answers">
          {previous.map((a) => (
            <PreviousAnswer key={a.id} answer={a} text={view.text[a.messageId] ?? ''} />
          ))}
        </ul>
      )}
      {error && (
        <p className="ov-fault" role="alert">
          {error}
        </p>
      )}
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
        <CopyConsent />
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
    </div>
  );
}
