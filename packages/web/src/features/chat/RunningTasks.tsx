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
import { AgentGlyph, Elapsed, LIVE_ROWS, Pet, busiestKind, petState } from '@/components/motion';
import { Popover } from '@/components/ui/Overlay';
import { useHub } from '@/store/store';
import { StateWord } from '@/components/ui/List';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { RUN_TONE, RUN_WORD, taskLine } from '@/features/workflows/words';
import { useRunDetail } from '@/features/workflows/data';
import { WorkflowDetail } from '@/features/workflows/WorkflowCard';
import { modelName } from '@/lib/models';
import { groupByKind, TASK_KIND_GROUP, TASK_KIND_LABEL } from '@/lib/taskKinds';
import { useSubagentNow } from './ToolRows';
import { taskKind, tasksWord, useRunningTasks, type RunningSubagent, type RunningTask, type RunningWorkflow } from './liveTasks';

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
        {/* the pet does what most of the jobs do (CHAT-AND-MOTION 1.11) */}
        <Pet state={waiting ? 'waiting' : petState(busiestKind(tasks.map((t) => (t.kind === 'workflow' ? 'workflow' : t.agent))))} size={24} className="-my-1 text-fg-2" />
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

/** Each running task by kind, workflows first, then the one started first first; a heading per kind when there are several. */
export function TaskList({ tasks }: { tasks: RunningTask[] }) {
  const phone = useIsMobile();
  const groups = groupByKind(tasks, taskKind);
  const several = groups.length > 1;
  return (
    <div className="flex flex-col [&>div+div]:border-t [&>div+div]:border-rule">
      {!phone && <p className="m-0 border-b border-rule px-3 pt-2.5 pb-2 text-[12px] text-fg-3">{tasksWord(tasks.length)}</p>}
      {groups.map((g) => {
        // only the first three rows move (CHAT-AND-MOTION 1.9), across groups
        const stillOf = new Map(groups.flatMap((gr) => gr.items).map((t, i) => [t.key, i >= LIVE_ROWS] as const));
        return (
        <div key={g.kind}>
          {several && <p className="m-0 px-3 pt-2 text-[11.5px] font-medium text-fg-3 phone:px-4 phone:text-[12.5px]">{TASK_KIND_GROUP[g.kind]}</p>}
          <ul className="m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-rule" aria-label={several ? TASK_KIND_GROUP[g.kind] : 'Running tasks'}>
            {g.items.map((t) => (t.kind === 'workflow' ? <WorkflowTask key={t.key} task={t} still={stillOf.get(t.key)} /> : <SubagentTask key={t.key} task={t} still={stillOf.get(t.key)} />))}
          </ul>
        </div>
        );
      })}
    </div>
  );
}

/**
 * A task's title: its kind's icon and word, then what it is. "Workflow ·
 * deep-research", "Subagent · explore: Find the auth code", "Delegate · Code
 * on MadX Arch: Find names". The panel's Background tasks card says the same.
 */
export function TaskTitle({ task, still }: { task: RunningTask; still?: boolean }) {
  const kind = taskKind(task);
  return (
    <>
      <AgentGlyph type={kind === 'subagent' ? task.agent : kind} state={task.waiting ? 'waiting' : 'running'} still={still} className="mr-1.5 inline align-[-2px]" label={TASK_KIND_LABEL[kind]} />
      <span className="text-fg-2">{TASK_KIND_LABEL[kind]}</span>
      <span className="text-fg-4"> · </span>
      {task.kind === 'workflow' ? (
        <span className="font-medium">{task.run.name}</span>
      ) : task.handedTo ? (
        <>
          <span className="font-medium">{task.handedTo}:</span> {task.description}
        </>
      ) : (
        <>
          {task.agent && <span className="font-medium">{task.agent}: </span>}
          {task.description}
        </>
      )}
    </>
  );
}

/** The model a task runs on, when one is known, before its time. A workflow's agents each pick their own. */
function ModelWord({ model }: { model?: string }) {
  const name = modelName(model);
  return name ? <span className="mr-1.5 inline-block max-w-[11ch] truncate align-bottom text-fg-4">{name}</span> : null;
}

const ITEM = 'px-3 py-2.5 phone:px-4 phone:py-3';
const HEAD = 'grid w-full grid-cols-[minmax(0,1fr)_auto_12px] items-baseline gap-x-3 text-left phone:grid-cols-[minmax(0,1fr)_auto_16px]';
const TITLE = 'min-w-0 truncate text-[13.5px] text-fg phone:text-[15px]';
const LINE = 'mt-0.5 flex items-baseline gap-3 text-[12.5px] phone:text-[14px]';

/** A workflow: name, time, where it is, Open run; opened, its phases and agents. */
function WorkflowTask({ task, still }: { task: RunningWorkflow; still?: boolean }) {
  const { run } = task;
  const [open, setOpen] = useState(false);
  // the agents load when it opens, then follow the run's events
  const detail = useRunDetail(open ? run.id : undefined);
  return (
    <li data-task="workflow" className={ITEM}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(HEAD, 'group/task')}>
        <span className={TITLE}>
          <TaskTitle task={task} still={still} />
        </span>
        <span className="cv-state text-[12px] phone:text-[13px]">{run.status === 'running' ? <Elapsed since={run.startedAt ?? run.createdAt} format="short" className="text-signal" /> : run.status === 'paused' ? <PausedWord /> : <StateWord tone={RUN_TONE[run.status]}>{RUN_WORD[run.status]}</StateWord>}</span>
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
function SubagentTask({ task, still }: { task: RunningSubagent; still?: boolean }) {
  const now = useSubagentNow(true, task.childId);
  const paused = useHub((s) => (task.childId ? s.sessions[task.childId]?.status === 'paused' : false));
  return (
    <li data-task="subagent" className={ITEM}>
      <div className={HEAD}>
        <span className={TITLE}>
          <TaskTitle task={task} still={still} />
        </span>
        {paused ? (
          <PausedWord className="phone:text-[13px]" />
        ) : (
          <span className="text-[12px] phone:text-[13px]">
            <ModelWord model={task.model} />
            <Elapsed since={task.startedAt} format="short" className="text-signal" />
          </span>
        )}
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
