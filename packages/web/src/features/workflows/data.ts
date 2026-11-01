/**
 * Workflow data for the pages: the library, the runs list and one run's
 * detail, each kept live from the hub's workflow.* events (store onHubEvent).
 * A session's runs (useSessionRuns) are loaded once and shared by its rows
 * and its running tasks.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkflowCall, WorkflowRun, WorkflowRunDetail, WorkflowSummary } from '@conclave/core/client';
import { api } from '@/lib/api';
import { onHubEvent } from '@/store/store';
import { isLive } from './words';

export function useLibrary(): { data?: WorkflowSummary[]; error?: string; reload: () => void } {
  const [data, setData] = useState<WorkflowSummary[]>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api()
      .workflows()
      .then((d) => alive && (setData(d), setError(undefined)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [tick]);
  // a run that ends updates the last-run column
  useEffect(
    () =>
      onHubEvent((e) => {
        if (e.type !== 'workflow.run') return;
        setData((list) => list?.map((w) => (w.name === e.run.name ? { ...w, lastRun: { id: e.run.id, status: e.run.status, createdAt: e.run.createdAt, ...(e.run.finishedAt ? { finishedAt: e.run.finishedAt } : {}) } } : w)));
      }),
    [],
  );
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function useRuns(q: { sessionId?: string; limit?: number } = {}): { data?: WorkflowRun[]; error?: string } {
  const [data, setData] = useState<WorkflowRun[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    api()
      .workflowRuns(q)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.sessionId, q.limit]);
  useEffect(
    () =>
      onHubEvent((e) => {
        if (e.type !== 'workflow.run') return;
        if (q.sessionId && e.run.sessionId !== q.sessionId) return;
        setData((list) => {
          if (!list) return list;
          const i = list.findIndex((r) => r.id === e.run.id);
          if (i < 0) return [e.run, ...list];
          const next = list.slice();
          next[i] = e.run;
          return next;
        });
      }),
    [q.sessionId],
  );
  return { data, error };
}

// ---------------------------------------------------------------------------
// A session's runs
// ---------------------------------------------------------------------------

interface SessionRuns {
  runs?: WorkflowRun[];
  subs: Set<() => void>;
  /** Runs the events brought since the list was asked for: they are newer than the list. */
  heard: Map<string, WorkflowRun>;
  stop?: () => void;
}

const bySession = new Map<string, SessionRuns>();
const NO_RUNS: readonly WorkflowRun[] = [];

const newestFirst = (a: WorkflowRun, b: WorkflowRun) => b.createdAt - a.createdAt;

function followSession(sessionId: string, fn: () => void): () => void {
  let entry = bySession.get(sessionId);
  if (!entry) bySession.set(sessionId, (entry = { subs: new Set(), heard: new Map() }));
  const e = entry;
  e.subs.add(fn);
  if (!e.stop) {
    let alive = true;
    e.heard = new Map();
    const tell = () => e.subs.forEach((f) => f());
    const off = onHubEvent((ev) => {
      if (ev.type === 'workflow.run') {
        if (ev.run.sessionId !== sessionId) return;
        e.heard.set(ev.run.id, ev.run);
        const list = (e.runs ?? []).filter((r) => r.id !== ev.run.id);
        e.runs = [ev.run, ...list].sort(newestFirst);
        tell();
      } else if (ev.type === 'workflow.phase' && e.runs?.some((r) => r.id === ev.runId)) {
        e.runs = e.runs.map((r) => (r.id === ev.runId ? { ...r, phaseIndex: ev.index, phaseTitle: ev.title } : r));
        tell();
      }
    });
    api()
      .workflowRuns({ sessionId, limit: 20 })
      .then((list) => {
        if (!alive) return;
        const all = new Map(list.map((r) => [r.id, r]));
        for (const r of e.heard.values()) all.set(r.id, r);
        e.runs = [...all.values()].sort(newestFirst);
        tell();
      })
      .catch(() => {
        if (!alive || e.runs) return;
        e.runs = [];
        tell();
      });
    e.stop = () => {
      alive = false;
      off();
    };
  }
  return () => {
    e.subs.delete(fn);
    // nobody looks: stop listening, and load again when someone does (events were missed meanwhile)
    if (!e.subs.size) {
      e.stop?.();
      e.stop = undefined;
    }
  };
}

/**
 * The workflow runs a session started, newest first, live: asked for once
 * when the first row or line that needs them mounts, then kept by the hub's
 * workflow.run and workflow.phase events. Empty until they load.
 */
export function useSessionRuns(sessionId: string | undefined): readonly WorkflowRun[] {
  const subscribe = useCallback((fn: () => void) => (sessionId ? followSession(sessionId, fn) : () => {}), [sessionId]);
  const get = () => (sessionId ? (bySession.get(sessionId)?.runs ?? NO_RUNS) : NO_RUNS);
  return useSyncExternalStore(subscribe, get, get);
}

/** One run with its calls, logs and findings, following the hub's events. */
export function useRunDetail(id: string | undefined): { data?: WorkflowRunDetail; error?: string; reload: () => void; progress: Record<number, string>; lastActivity?: { seq: number; text: string } } {
  const [data, setData] = useState<WorkflowRunDetail>();
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<Record<number, string>>({});
  const [lastActivity, setLastActivity] = useState<{ seq: number; text: string }>();
  const [tick, setTick] = useState(0);
  // whether the run had ended when we last heard: an end brings the result, a resume starts the calls over
  const endedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    api()
      .workflowRun(id)
      .then((d) => {
        if (!alive) return;
        endedRef.current = !isLive(d.run.status);
        setData(d);
        setError(undefined);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id, tick]);

  useEffect(() => {
    if (!id) return;
    return onHubEvent((e) => {
      if (!('runId' in e) && e.type !== 'workflow.run') return;
      if (e.type === 'workflow.run') {
        if (e.run.id !== id) return;
        setData((d) => (d ? { ...d, run: e.run } : d));
        // the result and findings arrive with the end of the run; a resumed run starts its calls over,
        // so both changes load the run again
        const ended = !isLive(e.run.status);
        if (endedRef.current !== undefined && ended !== endedRef.current) setTick((t) => t + 1);
        endedRef.current = ended;
        return;
      }
      if (e.type === 'workflow.agent' && e.runId === id) {
        setData((d) => (d ? { ...d, calls: upsertCall(d.calls, e.call) } : d));
        if (e.call.state === 'running' && e.call.lastTool) setLastActivity({ seq: e.call.seq, text: e.call.lastTool });
      } else if (e.type === 'workflow.log' && e.runId === id) {
        setData((d) => (d ? { ...d, logs: [...d.logs, { n: (d.logs[d.logs.length - 1]?.n ?? 0) + 1, ts: e.ts, text: e.text }] } : d));
      } else if (e.type === 'workflow.progress' && e.runId === id) {
        const seq = e.callSeq;
        setProgress((p) => ({ ...p, [seq]: e.lastTool }));
        setLastActivity({ seq, text: e.lastTool });
        // an approval the agent waits on, or its answer
        const waiting = e.waiting;
        if (waiting !== undefined) setData((d) => (d ? { ...d, calls: d.calls.map((c) => (c.seq === seq ? { ...c, waiting: waiting || undefined } : c)) } : d));
      } else if (e.type === 'workflow.phase' && e.runId === id) {
        setData((d) => (d ? { ...d, run: { ...d.run, phaseIndex: e.index, phaseTitle: e.title } } : d));
      }
    });
  }, [id]);
  return { data, error, progress, lastActivity, reload: useCallback(() => setTick((t) => t + 1), []) };
}

function upsertCall(list: WorkflowCall[], c: WorkflowCall): WorkflowCall[] {
  const i = list.findIndex((x) => x.seq === c.seq);
  if (i < 0) return [...list, c].sort((a, b) => a.seq - b.seq);
  const next = list.slice();
  next[i] = c;
  return next;
}

/** One run, live, for the card in a session. */
export function useRunLive(id: string | undefined): WorkflowRun | undefined {
  const [run, setRun] = useState<WorkflowRun>();
  useEffect(() => {
    if (!id) return;
    let alive = true;
    api()
      .workflowRun(id)
      .then((d) => alive && setRun(d.run))
      .catch(() => {});
    const off = onHubEvent((e) => {
      if (e.type === 'workflow.run' && e.run.id === id) setRun(e.run);
    });
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  return run;
}
