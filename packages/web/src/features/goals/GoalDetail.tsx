/**
 * One goal: what done looks like, the next step, subgoals, the progress
 * timeline (newest first) and linked tasks, with Complete or Reopen, Edit,
 * Add progress, Link tasks and Delete. The same view fills the panel a goal
 * row grows into on wide screens and the goal's own page on phones. Nothing
 * here opens a dialog: edits and confirmations happen in place, so the
 * panel keeps focus.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { GoalArea, GoalDetail } from '@conclave/core/client';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, Textarea } from '@/components/ui/Field';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { LoadingRows } from '@/components/ui/EmptyState';
import { GapList, Swap } from '@/components/motion';
import { goalActions, loadGoal, useGoals } from './store';
import { AREA_OPTIONS, areaLabel, dayOf, dayWords, sourceWords, targetWords, todayLocal, type Tone } from './words';

const TONE: Record<Tone, string> = { dim: 'text-fg-3', warn: 'text-warn', fault: 'text-fault', ok: 'text-ok' };

export function GoalDetailView({ id, onClose, phone, onDeleted }: { id: string; onClose?: () => void; phone?: boolean; onDeleted?: () => void }) {
  const d = useGoals((s) => s.details[id]);
  const missing = useGoals((s) => s.missing[id]);
  useEffect(() => {
    void loadGoal(id);
  }, [id]);
  if (!d && missing) return <NotLoaded id={id} gone={missing.gone} text={missing.text} phone={phone} onClose={onClose} />;
  if (!d) return <LoadingRows loading rows={5} className="p-5" />;
  return <Detail d={d} onClose={onClose} phone={phone} onDeleted={onDeleted} />;
}

/** The goal is gone (deleted, maybe on another device, or a wrong link), or the hub did not answer. */
function NotLoaded({ id, gone, text, phone, onClose }: { id: string; gone: boolean; text: string; phone?: boolean; onClose?: () => void }) {
  const size = phone ? 'touch' : 'sm';
  return (
    <div className={cn(!phone && 'p-5')} role="status">
      <p className="m-0 text-[13.5px] font-medium text-fg phone:text-[15px]">{gone ? 'This goal is not here any more.' : 'Could not load this goal.'}</p>
      <p className="m-0 mt-1 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[13px]">{gone ? 'It was deleted, maybe on another device, or the link is wrong.' : text}</p>
      <div className="mt-3 flex gap-2">
        {!gone && (
          <Button variant="outline" size={size} onClick={() => void loadGoal(id)}>
            Try again
          </Button>
        )}
        {onClose ? (
          <Button variant="quiet" size={size} onClick={onClose}>
            Close
          </Button>
        ) : (
          <Link href="/goals" className="inline-flex items-center text-[13px] text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg phone:text-[14px]">
            All goals
          </Link>
        )}
      </div>
    </div>
  );
}

function Detail({ d, onClose, phone, onDeleted }: { d: GoalDetail; onClose?: () => void; phone?: boolean; onDeleted?: () => void }) {
  const g = d.goal;
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [busy, setBusy] = useState(false);
  const size = phone ? 'touch' : 'sm';
  const target = targetWords(g);
  const done = g.status === 'done';

  const toggle = async () => {
    setBusy(true);
    await goalActions.update(g.id, { status: done ? 'active' : 'done' });
    setBusy(false);
  };

  return (
    <div className={cn(!phone && 'p-5')}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {d.parent && <p className="m-0 mb-0.5 text-[12px] text-fg-3 phone:text-[13px]">Subgoal of {d.parent.title}</p>}
          <h2 className={cn('m-0 text-[17px] leading-[1.3] font-semibold text-fg', phone && 'sr-only')}>{g.title}</h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-fg-3 phone:text-[13px]">
            {areaLabel(g.area)},{' '}
            <Swap on={done} off={<span>active</span>}>
              <span className="text-ok">done{g.completedAt ? ` ${dayOf(g.completedAt)}` : ''}</span>
            </Swap>
            {target && (
              <>
                , <span className={TONE[target.tone]}>{target.text}</span>
              </>
            )}
          </p>
        </div>
        {onClose && (
          <Button variant="quiet" size="sm" onClick={onClose} data-close>
            Close
          </Button>
        )}
      </header>

      {mode === 'edit' ? (
        <EditForm d={d} phone={phone} onDone={() => setMode('view')} />
      ) : (
        <>
          {g.description && <p className="m-0 mt-3 max-w-[64ch] text-[13.5px] leading-[1.55] text-fg-2 phone:text-[15px]">{g.description}</p>}
          {g.nextStep && !done && (
            <p className="m-0 mt-3 text-[13.5px] text-fg phone:text-[15px]">
              <span className="text-fg-3">Next step </span>
              {g.nextStep}
            </p>
          )}
          {mode === 'delete' ? (
            <DeleteConfirm d={d} size={size} onCancel={() => setMode('view')} onDeleted={onDeleted} />
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="outline" size={size} onClick={toggle} busy={busy ? (done ? 'Reopening' : 'Completing') : false}>
                {done ? 'Reopen' : 'Complete'}
              </Button>
              <Button variant="quiet" size={size} onClick={() => setMode('edit')}>
                Edit
              </Button>
              <span className="flex-1" />
              <Button variant="danger" size={size} onClick={() => setMode('delete')}>
                Delete
              </Button>
            </div>
          )}
        </>
      )}

      {!g.parentId && <Subgoals d={d} phone={phone} />}
      <Progress d={d} phone={phone} />
      <Tasks d={d} phone={phone} />
    </div>
  );
}

function Block({ title, count, right, children }: { title: string; count?: number | string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-7">
      <SectionHeading as="h3" count={count} right={right}>
        {title}
      </SectionHeading>
      {children}
    </section>
  );
}

function EditForm({ d, phone, onDone }: { d: GoalDetail; phone?: boolean; onDone: () => void }) {
  const g = d.goal;
  const [title, setTitle] = useState(g.title);
  const [area, setArea] = useState<GoalArea>(g.area);
  const [targetDate, setTarget] = useState(g.targetDate ?? '');
  const [nextStep, setNext] = useState(g.nextStep ?? '');
  const [description, setDesc] = useState(g.description);
  const [saving, setSaving] = useState(false);
  const size = phone ? 'touch' : 'sm';
  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const ok = await goalActions.update(g.id, { title: title.trim(), ...(g.parentId ? {} : { area }), targetDate: targetDate || null, nextStep: nextStep.trim() || null, description: description.trim() });
    setSaving(false);
    if (ok) onDone();
  };
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Labelled label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} invalid={!title.trim()} aria-label="Title" />
      </Labelled>
      {!g.parentId && (
        <Labelled label="Life area">
          <FilterLinks label="Life area" value={area} onChange={setArea} options={AREA_OPTIONS} />
        </Labelled>
      )}
      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
        <Labelled label="Target date">
          <Input type="date" value={targetDate} onChange={(e) => setTarget(e.target.value)} aria-label="Target date" />
        </Labelled>
        <Labelled label="Next step">
          <Input value={nextStep} onChange={(e) => setNext(e.target.value)} placeholder="The first thing to do" aria-label="Next step" />
        </Labelled>
      </div>
      <Labelled label="What done looks like">
        <Textarea value={description} onChange={(e) => setDesc(e.target.value)} minRows={2} maxRows={6} aria-label="What done looks like" />
      </Labelled>
      <div className="flex gap-2">
        <Button type="submit" variant="solid" size={size} busy={saving ? 'Saving' : false} disabled={!title.trim()}>
          Save
        </Button>
        <Button type="button" variant="quiet" size={size} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">{label}</span>
      {children}
    </div>
  );
}

function DeleteConfirm({ d, size, onCancel, onDeleted }: { d: GoalDetail; size: 'sm' | 'touch'; onCancel: () => void; onDeleted?: () => void }) {
  const [busy, setBusy] = useState(false);
  const subs = d.subgoals.length;
  const n = d.entries.length;
  const parts = [subs ? `${subs} ${subs === 1 ? 'subgoal' : 'subgoals'}` : '', n ? `${n} progress ${n === 1 ? 'entry' : 'entries'}` : ''].filter(Boolean);
  return (
    <div className="mt-4 rounded-[var(--r-2)] border border-rule-2 p-3.5" role="alert">
      <p className="m-0 text-[13.5px] font-medium text-fg phone:text-[15px]">Delete {d.goal.title}?</p>
      <p className="m-0 mt-1 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[13px]">
        {parts.length ? `Its ${parts.join(' and ')} go too. ` : ''}To keep the history, complete it instead. A note in Basic Memory stays, marked deleted.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          variant="danger-outline"
          size={size}
          busy={busy ? 'Deleting' : false}
          onClick={async () => {
            setBusy(true);
            const ok = await goalActions.remove(d.goal.id);
            setBusy(false);
            if (ok) onDeleted?.();
          }}
        >
          Delete
        </Button>
        <Button variant="quiet" size={size} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Subgoals({ d, phone }: { d: GoalDetail; phone?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const doneCount = d.subgoals.filter((s) => s.status === 'done').length;
  const size = phone ? 'touch' : 'sm';
  if (!d.subgoals.length && !adding)
    return (
      <Block title="Subgoals" right={<TextAction label="Add a subgoal" onClick={() => setAdding(true)} />}>
        <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">None. Split a big goal into parts you can finish in a week or two.</p>
      </Block>
    );
  return (
    <Block title="Subgoals" count={doneCount ? `${doneCount} of ${d.subgoals.length} done` : d.subgoals.length} right={<TextAction label="Add" onClick={() => setAdding(true)} />}>
      <div className="rows">
        {d.subgoals.map((s) => {
          const t = targetWords(s);
          return (
            <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5">
              <div className="min-w-0">
                <div className={cn('truncate text-[13.5px] font-medium phone:text-[15px]', s.status === 'done' ? 'text-fg-3' : 'text-fg')}>{s.title}</div>
                {(s.nextStep || t) && s.status !== 'done' && (
                  <div className="truncate text-[12px] text-fg-3 phone:text-[13px]">
                    {s.nextStep}
                    {s.nextStep && t ? ', ' : ''}
                    {t && <span className={TONE[t.tone]}>{t.text}</span>}
                  </div>
                )}
              </div>
              <span className="flex items-center gap-3 text-[12.5px] phone:text-[13px]">
                {s.status === 'done' && <span className="text-ok">done</span>}
                <TextAction label={s.status === 'done' ? 'Reopen' : 'Complete'} onClick={() => void goalActions.update(s.id, { status: s.status === 'done' ? 'active' : 'done' })} />
              </span>
            </div>
          );
        })}
        {adding && (
          <form
            className="flex gap-2 py-2.5"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!title.trim()) return;
              setBusy(true);
              const ok = await goalActions.create({ title: title.trim(), parentId: d.goal.id });
              setBusy(false);
              if (ok) {
                setTitle('');
                setAdding(false);
              }
            }}
          >
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A part you can finish in a week or two" aria-label="Subgoal title" />
            <Button type="submit" variant="solid" size={size} busy={busy ? 'Adding' : false} disabled={!title.trim()}>
              Add
            </Button>
            <Button type="button" variant="quiet" size={size} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </form>
        )}
      </div>
    </Block>
  );
}

function Progress({ d, phone }: { d: GoalDetail; phone?: boolean }) {
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [busy, setBusy] = useState(false);
  const titles = useMemo(() => new Map([d.goal, ...d.subgoals].map((g) => [g.id, g.title])), [d]);
  const size = phone ? 'touch' : 'sm';
  const add = async () => {
    // ⌘↵ again while it saves would log the entry twice
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await goalActions.addEntry(d.goal.id, text.trim(), date !== todayLocal() ? date : undefined);
    setBusy(false);
    if (ok) {
      setText('');
      setDate(todayLocal());
    }
  };
  return (
    <Block title="Progress" count={d.entries.length}>
      <form
        className="pt-3 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} maxRows={5} placeholder="What happened? One plain sentence is enough." aria-label="Add progress" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add(); }} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value || todayLocal())} aria-label="Date" className="w-[170px]!" size="sm" />
          <Button type="submit" variant="solid" size={size} busy={busy ? 'Adding' : false} disabled={!text.trim()}>
            Add progress
          </Button>
        </div>
      </form>
      {d.entries.length === 0 ? (
        <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">No progress yet. The evening review logs what moved each day, and you can add it here.</p>
      ) : (
        <GapList items={d.entries} keyOf={(e) => e.id} exit="fade" className="rows mt-2">
          {(e) => (
            <div className="group grid grid-cols-[64px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5 phone:grid-cols-[56px_minmax(0,1fr)]">
              <span className="num text-[12px] text-fg-3 phone:text-[13px]">{dayWords(e.date)}</span>
              <div className="min-w-0">
                <p className="m-0 text-[13.5px] leading-[1.5] text-fg phone:text-[15px]">{e.text}</p>
                <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">
                  {e.goalId !== d.goal.id ? `${titles.get(e.goalId) ?? 'Subgoal'}, ` : ''}
                  {sourceWords(e)}
                </p>
              </div>
              <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 phone:hidden">
                <TextAction label="Remove" onClick={() => void goalActions.removeEntry(e.goalId, e.id)} />
              </span>
            </div>
          )}
        </GapList>
      )}
    </Block>
  );
}

function Tasks({ d, phone }: { d: GoalDetail; phone?: boolean }) {
  const taskMap = useHub((s) => s.tasks);
  const [mode, setMode] = useState<'view' | 'link' | 'add'>('view');
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const size = phone ? 'touch' : 'sm';
  const linked = d.goal.taskIds;
  const open = useMemo(() => Object.values(taskMap).filter((t) => t.status !== 'done').sort((a, b) => b.updatedAt - a.updatedAt), [taskMap]);
  const startLink = () => {
    setPicked(linked);
    setMode('link');
  };
  const saveLinks = async () => {
    setBusy(true);
    const ok = await goalActions.update(d.goal.id, { taskIds: picked });
    setBusy(false);
    if (ok) setMode('view');
  };
  return (
    <Block
      title="Linked tasks"
      count={d.tasks.length || undefined}
      right={
        mode === 'view' ? (
          <span className="flex gap-3">
            <TextAction label="Link" onClick={startLink} />
            <TextAction label="Add a task" onClick={() => setMode('add')} />
          </span>
        ) : undefined
      }
    >
      {mode === 'link' && (
        <div className="pt-2">
          {open.length === 0 ? (
            <p className="m-0 py-2 text-[13px] text-fg-3">No open tasks on the board.</p>
          ) : (
            <div className="max-h-[240px] overflow-y-auto">
              {open.slice(0, 40).map((t) => (
                <Checkbox key={t.id} checked={picked.includes(t.id)} onChange={(v) => setPicked((p) => (v ? [...p, t.id] : p.filter((x) => x !== t.id)))} label={t.title} description={[t.labels.join(', '), t.due ? `due ${new Date(t.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''].filter(Boolean).join(', ') || undefined} className="py-1.5" />
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button variant="solid" size={size} onClick={saveLinks} busy={busy ? 'Saving' : false}>
              Save links
            </Button>
            <Button variant="quiet" size={size} onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === 'add' && (
        <form
          className="flex gap-2 pt-3 pb-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            setBusy(true);
            const ok = await goalActions.addTask(d.goal, title.trim());
            setBusy(false);
            if (ok) {
              setTitle('');
              setMode('view');
            }
          }}
        >
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A task for the board" aria-label="Task title" />
          <Button type="submit" variant="solid" size={size} busy={busy ? 'Adding' : false} disabled={!title.trim()}>
            Add
          </Button>
          <Button type="button" variant="quiet" size={size} onClick={() => setMode('view')}>
            Cancel
          </Button>
        </form>
      )}
      {d.tasks.length > 0 ? (
        <div className="rows">
          {d.tasks.map((t) => {
            const late = t.status !== 'done' && t.due !== undefined && t.due < Date.now();
            return (
              <Link key={t.id} href={`/tasks/${t.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5 hover:text-fg">
                <span className={cn('truncate text-[13.5px] phone:text-[15px]', t.status === 'done' ? 'text-fg-3' : 'text-fg')}>{t.title}</span>
                <span className={cn('text-[12.5px] phone:text-[13px]', t.status === 'done' ? 'text-ok' : late ? 'text-fault' : 'text-fg-3')}>{t.status === 'done' ? 'done' : late ? 'overdue' : t.status === 'doing' ? 'in progress' : t.status === 'review' ? 'in review' : 'to do'}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        mode === 'view' && <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">No tasks linked. Link tasks from the board, or add one for the next step.</p>
      )}
    </Block>
  );
}
