/**
 * Meetings in the app (docs/design/MEETING-MODE.md 2.3): /meetings lists
 * the account's meetings, /meetings/:id shows one: its notes once wrapped up,
 * the answers given, the transcript and the brief. A live meeting updates
 * from the app's own hub events, applied once per animation frame. Listening
 * happens only in the desktop app's overlay; here is "Open overlay" there,
 * and words that say so elsewhere.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { ListRow, StateWord, type StateTone } from '@/components/ui/List';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Section';
import { Markdown } from '@/features/chat/Markdown';
import { folderName, hhmm, relTime } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { isDesktopApp } from '@/lib/notify';
import { onHubEvent, toast } from '@/store/store';
import { frameBuffer } from '@/overlay/frame';
import { applyEvent, emptyView, loadDetail, parseAnswer, type MeetingView } from '@/overlay/model';
import { CONSENT_NOTE, type Meeting, type MeetingEvent, type MeetingStatus } from '@/overlay/wire';
import { meetings, openOverlay } from './api';
import { Notes } from './NotesPage';

export const STATUS_WORD: Record<MeetingStatus, [string, StateTone]> = {
  preparing: ['Preparing', 'signal'],
  ready: ['Ready', 'neutral'],
  live: ['Listening', 'signal'],
  paused: ['Paused', 'warn'],
  ending: ['Writing notes', 'signal'],
  ended: ['Ended', 'dim'],
  failed: ['Failed', 'fault'],
};

export default function MeetingPage() {
  const { id } = useParams<{ id?: string }>();
  return id ? <MeetingDetail id={id} /> : <MeetingList />;
}

function MeetingList() {
  const phone = useIsMobile();
  usePageHeader('Meetings');
  const [list, setList] = useState<Meeting[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    meetings()
      .list()
      .then(setList, (e: Error) => setError(e.message));
    // a meeting that starts, ends or changes shows without a reload
    return onHubEvent((e) => {
      // meeting events are not in core's EngineEvent until Track B lands
      if ((e.type as string) !== 'meeting.updated') return;
      const m = (e as unknown as { meeting: Meeting }).meeting;
      setList((l) => (l ? [m, ...l.filter((x) => x.id !== m.id)].sort((a, b) => b.createdAt - a.createdAt) : l));
    });
  }, []);
  return (
    <Page width="column">
      {!phone && <PageHeader title="Meetings" sub={list ? `${list.length} meeting${list.length === 1 ? '' : 's'}` : undefined} />}
      {error && <p className="text-[14px] text-fault">{error}</p>}
      <LoadingRows loading={!list && !error} />
      {list && !list.length && <EmptyState>No meetings yet. Start one from a Code session's header or the desktop app's tray, in the project the meeting is about.</EmptyState>}
      {list && list.length > 0 && (
        <div className="rows">
          {list.map((m) => {
            const [word, tone] = STATUS_WORD[m.status];
            return <ListRow key={m.id} href={`/meetings/${m.id}`} title={m.title} meta={folderName(m.cwd)} time={relTime(m.startedAt ?? m.createdAt)} state={word} stateTone={tone} />;
          })}
        </div>
      )}
    </Page>
  );
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

function MeetingDetail({ id }: { id: string }) {
  const phone = useIsMobile();
  const { view, error } = useMeeting(id);
  const m = view.meeting;
  usePageHeader(m?.title ?? 'Meeting', '/meetings');
  const [, go] = useLocation();
  const [confirm, setConfirm] = useState<'end' | 'delete'>();
  const [copied, setCopied] = useState(false);

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

  const [word, tone] = STATUS_WORD[m.status];
  const running = m.status === 'live' || m.status === 'paused';
  const desktop = isDesktopApp();
  const fail = (e: unknown) => toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });
  const actions = (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={() =>
          void navigator.clipboard?.writeText(CONSENT_NOTE).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? 'Copied' : 'Copy consent note'}
      </Button>
      {desktop && m.status !== 'ended' && m.status !== 'failed' && (
        <Button variant="outline" size="sm" onClick={() => void openOverlay(m.id).catch(fail)}>
          Open overlay
        </Button>
      )}
      {running && (
        <Button variant="outline" size="sm" onClick={() => setConfirm('end')}>
          End meeting
        </Button>
      )}
      {!running && m.status !== 'ending' && (
        <Button variant="quiet" size="sm" onClick={() => setConfirm('delete')}>
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
            , <span title={m.cwd}>{folderName(m.cwd)}</span>
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
      <div className="flex flex-col gap-8">
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
        body="The transcript, answers and session go. The notes file in the project and its tasks stay."
        onConfirm={() =>
          meetings()
            .remove(m.id)
            .then(() => go('/meetings'), fail)
        }
      />
    </Page>
  );
}
