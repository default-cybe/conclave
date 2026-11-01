/**
 * Before listening (docs/design/MEETING-MODE.md 1.1, 1.2): the setup screen
 * (project, title, agenda, Prepare) and the ready screen (the brief as it
 * streams, the consent line and "Start listening"). The window takes focus
 * only here (meeting_focusable, 7.6); "Start listening" gives it back.
 * The tap on "Start listening" is the consent gesture: capture never starts
 * without it.
 */
import { useEffect, useState } from 'react';
import type { ProjectDto } from '@conclave/core/client';
import type { MeetingApi, Req } from './hub';
import { ipc } from './desktop';
import type { MeetingView } from './model';
import { CONSENT_NOTE, type DesktopMeetingStatus } from './wire';

const AGENDA_MAX = 4000;
const LEGAL_KEY = 'conclave.meeting.legalSeen';

/** One choice per project folder: a project with two devices offers both. Newest project first. */
export function folderChoices(projects: ProjectDto[]): { projectId: string; device: string; cwd: string; label: string; where: string }[] {
  return [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((p) => p.locations.map((l) => ({ projectId: p.id, device: l.device, cwd: l.path, label: p.name, where: `${l.deviceName ?? l.device}, ${l.path}` })));
}

export function Setup({ api, req, onCreated }: { api: MeetingApi; req: Req; onCreated: (id: string) => void }) {
  const [choices, setChoices] = useState<ReturnType<typeof folderChoices>>();
  const [pick, setPick] = useState(0);
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void ipc.focusable(true)?.catch(() => undefined);
    req<ProjectDto[]>('GET', '/api/projects').then(
      (p) => setChoices(folderChoices(p)),
      (e: Error) => setError(e.message),
    );
  }, [req]);

  const prepare = async () => {
    const c = choices?.[pick];
    if (!c) return;
    setBusy(true);
    setError(undefined);
    try {
      const m = await api.create({ projectId: c.projectId, device: c.device, cwd: c.cwd, title: title.trim() || undefined, agenda: agenda.trim() || undefined });
      onCreated(m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="ov-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void prepare();
      }}
    >
      <h1 className="ov-title">Start a meeting</h1>
      <div className="ov-field">
        <span className="ov-label" id="ov-project">
          Project
        </span>
        {!choices && !error && <p className="ov-muted">Loading projects</p>}
        {choices && !choices.length && <p className="ov-muted">No project has a folder yet. Open a session in a project folder first.</p>}
        {choices && choices.length > 0 && (
          // a list of buttons, not a <select>: its popup is a separate window that shares capture (7.2)
          <div className="ov-choices" role="radiogroup" aria-labelledby="ov-project">
            {choices.slice(0, 12).map((c, i) => (
              <button key={`${c.projectId}:${c.device}:${c.cwd}`} type="button" role="radio" aria-checked={i === pick} className="ov-choice" onClick={() => setPick(i)}>
                <span className="ov-choice-name">{c.label}</span>
                <span className="ov-choice-where">{c.where}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <label className="ov-field">
        <span className="ov-label">Title</span>
        <input className="ov-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly sync" maxLength={200} />
      </label>
      <label className="ov-field">
        <span className="ov-label">What I need to present</span>
        <textarea className="ov-input" rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value.slice(0, AGENDA_MAX))} placeholder="Optional" />
      </label>
      {error && (
        <p className="ov-fault" role="alert">
          {error}
        </p>
      )}
      <div className="ov-row">
        <button type="submit" className="ov-btn ov-primary" disabled={busy || !choices?.length}>
          {busy ? 'Preparing' : 'Prepare'}
        </button>
      </div>
    </form>
  );
}

/** The brief streams here while the owner gets ready; nothing listens yet. */
export function Ready({ api, view, desktop }: { api: MeetingApi; view: MeetingView; desktop?: DesktopMeetingStatus }) {
  const m = view.meeting!;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // the consent law note shows on the first meeting only (8)
  const [legal] = useState(() => {
    try {
      return localStorage.getItem(LEGAL_KEY) !== '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LEGAL_KEY, '1');
    } catch {
      /* no storage: it shows again next time */
    }
  }, []);
  // a scheduled meeting with a prep has no brief message: the prep is its brief (11.4.5)
  const [prep, setPrep] = useState<string>();
  useEffect(() => {
    if (m.briefMessageId || m.status === 'preparing') return;
    let live = true;
    api.prep(m.id).then(
      (p) => live && setPrep(p.edited ?? p.draft),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, m.id, m.briefMessageId, m.status, m.prepEditedAt, m.prepAt]);
  const brief = m.briefMessageId ? view.text[m.briefMessageId] : prep;
  const mac = /Mac OS X|Macintosh/.test(navigator.userAgent);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await ipc.start(m.id);
      void ipc.focusable(false)?.catch(() => undefined);
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Could not start listening');
    }
    setBusy(false);
  };

  return (
    <div className="ov-stack">
      <p className="ov-state">{m.status === 'preparing' ? 'Preparing the brief' : 'Ready'}</p>
      <h1 className="ov-title">{m.title}</h1>
      <div className="ov-brief" aria-live="polite">
        {brief ? <BriefText text={brief} /> : <p className="ov-muted">{m.status === 'preparing' ? 'Reading the project' : 'No brief'}</p>}
      </div>
      <p className="ov-body">Conclave will hear your microphone and this computer's sound until you end the meeting.</p>
      {legal && <p className="ov-muted">Some places, for example California, need everyone's consent to record a call. Not legal advice.</p>}
      {mac && <p className="ov-muted">Hidden from older capture only. Zoom, Teams, OBS and Chrome on macOS 15 can see it. Hide it when you share.</p>}
      {desktop?.stt.state === 'downloading' && <p className="ov-muted">Downloading speech model {Math.round((desktop.stt.progress ?? 0) * 100)} %</p>}
      {error && (
        <p className="ov-fault" role="alert">
          {error}
        </p>
      )}
      <div className="ov-row">
        {desktop ? (
          // the desktop refuses to start before the meeting is ready (3.3)
          <button type="button" className="ov-btn ov-primary" disabled={busy || m.status !== 'ready'} onClick={() => void start()}>
            {busy ? 'Starting' : 'Start listening'}
          </button>
        ) : (
          <p className="ov-muted">Open this in the Conclave desktop app to listen.</p>
        )}
        <CopyConsent />
        <button type="button" className="ov-btn ov-quiet" onClick={() => void api.remove(m.id).then(() => ipc.hide())}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Headings and bullets of the brief, without a markdown library in this bundle. */
export function BriefText({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      out.push(
        <ul key={out.length} className="ov-list">
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) list.push(b[1]!.replace(/\*\*/g, ''));
    else {
      flush();
      out.push(h ? <h2 key={out.length} className="ov-h">{h[1]}</h2> : <p key={out.length}>{line.replace(/\*\*/g, '')}</p>);
    }
  }
  flush();
  return <>{out}</>;
}

export function CopyConsent() {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ov-btn ov-quiet"
      onClick={() =>
        void navigator.clipboard?.writeText(CONSENT_NOTE).then(
          () => setDone(true),
          () => undefined,
        )
      }
    >
      {done ? 'Copied' : 'Copy consent note'}
    </button>
  );
}
