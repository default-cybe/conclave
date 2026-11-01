/**
 * Goals (docs/design/ROUND-LIFE-ASSISTANT.md 6): what the owner is working
 * toward, grouped by life area, with subgoals and a progress history. The
 * assistant creates goals in chat after a short intake, the evening review
 * logs progress, and every agent recalls them from memory. Wide screens: a
 * goal row grows into its panel (Card to panel), with the latest progress
 * across goals in a column at the right. Phones: a goal opens as its own
 * page at /goals/:id.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams, useSearch } from 'wouter';
import type { GoalArea, GoalSummary } from '@conclave/core/client';
import { useHub } from '@/store/store';
import { sendToAssistant } from '@/features/conversation/actions';
import { cn } from '@/lib/text';
import { useIsMobile, useMedia } from '@/lib/hooks';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { Section, TextAction } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { CardToPanel, GapList, LiveStatus, Roll } from '@/components/motion';
import { GoalDetailView } from './GoalDetail';
import { goalActions, loadGoals, useGoals } from './store';
import { AREA_OPTIONS, GOAL_AREAS, areaLabel, dayOf, dayWords, daysUntil, targetWords, type Tone } from './words';

const TONE: Record<Tone, string> = { dim: 'text-fg-3', warn: 'text-warn', fault: 'text-fault', ok: 'text-ok' };

/** Rows stay flush with the section rule; the hover fill reaches 8px past the text (as on Home). */
const HOVER_ROW =
  'relative isolate rounded-[var(--r-1)] before:pointer-events-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-[var(--r-1)] before:bg-hover before:opacity-0 before:transition-opacity before:duration-[var(--dur-1)] hover:before:opacity-100';

/** The day-loop routines whose runs touch goals, and what they are doing meanwhile. */
const LIVE_WORDS: Record<string, string> = { 'evening-wrap-up': 'The evening review is logging progress', 'weekly-review': 'The weekly review is checking each goal', 'morning-brief': 'Planning your day' };

export default function GoalsPage() {
  const { id } = useParams<{ id?: string }>();
  const phone = useIsMobile();
  if (phone && id) return <GoalPage id={id} />;
  return <Goals openId={id} phone={phone} />;
}

function GoalPage({ id }: { id: string }) {
  const list = useGoals((s) => s.list);
  const [, navigate] = useLocation();
  const title = list?.find((g) => g.id === id)?.title ?? useGoals.getState().details[id]?.goal.title ?? 'Goal';
  usePageHeader(title, '/goals');
  useEffect(() => {
    if (!list) void loadGoals();
  }, [list]);
  return (
    <Page width="column">
      <div className="pt-4">
        <GoalDetailView id={id} phone onDeleted={() => navigate('/goals', { replace: true })} />
      </div>
    </Page>
  );
}

/** Talk a goal through in the assistant thread, the way Muse's Add goal opens its chat. */
async function talkItThrough(navigate: (to: string) => void, text = 'I want to set a new goal.') {
  const s = await sendToAssistant({ text });
  if (s) navigate(`/s/${s.id}`);
}

function Goals({ openId, phone }: { openId?: string; phone: boolean }) {
  const { list, loading, error } = useGoals();
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<'active' | 'done'>('active');
  const [creating, setCreating] = useState(false);
  const wide = useMedia('(min-width: 1180px)');
  const routines = useHub((s) => s.routines);
  const runs = useHub((s) => s.runs);

  useEffect(() => {
    void loadGoals();
  }, []);
  // the palette's New goal opens /goals?new=1
  const search = useSearch();
  useEffect(() => {
    if (!new URLSearchParams(search).has('new')) return;
    setCreating(true);
    navigate('/goals', { replace: true });
  }, [search, navigate]);

  const active = useMemo(() => (list ?? []).filter((g) => g.status === 'active'), [list]);
  const done = useMemo(() => (list ?? []).filter((g) => g.status === 'done'), [list]);
  const shown = status === 'active' ? active : done;
  const byArea = useMemo(() => GOAL_AREAS.map((a) => ({ area: a, goals: shown.filter((g) => g.area === a) })).filter((x) => x.goals.length), [shown]);

  // live work on goals: a day-loop routine that is running now
  const live = useMemo(() => {
    for (const r of Object.values(routines)) {
      const words = r.template ? LIVE_WORDS[r.template] : undefined;
      const run = runs[r.id]?.[0];
      if (words && run?.status === 'running') return { words, startedAt: run.startedAt, sessionId: run.sessionId };
    }
    return undefined;
  }, [routines, runs]);

  const latest = useMemo(
    () =>
      (list ?? [])
        .filter((g) => g.lastEntry)
        .map((g) => ({ goal: g, entry: g.lastEntry! }))
        .sort((a, b) => b.entry.createdAt - a.entry.createdAt)
        .slice(0, 8),
    [list],
  );

  const sub = list ? (
    <>
      <Roll value={active.length} /> active{done.length ? <>, <Roll value={done.length} /> done</> : null}
    </>
  ) : undefined;

  const body = !list ? (
    loading ? <LoadingRows loading rows={5} /> : error ? <p className="text-[13px] text-fault">Could not load the goals. {error}</p> : null
  ) : list.length === 0 ? (
    <div className="max-w-[720px]">
      <EmptyState action={{ label: 'New goal', onClick: () => setCreating(true) }}>
        No goals yet. Tell the assistant what you want to reach, like "finish my thesis draft by December", or add one here. Every agent sees your goals in memory.
      </EmptyState>
    </div>
  ) : (
    <div className={cn(wide && 'grid grid-cols-[minmax(0,1fr)_320px] gap-x-12')}>
      <div className="min-w-0">
        <FilterLinks
          label="Status"
          value={status}
          onChange={setStatus}
          className="mb-6"
          options={[
            { value: 'active', label: 'Active', count: active.length },
            { value: 'done', label: 'Done', count: done.length },
          ]}
        />
        {byArea.length === 0 && <p className="text-[13px] text-fg-3 phone:text-[14px]">{status === 'done' ? 'Nothing finished yet. Completed goals keep their history here.' : 'No active goals. Reopen one from Done, or add a new one.'}</p>}
        <div className="space-y-8">
          {byArea.map(({ area, goals }) => (
            <AreaSection key={area} area={area} goals={goals} openId={openId} phone={phone} onOpen={(id) => navigate(id ? `/goals/${id}` : '/goals', { replace: !!openId || !id })} />
          ))}
        </div>
      </div>
      {wide && (
        <aside className="min-w-0 space-y-8 border-l border-rule pl-8">
          <Section title="Latest progress" count={latest.length || undefined}>
            {latest.length === 0 ? (
              <p className="py-3 text-[13px] text-fg-3">Progress the evening review or you log shows up here.</p>
            ) : (
              latest.map(({ goal, entry }) => (
                <button key={entry.id} type="button" onClick={() => navigate(`/goals/${goal.id}`)} className="block w-full py-2.5 text-left">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-medium text-fg">{goal.title}</span>
                    <span className="num shrink-0 text-[12px] text-fg-3">{dayWords(entry.date)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.45] text-fg-2">{entry.text}</span>
                </button>
              ))
            )}
          </Section>
          <p className="max-w-[40ch] text-[12px] leading-[1.5] text-fg-3">The assistant creates goals in chat after a few questions, the evening review logs what moved, and the weekly review checks each goal. Every agent recalls them from memory.</p>
        </aside>
      )}
    </div>
  );

  return (
    <Page>
      <PageHeader
        title="Goals"
        sub={sub}
        actions={
          <>
            {!phone && (
              <Button variant="quiet" onClick={() => void talkItThrough(navigate)}>
                Talk it through
              </Button>
            )}
            <Button variant="solid" size={phone ? 'touch' : 'md'} onClick={() => setCreating(true)}>
              New goal
            </Button>
          </>
        }
      >
        {live && (
          <LiveStatus
            state="tool"
            label={live.words}
            startedAt={live.startedAt}
            size={14}
            action={live.sessionId ? <TextAction label="Open" href={`/s/${live.sessionId}`} /> : undefined}
          />
        )}
      </PageHeader>
      {body}
      <NewGoal open={creating} onClose={() => setCreating(false)} phone={phone} onTalk={() => (setCreating(false), void talkItThrough(navigate))} onCreated={(id) => navigate(`/goals/${id}`)} />
    </Page>
  );
}

function AreaSection({ area, goals, openId, phone, onOpen }: { area: GoalArea; goals: GoalSummary[]; openId?: string; phone: boolean; onOpen: (id?: string) => void }) {
  return (
    <Section title={areaLabel(area)} count={goals.length} rows={false}>
      {/* a goal completed in its panel leaves the Active list; the rows below ride up */}
      <GapList items={goals} keyOf={(g) => g.id} exit="fade" className="rows">
        {(g) => (phone ? <PhoneRow g={g} onOpen={() => onOpen(g.id)} /> : <PanelRow g={g} open={openId === g.id} onOpen={onOpen} />)}
      </GapList>
    </Section>
  );
}

function RowFace({ g, phone }: { g: GoalSummary; phone?: boolean }) {
  const t = targetWords(g);
  const subDone = g.subgoals.filter((s) => s.status === 'done').length;
  const meta = [
    g.status === 'active' && g.nextStep ? `Next: ${g.nextStep}` : g.status === 'done' && g.completedAt ? `Done ${dayOf(g.completedAt)}` : '',
    g.subgoals.length ? `${subDone} of ${g.subgoals.length} subgoals done` : '',
    g.openTasks ? `${g.openTasks} open ${g.openTasks === 1 ? 'task' : 'tasks'}` : '',
  ].filter(Boolean);
  const state = <span className={cn('state-word whitespace-nowrap', t ? TONE[t.tone] : g.status === 'done' ? 'text-ok' : 'text-fg-3')}>{t ? t.text : g.status === 'done' ? 'done' : 'active'}</span>;
  const last = g.lastEntry && (
    <span className="mt-1 block truncate text-[12.5px] text-fg-2 phone:text-[13px]">
      <span className="text-fg-3">{entryWhen(g.lastEntry.date)}: </span>
      {g.lastEntry.text}
    </span>
  );
  if (phone)
    // phones: the title may wrap, and the date sits in the meta line instead of a right column
    return (
      <span className="block w-full py-3 text-left">
        <span className="line-clamp-2 block text-[15px] leading-[1.35] font-medium text-fg">{g.title}</span>
        <span className="mt-0.5 block truncate text-[13px] text-fg-3">
          {state}
          {meta.length ? `, ${meta[0].charAt(0).toLowerCase()}${meta[0].slice(1)}` : ''}
        </span>
        {last}
      </span>
    );
  return (
    <span className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 py-3 text-left">
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-fg">{g.title}</span>
        {meta.length > 0 && <span className="mt-0.5 block truncate text-[12.5px] text-fg-3">{meta.join(', ')}</span>}
        {last}
      </span>
      <span className="pt-px text-right text-[12.5px]">{state}</span>
    </span>
  );
}

/** "Today", "Yesterday", "14 Oct". */
function entryWhen(date: string): string {
  const d = daysUntil(date);
  return d === 0 ? 'Today' : d === -1 ? 'Yesterday' : dayWords(date);
}

function PanelRow({ g, open, onOpen }: { g: GoalSummary; open: boolean; onOpen: (id?: string) => void }) {
  return (
    <CardToPanel
      open={open}
      onOpenChange={(v) => onOpen(v ? g.id : undefined)}
      label={g.title}
      cardClassName={HOVER_ROW}
      card={<RowFace g={g} />}
    >
      <GoalDetailView id={g.id} onClose={() => onOpen(undefined)} onDeleted={() => onOpen(undefined)} />
    </CardToPanel>
  );
}

function PhoneRow({ g, onOpen }: { g: GoalSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={cn('block w-full text-left', HOVER_ROW)}>
      <RowFace g={g} phone />
    </button>
  );
}

function NewGoal({ open, onClose, phone, onTalk, onCreated }: { open: boolean; onClose: () => void; phone: boolean; onTalk: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [area, setArea] = useState<GoalArea>('study');
  const [targetDate, setTarget] = useState('');
  const [nextStep, setNext] = useState('');
  const [description, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle('');
      setTarget('');
      setNext('');
      setDesc('');
      setTried(false);
    }
  }, [open]);
  const size = phone ? 'touch' : 'md';
  const save = async () => {
    setTried(true);
    if (!title.trim()) return;
    setBusy(true);
    const g = await goalActions.create({ title: title.trim(), area, ...(targetDate ? { targetDate } : {}), ...(nextStep.trim() ? { nextStep: nextStep.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) });
    setBusy(false);
    if (g) {
      onClose();
      onCreated(g.id);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New goal"
      description="In your own words. The assistant uses it in every chat and the evening review logs progress on it."
      width={560}
      footer={
        <>
          <Button variant="quiet" size={size} onClick={onTalk} className="mr-auto">
            Talk it through instead
          </Button>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={size} onClick={() => void save()} busy={busy ? 'Saving' : false}>
            Save goal
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">What do you want to reach?</span>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Finish my thesis draft" invalid={tried && !title.trim()} />
          {tried && !title.trim() && <span className="text-[12px] text-fault">A goal needs a title.</span>}
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Life area</span>
          <FilterLinks label="Life area" value={area} onChange={setArea} options={AREA_OPTIONS} />
        </div>
        <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">
              Target date <span className="font-normal text-fg-3">optional</span>
            </span>
            <Input type="date" value={targetDate} onChange={(e) => setTarget(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">
              First step <span className="font-normal text-fg-3">optional</span>
            </span>
            <Input value={nextStep} onChange={(e) => setNext(e.target.value)} placeholder="Outline chapter 3" />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">
            What done looks like <span className="font-normal text-fg-3">optional</span>
          </span>
          <Textarea value={description} onChange={(e) => setDesc(e.target.value)} minRows={2} maxRows={5} placeholder="A full draft goes to my supervisor before the winter break." />
        </label>
      </form>
    </Dialog>
  );
}
