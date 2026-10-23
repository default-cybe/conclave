/**
 * Tasks (spec 11.4). Desktop: a board of five columns split by rules, rows
 * not cards, drag rows between columns or focus one and press [ and ].
 * A row opens a side sheet with the details (/tasks/:id). Phones: one list
 * grouped by status with a status filter, and a task opens as its own page.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import type { Session, Task, TaskStatus } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, upsertTask, useHub } from '@/store/store';
import { cn, fuzzy } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { DetailSheet } from './DetailSheet';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { SelectMenu } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectedMark } from '@/components/ui/List';
import { TaskDetail } from './TaskDetail';
import { COLUMNS, STATUS_LABEL, areas, dueWords, inArea, liveSession, priorityWord, sessionState, tagWords } from './taskWords';

const DONE_SHOWN = 10;

export default function TasksPage() {
  const { id } = useParams<{ id?: string }>();
  const phone = useIsMobile();
  if (phone && id) return <TaskPage id={id} />;
  return <Tasks openId={id} phone={phone} />;
}

function sortTasks(list: Task[], status: TaskStatus): Task[] {
  if (status === 'done') return list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.sort((a, b) => b.priority - a.priority || (a.due ?? Infinity) - (b.due ?? Infinity) || b.updatedAt - a.updatedAt);
}

function Tasks({ openId, phone }: { openId?: string; phone: boolean }) {
  const taskMap = useHub((s) => s.tasks);
  const sessions = useHub((s) => s.sessions);
  const agents = useHub((s) => s.agents);
  const booted = useHub((s) => s.booted);
  const [, navigate] = useLocation();
  const [area, setArea] = useState('all');
  const [agent, setAgent] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | TaskStatus>('all');
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [announce, setAnnounce] = useState('');

  const all = useMemo(() => Object.values(taskMap), [taskMap]);
  const areaList = useMemo(() => areas(all), [all]);
  const byTask = useMemo(() => {
    const out: Record<string, Session[]> = {};
    for (const s of Object.values(sessions)) if (s.taskId) (out[s.taskId] ??= []).push(s);
    return out;
  }, [sessions]);
  const byStatus = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = { inbox: [], todo: [], doing: [], review: [], done: [] };
    for (const t of all) {
      if (!inArea(t, area)) continue;
      if (agent && t.agent !== agent) continue;
      if (q && fuzzy(q, `${t.title} ${t.labels.join(' ')} ${t.project ?? ''} ${t.agent ?? ''}`) < 0) continue;
      out[t.status].push(t);
    }
    for (const k of Object.keys(out) as TaskStatus[]) sortTasks(out[k], k);
    return out;
  }, [all, area, agent, q]);

  const move = async (id: string, to: TaskStatus) => {
    const t = useHub.getState().tasks[id];
    if (!t || t.status === to) return;
    upsertTask({ ...t, status: to, updatedAt: Date.now() });
    setAnnounce(`Moved ${t.title} to ${STATUS_LABEL[to]}.`);
    const next = await attempt(() => api().updateTask(id, { status: to }));
    upsertTask(next ?? t);
  };

  const doing = all.filter((t) => t.status === 'doing').length;
  const review = all.filter((t) => t.status === 'review').length;
  const dueSoon = all.filter((t) => t.status !== 'done' && t.due && t.due - Date.now() < 86_400_000).length;
  const sub = all.length ? (
    <>
      {doing} in progress
      {review > 0 && `, ${review} to review`}
      {dueSoon > 0 && <span className="text-warn">, {dueSoon} due within a day</span>}
    </>
  ) : undefined;

  const open = openId ? taskMap[openId] : undefined;
  const filtered = area !== 'all' || !!agent || !!q;
  const shownCount = COLUMNS.reduce((n, c) => n + byStatus[c.id].length, 0);

  return (
    <Page>
      <PageHeader
        title="Tasks"
        sub={sub}
        actions={
          <Button
            variant="solid"
            size={phone ? 'touch' : 'md'}
            onClick={() => {
              if (phone) setCreating(true);
              else setAdding('inbox');
            }}
          >
            New task
          </Button>
        }
      />

      {booted && all.length === 0 ? (
        <div className="max-w-[720px]">
          <EmptyState action={{ label: 'New task', onClick: () => (phone ? setCreating(true) : setAdding('inbox')) }}>No tasks. Add one, or start a session from a task to track its steps.</EmptyState>
          {adding && !phone && (
            <div className="mt-6">
              <QuickAdd status={adding} onDone={() => setAdding(null)} />
            </div>
          )}
        </div>
      ) : (
        <>
          {phone ? (
            <FilterLinks
              label="Status"
              value={status}
              onChange={setStatus}
              className="-mx-4 mb-5 flex-nowrap! overflow-x-auto px-4 whitespace-nowrap [scrollbar-width:none]"
              options={[{ value: 'all' as const, label: 'All' }, ...COLUMNS.map((c) => ({ value: c.id, label: c.label, count: byStatus[c.id].length }))]}
            />
          ) : (
            <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <FilterLinks label="Project or label" value={area} onChange={setArea} options={[{ value: 'all', label: 'All' }, ...areaList.slice(0, 9).map((a) => ({ value: a.value, label: a.value }))]} />
              <div className="ml-auto flex items-center gap-3">
                <SelectMenu
                  look="text"
                  prefix="Agent"
                  label="Agent"
                  value={agent}
                  onChange={setAgent}
                  width={220}
                  className="shrink-0"
                  options={[{ value: '', label: 'Anyone', text: 'Anyone' }, ...agents.filter((a) => all.some((t) => t.agent === a.name)).map((a) => ({ value: a.name, label: a.name, text: a.name }))]}
                />
                <div className="w-44">
                  <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter tasks" />
                </div>
              </div>
            </div>
          )}

          {filtered && shownCount === 0 && (
            <p role="status" className="py-2.5 text-[13px] text-fg-2">
              No task matches these filters.{' '}
              <TextAction
                label="Clear filters"
                className="link"
                onClick={() => {
                  setArea('all');
                  setAgent('');
                  setQ('');
                }}
              />
            </p>
          )}
          {filtered && shownCount === 0 ? null : phone ? (
            <PhoneList byStatus={byStatus} byTask={byTask} status={status} />
          ) : (
            <Board byStatus={byStatus} byTask={byTask} move={move} adding={adding} setAdding={setAdding} openId={openId} filtered={filtered} />
          )}
        </>
      )}

      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      <DetailSheet open={!!open && !phone} onClose={() => navigate('/tasks')} width={480} label={open?.title ?? 'Task'}>
        {open && <TaskDetail key={open.id} task={open} onClose={() => navigate('/tasks')} />}
      </DetailSheet>

      <NewTaskDialog open={creating} onClose={() => setCreating(false)} status={status === 'all' ? 'inbox' : status} />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function Board({
  byStatus,
  byTask,
  move,
  adding,
  setAdding,
  openId,
  filtered,
}: {
  byStatus: Record<TaskStatus, Task[]>;
  byTask: Record<string, Session[]>;
  move: (id: string, to: TaskStatus) => Promise<void>;
  adding: TaskStatus | null;
  setAdding: (s: TaskStatus | null) => void;
  openId?: string;
  filtered?: boolean;
}) {
  const [, navigate] = useLocation();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // keep focus on a row after it moves to another column
  useEffect(() => {
    if (!focusId) return;
    root.current?.querySelector<HTMLElement>(`[data-task="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId, byStatus]);

  const onKey = (e: KeyboardEvent<HTMLElement>, t: Task) => {
    const col = COLUMNS.findIndex((c) => c.id === t.status);
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const to = COLUMNS[col + (e.key === ']' ? 1 : -1)];
      if (to) {
        void move(t.id, to.id);
        setFocusId(t.id);
      }
      return;
    }
    const rows = (status: TaskStatus) => [...(root.current?.querySelectorAll<HTMLElement>(`[data-col="${status}"] [data-task]`) ?? [])];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = rows(t.status);
      const i = list.indexOf(e.currentTarget);
      list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      for (let c = col + (e.key === 'ArrowRight' ? 1 : -1); c >= 0 && c < COLUMNS.length; c += e.key === 'ArrowRight' ? 1 : -1) {
        const first = rows(COLUMNS[c].id)[0];
        if (first) {
          first.focus();
          break;
        }
      }
    }
  };

  const drop = (e: DragEvent, status: TaskStatus) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/x-task') || drag;
    setOver(null);
    setDrag(null);
    if (id) void move(id, status);
  };

  return (
    <div ref={root} className="-mx-[var(--gutter)] overflow-x-auto px-[var(--gutter)]">
      <div className="grid min-h-[calc(100dvh-320px)] min-w-[940px] grid-cols-5 gap-x-10 xl:gap-x-14">
        {COLUMNS.map((col, ci) => {
          const list = byStatus[col.id];
          const shown = col.id === 'done' && !allDone ? list.slice(0, DONE_SHOWN) : list;
          return (
            <section
              key={col.id}
              data-col={col.id}
              aria-labelledby={`col-${col.id}`}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== col.id) setOver(col.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === col.id ? null : o));
              }}
              onDrop={(e) => drop(e, col.id)}
              className={cn('relative flex min-w-0 flex-col', ci > 0 && 'before:absolute before:inset-y-0 before:-left-5 before:w-px before:bg-rule xl:before:-left-7')}
            >
              <SectionHeading id={`col-${col.id}`} count={list.length} right={<TextAction label="Add" onClick={() => setAdding(col.id)} />}>
                {col.label}
              </SectionHeading>
              <div className={cn('-mx-2 flex-1 rounded-[var(--r-1)] px-2 pb-6 transition-colors duration-[var(--dur-1)]', over === col.id && drag && 'bg-hover')}>
                {adding === col.id && (
                  <div className="pt-2.5 pb-1">
                    <QuickAdd status={col.id} onDone={() => setAdding(null)} />
                  </div>
                )}
                <ol className="rows" aria-label={col.label}>
                  {shown.map((t) => (
                    <li key={t.id} className="anim-fade">
                      <TaskRow
                        t={t}
                        linked={byTask[t.id]}
                        dragging={drag === t.id}
                        selected={openId === t.id}
                        onOpen={() => navigate(`/tasks/${t.id}`)}
                        onKeyDown={(e) => onKey(e, t)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/x-task', t.id);
                          e.dataTransfer.effectAllowed = 'move';
                          setDrag(t.id);
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setOver(null);
                        }}
                      />
                    </li>
                  ))}
                </ol>
                {list.length === 0 && adding !== col.id && <p className="py-2.5 text-[12px] text-fg-3">{filtered ? 'No match.' : col.empty}</p>}
                {col.id === 'done' && list.length > DONE_SHOWN && (
                  <div className="mt-2">
                    <TextAction label={allDone ? 'Show fewer' : `Show all ${list.length}`} onClick={() => setAllDone((v) => !v)} />
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p id="tasks-keys" className="mt-4 mb-2 text-[12px] text-fg-3">
        Drag a task to another column, or focus it and press <kbd className="font-mono text-[11px]">[</kbd> or <kbd className="font-mono text-[11px]">]</kbd>.
      </p>
    </div>
  );
}

function TaskRow({
  t,
  linked,
  dragging,
  selected,
  onOpen,
  onKeyDown,
  onDragStart,
  onDragEnd,
}: {
  t: Task;
  linked?: Session[];
  dragging: boolean;
  selected: boolean;
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const live = liveSession(linked);
  const state = live ? sessionState(live) : null;
  const done = t.status === 'done';
  const due = dueWords(t.due, done);
  const prio = done ? undefined : priorityWord(t.priority);
  const parts: React.ReactNode[] = [];
  if (prio) parts.push(<span className="text-fg-2">{prio}</span>);
  const tags = tagWords(t);
  for (const w of tags) parts.push(w);
  if (t.agent && !tags.includes(t.agent)) parts.push(t.agent);
  if (due) parts.push(<span className={due.tone === 'fault' ? 'text-fault' : due.tone === 'warn' ? 'text-warn' : undefined}>{due.text}</span>);
  if (state) parts.push(state);
  return (
    <button
      type="button"
      data-task={t.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        onKeyDown(e);
      }}
      aria-current={selected || undefined}
      aria-label={`${t.title}${prio ? `, ${prio}` : ''}${due ? `, ${due.text}` : ''}`}
      aria-describedby="tasks-keys"
      className={cn(
        'relative -mx-2 block w-[calc(100%+16px)] cursor-default rounded-[var(--r-1)] px-2 py-2.5 text-left focus-visible:outline-offset-0 transition-colors duration-[var(--dur-1)] hover:bg-hover',
        selected && 'bg-raise hover:bg-raise',
        dragging && 'text-fg-3',
      )}
    >
      {selected && <SelectedMark />}
      <span className={cn('line-clamp-2 text-[13.5px] leading-[1.35] font-medium', dragging ? 'text-fg-3' : done ? 'text-fg-2' : 'text-fg')}>{t.title}</span>
      {parts.length > 0 && (
        <span className="mt-1 block text-[12px] leading-[1.4] text-fg-3">
          {parts.map((p, i) => (
            <Fragment key={i}>
              <span className="whitespace-nowrap">
                {p}
                {i < parts.length - 1 && ','}
              </span>
              {i < parts.length - 1 && ' '}
            </Fragment>
          ))}
        </span>
      )}
    </button>
  );
}

function QuickAdd({ status, onDone }: { status: TaskStatus; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return onDone();
        setBusy(true);
        const t = await attempt(() => api().createTask({ title: title.trim(), status }));
        setBusy(false);
        if (t) {
          upsertTask(t);
          setTitle('');
        }
      }}
    >
      <Input
        autoFocus
        size="sm"
        value={title}
        readOnly={busy}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => !title.trim() && onDone()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
        placeholder={`Add to ${STATUS_LABEL[status]}, then Enter`}
        aria-label={`New task in ${STATUS_LABEL[status]}`}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

function PhoneList({ byStatus, byTask, status }: { byStatus: Record<TaskStatus, Task[]>; byTask: Record<string, Session[]>; status: 'all' | TaskStatus }) {
  const cols = COLUMNS.filter((c) => status === 'all' || c.id === status);
  return (
    <div className="space-y-8">
      {cols.map((c) => {
        const list = c.id === 'done' && status === 'all' ? byStatus.done.slice(0, 5) : byStatus[c.id];
        if (status === 'all' && list.length === 0) return null;
        return (
          <section key={c.id} aria-labelledby={`ph-${c.id}`}>
            <SectionHeading id={`ph-${c.id}`} count={byStatus[c.id].length}>
              {c.label}
            </SectionHeading>
            {list.length === 0 ? (
              <p className="py-3 text-[14px] text-fg-3">{c.empty}</p>
            ) : (
              <ol className="rows">
                {list.map((t) => {
                  const live = liveSession(byTask[t.id]);
                  const due = dueWords(t.due, t.status === 'done');
                  const prio = t.status === 'done' ? undefined : priorityWord(t.priority);
                  return (
                    <li key={t.id}>
                      <Link href={`/tasks/${t.id}`} className="flex items-start gap-3 py-3 active:bg-hover">
                        <span className="min-w-0 flex-1">
                          <span className={cn('line-clamp-2 text-[15px] leading-[1.35] font-medium', t.status === 'done' ? 'text-fg-2' : 'text-fg')}>{t.title}</span>
                          <span className="mt-0.5 block text-[13px] text-fg-3">
                            {[prio, ...tagWords(t), t.agent && !tagWords(t).includes(t.agent) ? t.agent : undefined].filter(Boolean).join(', ')}
                            {due && (
                              <span className={due.tone === 'fault' ? 'text-fault' : due.tone === 'warn' ? 'text-warn' : undefined}>
                                {prio || tagWords(t).length || t.agent ? ', ' : ''}
                                {due.text}
                              </span>
                            )}
                          </span>
                        </span>
                        {live && <span className="shrink-0 pt-0.5 text-[13px]">{sessionState(live)}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskPage({ id }: { id: string }) {
  const task = useHub((s) => s.tasks[id]);
  const booted = useHub((s) => s.booted);
  const [, navigate] = useLocation();
  usePageHeader(task?.title ?? 'Task', '/tasks');
  if (!task)
    return (
      <Page>
        {booted && (
          <EmptyState wave={false} className="pt-6" action={{ label: 'All tasks', onClick: () => navigate('/tasks') }}>
            This task was deleted, or the link is wrong.
          </EmptyState>
        )}
      </Page>
    );
  return (
    <Page innerClassName="pb-0 phone:pb-0">
      <TaskDetail task={task} page />
    </Page>
  );
}

function NewTaskDialog({ open, onClose, status }: { open: boolean; onClose: () => void; status: TaskStatus }) {
  const [, navigate] = useLocation();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTitle('');
  }, [open]);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const t = await attempt(() => api().createTask({ title: title.trim(), status }));
    setBusy(false);
    if (!t) return;
    upsertTask(t);
    onClose();
    navigate(`/tasks/${t.id}`);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task"
      footer={
        <>
          <Button variant="quiet" size="touch" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size="touch" onClick={create} busy={busy ? 'Adding' : false} disabled={!title.trim()}>
            Add to {STATUS_LABEL[status]}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" aria-label="Title" />
      </form>
    </Dialog>
  );
}
