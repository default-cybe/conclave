/**
 * One workflow run (spec 3.18): a status sentence on top with the Knot while
 * it works and the current step under it, the phases in meta order with one
 * row per call, the narrator log, the result, findings and kept branches.
 * A row opens the agent's transcript in a side panel.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { Message } from '@conclave/core/types';
import type { WorkflowCall, WorkflowFinding, WorkflowRunDetail } from '@conclave/core/client';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SideSheet } from '@/components/ui/Overlay';
import { Notice, SectionHeading } from '@/components/ui/Section';
import { Meter } from '@/components/ui/Meter';
import { CodeBlock } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Knot, Roll, Steps } from '@/components/motion';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { compact, folderName, hhmm, usd } from '@/lib/format';
import { modelName } from '@/lib/models';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Markdown } from '../chat/Markdown';
import { useRunDetail } from './data';
import { CallHeader, CallRows, hasToolCell } from './CallRows';
import { Findings } from './Findings';
import { Worktrees } from './Worktrees';
import { byPhase, isLive, knotFor, statusParts } from './words';

export function RunView({ id }: { id: string }) {
  const { data, error, progress, lastActivity, reload } = useRunDetail(id);
  const [detail, setDetail] = useState<WorkflowRunDetail>();
  const [openCall, setOpenCall] = useState<WorkflowCall>();
  const [stopping, setStopping] = useState(false);
  const phone = useIsMobile();
  const devices = useHub((s) => s.devices);
  usePageHeader(data?.run.name ?? 'Run', '/workflows/runs');
  useEffect(() => setDetail(data), [data]);

  if (error)
    return (
      <Page>
        <PageHeader title="Run" />
        <Notice tone="fault">Failed. {error}</Notice>
      </Page>
    );
  if (!detail)
    return (
      <Page>
        <LoadingRows loading rows={8} />
      </Page>
    );
  const run = detail.run;
  const live = isLive(run.status);
  const parts = statusParts(run);
  // before the first progress event, the newest running call with a tool says what is happening
  const running = [...detail.calls].reverse().find((c) => c.state === 'running' && c.lastTool);
  const activity = lastActivity ?? (running ? { seq: running.seq, text: running.lastTool! } : undefined);
  const activityCall = activity ? detail.calls.find((c) => c.seq === activity.seq) : undefined;
  const phases = byPhase(run, detail.calls);
  // no call used a tool yet: no Last tool column, rather than one empty in every row
  const tools = detail.calls.some((c) => hasToolCell(c, progress));
  // a running call whose agent waits on an approval counts as waiting, not running
  const waitingApproval = detail.calls.filter((c) => c.kind === 'agent' && c.state === 'running' && c.waiting).length;
  const runningNow = Math.max(0, run.counts.running - waitingApproval);
  const actions = {
    open: (c: WorkflowCall) => setOpenCall(c),
    skip: (c: WorkflowCall) => void attempt(() => api().skipWorkflowCall(run.id, c.seq), `Skipped ${c.label ?? `call ${c.seq}`}`),
    rerun: (c: WorkflowCall) => void attempt(() => api().rerunWorkflow(run.id, c.seq), `Running again from ${c.label ?? `call ${c.seq}`}`).then(() => reload()),
  };
  const setFinding = (f: WorkflowFinding) => setDetail((d) => (d ? { ...d, findings: d.findings.map((x) => (x.id === f.id ? f : x)) } : d));
  const setWorktree = (seq: number, state: NonNullable<WorkflowCall['worktree']>['state']) =>
    setDetail((d) => (d ? { ...d, calls: d.calls.map((c) => (c.seq === seq && c.worktree ? { ...c, worktree: { ...c.worktree, state } } : c)) } : d));

  const control = (
    <>
      {run.status === 'running' && (
        <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={() => void attempt(() => api().pauseWorkflow(run.id))}>
          Pause
        </Button>
      )}
      {(run.status === 'paused' || run.status === 'interrupted' || run.status === 'waiting_reset') && (
        <Button variant="outline" size={phone ? 'touch' : 'md'} onClick={() => void attempt(() => api().resumeWorkflow(run.id)).then(() => reload())}>
          Resume
        </Button>
      )}
      {live && (
        <Button variant="quiet-fault" size={phone ? 'touch' : 'md'} onClick={() => setStopping(true)}>
          Stop
        </Button>
      )}
    </>
  );

  return (
    <Page>
      <nav aria-label="Breadcrumb" className="pt-6 text-[12px] phone:hidden">
        <Link href="/workflows" className="text-fg-3 hover:text-fg">
          Workflows
        </Link>
        <span className="px-1.5 text-fg-4">/</span>
        <Link href="/workflows/runs" className="text-fg-3 hover:text-fg">
          Runs
        </Link>
      </nav>
      <PageHeader title={<span className="phone:sr-only">{run.name}</span>} className="pt-1 phone:pt-2 phone:pb-0" actions={control} />

      {/* the rows use the page's whole width, out to the actions' edge; running text keeps its own measure */}
      <div className="space-y-9 phone:space-y-8">
        <section aria-label="Status">
          <div className="flex items-start gap-3">
            <span className="mt-[5px] grid size-4 shrink-0 place-items-center phone:mt-[6px]">
              <Knot state={knotFor(run)} size={16} still={!live} label={live ? 'Working' : undefined} />
            </span>
            <p className="t-title max-w-[80ch] text-fg" aria-live="polite">
              {parts.lead}.{parts.phase ? ` ${parts.phase}.` : ''} <Roll value={run.counts.agents} /> {run.counts.agents === 1 ? 'agent' : 'agents'}
              {run.counts.done + run.counts.cached > 0 && (
                <>
                  : <Roll value={run.counts.done + run.counts.cached} /> done
                </>
              )}
              {runningNow > 0 && (
                <span className="text-signal">
                  , <Roll value={runningNow} /> running
                </span>
              )}
              {waitingApproval > 0 && <span className="text-warn">, {waitingApproval} waiting for you</span>}
              {run.counts.failed > 0 && (
                <span className="text-fault">
                  , <Roll value={run.counts.failed} /> failed
                </span>
              )}
              {run.counts.parked > 0 && <span className="text-warn">, {run.counts.parked} waiting for a limit</span>}. <Roll value={compact(run.inputTokens + run.outputTokens)} /> tokens, <Roll value={usd(run.costUsd)} />.
            </p>
          </div>
          {live && activity && (
            <div className="mt-2 ml-7 text-[13px] text-fg-2 phone:text-[14px]">
              <Steps step={{ id: `${activity.seq}:${activity.text}`, verb: activityCall?.label ?? `Call ${activity.seq}`, target: activity.text }} />
            </div>
          )}
          <div className="mt-3 ml-7 max-w-[100ch] text-[12px] text-fg-3 phone:text-[13px]">
            {[run.description?.replace(/\.$/, ''), `On ${run.device === 'local' ? 'the hub' : (devices[run.device]?.name ?? run.device)}, in ${folderName(run.cwd) || 'the home folder'}`, run.sessionId ? null : 'Started from the app', run.portable ? null : 'Uses the Conclave layer'].filter(Boolean).join('. ')}
            {run.sessionId && (
              <>
                {'. '}
                <Link href={`/s/${run.sessionId}`} className="link">
                  Open the session
                </Link>
              </>
            )}
          </div>
          {run.budget?.tokens && (
            <div className="mt-3 ml-7 max-w-[420px]">
              <Meter value={run.outputTokens} max={run.budget.tokens} tone={run.outputTokens / run.budget.tokens >= 0.9 ? 'fault' : run.outputTokens / run.budget.tokens >= 0.7 ? 'warn' : 'neutral'} label={`Budget, ${compact(run.outputTokens)} of ${compact(run.budget.tokens)} output tokens`} />
              <div className="mt-1 text-[12px] text-fg-3">
                {compact(run.outputTokens)} of {compact(run.budget.tokens)} output tokens
              </div>
            </div>
          )}
          {run.error && run.status !== 'stopped' && (
            <Notice tone="fault" className="mt-3">
              {run.error}
            </Notice>
          )}
        </section>

        {phases.map((p, i) => (
          <section key={p.title} aria-labelledby={`ph-${i}`}>
            <SectionHeading
              id={`ph-${i}`}
              tone={undefined}
              right={
                <span className="num text-[12px] text-fg-3 phone:text-[13px]">
                  {p.calls.length ? `${p.calls.filter((c) => c.state === 'done' || c.state === 'cached').length} of ${p.calls.length} done` : i > run.phaseIndex && live ? 'not started' : 'no agents'}
                </span>
              }
            >
              <span className={cn(i === run.phaseIndex && live && 'text-signal')}>{p.title}</span>
            </SectionHeading>
            {p.detail && <p className="pt-2 text-[12px] text-fg-3 phone:text-[13px]">{p.detail}</p>}
            {p.calls.length > 0 && (
              <div className="pt-2">
                <CallHeader tools={tools} />
                <CallRows run={run} calls={p.calls} progress={progress} actions={actions} selected={openCall?.seq} tools={tools} />
              </div>
            )}
          </section>
        ))}

        <ResultSection detail={detail} />

        <Findings runId={run.id} findings={detail.findings} refutedRate={detail.refutedRate} onChange={setFinding} />
        <Worktrees runId={run.id} calls={detail.calls} onChange={setWorktree} />

        {detail.logs.length > 0 && (
          <section aria-labelledby="wf-log">
            <SectionHeading id="wf-log" count={detail.logs.length}>
              Log
            </SectionHeading>
            <ol className="rows">
              {detail.logs.map((l) => (
                <li key={l.n} className="grid grid-cols-[48px_minmax(0,1fr)] gap-x-3 py-2 text-[13px] phone:text-[14px]">
                  <span className="num text-fg-3">{hhmm(l.ts)}</span>
                  <span className="min-w-0 break-words text-fg-2">{l.text}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <SideSheet open={!!openCall} onClose={() => setOpenCall(undefined)} width={phone ? 390 : 560} label={openCall?.label ?? 'Transcript'}>
        {openCall && <Transcript call={openCall} />}
      </SideSheet>
      <ConfirmDialog
        open={stopping}
        onClose={() => setStopping(false)}
        onConfirm={async () => {
          setStopping(false);
          await attempt(() => api().stopWorkflow(run.id), 'Stopped');
        }}
        title={`Stop ${run.name}?`}
        body="Running agents are stopped and the script ends. Finished calls stay in the journal, so Resume replays them."
        confirm="Stop"
        tone="danger"
      />
    </Page>
  );
}

function ResultSection({ detail }: { detail: WorkflowRunDetail }) {
  const r = detail.result;
  if (r === undefined || r === null) return null;
  const report = typeof r === 'string' ? r : typeof (r as { report?: unknown }).report === 'string' ? ((r as { report: string }).report as string) : undefined;
  const rest = typeof r === 'object' ? r : undefined;
  return (
    <section aria-labelledby="wf-result">
      <SectionHeading id="wf-result">Result</SectionHeading>
      {report && <Markdown text={report} className="max-w-[80ch] pt-3" />}
      {rest && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-[12px] text-fg-3 hover:text-fg phone:text-[13px]">{report ? 'The whole result' : 'Result'}</summary>
          <CodeBlock code={JSON.stringify(rest, null, 2)} lang="json" maxLines={40} className="mt-2" />
        </details>
      )}
    </section>
  );
}

function textOf(m: Message): string {
  return m.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
    .trim();
}

/** The agent's session, read-only: the prompt on top, what it did, the result at the bottom. */
function Transcript({ call }: { call: WorkflowCall }) {
  const [msgs, setMsgs] = useState<Message[]>();
  useEffect(() => {
    if (!call.childSessionId) return;
    let alive = true;
    api()
      .messages(call.childSessionId)
      .then((m) => alive && setMsgs(m))
      .catch(() => alive && setMsgs([]));
    return () => {
      alive = false;
    };
  }, [call.childSessionId]);
  const prompt = useMemo(() => (msgs?.find((m) => m.role === 'user') ? textOf(msgs.find((m) => m.role === 'user')!) : call.promptPreview), [msgs, call.promptPreview]);
  const steps = (msgs ?? []).filter((m) => m.role === 'assistant' && m.kind === 'normal');
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule px-5 pt-4 pb-3">
        <div className="t-title text-fg">{call.label ?? `Call ${call.seq}`}</div>
        <div className="mt-0.5 text-[12px] text-fg-3">
          {[call.agentType, call.model ? modelName(call.model) : '', `${compact(call.inputTokens + call.outputTokens)} tokens`, usd(call.costUsd)].filter(Boolean).join(', ')}
        </div>
      </div>
      <div className="scroll-y min-h-0 flex-1 space-y-5 px-5 py-4">
        <div>
          <div className="t-section pb-1.5 text-fg">Prompt</div>
          <div className="max-h-[240px] overflow-y-auto rounded-[var(--r-2)] bg-sunk p-3 text-[12.5px] whitespace-pre-wrap text-fg-2">{prompt ?? ''}</div>
        </div>
        {!call.childSessionId && <p className="text-[13px] text-fg-3">This call ran on the hub (a check or a question), so it has no transcript.</p>}
        {msgs === undefined && call.childSessionId && <LoadingRows loading rows={3} />}
        {steps.length > 0 && (
          <div>
            <div className="t-section pb-1.5 text-fg">Steps</div>
            <ol className="rows">
              {steps.map((m) => {
                const tools = m.content.filter((b) => b.type === 'tool_use') as Array<{ name: string; input: Record<string, unknown> }>;
                const t = textOf(m);
                return (
                  <li key={m.id} className="py-2 text-[13px]">
                    {t && <Markdown text={t.length > 1200 ? `${t.slice(0, 1200)}…` : t} />}
                    {tools.map((u, i) => (
                      <div key={i} className="mono truncate text-[12px] text-fg-3">
                        {u.name} {Object.values(u.input ?? {}).find((v) => typeof v === 'string') as string | undefined}
                      </div>
                    ))}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        <div>
          <div className="t-section pb-1.5 text-fg">Result</div>
          {call.state === 'failed' && call.error ? <p className="text-[13px] text-fault">{call.error}</p> : call.resultPreview ? <CodeBlock code={call.resultPreview} wrap maxLines={30} /> : <p className="text-[13px] text-fg-3">{call.state === 'running' ? 'Still working.' : 'No result.'}</p>}
        </div>
      </div>
    </div>
  );
}
