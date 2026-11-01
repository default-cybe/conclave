/** Row and header actions for a routine: Run now, Pause or Resume, Duplicate, Delete (with a confirm). */
import { useState } from 'react';
import { useLocation } from 'wouter';
import type { Routine, RoutineRun } from '@conclave/core/types';
import type { RoutineInput } from '@conclave/core/scheduler/types';
import { api } from '@/lib/api';
import { attempt, removeKey, toast, upsertRoutine, useHub } from '@/store/store';
import { ConfirmDialog } from '@/components/ui/Overlay';

/** Add or replace a run in the store (the hub also sends it as an event). */
export function upsertRun(run: RoutineRun) {
  useHub.setState((s) => {
    const list = [...(s.runs[run.routineId] ?? [])];
    const i = list.findIndex((r) => r.id === run.id);
    if (i >= 0) list[i] = run;
    else list.unshift(run);
    return { runs: { ...s.runs, [run.routineId]: list } };
  });
}

export function routineInput(r: RoutineInput): RoutineInput {
  return {
    name: r.name,
    schedule: r.schedule,
    prompt: r.prompt,
    agent: r.agent,
    model: r.model,
    mode: r.mode,
    cwd: r.cwd,
    device: r.device,
    timezone: r.timezone,
    enabled: r.enabled,
    sessionPolicy: r.sessionPolicy,
    notify: r.notify,
    allow: r.allow,
    deny: r.deny,
    onApproval: r.onApproval,
    precheck: r.precheck,
    env: r.env,
    timeoutMin: r.timeoutMin,
    maxCostUsd: r.maxCostUsd,
    suggestion: r.suggestion,
    template: r.template,
  };
}

export function useRoutineActions(routine: Routine, opts: { afterDelete?: string } = {}) {
  const [, navigate] = useLocation();
  const [confirm, setConfirm] = useState(false);
  const runCount = useHub((s) => s.runs[routine.id]?.length ?? 0);

  const runNow = async () => {
    const run = await attempt(() => api().runRoutine(routine.id));
    if (run) {
      upsertRun(run);
      toast({ title: `Started ${routine.name}.`, level: 'info', link: run.sessionId ? `/s/${run.sessionId}` : undefined });
    }
  };
  const toggle = async () => {
    const enabled = !routine.enabled;
    upsertRoutine({ ...routine, enabled });
    const next = await attempt(() => api().updateRoutine(routine.id, { enabled }));
    if (next) upsertRoutine(next);
    else upsertRoutine(routine);
  };
  const duplicate = async () => {
    // a watch's copy is a watch too (features/watches); the editor never sends the watch, so a stale form cannot undo Edit filters
    const copy = await attempt(() => api().createRoutine({ ...routineInput(routine), ...(routine.watch ? { watch: routine.watch } : {}), name: `${routine.name} copy`, enabled: false }));
    if (copy) {
      upsertRoutine(copy);
      navigate(`/routines/${copy.id}?tab=settings`);
    }
  };
  const remove = async () => {
    const ok = await attempt(() => api().deleteRoutine(routine.id), `Deleted ${routine.name}.`);
    if (!ok) throw new Error('not deleted');
    removeKey('routines', routine.id);
    if (opts.afterDelete) navigate(opts.afterDelete);
  };

  const dialogs = (
    <ConfirmDialog
      open={confirm}
      onClose={() => setConfirm(false)}
      onConfirm={() => remove().catch(() => undefined)}
      title={`Delete routine ${routine.name}?`}
      body={runCount ? `It stops running. Its ${runCount} past ${runCount === 1 ? 'run keeps its' : 'runs keep their'} sessions.` : 'It stops running. The sessions it started stay.'}
      confirm="Delete"
      busy="Deleting"
    />
  );

  return { runNow, toggle, duplicate, askDelete: () => setConfirm(true), dialogs };
}
