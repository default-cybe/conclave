/**
 * The Meetings page (docs/design/MEETING-MODE.md 11.2): Now, Upcoming and
 * Past, with "Schedule meeting" and "Start now". /meetings/new opens the
 * form (prefilled from "Schedule a meeting here..."); on a phone the form is
 * the whole page.
 */
import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Button } from '@/components/ui/Button';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { ListRow, MetaLine } from '@/components/ui/List';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Section';
import { folderName } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { onHubEvent } from '@/store/store';
import type { Meeting } from '@/overlay/wire';
import { meetings } from './api';
import { MeetingForm, useOwnerZone, type FormMode } from './MeetingForm';
import { STATUS_WORD } from './MeetingPage';
import { countdown, notHeld, pastKey, prepWord, sections, tickFor, when, yourTime } from './time';

const PAST_PAGE = 20;

/** Every Now and Upcoming meeting, and Past one page at a time (the view routes of 11.6, not the 50 newest created). */
function useMeetings() {
  const [list, setList] = useState<Meeting[]>();
  const [error, setError] = useState<string>();
  const [morePast, setMorePast] = useState(false);
  // by id: one meeting can come back in two views (a late ready one under Now and Upcoming)
  const merge = (more: Meeting[]) => setList((l) => [...new Map([...(l ?? []), ...more].map((m) => [m.id, m])).values()]);
  const older = (before?: number) =>
    meetings()
      .view('past', { limit: PAST_PAGE, before })
      .then((p) => {
        merge(p);
        setMorePast(p.length === PAST_PAGE);
      });
  useEffect(() => {
    const api = meetings();
    Promise.all([api.view('now', { limit: 200 }), api.view('upcoming', { limit: 200 }), api.view('past', { limit: PAST_PAGE })])
      .then(([now, up, past]) => {
        merge([...now, ...up, ...past]);
        setMorePast(past.length === PAST_PAGE);
      })
      .catch((e: Error) => setError(e.message));
    return onHubEvent((e) => {
      if (e.type === 'meeting.updated') {
        const m = (e as unknown as { meeting: Meeting }).meeting;
        setList((l) => (l ? [m, ...l.filter((x) => x.id !== m.id)] : l));
      } else if (e.type === 'session.deleted') setList((l) => l?.filter((x) => x.sessionId !== e.sessionId));
    });
  }, []);
  return { list, error, morePast, older };
}

export function MeetingsList({ form }: { form?: 'new' | 'start' }) {
  const phone = useIsMobile();
  const zone = useOwnerZone();
  const [, go] = useLocation();
  const search = useSearch();
  const { list, error, morePast, older } = useMeetings();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const soonest = list?.filter((m) => m.status === 'scheduled' || m.status === 'ready').map((m) => m.scheduledAt ?? Infinity).sort((a, b) => a - b)[0];
  const now = useNow(tickFor(soonest, Date.now()));
  usePageHeader(form === 'new' ? 'Schedule a meeting' : form === 'start' ? 'Start a meeting now' : 'Meetings', form ? '/meetings' : undefined);
  const q = new URLSearchParams(search);
  const prefill = q.get('cwd') && q.get('device') ? { device: q.get('device')!, cwd: q.get('cwd')! } : undefined;
  const mode: FormMode | undefined = form === 'new' ? { kind: 'new' } : form === 'start' ? { kind: 'start' } : undefined;
  const close = () => go('/meetings', { replace: true });
  const saved = (m: Meeting, opened?: boolean) => go(opened ? '/meetings' : `/meetings/${m.id}`, { replace: true });

  if (mode && phone) return <MeetingForm page mode={mode} open onClose={close} onSaved={saved} others={list} prefill={prefill} />;

  const s = list ? sections(list, now) : undefined;
  const row = (m: Meeting) => {
    const [prep, prepTone] = prepWord(m);
    const held = notHeld(m, now);
    const [word, tone] = held ? (['Not held', 'dim'] as const) : m.status === 'scheduled' ? [prep, prepTone] : STATUS_WORD[m.status];
    const t = m.scheduledAt ?? m.startedAt ?? m.createdAt;
    const right = m.status === 'scheduled' || m.status === 'ready' ? (held ? when(t, undefined, zone) : countdown(t, now, zone)) : when(t, undefined, zone);
    return (
      <ListRow
        key={m.id}
        href={`/meetings/${m.id}`}
        title={m.title}
        meta={<MetaLine parts={[m.scheduledAt && !held ? `${when(m.scheduledAt, m.durationMin, zone)} ${yourTime(m.scheduledAt, zone)}`.trim() : undefined, m.cwd ? <span title={m.cwd}>{folderName(m.cwd)}</span> : 'files only', m.steeringPreset && m.steeringPreset !== 'custom' ? m.steeringPreset : undefined]} />}
        time={right}
        state={word}
        stateTone={tone}
      />
    );
  };
  const actions = (
    <>
      <Button variant="outline" size={phone ? 'touch' : 'sm'} onClick={() => go('/meetings/start')}>
        Start now
      </Button>
      <Button variant="solid" size={phone ? 'touch' : 'sm'} onClick={() => go('/meetings/new')}>
        Schedule meeting
      </Button>
    </>
  );
  const sub = s ? [s.now.length && `${s.now.length} now`, `${s.upcoming.length} upcoming`].filter(Boolean).join(', ') : undefined;
  return (
    <Page width="column">
      <PageHeader title="Meetings" sub={sub} actions={actions} />
      {error && <p className="text-[14px] text-fault">{error}</p>}
      <LoadingRows loading={!list && !error} />
      {s && !list!.length && (
        <EmptyState action={{ label: 'Schedule meeting', onClick: () => go('/meetings/new') }}>
          No meetings yet. Schedule one for a project folder: before it starts, Conclave reads your chats, code and git history there and writes you a brief.
        </EmptyState>
      )}
      {s && list!.length > 0 && (
        <div className="flex flex-col gap-8">
          {s.now.length > 0 && (
            <Section title="Now" count={s.now.length}>
              {s.now.map(row)}
            </Section>
          )}
          <Section title="Upcoming" count={s.upcoming.length || undefined}>
            {s.upcoming.length ? s.upcoming.map(row) : <p className="py-3 text-[13px] text-fg-3 phone:text-[15px]">Nothing scheduled.</p>}
          </Section>
          {s.past.length > 0 && (
            <Section title="Past" count={s.past.length}>
              {s.past.map(row)}
              {morePast && (
                <div className="py-2">
                  <Button
                    variant="quiet"
                    size={phone ? 'touch' : 'sm'}
                    disabled={loadingOlder}
                    onClick={() => {
                      setLoadingOlder(true);
                      void older(pastKey(s.past.at(-1)!)).finally(() => setLoadingOlder(false));
                    }}
                  >
                    Show older
                  </Button>
                </div>
              )}
            </Section>
          )}
        </div>
      )}
      {mode && <MeetingForm mode={mode} open onClose={close} onSaved={saved} others={list} prefill={prefill} />}
    </Page>
  );
}
