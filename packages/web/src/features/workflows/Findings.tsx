/**
 * A run's findings (spec 3.18): open ones first with Fixed, Dismiss (asks for
 * a reason) and Ignore; a decided one glides out of that list into Decided
 * (the gap list). Dismissals teach later runs to drop similar findings.
 */
import { useState } from 'react';
import type { FindingVerdict, WorkflowFinding } from '@conclave/core/client';
import { GapList } from '@/components/motion';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { Field, Textarea } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';
import { StateWord } from '@/components/ui/List';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { cn } from '@/lib/text';

const VERDICT_WORD: Record<FindingVerdict, string> = { fixed: 'fixed', dismissed: 'dismissed', ignored: 'ignored' };

function votesWord(f: WorkflowFinding): string | undefined {
  const v = Array.isArray(f.votes) ? (f.votes as Array<string | null>) : undefined;
  if (!v?.length) return undefined;
  const yes = v.filter((x) => x === 'confirmed').length;
  return `${yes} of ${v.length} refuters confirmed`;
}

export function Findings({ runId, findings, refutedRate, onChange }: { runId: string; findings: WorkflowFinding[]; refutedRate?: number; onChange: (f: WorkflowFinding) => void }) {
  const [dismissing, setDismissing] = useState<WorkflowFinding>();
  const open = findings.filter((f) => !f.verdict);
  const decided = findings.filter((f) => f.verdict);
  const judge = async (f: WorkflowFinding, verdict: FindingVerdict, reason?: string) => {
    const r = await attempt(() => api().judgeFinding(runId, f.id, verdict, reason));
    if (r) onChange(r);
  };
  if (!findings.length) return null;
  return (
    <section aria-labelledby="wf-findings">
      <SectionHeading id="wf-findings" count={open.length} right={refutedRate !== undefined ? <span className="num text-[12px] text-fg-3">Refuters dropped {Math.round(refutedRate * 100)}% of the findings they checked</span> : undefined}>
        Findings
      </SectionHeading>
      {open.length > 0 ? (
        <GapList items={open} keyOf={(f) => f.id} className="rows" exit="right">
          {(f) => <FindingRow f={f} actions={<Actions f={f} onFixed={() => judge(f, 'fixed')} onIgnore={() => judge(f, 'ignored')} onDismiss={() => setDismissing(f)} />} />}
        </GapList>
      ) : (
        <p className="py-3 text-[13px] text-fg-3">Every finding has a verdict.</p>
      )}
      {decided.length > 0 && (
        <div className="mt-6">
          <SectionHeading as="h3" count={decided.length}>
            Decided
          </SectionHeading>
          <div className="rows">
            {decided.map((f) => (
              <FindingRow key={f.id} f={f} dim actions={<StateWord tone="dim">{VERDICT_WORD[f.verdict!]}</StateWord>} />
            ))}
          </div>
        </div>
      )}
      <DismissDialog finding={dismissing} onClose={() => setDismissing(undefined)} onDismiss={(reason) => dismissing && judge(dismissing, 'dismissed', reason).then(() => setDismissing(undefined))} />
    </section>
  );
}

function FindingRow({ f, actions, dim }: { f: WorkflowFinding; actions: React.ReactNode; dim?: boolean }) {
  const scenario = typeof f.data?.scenario === 'string' ? f.data.scenario : undefined;
  const quote = typeof f.data?.quote === 'string' ? f.data.quote : undefined;
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-3 phone:grid-cols-[28px_minmax(0,1fr)]">
      <span className={cn('num text-[12px] font-medium', f.priority === 'P0' || f.priority === 'P1' ? 'text-fg' : 'text-fg-3')}>{f.priority ?? ''}</span>
      <div className="min-w-0">
        <div className={cn('t-row', dim ? 'text-fg-2' : 'text-fg')}>{f.title}</div>
        <div className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
          {f.file && (
            <span className="mono">
              {f.file}
              {f.line ? `:${f.line}` : ''}
            </span>
          )}
          {f.proven ? <span className="text-ok">, proven by a failing test</span> : votesWord(f) ? `, ${votesWord(f)}` : ''}
        </div>
        {quote && !dim && <div className="mono mt-1.5 truncate text-[12px] text-fg-2">{quote}</div>}
        {scenario && !dim && <div className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">Trigger: {scenario}</div>}
        {f.reason && <div className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">Reason: {f.reason}</div>}
      </div>
      <div className="phone:col-start-2 phone:mt-2">{actions}</div>
    </div>
  );
}

function Actions({ f, onFixed, onIgnore, onDismiss }: { f: WorkflowFinding; onFixed: () => void; onIgnore: () => void; onDismiss: () => void }) {
  return (
    <span className="flex items-center gap-1" aria-label={`Verdict for ${f.title}`}>
      <Button variant="quiet" size="sm" onClick={onFixed}>
        Fixed
      </Button>
      <Button variant="quiet" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
      <Button variant="quiet" size="sm" onClick={onIgnore}>
        Ignore
      </Button>
    </span>
  );
}

function DismissDialog({ finding, onClose, onDismiss }: { finding?: WorkflowFinding; onClose: () => void; onDismiss: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  if (!finding) return null;
  const submit = () => {
    if (!reason.trim()) {
      setError('Say why, so later runs can drop findings like it.');
      return;
    }
    onDismiss(reason.trim());
    setReason('');
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Dismiss this finding?"
      description={finding.title}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" onClick={submit}>
            Dismiss
          </Button>
        </>
      }
    >
      <Field label="Why it is not a problem" help="After three similar dismissals, later runs of this workflow drop such findings and say how many." error={error}>
        <Textarea minRows={3} value={reason} onChange={(e) => (setReason(e.target.value), setError(undefined))} />
      </Field>
    </Dialog>
  );
}
