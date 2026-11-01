/**
 * Step 4, Defaults (spec 11.11): the default model, the small model for
 * titles and summaries, the fallback when the default is limited, the
 * default agent and device, then the model and device per kind of work
 * (each kind is an agent). Changes save at once.
 */
import type { AgentDef } from '@conclave/core/extensions/types';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { cn } from '@/lib/text';
import { toast, updateConfig, useHub } from '@/store/store';
import { AgentPicker } from '@/components/pickers/Pickers';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { SelectMenu } from '@/components/ui/Select';
import { SectionHeading } from '@/components/ui/Section';
import { StepFrame } from '../StepLayout';
import { errText, SettingRow } from '../parts';

/** Kinds of work and the agent that carries each one. */
const KINDS: Array<{ kind: string; agent: string }> = [
  { kind: 'Coding', agent: 'coder' },
  { kind: 'Homelab', agent: 'sysadmin' },
  { kind: 'Uni', agent: 'tutor' },
  { kind: 'Security research', agent: 'ctf' },
  { kind: 'Everyday', agent: 'assistant' },
];

async function save(patch: Record<string, unknown>) {
  try {
    await updateConfig(patch);
  } catch (e) {
    toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
  }
}

async function saveAgent(def: AgentDef, patch: Partial<AgentDef>) {
  const prev = useHub.getState().agents;
  const next = { ...def, ...patch };
  useHub.setState({ agents: prev.map((a) => (a.name === def.name ? next : a)) });
  try {
    // the hub merges a saved agent into the copy it has, so a field to clear ("no device of its own") goes as null
    const cleared = Object.fromEntries(Object.keys(patch).filter((k) => patch[k as keyof AgentDef] === undefined).map((k) => [k, null]));
    const saved = await api().saveAgent({ ...next, ...cleared } as AgentDef);
    useHub.setState((s) => ({ agents: s.agents.map((a) => (a.name === def.name ? { ...next, ...saved } : a)) }));
  } catch (e) {
    useHub.setState({ agents: prev });
    toast({ title: `Could not save ${def.name}. ${errText(e)}`, level: 'error' });
  }
}

/**
 * A device picker. "" is "no device of its own": with `inherit` (the hub's
 * default device) that option shows the default's name, and "The hub" becomes
 * its own choice; without it "" is the hub.
 */
function DeviceSelect({ value, onChange, label, look = 'text', inherit }: { value: string | undefined; onChange: (id: string) => void; label: string; look?: 'text' | 'field'; inherit?: string }) {
  const devices = useHub((s) => s.devices);
  const list = Object.values(devices).filter((d) => !['ios', 'android'].includes(d.info?.platform ?? ''));
  const fallback = inherit && inherit !== 'local' ? (devices[inherit]?.name ?? inherit) : undefined;
  const state = (online: boolean | undefined) => <span className={online ? 'text-ok' : 'text-fg-3'}>{online ? 'online' : 'offline'}</span>;
  // with a default, "no device of its own" reads like the model column: the inherited name as a placeholder
  const INHERIT = '__default';
  const options = [
    ...(fallback
      ? [
          { value: INHERIT, label: `Default, ${fallback}`, text: `Default, ${fallback}` },
          { value: 'local', label: 'The hub', text: 'The hub' },
        ]
      : [{ value: '', label: 'The hub', text: 'The hub' }]),
    ...list.filter((d) => d.id !== 'local').map((d) => ({ value: d.id, label: d.name, text: d.name, hint: state(d.online) })),
  ];
  const v = !fallback && value === 'local' ? '' : (value ?? '');
  if (v && !options.some((o) => o.value === v)) options.push({ value: v, label: v, text: v, hint: <span className="text-fg-3">not paired</span> });
  return <SelectMenu look={look} label={label} value={v} placeholder={fallback} onChange={(id) => onChange(id === INHERIT ? '' : id)} options={options} width={240} />;
}

export function DefaultsStep() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config);
  const agents = useHub((s) => s.agents);
  const devices = useHub((s) => s.devices);
  const defaultModel = (config?.defaultModel as string | undefined) ?? 'anthropic/claude-sonnet-5-5';
  const smallModel = config?.smallModel as string | undefined;
  const defaultAgent = config?.defaultAgent as string | undefined;
  const defaultDevice = config?.defaultDevice as string | undefined;
  const fallbacks = ((config?.limits as { fallbacks?: Record<string, string[]> } | undefined)?.fallbacks ?? {}) as Record<string, string[]>;
  const fallback = fallbacks[defaultModel]?.[0];

  const kinds = KINDS.map((k) => ({ ...k, def: agents.find((a) => a.name === k.agent) })).filter((k): k is { kind: string; agent: string; def: AgentDef } => !!k.def);
  const coding = kinds.find((k) => k.agent === 'coder');
  const where = (id: string | undefined) => (id ? (devices[id]?.name ?? id) : 'the hub');
  const fallbackDevice = defaultDevice && defaultDevice !== 'local' ? defaultDevice : undefined;
  const summary = coding ? `Coding uses ${modelName(coding.def.model ?? defaultModel)} on ${where(coding.def.device ?? fallbackDevice)}.` : `New sessions use ${modelName(defaultModel)} on ${where(fallbackDevice)}.`;

  return (
    <StepFrame summary={summary}>
      <div className="rows border-y border-rule">
        <SettingRow label="Default model" help="New chats and sessions use it when you do not pick a model.">
          <ModelPicker look="field" label="Default model" value={defaultModel} onChange={(m) => void save({ defaultModel: m })} harnesses={false} />
        </SettingRow>
        <SettingRow label="Small model" help="Titles, summaries and memory notes. Pick something fast and cheap.">
          <ModelPicker look="field" label="Small model" value={smallModel} onChange={(m) => void save({ smallModel: m })} harnesses={false} />
        </SettingRow>
        <SettingRow
          label="When the default is limited"
          help={
            <>
              Sessions on {modelName(defaultModel)} switch to this model instead of waiting for the reset.
              {fallback && (
                <>
                  {' '}
                  <button type="button" className="text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg" onClick={() => void save({ limits: { fallbacks: { [defaultModel]: [] } } })}>
                    Wait instead
                  </button>
                </>
              )}
            </>
          }
        >
          {/* "Wait for the reset" is a real choice, not an empty field: show it in readable ink instead of placeholder grey */}
          <div className="[&_[data-placeholder]]:text-fg-2">
            <ModelPicker look="field" label="Fallback model" value={fallback} placeholder="Wait for the reset" onChange={(m) => void save({ limits: { fallbacks: { [defaultModel]: [m] } } })} />
          </div>
        </SettingRow>
        <SettingRow label="Default agent" help="The instructions and tools a new session starts with.">
          <AgentPicker look="field" value={defaultAgent} onChange={(a) => void save({ defaultAgent: a })} />
        </SettingRow>
        <SettingRow label="Default device" help="Where a session runs when you do not pick one. While it is offline, sessions start on the hub.">
          <DeviceSelect look="field" label="Default device" value={defaultDevice === 'local' ? '' : defaultDevice} onChange={(d) => void save({ defaultDevice: d || 'local' })} />
        </SettingRow>
      </div>

      {kinds.length > 0 && (
        <section className="mt-11">
          <SectionHeading count={kinds.length}>Per kind of work</SectionHeading>
          <p className="m-0 mt-3 mb-1 max-w-[60ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">Each kind of work has its own agent. Its model and device are what a session of that kind starts with.</p>
          {!mobile && (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-x-4 border-b border-rule pt-3 pb-[7px] text-[12px] text-fg-3">
              <span>Kind</span>
              <span>Agent</span>
              <span>Model</span>
              <span>Device</span>
            </div>
          )}
          <div className="rows">
            {kinds.map(({ kind, def }) => (
              <div
                key={def.name}
                className={cn(mobile ? 'py-3' : 'grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-x-4 py-[7px]')}
              >
                {mobile ? (
                  <>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[15px] font-medium text-fg">{kind}</span>
                      <span className="text-[13px] text-fg-3">{def.name}</span>
                    </div>
                    <div className="mt-1.5 -ml-1.5 flex flex-wrap items-center gap-x-1 [&_button]:min-h-11">
                      <ModelPicker look="text" label={`${kind} model`} value={def.model} placeholder={modelName(defaultModel)} onChange={(m) => void saveAgent(def, { model: m })} />
                      <span className="text-fg-3">on</span>
                      <DeviceSelect label={`${kind} device`} value={def.device} inherit={defaultDevice} onChange={(d) => void saveAgent(def, { device: d || undefined })} />
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-[13.5px] font-medium text-fg">{kind}</span>
                    <span className="truncate text-[13px] text-fg-2">{def.name}</span>
                    <span className="-ml-1.5 min-w-0">
                      <ModelPicker look="text" label={`${kind} model`} value={def.model} placeholder={modelName(defaultModel)} onChange={(m) => void saveAgent(def, { model: m })} />
                    </span>
                    <span className="-ml-1.5 min-w-0">
                      <DeviceSelect label={`${kind} device`} value={def.device} inherit={defaultDevice} onChange={(d) => void saveAgent(def, { device: d || undefined })} />
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </StepFrame>
  );
}
