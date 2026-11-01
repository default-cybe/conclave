/**
 * The prep of a scheduled meeting (docs/design/MEETING-MODE.md 11.4, 11.5):
 * Prepare, progress while it reads, the 500k approval, the brief rendered
 * with Edit and Re-run, the new-draft banner with Compare, "Also include
 * chats", and the Steering tab with its preview. Start now and the
 * arm-at-time flow open the overlay through openOverlay. Once the meeting
 * started the prep is read-only, and the Steering tab stays while it listens.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { Session } from '@conclave/core/types';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox, Input, Textarea } from '@/components/ui/Field';
import { Meter } from '@/components/ui/Meter';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { Section } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tags';
import { Markdown } from '@/features/chat/Markdown';
import { api } from '@/lib/api';
import { compact, folderName, relTime } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { isDesktopApp } from '@/lib/notify';
import { onHubEvent, toast } from '@/store/store';
import type { Meeting, PrepView } from '@/overlay/wire';
import { meetings, openOverlay } from './api';
import { framed, SteeringFields, type Steering } from './MeetingForm';
import { countdown } from './time';
import { useMeetingHint } from './useMeetingHint';

const PHASE: Record<string, string> = {
  inventory: 'Finding your chats, workflows and commits',
  'waiting-approval': 'Waiting for your OK',
  map: 'Reading chats',
  merge: 'Merging summaries',
  reduce: 'Writing the brief',
  done: 'Done',
};

/** Chats read at once (core meeting/prep.ts MAP_PARALLEL). */
const MAP_PARALLEL = 3;
const EXTRA_SUGGESTIONS = 10;

const fail = (e: unknown) => toast({ title: e instanceof Error ? e.message : String(e), level: 'error' });

function usePrep(m: Meeting) {
  const [prep, setPrep] = useState<PrepView>();
  useEffect(() => {
    const load = () =>
      meetings()
        .prep(m.id)
        .then(setPrep, () => setPrep({ state: 'none' }));
    void load();
    return onHubEvent((e) => {
      const x = e as unknown as { type: string; meetingId?: string; state?: PrepView['state']; progress?: PrepView['progress'] };
      if (x.type !== 'meeting.prep' || x.meetingId !== m.id) return;
      // progress rides the event; a finished prep needs its text
      if (x.state === 'done' || x.state === 'failed' || x.state === 'waiting') void load();
      else setPrep((p) => ({ ...(p ?? { state: 'none' }), state: x.state!, progress: x.progress }));
    });
  }, [m.id]);
  return [prep, setPrep] as const;
}

/** Start listening: arm a scheduled meeting first (11.5), then open the overlay. Elsewhere the page shows "Open on desktop". */
export async function startMeeting(m: Meeting): Promise<void> {
  const out = m.status === 'scheduled' ? await meetings().arm(m.id) : m;
  await openOverlay(out.id);
}

/** 11.4.1 "Also include chats": imported claude.ai and ChatGPT chats match only by a tick. */
function ExtraChats({ meeting: m, extra, onChange }: { meeting: Meeting; extra: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Session[]>();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const name = m.title.split(/[\s,]/)[0] || folderName(m.cwd);
  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        void api()
          .listSessions({ kind: 'chat', search: q.trim() || name, limit: EXTRA_SUGGESTIONS })
          .then(
            (l) => {
              if (!live) return;
              setFound(l);
              setTitles((t) => ({ ...t, ...Object.fromEntries(l.map((s) => [s.id, s.title])) }));
            },
            () => live && setFound([]),
          ),
      q ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, name]);
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...extra, id] : extra.filter((x) => x !== id);
    onChange(next);
    void meetings().prepExtra(m.id, next).catch(fail);
  };
  const rows = [...extra.map((id) => ({ id, title: titles[id] ?? 'A ticked chat' })), ...(found ?? []).filter((s) => !extra.includes(s.id)).map((s) => ({ id: s.id, title: s.title }))];
  return (
    <Section title="Also include chats" count={extra.length || undefined} rows={false}>
      <div className="flex flex-col gap-2 py-2">
        <p className="m-0 text-[13px] text-fg-3 phone:text-[14px]">Chats imported from claude.ai or ChatGPT are not on this folder. Tick the ones the prep should read too.</p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search chats, e.g. ${name}`} aria-label="Search chats" />
        {found && !rows.length && <p className="m-0 text-[13px] text-fg-3 phone:text-[14px]">No chats match.</p>}
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <Checkbox key={r.id} label={r.title || 'Untitled chat'} checked={extra.includes(r.id)} onChange={(on) => toggle(r.id, on)} />
          ))}
        </div>
      </div>
    </Section>
  );
}

export function PrepPanel({ meeting: m, zone, now, ahead = true }: { meeting: Meeting; zone: string; now: number; ahead?: boolean }) {
  const phone = useIsMobile();
  const size = phone ? 'touch' : 'sm';
  const desktop = isDesktopApp();
  const [prep, setPrep] = usePrep(m);
  const listening = m.status === 'live' || m.status === 'paused';
  const [tab, setTab] = useState<'prep' | 'steering'>('prep');
  const [editing, setEditing] = useState<string>();
  const [ask, setAsk] = useState<'rerun' | 'discard' | 'new'>();
  const [compare, setCompare] = useState(false);
  const [side, setSide] = useState<'mine' | 'new'>('mine');
  const [kept, setKept] = useState<number>();
  const [saved, setSaved] = useState(false);
  const [steer, setSteer] = useState<Steering>({ steering: m.steering ?? '', steeringPreset: m.steeringPreset, answerLength: m.answerLength ?? 'short' });
  const [steerSaved, setSteerSaved] = useState<Steering>(steer);
  const [preview, setPreview] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const article = useRef<HTMLDivElement>(null);
  const other = useMeetingHint().live;
  const blocked = other && other.id !== m.id ? other : undefined;
  useEffect(() => setExtra(prep?.extra ?? []), [prep?.extra]);
  const steerDirty = steer.steering !== steerSaved.steering || steer.answerLength !== steerSaved.answerLength || steer.steeringPreset !== steerSaved.steeringPreset;

  const run = (approve?: boolean) => meetings().runPrep(m.id, approve ? true : undefined).catch(fail);
  const text = prep?.edited ?? prep?.draft;
  const busy = prep?.state === 'queued' || prep?.state === 'running';
  const p = prep?.progress;
  const elapsed = p ? Math.max(0, now - p.startedAt) : 0;
  const left = p?.medianMs && p.total > p.done ? Math.ceil(((p.total - p.done) * p.medianMs) / MAP_PARALLEL / 60_000) : undefined;
  // 11.4.4: a draft newer than the owner's edit, until he picks one
  const newDraft = ahead && prep?.edited !== undefined && prep.draft !== undefined && !!prep.at && !!prep.editedAt && prep.at > prep.editedAt && kept !== prep.at;

  const start = () => startMeeting(m).catch(fail);
  const showTabs = ahead || listening;
  const steeringTab = ahead || listening;
  // read-only after the start: nothing to show without a prep
  if (!ahead && !listening && !text) return null;

  const body = (md: string) => (
    <article className="rounded-[var(--r-2)] border border-rule px-5 py-4 phone:px-4">
      <Markdown text={md} />
    </article>
  );

  return (
    <div className="flex flex-col gap-6">
      {ahead && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {desktop || m.status === 'scheduled' ? (
              <Button variant="solid" size={size} disabled={!!blocked} onClick={() => void start()}>
                {m.status === 'scheduled' ? 'Start now' : 'Open overlay'}
              </Button>
            ) : (
              <ButtonLink variant="solid" size={size} href={`conclave://meeting/${encodeURIComponent(m.id)}`} target="_self">
                Open on desktop
              </ButtonLink>
            )}
            {m.scheduledAt && m.status === 'scheduled' && (
              <span className="text-[13px] text-fg-3 phone:text-[14px]">
                Starts {countdown(m.scheduledAt, now, zone)}. Ten minutes before, Conclave gets it ready; open the overlay in the desktop app and press Start listening.
              </span>
            )}
            {!desktop && m.status !== 'scheduled' && <span className="text-[13px] text-fg-3 phone:text-[14px]">Ready. Listening works in the Conclave desktop app only.</span>}
          </div>
          {blocked && (
            <p className="m-0 text-[13px] text-warn phone:text-[14px]">
              {blocked.title} is listening. End it before you start this one.{' '}
              <Link href={`/meetings/${blocked.id}`} className="link">
                Open it
              </Link>
            </p>
          )}
        </div>
      )}
      {showTabs && (
        <Tabs
          label="Prep and steering"
          value={tab}
          onChange={setTab}
          options={[{ value: 'prep', label: 'Prep' }, ...(steeringTab ? [{ value: 'steering' as const, label: 'Steering' }] : [])]}
        />
      )}
      {!showTabs && <h2 className="t-title m-0 text-fg">Prep</h2>}
      {tab === 'prep' && (
        <div className="flex flex-col gap-4">
          {!prep && <p className="text-[14px] text-fg-3">Loading the prep</p>}
          {!ahead && prep && !text && <p className="text-[14px] text-fg-3">This meeting had no prep.</p>}
          {ahead && prep && (prep.state === 'none' || prep.state === 'cancelled') && !text && (
            <div className="flex flex-col items-start gap-3">
              <p className="max-w-[60ch] text-[14px] leading-[1.55] text-fg-2 phone:text-[15px]">
                Prepare reads every chat on this folder and below it, its workflows, the code and the git history, and writes a brief for the meeting: what you did, the evidence and numbers, likely questions, and weak spots. You can edit it before the meeting.
              </p>
              <Button variant="solid" size={size} onClick={() => void run()}>
                Prepare
              </Button>
            </div>
          )}
          {ahead && prep?.state === 'waiting' && prep.estimate && (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[14px] leading-[1.55] text-fg phone:text-[15px]">
                This reads <span className="num">{prep.estimate.sessions}</span> chats, about <span className="num">{compact(prep.estimate.tokens)}</span> tokens on {prep.estimate.model}
                {prep.estimate.usd !== undefined && <span className="num"> (about ${prep.estimate.usd.toFixed(2)})</span>}. Continue?
              </p>
              <div className="flex gap-2">
                <Button variant="solid" size={size} onClick={() => void run(true)}>
                  Continue
                </Button>
                <Button variant="quiet" size={size} onClick={() => void meetings().cancelPrep(m.id).catch(fail)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {busy && (
            <div className="flex flex-col gap-2" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-[13px] phone:text-[14px]">
                <span className="text-fg">
                  {PHASE[p?.phase ?? 'inventory']}
                  <span className="num text-fg-3">
                    {p && p.total > 0 ? ` ${p.done} of ${p.total}` : ''}
                    {left ? `, about ${left} min left` : elapsed > 5000 ? `, ${Math.round(elapsed / 1000)}s` : ''}
                  </span>
                </span>
                {ahead && (
                  <Button variant="outline" size={size} onClick={() => void meetings().cancelPrep(m.id).catch(fail)}>
                    Cancel
                  </Button>
                )}
              </div>
              <Meter value={p && p.total ? p.done : 0} max={p?.total || 1} label="Prep progress" tone="signal" />
            </div>
          )}
          {prep?.state === 'failed' && (
            <p className="text-[14px] text-fault">
              {prep.error ?? 'The prep failed.'}{' '}
              {ahead && (
                <button type="button" className="link" onClick={() => void run()}>
                  Try again
                </button>
              )}
            </p>
          )}
          {newDraft && (
            <div className="flex flex-col gap-2 rounded-[var(--r-2)] border border-rule bg-sunk px-4 py-3" role="status">
              <p className="m-0 text-[14px] text-fg phone:text-[15px]">A new draft is ready. Your edited version is still the one in use.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size={size} onClick={() => setCompare((c) => !c)}>
                  {compare ? 'Hide compare' : 'Compare'}
                </Button>
                <Button variant="outline" size={size} onClick={() => setAsk('new')}>
                  Use new draft
                </Button>
                <Button
                  variant="quiet"
                  size={size}
                  onClick={() => {
                    setKept(prep!.at);
                    setCompare(false);
                  }}
                >
                  Keep mine
                </Button>
              </div>
            </div>
          )}
          {newDraft && compare && prep?.edited !== undefined && prep.draft !== undefined && editing === undefined && (
            <div className="flex flex-col gap-3">
              {phone ? (
                <>
                  <Tabs
                    label="Compare"
                    value={side}
                    onChange={setSide}
                    options={[
                      { value: 'mine', label: 'Mine' },
                      { value: 'new', label: 'New' },
                    ]}
                  />
                  {body(side === 'mine' ? prep.edited : prep.draft)}
                </>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-[12px] font-medium text-fg-2">Mine</span>
                    {body(prep.edited)}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-[12px] font-medium text-fg-2">New</span>
                    {body(prep.draft)}
                  </div>
                </div>
              )}
            </div>
          )}
          {text !== undefined && editing === undefined && !(newDraft && compare) && (
            <div ref={article} className="flex scroll-mt-4 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3 phone:text-[13px]">
                <span className="num">
                  {saved && <span className="text-fg-2">Saved. </span>}
                  {[prep?.edited !== undefined && prep.editedAt ? `Edited ${relTime(prep.editedAt)}` : prep?.at ? `Prepared ${relTime(prep.at)}` : '', prep?.sources ? `from ${prep.sources.sessions} chats, ${prep.sources.commits} commits, ${prep.sources.files} files` : ''].filter(Boolean).join(' ')}
                </span>
                {ahead && (
                  <span className="ml-auto flex flex-wrap gap-1">
                    <Button variant="outline" size={size} onClick={() => setEditing(text)}>
                      Edit brief
                    </Button>
                    {prep?.edited !== undefined && prep.draft !== undefined && !newDraft && (
                      <Button variant="quiet" size={size} onClick={() => setAsk('discard')}>
                        Drop my edits
                      </Button>
                    )}
                    <Button variant="quiet" size={size} disabled={busy} onClick={() => (prep?.edited !== undefined ? setAsk('rerun') : void run())}>
                      Re-run
                    </Button>
                  </span>
                )}
              </div>
              {body(text)}
            </div>
          )}
          {editing !== undefined && (
            <div className="flex flex-col">
              <Textarea mono aria-label="Brief" minRows={14} maxRows={30} maxLength={60_000} value={editing} onChange={(e) => setEditing(e.target.value)} />
              {/* sticky, so Save stays in reach under a long brief (11.7) */}
              <div className="sticky bottom-0 z-[1] flex gap-2 border-t border-rule bg-bg py-2 pb-safe">
                <Button
                  variant="solid"
                  size={size}
                  onClick={() =>
                    void meetings()
                      .savePrep(m.id, editing)
                      .then((v) => {
                        setPrep(v);
                        setEditing(undefined);
                        setSaved(true);
                        requestAnimationFrame(() => article.current?.scrollIntoView({ block: 'start' }));
                      }, fail)
                  }
                >
                  Save
                </Button>
                <Button variant="quiet" size={size} onClick={() => setEditing(undefined)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {ahead && prep && editing === undefined && <ExtraChats meeting={m} extra={extra} onChange={setExtra} />}
        </div>
      )}
      {tab === 'steering' && steeringTab && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-fg-3 phone:text-[14px]">How the live answers sound: tone, what to stress, what to avoid. {listening ? 'Changes apply from the next answer.' : 'You can change it until the meeting ends.'}</p>
          <SteeringFields value={steer} onChange={setSteer} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="solid"
              size={size}
              disabled={!steerDirty}
              onClick={() =>
                // '' clears it on the hub (undefined would be dropped from the JSON)
                void meetings()
                  .patch(m.id, { steering: steer.steering.trim(), steeringPreset: steer.steeringPreset, answerLength: steer.answerLength })
                  .then(() => setSteerSaved(steer), fail)
              }
            >
              {steerDirty ? 'Save steering' : 'Saved'}
            </Button>
            <Button variant="quiet" size={size} onClick={() => setPreview((v) => !v)}>
              {preview ? 'Hide preview' : 'Preview'}
            </Button>
          </div>
          {preview && (
            <Section title="What the answers get" rows={false}>
              <pre className="overflow-x-auto py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-fg-2">{framed(steer)}</pre>
            </Section>
          )}
        </div>
      )}
      <ConfirmDialog
        open={ask === 'rerun'}
        onClose={() => setAsk(undefined)}
        title="Re-run the prep?"
        body="Your edited brief stays until the new draft is done; then you pick which one the meeting uses."
        confirm="Re-run"
        tone="neutral"
        onConfirm={() => run()}
      />
      <ConfirmDialog
        open={ask === 'discard' || ask === 'new'}
        onClose={() => setAsk(undefined)}
        title={ask === 'new' ? 'Use the new draft?' : 'Drop your edits?'}
        body="Your edited brief is deleted and the meeting uses the generated draft."
        confirm={ask === 'new' ? 'Use new draft' : 'Drop my edits'}
        onConfirm={() =>
          meetings()
            .revertPrep(m.id)
            .then(() => {
              setCompare(false);
              return meetings().prep(m.id).then(setPrep);
            }, fail)
        }
      />
    </div>
  );
}
