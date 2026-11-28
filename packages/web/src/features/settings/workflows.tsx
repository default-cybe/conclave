/**
 * Settings > Advanced > Workflows and subagents: the hub's workflow caps
 * (config workflows.*, core config/schema.ts WORKFLOW_LIMITS). The hub
 * refuses a value out of range, so this checks only to keep Save off.
 */
import { useState } from 'react';
import { WORKFLOW_LIMITS } from '@conclave/core/config/schema';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Group, NumberSetting, save, SettingRow } from './parts';

type LimitKey = keyof typeof WORKFLOW_LIMITS;

const ROWS: Array<{ key: LimitKey; label: string; help: string }> = [
  { key: 'concurrency', label: 'At once in one run', help: 'Agents one workflow run keeps going at the same time. Runs that start after a change use it.' },
  { key: 'perProvider', label: 'At once per provider, all runs', help: 'Workflow agents on one provider at the same time, across every run.' },
  { key: 'hubMax', label: 'At once on this hub', help: 'Workflow agents at the same time on the whole hub. Applies at once.' },
  { key: 'maxAgents', label: 'Most agents one run can start', help: 'When a run reaches it, its next agent call fails.' },
];

/** Ultra's threshold (workflows.autoApproveTokens): its own group, it is not a cap on agents at once. */
const ULTRA_ROW: { key: LimitKey; label: string; help: string } = { key: 'autoApproveTokens', label: 'Start Ultra runs without asking under', help: 'In Ultra, a run estimated under this many tokens starts at once; a bigger one asks first.' };

/** The number typed, when it is a whole number from 1 to the key's max; undefined otherwise. */
export function limitValue(key: LimitKey, raw: string): number | undefined {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= WORKFLOW_LIMITS[key].max ? n : undefined;
}

/** Save one cap; null resets it to the default. */
export function saveLimit(key: LimitKey, value: number | null): Promise<boolean> {
  return save({ workflows: { [key]: value } });
}

export function WorkflowsSection() {
  const wf = (useHub((s) => s.config?.workflows) ?? {}) as Partial<Record<LimitKey, number | null>>;
  return (
    <div className="space-y-9">
      <WorkflowsBody values={wf} />
      <Group title="Ultra">
        <LimitRow key={`${ULTRA_ROW.key}:${wf[ULTRA_ROW.key] ?? 'default'}`} row={ULTRA_ROW} saved={wf[ULTRA_ROW.key] ?? undefined} />
      </Group>
      {/* limits.maxSteps and limits.subagentMaxSteps (core session/runner.ts): "Stopped after N steps." */}
      <Group title="Model calls per turn" help="A turn that reaches its number wraps up with a final reply and no more tools. An agent's own maxSteps wins over both.">
        <NumberSetting path="limits.maxSteps" label="In a chat or session" unit="calls" help="Model calls in one of your turns." />
        <NumberSetting path="limits.subagentMaxSteps" label="In a subagent" unit="calls" help="Model calls in one subagent's turn." />
      </Group>
      {/* server.heavyCommands and server.uploadMaxMb: here, not in This computer, which only the desktop app shows */}
      <Group title="This hub">
        <NumberSetting path="server.heavyCommands" label="Test runs and builds at once" help="Whole test suites and builds agents run on the hub itself at the same time; more wait in line. Paired computers are never held." zero="turns the line off" />
        <NumberSetting path="server.uploadMaxMb" label="Largest upload" unit="MB" help="One file you attach. Over about 127 MB takes effect after the hub restarts." />
      </Group>
    </div>
  );
}

export function WorkflowsBody({ values }: { values: Partial<Record<LimitKey, number | null>> }) {
  return (
    <Group
      title="Agents at once"
      help="Only workflow agents count here. A Task subagent started from a chat is not held by these caps. Extra calls wait in a queue and still finish. A higher number can hit a plan's rate limits sooner."
    >
      {ROWS.map((r) => (
        // keyed on the saved value: a config that loads late or changes elsewhere replaces what the field shows
        <LimitRow key={`${r.key}:${values[r.key] ?? 'default'}`} row={r} saved={values[r.key] ?? undefined} />
      ))}
    </Group>
  );
}

function LimitRow({ row, saved }: { row: (typeof ROWS)[number]; saved?: number }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const { default: def, max } = WORKFLOW_LIMITS[row.key];
  const current = saved ?? def;
  const [text, setText] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const value = limitValue(row.key, text);
  const dirty = text.trim() !== String(current);
  const run = async (v: number | null) => {
    setBusy(true);
    const ok = await saveLimit(row.key, v);
    setBusy(false);
    if (ok) setText(String(v ?? def));
  };
  return (
    <SettingRow label={row.label} help={`${row.help} 1 to ${max.toLocaleString('en-US')}.`} top>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <span className="text-[12px] text-fg-3 phone:text-[13px]">Default {def.toLocaleString('en-US')}</span>
        {saved !== undefined && !dirty && (
          <Button variant="quiet" size={size} disabled={busy} onClick={() => void run(null)}>
            Reset
          </Button>
        )}
        <Input mono inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} aria-label={row.label} className="w-[88px]!" size="sm" invalid={value === undefined} />
        {dirty && (
          <Button variant="solid" size={size} disabled={value === undefined} busy={busy ? 'Saving' : false} onClick={() => value !== undefined && void run(value)}>
            Save
          </Button>
        )}
      </div>
    </SettingRow>
  );
}
