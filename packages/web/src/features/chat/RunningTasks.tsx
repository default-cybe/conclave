/**
 * The session's running tasks, as the Claude app shows them (CHAT-AND-MOTION
 * 6.3): while a workflow or a subagent works in the session, one small line
 * just above the composer, "2 running tasks" ("1 running task"), on desktop
 * and on a phone. It goes away when nothing runs. A click opens the list (a
 * popover above it; a sheet on a phone):
 *
 * - A workflow: its name and running time, where it is ("Phase 2 of 5,
 *   Search. 3 of 6 agents running") and Open run. Opened, its phases with
 *   the busy phase's agents: label, what each does now ("Searching for
 *   jwt"), its state and time (WorkflowCard.tsx WorkflowDetail, the detail
 *   the row in the transcript opens to).
 * - A subagent: "Subagent explore: Find the auth code" and its running time,
 *   what it is doing now from its own transcript, and Open session.
 *
 * A task with an approval or a question open (its own, or a subagent's or
 * an agent's under it) says so: the line reads "1 running task, waiting on
 * you" in amber, and the task's line in the list "Waiting on you". The card
 * itself is in the transcript (lib/asks.ts).
 *
 * The list is worked out on the client (liveTasks.ts) and kept live by
 * the hub's workflow.* events and the subagent's transcript; nothing polls.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ChevronRight, ChevronUp, Pause } from 'lucide-react';
import { Elapsed, Knot } from '@/components/motion';
import { Popover } from '@/components/ui/Overlay';
import { useHub } from '@/store/store';
import { StateWord } from '@/components/ui/List';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { RUN_TONE, RUN_WORD, taskLine } from '@/features/workflows/words';
import { useRunDetail } from '@/features/workflows/data';
import { WorkflowDetail } from '@/features/workflows/WorkflowCard';
import { useSubagentNow } from './ToolRows';
import { subagentLead, tasksWord, useRunningTasks, type RunningSubagent, type RunningTask, type RunningWorkflow } from './liveTasks';

/** The line above the composer, and the list it opens. Nothing while no task runs. */
export function RunningTasks({ sessionId, className }: { sessionId: string; className?: string }) {
  const tasks = useRunningTasks(sessionId);
  return <RunningTasksView tasks={tasks} className={className} />;
}

export function RunningTasksView({ tasks, className }: { tasks: RunningTask[]; className?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const n = tasks.length;
  // the last one ended: the list closes with the line
  useEffect(() => {
    if (!n) setOpen(false);
  }, [n]);
  if (!n) return null;
  const words = tasksWord(n);
  const waiting = tasks.some((t) => t.waiting);
  return (
    <div className={cn('mx-auto flex w-full max-w-[924px] px-8 pb-1.5 anim-fade phone:px-4 phone:pb-1', className)}>
      <button
        ref={anchor}
        type="button"
        data-running-tasks=""
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-2 rounded-full border border-rule-2 bg-raise pr-2.5 pl-2.5 text-[12.5px] text-fg-2 transition-colors duration-[var(--dur-1)] hov:text-fg phone:h-9 phone:gap-2.5 phone:px-3.5 phone:text-[14px]"
      >
        {/* a button never animates a Knot (spec 1.9) */}
        <Knot state={waiting ? 'waiting' : 'tool'} size={12} still />
        <span className="num">
          {words}
          {waiting && <span className="text-warn">, waiting on you</span>}
        </span>
        <ChevronUp aria-hidden strokeWidth={1.75} className={cn('size-3 text-fg-4 transition-transform duration-[var(--dur-1)] phone:size-3.5', open && 'rotate-180')} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={460} maxHeight={560} sheetTitle={words} label={words}>
        <TaskList tasks={tasks} />
      </Popover>
    </div>
  );
}

/** Each running task, the one started first first. */
export function TaskList({ tasks }: { tasks: RunningTask[] }) {
  const phone = useIsMobile();
  return (
    <div className="flex flex-col">
      {!phone && <p className="m-0 border-b border-rule px-3 pt-2.5 pb-2 text-[12px] text-fg-3">{tasksWord(tasks.length)}</p>}
      <ul className="m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-rule" aria-label="Running tasks">
        {tasks.map((t) => (t.kind === 'workflow' ? <WorkflowTask key={t.key} task={t} /> : <SubagentTask key={t.key} task={t} />))}
      </ul>
    </div>
  );
}

const ITEM = 'px-3 py-2.5 phone:px-4 phone:py-3';
const HEAD = 'grid w-full grid-cols-[minmax(0,1fr)_auto_12px] items-baseline gap-x-3 text-left phone:grid-cols-[minmax(0,1fr)_auto_16px]';
const TITLE = 'min-w-0 truncate text-[13.5px] text-fg phone:text-[15px]';
const LINE = 'mt-0.5 flex items-baseline gap-3 text-[12.5px] phone:text-[14px]';

/** A workflow: name, time, where it is, Open run; opened, its phases and agents. */
function WorkflowTask({ task }: { task: RunningWorkflow }) {
  const { run } = task;
  const [open, setOpen] = useState(false);
  // the agents load when it opens, then follow the run's events
  const detail = useRunDetail(open ? run.id : undefined);
  return (
    <li data-task="workflow" className={ITEM}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(HEAD, 'group/task')}>
        <span className={TITLE}>
          <span className="text-fg-2">Workflow</span> <span className="font-medium">{run.name}</span>
        </span>
        <span className="text-[12px] phone:text-[13px]">{run.status === 'running' ? <Elapsed since={run.startedAt ?? run.createdAt} format="short" className="text-signal" /> : run.status === 'paused' ? <PausedWord /> : <StateWord tone={RUN_TONE[run.status]}>{RUN_WORD[run.status]}</StateWord>}</span>
        <ChevronRight aria-hidden strokeWidth={1.75} className={cn('size-3 self-center text-fg-4 transition-transform duration-[var(--dur-1)] group-hover/task:text-fg-2 phone:size-4', open && 'rotate-90')} />
      </button>
      <div className={LINE}>
        <span className="min-w-0 flex-1 truncate text-fg-3">
          {task.waiting && <span className="text-warn">Waiting on you. </span>}
          {taskLine(run)}
        </span>
        <Link href={`/workflows/runs/${run.id}`} className="link shrink-0">
          Open run
        </Link>
      </div>
      {open && (
        <div className="mt-1.5 ml-1 border-l border-rule pl-3 anim-fade">
          <WorkflowDetail name={run.name} run={detail.data?.run ?? run} calls={detail.data?.calls} progress={detail.progress} summary={false} footer={false} />
        </div>
      )}
    </li>
  );
}

/** "paused" with a pause icon, in fg-3: work the owner paused, waiting for Resume. */
export function PausedWord({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] text-fg-3', className)}>
      <Pause aria-hidden strokeWidth={1.75} className="size-3" />
      paused
    </span>
  );
}

/** A subagent: what it does, who does it, its time, what it is doing now, Open session. */
function SubagentTask({ task }: { task: RunningSubagent }) {
  const now = useSubagentNow(true, task.childId);
  const paused = useHub((s) => (task.childId ? s.sessions[task.childId]?.status === 'paused' : false));
  const lead = subagentLead(task);
  return (
    <li data-task="subagent" className={ITEM}>
      <div className={HEAD}>
        <span className={TITLE}>
          <span className="text-fg-2">{lead.verb}</span> {lead.who && <span className="font-medium">{lead.who}: </span>}
          {task.description}
        </span>
        {paused ? <PausedWord className="phone:text-[13px]" /> : <Elapsed since={task.startedAt} format="short" className="text-[12px] text-signal phone:text-[13px]" />}
        <span aria-hidden />
      </div>
      <div className={LINE}>
        <span data-subagent-now="" className={cn('min-w-0 flex-1 truncate', now?.waiting ? 'text-warn' : 'text-fg-3')}>
          {now?.text ?? 'Starting'}
        </span>
        {task.childId && (
          <Link href={`/s/${task.childId}`} className="link shrink-0">
            Open session
          </Link>
        )}
      </div>
    </li>
  );
}
