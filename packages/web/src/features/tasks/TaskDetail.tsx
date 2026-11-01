/**
 * A task's details (spec 11.4): title edited in place, status, description,
 * project, agent, priority, due date, labels, linked sessions, and a footer
 * to start a session with an agent, a model and a device, or have a model
 * review the work. Rendered in a 480px side sheet on desktop and as its own
 * page on phones. Text saves when the field loses focus; choices save at once.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { MoreHorizontal, X } from 'lucide-react';
import type { Session, Task } from '@conclave/core/types';
import { api } from '@/lib/api';
import { agentByName, attempt, removeKey, upsertSession, upsertTask, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { relTime, shortDate } from '@/lib/format';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, Segmented, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Menu, Popover } from '@/components/ui/Overlay';
import { SectionHeading } from '@/components/ui/Section';
import { MetaLine } from '@/components/ui/List';
import { AgentPicker, DevicePicker } from '@/components/pickers/Pickers';
import { ModelList, ModelPicker } from '@/components/pickers/ModelPicker';
import { ModelName } from '@/components/logo';
import { COLUMNS, PRIORITY, dueWords, sessionState } from './taskWords';

/** datetime-local value in local time */
function localValue(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function TaskDetail({ task, onClose, page }: { task: Task; onClose?: () => void; page?: boolean }) {
  const sessions = useHub((s) => s.sessions);
  const [, navigate] = useLocation();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [labels, setLabels] = useState(task.labels.join(', '));
  const [project, setProject] = useState(task.project ?? '');
  const [confirm, setConfirm] = useState(false);

  // follow changes from elsewhere (drag on the board, another client)
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setDescription(task.description), [task.description]);
  useEffect(() => setLabels(task.labels.join(', ')), [task.labels]);
  useEffect(() => setProject(task.project ?? ''), [task.project]);

  // the title grows with its text (field-sizing is not in every WebKit yet)
  const titleEl = useRef<HTMLTextAreaElement | null>(null);
  const fitTitle = (el: HTMLTextAreaElement | null) => {
    titleEl.current = el;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + 2}px`;
    }
  };
  useEffect(() => fitTitle(titleEl.current), [title]);

  const linked = useMemo(() => Object.values(sessions).filter((s) => s.taskId === task.id).sort((a, b) => b.updatedAt - a.updatedAt), [sessions, task.id]);

  const commit = async (patch: Partial<Task>) => {
    const keys = Object.keys(patch) as Array<keyof Task>;
    if (keys.every((k) => JSON.stringify(patch[k]) === JSON.stringify(task[k]))) return;
    const prev = task;
    upsertTask({ ...task, ...patch, updatedAt: Date.now() });
    const next = await attempt(() => api().updateTask(task.id, patch));
    upsertTask(next ?? prev);
  };

  const pending = (): Partial<Task> => {
    const p: Partial<Task> = {};
    if (title.trim() && title.trim() !== task.title) p.title = title.trim();
    if (description !== task.description) p.description = description;
    const ls = labels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    if (ls.join(',') !== task.labels.join(',')) p.labels = ls;
    if ((project.trim() || undefined) !== task.project) p.project = project.trim() || undefined;
    return p;
  };
  // save typed text when the sheet closes or the page unmounts
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      const p = pendingRef.current();
      if (Object.keys(p).length) void attempt(() => api().updateTask(task.id, p)).then((t) => t && upsertTask(t));
    },
    [task.id],
  );

  const remove = async () => {
    const ok = await attempt(() => api().deleteTask(task.id), `Deleted ${task.title}.`);
    if (!ok) return;
    removeKey('tasks', task.id);
    onClose ? onClose() : navigate('/tasks');
  };

  const due = dueWords(task.due, task.status === 'done');

  return (
    <div className={cn('flex min-h-full flex-col', !page && 'h-full')}>
      <div className={cn('flex-1', !page && 'overflow-x-hidden overflow-y-auto px-5 pt-4 pb-6')}>
        <div data-autofocus tabIndex={-1} className={cn('flex items-center gap-2 text-[12px] text-fg-3 outline-none phone:text-[13px]', page && 'pt-4')}>
          <span className="mr-auto">Added {shortDate(task.createdAt)}</span>
          <Menu
            label="Task actions"
            items={[
              { label: 'Copy link', onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/tasks/${task.id}`) },
              { separator: true, label: '' },
              { label: 'Delete task', danger: true, onSelect: () => setConfirm(true) },
            ]}
            trigger={({ ref, props }) => (
              <IconButton ref={ref} label="Task actions" size="sm" {...props}>
                <MoreHorizontal />
              </IconButton>
            )}
          />
          {onClose && (
            <IconButton label="Close" size="sm" onClick={onClose} tooltip={false} data-close>
              <X />
            </IconButton>
          )}
        </div>

        <label htmlFor="task-title" className="sr-only">
          Title
        </label>
        <textarea
          id="task-title"
          ref={fitTitle}
          value={title}
          rows={1}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
          onBlur={() => (title.trim() ? void commit({ title: title.trim() }) : setTitle(task.title))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
            if (e.key === 'Escape' && title !== task.title) {
              e.stopPropagation();
              setTitle(task.title);
            }
          }}
          className="t-title mt-2 -ml-1.5 block w-[calc(100%+12px)] resize-none overflow-hidden rounded-[var(--r-1)] border border-transparent bg-transparent px-1.5 py-1 text-fg outline-none hover:border-rule focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)] phone:text-[20px]"
        />

        <div className="mt-3">
          <Segmented label="Status" size="sm" value={task.status} onChange={(v) => void commit({ status: v })} options={COLUMNS.map((c) => ({ value: c.id, label: c.label }))} full={page} />
        </div>

        <div className="mt-5">
          <label htmlFor="task-desc" className="sr-only">
            Description
          </label>
          <Textarea
            id="task-desc"
            prose
            minRows={4}
            maxRows={16}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void commit({ description })}
            placeholder="Describe the outcome you want. The agent gets this as its first message."
          />
        </div>

        <dl className="mt-6">
          <Row k="Project">
            <Input
              size="sm"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              onBlur={() => void commit({ project: project.trim() || undefined })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="None"
              aria-label="Project"
            />
          </Row>
          <Row k="Agent">
            <AgentPicker look="field" value={task.agent} onChange={(v) => void commit({ agent: v })} className="h-[30px]" />
          </Row>
          <Row k="Priority">
            <Segmented label="Priority" size="sm" value={String(task.priority)} onChange={(v) => void commit({ priority: Number(v) as Task['priority'] })} options={PRIORITY.map((p) => ({ value: String(p.value), label: p.label }))} />
          </Row>
          <Row k="Due">
            <div className="flex items-center gap-3">
              <div className="w-[210px] shrink-0 phone:w-auto phone:flex-1">
                <Input
                  size="sm"
                  type="datetime-local"
                  mono
                  value={localValue(task.due)}
                  onChange={(e) => void commit({ due: e.target.value ? new Date(e.target.value).getTime() : undefined })}
                  className={task.due ? undefined : 'text-fg-3 focus:text-fg'}
                  aria-label="Due"
                />
              </div>
              {due && <span className={cn('shrink-0 text-[12px]', due.tone === 'fault' ? 'text-fault' : due.tone === 'warn' ? 'text-warn' : 'text-fg-3')}>{due.text}</span>}
            </div>
          </Row>
          <Row k="Labels">
            <Input
              size="sm"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              onBlur={() =>
                void commit({
                  labels: labels
                    .split(',')
                    .map((l) => l.trim())
                    .filter(Boolean),
                })
              }
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="homelab, uni"
              aria-label="Labels, separated by commas"
            />
          </Row>
        </dl>

        <section className="mt-8" aria-labelledby="task-sessions-h">
          <SectionHeading id="task-sessions-h" count={linked.length || undefined}>
            Sessions
          </SectionHeading>
          {linked.length === 0 ? (
            <p className="py-3 text-[13px] text-fg-3 phone:text-[14px]">None yet. Start one below and it shows up here with its state.</p>
          ) : (
            <div className="rows">
              {linked.map((s) => (
                <SessionRow key={s.id} s={s} onOpen={onClose} />
              ))}
            </div>
          )}
        </section>
      </div>

      <StartBar task={task} page={page} onStarted={onClose} />

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={remove} title={`Delete task ${task.title}?`} body={linked.length ? 'Its sessions stay.' : undefined} confirm="Delete" busy="Deleting" />
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-3 py-[5px] phone:grid-cols-1 phone:gap-y-1.5 phone:py-2">
      <dt className="text-[12px] text-fg-3 phone:text-[13px]">{k}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

function SessionRow({ s, onOpen }: { s: Session; onOpen?: () => void }) {
  const state = sessionState(s);
  return (
    <Link href={`/s/${s.id}`} onClick={onOpen} className="-mx-2 flex items-start gap-3 rounded-[var(--r-1)] px-2 py-2.5 hover:bg-hover">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{s.title}</span>
        <span className="mt-0.5 flex text-[12px] text-fg-3 phone:text-[13px]">
          <MetaLine parts={[s.agent, <ModelName key="m" model={s.model} size={13} />]} />
        </span>
      </span>
      <span className="shrink-0 pt-px text-right text-[12px] phone:text-[13px]">{state ?? <span className="num text-fg-3">{relTime(s.updatedAt)}</span>}</span>
    </Link>
  );
}

/** Start a session for the task, or have a model review the work. */
function StartBar({ task, page, onStarted }: { task: Task; page?: boolean; onStarted?: () => void }) {
  const [, navigate] = useLocation();
  const agentDef = agentByName(task.agent);
  const [agent, setAgent] = useState(task.agent ?? 'coder');
  const [model, setModel] = useState<string | undefined>(undefined);
  const [device, setDevice] = useState<string | undefined>(agentDef?.device);
  const [busy, setBusy] = useState<'start' | 'review' | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const def = agentByName(agent);

  useEffect(() => {
    if (task.agent) setAgent(task.agent);
  }, [task.agent]);

  const open = (s: Session) => {
    upsertSession(s);
    onStarted?.();
    navigate(`/s/${s.id}`);
  };

  const start = async () => {
    setBusy('start');
    const s = await attempt(() => api().startTask(task.id, { agent, model, device }));
    setBusy(null);
    if (s) open(s);
  };

  const review = async (m: string) => {
    setReviewOpen(false);
    setBusy('review');
    const s = await attempt(() =>
      api().createSession({
        agent: 'reviewer',
        model: m,
        device,
        taskId: task.id,
        title: `Review: ${task.title}`,
        prompt: `Review the work done for the task "${task.title}".${task.description ? `\n\n${task.description}` : ''}\n\nRead the diff, run the tests, and list bugs first.`,
      }),
    );
    setBusy(null);
    if (s) open(s);
  };

  return (
    <div className={cn(page ? 'mt-8 pb-8' : 'border-t border-rule bg-bg px-5 py-3')}>
      {page && <SectionHeading>Start a session</SectionHeading>}
      {/* The rule before each picker is clipped at the start of a line, so a wrapped row never starts with a stray rule. */}
      <div className={cn('-ml-1 overflow-hidden py-1 pl-1', page && 'my-1')}>
        <div className="-ml-[17px] flex flex-wrap items-center gap-y-1 text-[13px]">
          {[
            <AgentPicker key="a" value={agent} onChange={setAgent} prefix="Agent" />,
            <ModelPicker key="m" value={model ?? def?.model} onChange={setModel} prefix="Model" />,
            <DevicePicker key="d" value={device ?? def?.device ?? 'local'} onChange={setDevice} prefix="On" />,
          ].map((picker) => (
            <span key={picker.key} className="relative inline-flex min-w-0 pl-[17px] before:absolute before:top-1/2 before:left-2 before:h-3.5 before:w-px before:-translate-y-1/2 before:bg-rule">
              {picker}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button variant="solid" size={page ? 'touch' : 'md'} onClick={start} busy={busy === 'start' ? 'Starting' : false} className={page ? 'flex-1' : undefined}>
          Start session
        </Button>
        <Button ref={reviewRef} variant="outline" size={page ? 'touch' : 'md'} onClick={() => setReviewOpen((o) => !o)} busy={busy === 'review' ? 'Starting review' : false} aria-haspopup="listbox" aria-expanded={reviewOpen}>
          Review with a model
        </Button>
      </div>
      <Popover anchor={reviewRef} open={reviewOpen} onClose={() => setReviewOpen(false)} placement="top-start" width={380} maxHeight={440} label="Review with" sheetTitle="Review with">
        <ModelList onChange={(m) => void review(m)} harnesses={false} onDone={() => setReviewOpen(false)} />
      </Popover>
    </div>
  );
}
