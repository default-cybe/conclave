/**
 * Meetings in the app (docs/design/MEETING-MODE.md 2.3, 11): /meetings lists
 * the account's meetings (MeetingsList), /meetings/new and /meetings/start
 * open the form, /meetings/:id shows one: the prep before it starts, its notes once wrapped up,
 * the answers given, the transcript and the brief. A live meeting updates
 * from the app's own hub events, applied once per animation frame. Listening
 * happens only in the desktop app's overlay; here is "Open overlay" there,
 * and words that say so elsewhere.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { StateWord, type StateTone } from '@/components/ui/List';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Section';
import { Markdown } from '@/features/chat/Markdown';
import { bytes, folderName, hhmm } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { isDesktopApp } from '@/lib/notify';
import { onHubEvent, toast, useHub } from '@/store/store';
import { frameBuffer } from '@/overlay/frame';
import { answerLatency, applyEvent, emptyView, loadDetail, parseAnswer, seconds, type MeetingView } from '@/overlay/model';
import type { Meeting, MeetingAnswer, MeetingEvent, MeetingStatus } from '@/overlay/wire';
import { meetings, openOverlay } from './api';
import { Notes } from './NotesPage';
import { AfterActions } from './AfterActions';
import { MeetingsList } from './MeetingsList';
import { MeetingForm, useOwnerZone } from './MeetingForm';
import { PrepPanel, startMeeting } from './Prep';
import { notHeld, tickFor, when, yourTime } from './time';

export const STATUS_WORD: Record<MeetingStatus, [string, StateTone]> = {
  scheduled: ['Scheduled', 'neutral'],
  preparing: ['Preparing', 'signal'],
  ready: ['Ready', 'neutral'],
  // red while it listens, as the sidebar's dot (11.1, 11.7)
  live: ['Listening', 'fault'],
  paused: ['Paused', 'warn'],
  ending: ['Writing notes', 'signal'],
  ended: ['Ended', 'dim'],
  failed: ['Failed', 'fault'],
};

export default function MeetingPage() {
  const { id } = useParams<{ id?: string }>();
  if (!id) return <MeetingsList />;
  if (id === 'new' || id === 'start') return <MeetingsList form={id} />;
  return <MeetingDetail id={id} />;
}

/** The meeting's view from GET /api/meetings/:id and the hub's events, one render per frame at most. */
function useMeeting(id: string) {
  const view = useRef<MeetingView>(emptyView()).current;
  const subs = useRef(new Set<() => void>()).current;
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stop = false;
    const notify = () => subs.forEach((fn) => fn());
    const api = meetings();
    const load = async () => {
      try {
        const d = await api.get(id);
        const msgs = await api.messages(d.sessionId).catch(() => []);
        if (stop) return;
        loadDetail(view, d, msgs);
        if (d.status === 'ended') view.notes = await api.notes(id).catch(() => undefined);
        notify();
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const frame = frameBuffer<MeetingEvent>((events) => {
      let changed = false;
      for (const e of events) changed = applyEvent(view, e) || changed;
      if (changed) notify();
    });
    const off = onHubEvent((e) => {
      if (e.type.startsWith('meeting.') || e.type.startsWith('message.')) frame.push(e as unknown as MeetingEvent);
    });
    return () => {
      stop = true;
      off();
      frame.cancel();
    };
  }, [id, view, subs]);
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => view.version,
  );
  return { view, error };
}

const DAY = 24 * 60 * 60_000;

/** "First word 0.8 s after they stopped, done in 2.4 s, haiku-5-5": one answer's timings. */
export function answerTimings(a: MeetingAnswer): string | undefined {
  const first = answerLatency(a);
  const parts: string[] = [];
  if (first !== undefined) parts.push(`First word ${seconds(first)} after ${a.speechEndAt !== undefined ? 'they stopped' : 'you asked'}`);
  if (a.doneAt !== undefined) parts.push(`done in ${seconds(a.doneAt - (a.speechEndAt ?? a.createdAt))}`);
  if (a.model) parts.push(a.model.split('/').pop()!);
  return parts.length ? parts.join(', ') : undefined;
}

/** 11.3.2: the linked event's start when it moved from the meeting's, read when the page opens. */
function useMovedEvent(m: Meeting | undefined): number | undefined {
  const [at, setAt] = useState<number>();
  const id = m?.calendarEventId;
  const start = m?.status === 'scheduled' ? m.scheduledAt : undefined;
  useEffect(() => {
    setAt(undefined);
    if (!id || !start) return;
    let live = true;
    void meetings()
      .calendar(start - 7 * DAY, start + 7 * DAY)
      .then(
        (r) => {
          const e = r.events.find((x) => x.id === id);
          if (live && e && e.start !== start && e.start > Date.now()) setAt(e.start);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [id, start]);
  return at;
}

function MeetingDetail({ id }: { id: string }) {
  const phone = useIsMobile();
  const { view, error } = useMeeting(id);
  const m = view.meeting;
  usePageHeader(m?.title ?? 'Meeting', '/meetings');
  const [, go] = useLocation();
  const [confirm, setConfirm] = useState<'end' | 'delete'>();
  const [edit, setEdit] = useState(false);
  const [keep, setKeep] = useState<number>();
  const moved = useMovedEvent(view.meeting);
  const online = useHub((s) => (view.meeting ? s.devices[view.meeting.device]?.online : undefined));
  const deviceName = useHub((s) => (view.meeting ? s.devices[view.meeting.device]?.name : undefined));
  const zone = useOwnerZone();
  const now = useNow(tickFor(m?.scheduledAt, Date.now()));
  // ?open=1: the "starts now" notice's link (11.5); the overlay opens only on this tap
  const due = new URLSearchParams(useSearch()).get('open') === '1';

  if (error)
    return (
      <Page width="column">
        <PageHeader title="Meeting" />
        <EmptyState action={<Link href="/meetings">All meetings</Link>}>{error}</EmptyState>
      </Page>
    );
  if (!m)
    return (
      <Page width="column">
        <LoadingRows loading />
      </Page>
    );

  const held = notHeld(m, now);
  const [word, tone]: [string, StateTone] = held ? ['Not held', 'dim'] : STATUS_WORD[m.status];
  const running = m.status === 'live' || m.status === 'paused';
  const desktop = isDesktopApp();
  const fail = (e: unknown) => toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
  // a meeting not started yet: the prep view (11.5)
  const ahead = !m.startedAt && (m.status === 'scheduled' || m.status === 'ready' || m.status === 'preparing') && !notHeld(m, now);
  const size = phone ? 'touch' : 'sm';
  const actions = (
    <>
      {(m.status === 'scheduled' || held) && !m.startedAt && (
        <Button variant={held ? 'solid' : 'outline'} size={size} onClick={() => setEdit(true)}>
          {held ? 'Reschedule' : 'Edit meeting'}
        </Button>
      )}
      {desktop && !ahead && m.status !== 'ended' && m.status !== 'failed' && (
        <Button variant="outline" size={size} onClick={() => void openOverlay(m.id).catch(fail)}>
          Open overlay
        </Button>
      )}
      {!running && m.status !== 'ending' && <AfterActions meeting={m} size={size} wrapped={!!view.notes} />}
      {running && (
        <Button variant="outline" size={size} onClick={() => setConfirm('end')}>
          End meeting
        </Button>
      )}
      {!running && m.status !== 'ending' && (
        <Button variant="quiet" size={size} onClick={() => setConfirm('delete')}>
          Delete
        </Button>
      )}
    </>
  );
  const finals = view.finals;
  const brief = m.briefMessageId ? view.text[m.briefMessageId] : undefined;

  return (
    <Page width="column">
      <PageHeader
        title={m.title}
        sub={
          <span>
            <StateWord tone={tone} live>
              {word}
            </StateWord>
            , {m.cwd ? <span title={m.cwd}>{folderName(m.cwd)}</span> : <span>files only</span>}
            {m.scheduledAt && !m.startedAt && (
              <>
                , <span className="num">{when(m.scheduledAt, m.durationMin, zone)}</span> <span className="num">{yourTime(m.scheduledAt, zone)}</span>
              </>
            )}
            {m.startedAt && (
              <>
                , <span className="num">{hhmm(m.startedAt)}</span>
              </>
            )}
          </span>
        }
        actions={phone ? undefined : actions}
      />
      {phone && <div className="mb-4 flex flex-wrap gap-2">{actions}</div>}
      {due && !m.startedAt && m.status !== 'ended' && m.status !== 'failed' && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <p className="m-0 text-[14px] text-fg phone:text-[15px]">{m.title} starts now</p>
          {desktop ? (
            <Button variant="solid" size={size} onClick={() => void startMeeting(m).then(() => go(`/meetings/${m.id}`, { replace: true }), fail)}>
              Open overlay
            </Button>
          ) : (
            <ButtonLink variant="solid" size={size} href={`conclave://meeting/${encodeURIComponent(m.id)}`} target="_self">
              Open on desktop
            </ButtonLink>
          )}
          <Button variant="quiet" size={size} onClick={() => go(`/meetings/${m.id}`, { replace: true })}>
            Not now
          </Button>
        </div>
      )}
      {moved && keep !== moved && m.status === 'scheduled' && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-[var(--r-2)] border border-rule bg-sunk px-4 py-3" role="status">
          <p className="m-0 text-[14px] text-fg phone:text-[15px]">
            The calendar event moved to <span className="num">{when(moved, undefined, zone)}</span>. Move this meeting too?
          </p>
          <Button variant="solid" size={size} onClick={() => void meetings().patch(m.id, { scheduledAt: moved }).then(() => setKeep(moved), fail)}>
            Move
          </Button>
          <Button variant="quiet" size={size} onClick={() => setKeep(moved)}>
            Keep
          </Button>
        </div>
      )}
      {ahead && online === false && (
        <p className="mb-6 text-[13px] text-warn phone:text-[14px]">
          {deviceName ?? m.device} is offline. Prep reads your chats now, and the code and git history only once it is online.
        </p>
      )}
      {ahead && <PrepPanel meeting={m} zone={zone} now={now} />}
      {!!m.files?.length && (
        <div className="mb-8">
          <Section title="Files" count={m.files.length}>
            {m.files.map((f) => (
              <div key={f.id} className="flex items-baseline justify-between gap-3 py-2.5 text-[14px] phone:text-[15px]">
                <span className="min-w-0 truncate text-fg">{f.name}</span>
                <span className="num shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{bytes(f.size)}</span>
              </div>
            ))}
          </Section>
        </div>
      )}
      {edit && <MeetingForm mode={{ kind: 'edit', meeting: m }} open onClose={() => setEdit(false)} onSaved={() => setEdit(false)} />}
      <div className={ahead ? 'hidden' : 'flex flex-col gap-8'}>
        {!desktop && (m.status === 'ready' || m.status === 'preparing') && (
          <p className="text-[14px] text-fg-2">
            Open the Conclave desktop app to listen.{' '}
            <a className="link" href={`conclave://meeting/${encodeURIComponent(m.id)}`}>
              Open it now
            </a>
          </p>
        )}
        {m.status === 'failed' && m.error && <p className="text-[14px] text-fault">{m.error}</p>}
        {m.status === 'ending' && <p className="text-[14px] text-fg-2">Writing the notes. This page fills in when they are done.</p>}
        {view.notes && <Notes meeting={m} notes={view.notes} />}
        {view.answers.length > 0 && (
          <Section title="Answers" count={view.answers.length}>
            {[...view.answers].reverse().map((a) => {
              const p = parseAnswer(view.text[a.messageId] ?? '');
              const timings = answerTimings(a);
              return (
                <div key={a.id} className="py-3">
                  <p className="text-[13px] text-fg-3">
                    {a.question || 'Answer now'}
                    {a.state !== 'done' && <span className={a.state === 'failed' ? 'text-fault' : undefined}>, {a.state === 'streaming' ? 'writing' : a.state}</span>}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-[15px] leading-[1.55] text-fg">
                    {p.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                  {p.rest && <p className="mt-1 text-[15px] text-fg">{p.rest}</p>}
                  {p.source !== undefined && <p className="mt-1 text-[12px] text-fg-3">Source: {p.source}</p>}
                  {timings && <p className="num mt-1 text-[12px] text-fg-3 phone:text-[13px]">{timings}</p>}
                </div>
              );
            })}
          </Section>
        )}
        <Section title="Transcript" count={finals.length || undefined} rows={false}>
          {finals.length ? (
            <ol className="flex flex-col gap-1.5 py-2 text-[14px] leading-[1.5]">
              {finals.map((l) => (
                <li key={`${l.channel}:${l.seq}`} className={l.channel === 'me' ? 'text-fg-2' : 'text-fg'}>
                  <span className="text-fg-3">{l.channel === 'them' ? 'Them:' : 'Me:'}</span> {l.text}
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-2 text-[14px] text-fg-3">Nothing said yet.</p>
          )}
        </Section>
        {brief && (
          <Section title="Brief" rows={false}>
            <Markdown text={brief} className="py-2" />
          </Section>
        )}
        {!ahead && !held && <PrepPanel meeting={m} zone={zone} now={now} ahead={false} />}
      </div>
      <ConfirmDialog
        open={confirm === 'end'}
        onClose={() => setConfirm(undefined)}
        title="End this meeting?"
        body="Listening stops and Conclave writes the notes."
        confirm="End meeting"
        tone="neutral"
        onConfirm={() => meetings().end(m.id).catch(fail)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(undefined)}
        title="Delete this meeting?"
        body="The transcript, answers, session and its memory entry go. The notes file in the project and its tasks stay."
        onConfirm={() =>
          meetings()
            .remove(m.id)
            .then(() => go('/meetings'), fail)
        }
      />
    </Page>
  );
}
