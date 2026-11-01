/**
 * Engine events as log lines: tool calls, approvals and questions, routine
 * and workflow runs, imports, alerts, error notices, provider limits.
 * Friends' messages are logged by the peer service (server/src/peer), device
 * connects by the daemon hub (server/src/ws/daemons.ts). Turns are logged by the runner itself (logTurn), which
 * knows the error and the stop reason.
 *
 * Only ids, names, counts, durations and outcomes are written. A tool call
 * line has the tool's name, how long it took and whether it failed, never
 * its input or output; an approval has the tool, never the command.
 */
import type { EngineEventEnvelope, UsageRecord } from '../types';
import type { EventBus } from '../util/bus';
import { logEvent, logger, type Level } from '../util/log';
import { EV, ev, type EventName } from './names';

/** Tool calls in flight are remembered this long at most. */
const MAX_OPEN = 5000;

function write(level: Level, name: EventName, fields: Record<string, unknown>, console = false): void {
  const [component, msg] = ev(name);
  if (console) logger(component)[level](msg, fields);
  else logEvent(level, component, msg, fields);
}

/** "anthropic" from "anthropic/claude-sonnet-5-5". */
export function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const i = model.indexOf('/');
  return i > 0 ? model.slice(0, i) : undefined;
}

export interface TurnLog {
  sessionId: string;
  agent?: string;
  model: string;
  mode?: string;
  /** chat or agent. */
  kind?: string;
  device?: string;
  startedAt: number;
  endedAt?: number;
  /** done, aborted, error, or why the loop stopped (rate_limit, step_limit, refusal...). */
  stop: string;
  error?: unknown;
  /** Tool calls in the turn. */
  tools?: number;
  /** Model calls, tokens and cost since startedAt. */
  usage?: Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'> & { calls?: number };
  /** True for a turn a routine, a loop or a subagent ran. */
  unattended?: boolean;
}

/** One line per user turn: who, which model, how long, what it cost, how it ended. */
export function logTurn(t: TurnLog): void {
  const ended = t.endedAt ?? Date.now();
  const u = t.usage;
  // a failed turn is a warning here: the runner writes the error itself, with its stack ("turn failed in <session>"), so one failure counts once
  const level: Level = t.stop === 'done' || t.stop === 'aborted' || t.stop === 'stopped' ? 'info' : 'warn';
  const err = t.error;
  write(
    level,
    EV.turn,
    {
      sessionId: t.sessionId,
      ...(t.agent ? { agent: t.agent } : {}),
      model: t.model,
      ...(providerOf(t.model) ? { provider: providerOf(t.model) } : {}),
      ...(t.mode && t.mode !== 'agent' ? { mode: t.mode } : {}),
      ...(t.kind ? { kind: t.kind } : {}),
      ...(t.device && t.device !== 'local' ? { device: t.device } : {}),
      durationMs: Math.max(0, ended - t.startedAt),
      stop: t.stop,
      ...(t.tools !== undefined ? { tools: t.tools } : {}),
      ...(u
        ? {
            calls: u.calls ?? 0,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            ...(u.cacheReadTokens ? { cacheReadTokens: u.cacheReadTokens } : {}),
            ...(u.cacheWriteTokens ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
            costUsd: Math.round(u.costUsd * 1e6) / 1e6,
          }
        : {}),
      ...(t.unattended ? { unattended: true } : {}),
      ...(err !== undefined ? { error: err instanceof Error ? err.message : String(err) } : {}),
    },
    true,
  );
}

/** Follow the bus and write the events above. Returns a function that stops. */
export function attachLogEvents(bus: EventBus, now: () => number = Date.now): () => void {
  const tools = new Map<string, { name: string; at: number }>();
  const asked = new Map<string, number>();
  const runs = new Map<string, string>();
  const batches = new Map<string, string>();
  const workflows = new Map<string, string>();
  const blocked = new Map<string, boolean>();

  const remember = <V>(m: Map<string, V>, k: string, v: V) => {
    m.set(k, v);
    if (m.size > MAX_OPEN) m.delete(m.keys().next().value as string);
  };

  const handle = (e: EngineEventEnvelope) => {
    switch (e.type) {
      case 'tool.started':
        remember(tools, e.toolUseId, { name: e.name, at: e.ts ?? now() });
        return;
      case 'tool.completed': {
        const open = tools.get(e.toolUseId);
        tools.delete(e.toolUseId);
        const meta = e.result.meta;
        const durationMs = typeof meta?.durationMs === 'number' ? meta.durationMs : open ? Math.max(0, (e.ts ?? now()) - open.at) : undefined;
        write('info', EV.tool, {
          sessionId: e.sessionId,
          tool: open?.name ?? 'unknown',
          ...(durationMs !== undefined ? { durationMs } : {}),
          ok: !e.result.isError,
          ...(typeof meta?.exitCode === 'number' ? { exitCode: meta.exitCode } : {}),
          ...(meta?.external ? { external: true } : {}),
          ...((meta as { notRun?: string } | undefined)?.notRun ? { notRun: (meta as { notRun?: string }).notRun } : {}),
          ...(meta?.truncated ? { truncated: true } : {}),
        });
        return;
      }
      case 'approval.requested':
        remember(asked, e.approval.id, e.approval.createdAt ?? now());
        write('info', EV.approvalAsked, { id: e.approval.id, sessionId: e.approval.sessionId, tool: e.approval.tool, ...(e.approval.harness ? { harness: e.approval.harness } : {}) });
        return;
      case 'approval.resolved': {
        const at = asked.get(e.id);
        asked.delete(e.id);
        const r = e.response;
        write('info', EV.approvalAnswered, {
          id: e.id,
          sessionId: e.sessionId,
          decision: r.decision,
          ...(r.decision === 'allow' && r.scope ? { scope: r.scope } : {}),
          ...(at ? { waitMs: Math.max(0, (e.ts ?? now()) - at) } : {}),
        });
        return;
      }
      case 'question.asked':
        remember(asked, e.question.id, e.question.createdAt ?? now());
        write('info', EV.questionAsked, { id: e.question.id, sessionId: e.question.sessionId, questions: e.question.questions.length });
        return;
      case 'question.answered': {
        const at = asked.get(e.id);
        asked.delete(e.id);
        write('info', EV.questionAnswered, { id: e.id, sessionId: e.sessionId, ...(at ? { waitMs: Math.max(0, (e.ts ?? now()) - at) } : {}) });
        return;
      }
      case 'session.created': {
        const s = e.session;
        write('info', EV.sessionCreated, { sessionId: s.id, agent: s.agent, model: s.model, kind: s.kind ?? 'agent', ...(s.device && s.device !== 'local' ? { device: s.device } : {}), ...(s.parentId ? { parentId: s.parentId } : {}) });
        return;
      }
      case 'routine.run': {
        const r = e.run;
        const was = runs.get(r.id);
        if (was === r.status) return;
        remember(runs, r.id, r.status);
        if (r.status === 'running') {
          write('info', EV.routineStarted, { routineId: r.routineId, runId: r.id, trigger: r.trigger, ...(r.sessionId ? { sessionId: r.sessionId } : {}) });
          return;
        }
        write(
          r.status === 'error' ? 'error' : 'info',
          EV.routineRun,
          {
            routineId: r.routineId,
            runId: r.id,
            trigger: r.trigger,
            status: r.status,
            ...(r.outcome ? { outcome: r.outcome } : {}),
            ...(r.finishedAt ? { durationMs: Math.max(0, r.finishedAt - r.startedAt) } : {}),
            ...(r.sessionId ? { sessionId: r.sessionId } : {}),
            ...(r.denied?.length ? { denied: r.denied.length } : {}),
            ...(r.error ? { error: r.error } : {}),
          },
          true,
        );
        return;
      }
      case 'workflow.run': {
        const w = e.run;
        if (workflows.get(w.id) === w.status) return;
        remember(workflows, w.id, w.status);
        const failed = w.status === 'failed';
        write(failed ? 'error' : 'info', EV.workflowRun, {
          runId: w.id,
          name: w.name,
          status: w.status,
          ...(w.sessionId ? { sessionId: w.sessionId } : {}),
          ...(w.device !== 'local' ? { device: w.device } : {}),
          inputTokens: w.inputTokens,
          outputTokens: w.outputTokens,
          costUsd: w.costUsd,
          ...((w as { error?: string }).error ? { error: (w as { error?: string }).error } : {}),
        });
        return;
      }
      case 'import.batch': {
        const b = e.batch;
        if (batches.get(b.id) === b.status) return;
        remember(batches, b.id, b.status);
        write(b.status === 'failed' ? 'error' : 'info', EV.importBatch, {
          batchId: b.id,
          device: b.device,
          mode: b.mode,
          status: b.status,
          total: b.total,
          imported: b.imported,
          updated: b.updated,
          skipped: b.skipped,
          failed: b.failed,
          ...(b.memoriesAdded ? { memoriesAdded: b.memoriesAdded } : {}),
          ...(b.costUsd ? { costUsd: b.costUsd } : {}),
          ...(b.error ? { error: b.error } : {}),
        });
        return;
      }
      case 'alert.raised': {
        const a = e.alert;
        write('warn', EV.alert, { id: a.id, kind: a.kind, sessionId: a.sessionId, ...(a.reason ? { reason: a.reason } : {}), ...(a.tool ? { tool: a.tool } : {}), ...(a.count ? { count: a.count } : {}) });
        return;
      }
      case 'notice': {
        const n = e.notice;
        // error notices that are not about a session (a session's are its turn's error, logged with the turn);
        // the title is the hub's own words, the body may quote a chat and stays out
        if (n.level !== 'error' || n.sessionId) return;
        write('warn', EV.notice, { title: n.title.slice(0, 160) });
        return;
      }
      case 'limit.updated': {
        const l = e.limit;
        const key = `${l.provider}:${l.account ?? ''}`;
        const now = !!l.blocked;
        if ((blocked.get(key) ?? false) === now) return;
        remember(blocked, key, now);
        write(now ? 'warn' : 'info', EV.limit, { provider: l.provider, ...(l.account ? { account: l.account } : {}), blocked: now, source: l.source }, true);
        return;
      }
      default:
        return;
    }
  };

  return bus.on((e) => {
    try {
      handle(e);
    } catch {
      /* logging must never break the bus */
    }
  });
}
