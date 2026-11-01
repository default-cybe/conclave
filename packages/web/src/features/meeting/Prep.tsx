/**
 * The prep of a scheduled meeting (docs/design/MEETING-MODE.md 11.4, 11.5):
 * Prepare, progress while it reads, the 500k approval, the brief rendered
 * with Edit and Re-run, and the Steering tab with its preview. Start now and
 * the arm-at-time flow open the overlay through openOverlay.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Meter } from '@/components/ui/Meter';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { Section } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tags';
import { Markdown } from '@/features/chat/Markdown';
import { compact, relTime } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { isDesktopApp } from '@/lib/notify';
import { onHubEvent, toast } from '@/store/store';
import type { Meeting, PrepView } from '@/overlay/wire';
import { meetings, openOverlay } from './api';
import { framed, SteeringFields, type Steering } from './MeetingForm';
import { countdown, when } from './time';

const PHASE: Record<string, string> = {
  inventory: 'Finding your chats, workflows and commits',
  'waiting-approval': 'Waiting for your OK',
  map: 'Reading chats',
  merge: 'Merging summaries',
  reduce: 'Writing the brief',
  done: 'Done',
};

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

export function PrepPanel({ meeting: m, zone, now }: { meeting: Meeting; zone: string; now: number }) {
  const phone = useIsMobile();
  const size = phone ? 'touch' : 'sm';
  const [prep, setPrep] = usePrep(m);
  const [tab, setTab] = useState<'prep' | 'steering'>('prep');
  const [editing, setEditing] = useState<string>();
  const [ask, setAsk] = useState<'rerun' | 'discard'>();
  const [steer, setSteer] = useState<Steering>({ steering: m.steering ?? '', steeringPreset: m.steeringPreset, answerLength: m.answerLength ?? 'short' });
  const [preview, setPreview] = useState(false);
  const steerDirty = steer.steering !== (m.steering ?? '') || steer.answerLength !== (m.answerLength ?? 'short');

  const run = (approve?: boolean) => meetings().runPrep(m.id, approve ? true : undefined).catch(fail);
  const text = prep?.edited ?? prep?.draft;
  const busy = prep?.state === 'queued' || prep?.state === 'running';
  const p = prep?.progress;
  const elapsed = p ? Math.max(0, now - p.startedAt) : 0;
  // 4 chats are read at once (11.4.3)
  const left = p?.medianMs && p.total > p.done ? Math.ceil(((p.total - p.done) * p.medianMs) / 4 / 60_000) : undefined;

  const start = async () => {
    try {
      const out = m.status === 'scheduled' ? await meetings().arm(m.id) : m;
      if (!(await openOverlay(out.id)) && !isDesktopApp()) toast({ title: 'Armed. Open the Conclave desktop app to listen.' });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" size={size} onClick={() => void start()}>
          {m.status === 'scheduled' ? 'Start now' : 'Open overlay'}
        </Button>
        {m.scheduledAt && m.status === 'scheduled' && (
          <span className="num text-[13px] text-fg-3 phone:text-[14px]">
            Starts {countdown(m.scheduledAt, now, zone)}. At {when(m.scheduledAt, undefined, zone)} the desktop app prepares it and opens the overlay; you press Listen.
          </span>
        )}
      </div>
      <Tabs
        label="Prep and steering"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'prep', label: 'Prep' },
          { value: 'steering', label: 'Steering' },
        ]}
      />
      {tab === 'prep' && (
        <div className="flex flex-col gap-4">
          {!prep && <p className="text-[14px] text-fg-3">Loading the prep</p>}
          {prep && (prep.state === 'none' || prep.state === 'cancelled') && !text && (
            <div className="flex flex-col items-start gap-3">
              <p className="max-w-[60ch] text-[14px] leading-[1.55] text-fg-2 phone:text-[15px]">
                Prepare reads every chat on this folder and below it, its workflows, the code and the git history, and writes a brief for the meeting: what you did, the evidence and numbers, likely questions, and weak spots. You can edit it before the meeting.
              </p>
              <Button variant="outline" size={size} onClick={() => void run()}>
                Prepare
              </Button>
            </div>
          )}
          {prep?.state === 'waiting' && prep.estimate && (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[14px] leading-[1.55] text-fg phone:text-[15px]">
                This reads <span className="num">{prep.estimate.chats}</span> chats, about <span className="num">{compact(prep.estimate.tokens)}</span> tokens on {prep.estimate.model}
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
              <div className="flex items-baseline justify-between gap-3 text-[13px] phone:text-[14px]">
                <span className="text-fg">{PHASE[p?.phase ?? 'inventory']}</span>
                <span className="num text-fg-3">
                  {p && p.total > 0 ? `${p.done} of ${p.total}` : ''}
                  {left ? `, about ${left} min left` : elapsed > 5000 ? `, ${Math.round(elapsed / 1000)}s` : ''}
                </span>
              </div>
              <Meter value={p && p.total ? p.done : 0} max={p?.total || 1} label="Prep progress" tone="signal" />
              <div>
                <Button variant="quiet" size="sm" onClick={() => void meetings().cancelPrep(m.id).catch(fail)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {prep?.state === 'failed' && (
            <p className="text-[14px] text-fault">
              {prep.error ?? 'The prep failed.'}{' '}
              <button type="button" className="link" onClick={() => void run()}>
                Try again
              </button>
            </p>
          )}
          {text !== undefined && editing === undefined && (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3 phone:text-[13px]">
                <span className="num">
                  {[prep?.edited !== undefined && prep.editedAt ? `Edited ${relTime(prep.editedAt)}` : prep?.at ? `Prepared ${relTime(prep.at)}` : '', prep?.sources ? `from ${prep.sources.sessions} chats, ${prep.sources.commits} commits, ${prep.sources.files} files` : ''].filter(Boolean).join(' ')}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button variant="quiet" size="sm" onClick={() => setEditing(text)}>
                    Edit
                  </Button>
                  {prep?.edited !== undefined && prep.draft !== undefined && (
                    <Button variant="quiet" size="sm" onClick={() => setAsk('discard')}>
                      Use the draft
                    </Button>
                  )}
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => (prep?.edited !== undefined ? setAsk('rerun') : void run())}>
                    Re-run
                  </Button>
                </span>
              </div>
              <article className="rounded-[var(--r-2)] border border-rule px-5 py-4 phone:px-4">
                <Markdown text={text} />
              </article>
            </>
          )}
          {editing !== undefined && (
            <div className="flex flex-col gap-2">
              <Textarea mono aria-label="Brief" minRows={18} maxRows={40} maxLength={60_000} value={editing} onChange={(e) => setEditing(e.target.value)} />
              <div className="flex gap-2">
                <Button
                  variant="solid"
                  size={size}
                  onClick={() =>
                    void meetings()
                      .savePrep(m.id, editing)
                      .then((v) => {
                        setPrep(v);
                        setEditing(undefined);
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
        </div>
      )}
      {tab === 'steering' && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-fg-3 phone:text-[14px]">How the live answers sound: tone, what to stress, what to avoid. You can change it until the meeting ends.</p>
          <SteeringFields value={steer} onChange={setSteer} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="solid"
              size={size}
              disabled={!steerDirty}
              onClick={() =>
                void meetings()
                  .patch(m.id, { steering: steer.steering.trim() || undefined, steeringPreset: steer.steeringPreset, answerLength: steer.answerLength })
                  .then(() => toast({ title: 'Steering saved.' }), fail)
              }
            >
              Save steering
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
        open={ask === 'discard'}
        onClose={() => setAsk(undefined)}
        title="Use the draft instead of your edits?"
        body="Your edited brief is dropped."
        confirm="Use the draft"
        onConfirm={() =>
          meetings()
            .revertPrep(m.id)
            .then(() => meetings().prep(m.id).then(setPrep), fail)
        }
      />
    </div>
  );
}
