/**
 * One row per workflow call (spec 3.18): label, model, the state word in a
 * fixed column (violet running, amber parked or waiting on an approval, red
 * failed), the last tool, tokens and cost as aligned numbers. A value not
 * known yet is a grey dash, and a run with no tool calls has no Last tool
 * column. Nested workflow() calls are indented under their parent. A row
 * opens the child's transcript.
 */
import type { WorkflowCall, WorkflowRun } from '@conclave/core/client';
import { MoreHorizontal } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Overlay';
import { StateWord } from '@/components/ui/List';
import { Elapsed } from '@/components/motion';
import { modelName } from '@/lib/models';
import { compact, usd } from '@/lib/format';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { CALL_TONE, CALL_WORD, isLive } from './words';

export interface CallActions {
  open(call: WorkflowCall): void;
  skip(call: WorkflowCall): void;
  rerun(call: WorkflowCall): void;
}

const GRID = 'grid w-full items-baseline gap-x-4';
/** With the Last tool column, and without it (a run where no call used a tool yet). */
const COLS = { tool: 'grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)_96px_minmax(0,1fr)_64px_64px_28px]', none: 'grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)_96px_64px_64px_28px]' };

/** A call with something for the Last tool column: a tool it used, or why it failed. */
export function hasToolCell(call: WorkflowCall, progress: Record<number, string>): boolean {
  return !!(progress[call.seq] ?? call.lastTool) || (call.state === 'failed' && !!call.error && !stoppedByRun(call));
}

/** Not known yet, or not this call's: a grey dash (a hyphen; screen readers hear "none"). */
function Missing() {
  return (
    <span className="text-fg-4">
      <span aria-hidden>-</span>
      <span className="sr-only">none</span>
    </span>
  );
}

export function CallHeader({ tools = true }: { tools?: boolean }) {
  return (
    <div className={cn(GRID, tools ? COLS.tool : COLS.none, 'border-b border-rule pb-1.5 text-[12px] text-fg-3 phone:hidden')} aria-hidden>
      <span>Agent</span>
      <span>Model</span>
      <span>State</span>
      {tools && <span>Last tool</span>}
      <span className="text-right">Tokens</span>
      <span className="text-right">Cost</span>
      <span />
    </div>
  );
}

export function CallRows({ run, calls, progress, actions, selected, tools = true }: { run: WorkflowRun; calls: WorkflowCall[]; progress: Record<number, string>; actions: CallActions; selected?: number; tools?: boolean }) {
  const top = calls.filter((c) => c.parentSeq === undefined || !calls.some((p) => p.seq === c.parentSeq));
  return (
    <div className="rows">
      {top.map((c) => (
        <div key={c.seq}>
          <CallRow run={run} call={c} lastTool={progress[c.seq] ?? c.lastTool} actions={actions} selected={selected === c.seq} tools={tools} />
          {c.kind === 'workflow' &&
            calls
              .filter((x) => x.parentSeq === c.seq)
              .map((x) => (
                <div key={x.seq} className="border-t border-rule pl-6">
                  <CallRow run={run} call={x} lastTool={progress[x.seq] ?? x.lastTool} actions={actions} selected={selected === x.seq} tools={tools} />
                </div>
              ))}
        </div>
      ))}
    </div>
  );
}

/** A call cut short because the owner stopped the run: not a failure of the call. */
function stoppedByRun(call: WorkflowCall): boolean {
  return call.state === 'failed' && call.error === 'the run was stopped';
}

function CallRow({ run, call, lastTool, actions, selected, tools }: { run: WorkflowRun; call: WorkflowCall; lastTool?: string; actions: CallActions; selected?: boolean; tools: boolean }) {
  const phone = useIsMobile();
  const live = isLive(run.status);
  const state =
    call.state === 'running' && call.waiting ? (
      <StateWord tone="warn">waiting</StateWord>
    ) : call.state === 'running' ? (
      <span className="state-word inline-flex items-baseline gap-1.5 text-signal">
        running <Elapsed since={call.startedAt} format="short" />
      </span>
    ) : stoppedByRun(call) ? (
      <StateWord tone="dim">stopped</StateWord>
    ) : (
      <StateWord tone={CALL_TONE[call.state]}>{call.kind === 'workflow' && call.state === 'done' ? 'done' : CALL_WORD[call.state]}</StateWord>
    );
  const menu: MenuItem[] = [
    { label: call.childSessionId ? 'Open transcript' : 'Open details', onSelect: () => actions.open(call) },
    ...(live && (call.state === 'queued' || call.state === 'running' || call.state === 'parked') ? [{ label: 'Skip', detail: 'It returns null to the script', onSelect: () => actions.skip(call) }] : []),
    ...(!live ? [{ label: 'Rerun from here', detail: 'Earlier calls replay from the journal', onSelect: () => actions.rerun(call) }] : []),
  ];
  const label = call.label ?? (call.kind === 'workflow' ? 'workflow' : `call ${call.seq}`);
  const model = call.model ? modelName(call.model) : call.kind === 'agent' ? '' : call.kind;

  const more = (
    <Menu
      label={`Actions for ${label}`}
      items={menu}
      trigger={({ ref, props }) => (
        <IconButton ref={ref} label="More actions" size="sm" variant="quiet" {...props}>
          <MoreHorizontal />
        </IconButton>
      )}
    />
  );

  if (phone)
    return (
      <div className={cn('flex items-start gap-3 py-2.5', selected && 'bg-raise')}>
        <button type="button" onClick={() => actions.open(call)} className="min-w-0 flex-1 text-left">
          <span className="t-row block truncate text-fg">{label}</span>
          <span className="mt-0.5 block truncate text-[13px] text-fg-3">{[model, lastTool, call.inputTokens + call.outputTokens ? `${compact(call.inputTokens + call.outputTokens)} tokens` : '', call.costUsd ? usd(call.costUsd) : ''].filter(Boolean).join(', ')}</span>
        </button>
        <span className="pt-0.5 text-[13px]">{state}</span>
        {more}
      </div>
    );
  const tokens = call.inputTokens + call.outputTokens;
  const failure = call.state === 'failed' && call.error && !stoppedByRun(call) ? call.error : undefined;
  return (
    <div className={cn(GRID, tools ? COLS.tool : COLS.none, 'py-[var(--row-py)]', selected && 'bg-raise')}>
      <button type="button" onClick={() => actions.open(call)} className="t-row min-w-0 truncate text-left text-fg hov:underline" title={call.promptPreview}>
        {label}
        {call.attempt > 1 && <span className="text-fg-3">, attempt {call.attempt}</span>}
      </button>
      <span className="min-w-0 truncate text-[12px] text-fg-2" title={call.model}>
        {model || <Missing />}
        {call.effort ? <span className="text-fg-3">, {call.effort}</span> : null}
      </span>
      <span className="text-[12px]">{state}</span>
      {tools && (
        <span className="min-w-0 truncate text-[12px] text-fg-3" title={failure ?? lastTool}>
          {failure ? <span className="text-fault">{failure}</span> : lastTool || <Missing />}
        </span>
      )}
      <span className="num text-right text-[12px] text-fg-2">{tokens ? compact(tokens) : <Missing />}</span>
      <span className="num text-right text-[12px] text-fg-2">{call.costUsd ? usd(call.costUsd) : <Missing />}</span>
      {more}
    </div>
  );
}
