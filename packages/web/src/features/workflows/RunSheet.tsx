/**
 * Start a workflow from the library (spec 3.18): what it is for, its args
 * as JSON, where it runs, a budget, and Start. A dialog on desktop, a sheet
 * on phones.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import type { WorkflowSummary } from '@conclave/core/client';
import { Dialog, Sheet } from '@/components/ui/Overlay';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { DevicePicker } from '@/components/pickers/Pickers';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { SOURCE_WORD } from './words';

export function RunSheet({ workflow, onClose }: { workflow: WorkflowSummary | undefined; onClose: () => void }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const [args, setArgs] = useState('');
  const [device, setDevice] = useState('local');
  const [cwd, setCwd] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [argsError, setArgsError] = useState<string>();
  const [budgetError, setBudgetError] = useState<string>();

  useEffect(() => {
    setArgs('');
    setArgsError(undefined);
    setBudget('');
    setBudgetError(undefined);
  }, [workflow?.id]);

  if (!workflow) return null;
  const start = async () => {
    let parsed: unknown;
    if (args.trim()) {
      try {
        parsed = JSON.parse(args);
      } catch {
        setArgsError('Args must be JSON, for example {"question": "Caddy or Traefik?"}. Strings need double quotes.');
        return;
      }
    }
    let tokens: number | undefined;
    if (budget.trim()) {
      const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(budget.trim());
      if (!m) {
        setBudgetError('Write a number of tokens, like 500k or 2m.');
        return;
      }
      tokens = Math.round(parseFloat(m[1]) * (m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1));
    }
    setBusy(true);
    const run = await attempt(() =>
      api().startWorkflow({ name: workflow.id, ...(parsed !== undefined ? { args: parsed } : {}), device, ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(tokens ? { budget: { tokens } } : {}) }),
    );
    setBusy(false);
    if (run) {
      onClose();
      navigate(`/workflows/runs/${run.id}`);
    }
  };

  const body = (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-2 phone:text-[15px]">{workflow.description}</p>
      {workflow.whenToUse && <p className="text-[12px] text-fg-3 phone:text-[13px]">{workflow.whenToUse}</p>}
      <p className="text-[12px] text-fg-3 phone:text-[13px]">
        {SOURCE_WORD[workflow.source].charAt(0).toUpperCase() + SOURCE_WORD[workflow.source].slice(1)}
        {!workflow.portable && ', uses the Conclave layer, so it does not run in Claude Code'}
        {workflow.phases.length ? `. Phases: ${workflow.phases.map((p) => p.title).join(', ')}.` : ''}
      </p>
      <Field label="Args" help="JSON the script reads as args. Leave it empty when the workflow needs none." error={argsError}>
        <Textarea mono minRows={3} maxRows={10} value={args} onChange={(e) => (setArgs(e.target.value), setArgsError(undefined))} placeholder='{"question": "..."}' />
      </Field>
      <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
        <Field label="Device">
          <DevicePicker look="field" value={device} onChange={setDevice} onlineOnly />
        </Field>
        <Field label="Folder" help="The repository or folder it works in. Empty: the device's home.">
          <Input mono value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/conclave" />
        </Field>
      </div>
      <Field label="Budget" help="A hard ceiling on output tokens: agent calls after it stop. Empty: no ceiling." error={budgetError}>
        <Input value={budget} onChange={(e) => (setBudget(e.target.value), setBudgetError(undefined))} placeholder="2m" />
      </Field>
    </div>
  );
  const footer = (
    <>
      <Button variant="quiet" onClick={onClose} size={phone ? 'touch' : 'md'}>
        Cancel
      </Button>
      <Button variant="solid" onClick={start} busy={busy ? 'Starting' : false} size={phone ? 'touch' : 'md'} disabled={!workflow.runnable}>
        Start
      </Button>
    </>
  );
  if (phone)
    return (
      <Sheet open onClose={onClose} title={`Run ${workflow.name}`} footer={<div className="flex justify-end gap-2">{footer}</div>}>
        {body}
      </Sheet>
    );
  return (
    <Dialog open onClose={onClose} title={`Run ${workflow.name}`} width={560} footer={footer}>
      {body}
    </Dialog>
  );
}
