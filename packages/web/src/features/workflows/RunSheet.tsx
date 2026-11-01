/**
 * Start a workflow from the library (spec 3.18): what it is for, its args, where it runs, a budget, and Start.
 * A workflow that declares its args (meta.args) gets a typed form instead of the JSON box; any workflow's
 * args can be saved as a named preset and picked again. A dialog on desktop, a sheet on phones.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import type { WorkflowPreset, WorkflowSummary } from '@conclave/core/client';
import { Dialog, Sheet } from '@/components/ui/Overlay';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { DevicePicker } from '@/components/pickers/Pickers';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { ArgsForm, argsFromValues, valuesFromArgs, type ArgValues } from './args-form';
import { SOURCE_WORD } from './words';

export function RunSheet({ workflow, onClose }: { workflow: WorkflowSummary | undefined; onClose: () => void }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const schema = workflow?.argsSchema;
  const [values, setValues] = useState<ArgValues>({});
  // schema mode: JSON for the args the schema does not name (a preset's extras, or ones typed by hand)
  const [extras, setExtras] = useState('');
  const [args, setArgs] = useState('');
  const [device, setDevice] = useState('local');
  const [cwd, setCwd] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [argsError, setArgsError] = useState<string>();
  const [budgetError, setBudgetError] = useState<string>();
  const [presets, setPresets] = useState<WorkflowPreset[]>();
  const [presetName, setPresetName] = useState('');

  const reloadPresets = (id: string) => {
    void attempt(() => api().workflowPresets(id)).then((r) => r && setPresets(r));
  };
  useEffect(() => {
    setValues({});
    setExtras('');
    setArgs('');
    setArgsError(undefined);
    setBudget('');
    setBudgetError(undefined);
    setPresetName('');
    if (workflow?.id) {
      setPresets(undefined);
      reloadPresets(workflow.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow?.id]);

  if (!workflow) return null;

  // { args } to start or save with, or { error } when the box or a field is bad; no args is not an error
  const parsedArgs = (): { args?: unknown; error?: string } => {
    if (schema) {
      let more: unknown = {};
      if (extras.trim()) {
        try {
          more = JSON.parse(extras);
        } catch {
          more = undefined;
        }
      }
      if (!more || typeof more !== 'object' || Array.isArray(more)) return { error: 'More args must be a JSON object, for example {"votes": 3}.' };
      const { args: built, error } = argsFromValues(schema, values, more as Record<string, unknown>);
      if (error) return { error };
      return { args: built };
    }
    if (args.trim()) {
      try {
        return { args: JSON.parse(args) };
      } catch {
        return { error: 'Args must be JSON, for example {"question": "Caddy or Traefik?"}. Strings need double quotes.' };
      }
    }
    return {};
  };

  const applyPreset = (p: WorkflowPreset) => {
    setArgsError(undefined);
    if (schema) {
      const { values: v, extras: e } = valuesFromArgs(schema, p.args);
      setValues(v);
      setExtras(Object.keys(e).length ? JSON.stringify(e, null, 2) : '');
    } else setArgs(p.args === null || p.args === undefined ? '' : JSON.stringify(p.args, null, 2));
  };

  const savePreset = async () => {
    if (!presetName.trim()) return;
    const { args: built, error } = parsedArgs();
    if (error) {
      setArgsError(error);
      return;
    }
    const saved = await attempt(() => api().saveWorkflowPreset(workflow.id, presetName, built ?? null));
    if (saved) {
      setPresetName('');
      reloadPresets(workflow.id);
    }
  };

  const start = async () => {
    setArgsError(undefined);
    const { args: parsed, error } = parsedArgs();
    if (error) {
      setArgsError(error);
      return;
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
      {presets && presets.length > 0 && (
        <Field label="Presets" help="Fill the form from a saved set of args.">
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <span key={p.id} className="inline-flex items-center overflow-hidden rounded-[var(--r-1)] border border-edge">
                <button type="button" className="px-2 py-1 text-[12px] text-fg-2 hov:bg-sunk hov:text-fg" onClick={() => applyPreset(p)}>
                  {p.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete preset ${p.name}`}
                  className="border-l border-edge px-1.5 py-1 text-[12px] text-fg-3 hov:bg-sunk hov:text-fault"
                  onClick={() => {
                    void attempt(() => api().deleteWorkflowPreset(workflow.id, p.id)).then((ok) => ok && reloadPresets(workflow.id));
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </Field>
      )}
      {schema ? (
        <>
          <Field label="Args" help="The workflow's declared args. Empty fields are left out." error={argsError}>
            <ArgsForm schema={schema} values={values} set={(name, v) => (setValues((s) => ({ ...s, [name]: v })), setArgsError(undefined))} />
          </Field>
          <Field label="More args" help="JSON for args the form does not list. The fields above win on the same name." optional>
            <Textarea mono minRows={2} maxRows={8} value={extras} onChange={(e) => (setExtras(e.target.value), setArgsError(undefined))} placeholder='{"votes": 3}' />
          </Field>
        </>
      ) : (
        <Field label="Args" help="JSON the script reads as args. Leave it empty when the workflow needs none." error={argsError}>
          <Textarea mono minRows={3} maxRows={10} value={args} onChange={(e) => (setArgs(e.target.value), setArgsError(undefined))} placeholder='{"question": "..."}' />
        </Field>
      )}
      <div className="flex items-end gap-2">
        <Field label="Save as preset" help="Give these args a name to rerun them." className="flex-1">
          <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="weekly triage" />
        </Field>
        <Button variant="quiet" onClick={savePreset} size={phone ? 'touch' : 'md'} disabled={!presetName.trim()}>
          Save
        </Button>
      </div>
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
