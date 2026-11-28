/**
 * Settings > Defaults (spec 11.10): models, agent and device for new sessions, what
 * happens at a limit, the model and device per kind of work (each kind is an
 * agent, the same table onboarding fills), and how memory is used.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { AgentDef } from '@conclave/core/extensions/types';
import { api } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { modelName } from '@/lib/models';
import { isOwnerNow } from '@/lib/people';
import { AgentPicker } from '@/components/pickers/Pickers';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { SelectMenu } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { useConnectionList } from '@/features/memory/store';
import { storeWords } from '@/features/memory/words';
import { CONFIG_NUMBERS } from '@conclave/core/config/schema';
import { configAt, errText, Group, NumberSetting, numberValue, patchAt, save, SettingRow } from './parts';

/** Kinds of work and the agent that carries each one (same as onboarding). */
const KINDS: Array<{ kind: string; agent: string }> = [
  { kind: 'Coding', agent: 'coder' },
  { kind: 'Homelab', agent: 'sysadmin' },
  { kind: 'Uni', agent: 'tutor' },
  { kind: 'Security research', agent: 'ctf' },
  { kind: 'Everyday', agent: 'assistant' },
];

async function saveAgent(def: AgentDef, patch: Partial<AgentDef>) {
  const prev = useHub.getState().agents;
  const next = { ...def, ...patch };
  useHub.setState({
    agents: prev.map((a) => (a.name === def.name ? next : a)),
  });
  try {
    // the hub merges a saved agent into the copy it has, so a field to clear ("no device of its own") goes as null
    const cleared = Object.fromEntries(Object.keys(patch).filter((k) => patch[k as keyof AgentDef] === undefined).map((k) => [k, null]));
    const saved = await api().saveAgent({ ...next, ...cleared } as AgentDef);
    useHub.setState((s) => ({
      agents: s.agents.map((a) => (a.name === def.name ? { ...next, ...saved } : a)),
    }));
  } catch (e) {
    useHub.setState({ agents: prev });
    toast({
      title: `Could not save ${def.name}. ${errText(e)}`,
      level: 'error',
    });
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

export const DEFAULT_IMAGE_MODEL = 'cliproxy/gpt-image-2.5';

/** The models GenerateImage may use: every listed image model, the default and the saved one always among them. */
export function imageModelOptions(groups: Array<{ models: Array<{ ref: string; id: string; kind?: string }> }>, value: string): Array<{ value: string; label: string; text: string }> {
  const refs = new Set([DEFAULT_IMAGE_MODEL, value]);
  for (const g of groups) for (const m of g.models) if (m.kind === 'image') refs.add(m.ref);
  return [...refs].map((r) => ({ value: r, label: modelName(r), text: r }));
}

function ImageModelSelect({ value }: { value: string }) {
  const groups = useHub((s) => s.models);
  return <SelectMenu look="field" label="Image model" value={value} onChange={(m) => void save({ imageModel: m })} options={imageModelOptions(groups, value)} width={300} />;
}

export function DefaultsSection() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config);
  const agents = useHub((s) => s.agents);
  const defaultModel = (config?.defaultModel as string | undefined) ?? 'anthropic/claude-sonnet-5-5';
  const smallModel = config?.smallModel as string | undefined;
  const imageModel = (config?.imageModel as string | undefined) ?? DEFAULT_IMAGE_MODEL;
  const defaultAgent = config?.defaultAgent as string | undefined;
  const defaultDevice = config?.defaultDevice as string | undefined;
  const reviewer = (config?.modes as { reviewer?: string } | undefined)?.reviewer;
  const models = (config?.models ?? {}) as { tiers?: Partial<Record<'fast' | 'smart' | 'deep', string | null>>; vision?: string | null; sameModel?: boolean; limitFallback?: { enabled?: boolean; models?: string[] } };
  const tiers = Object.fromEntries(Object.entries(models.tiers ?? {}).filter(([, v]) => !!v)) as Partial<Record<'fast' | 'smart' | 'deep', string>>;
  const vision = models.vision ?? undefined;
  const sameModel = models.sameModel === true;
  const limitChain = models.limitFallback?.enabled === true ? (models.limitFallback.models ?? []) : [];
  const ttl = ((config?.cache as { ttl?: 'auto' | '5m' | '1h' } | undefined)?.ttl ?? 'auto') as 'auto' | '5m' | '1h';
  const hidden = (config?.models as { hidden?: string[] } | undefined)?.hidden ?? [];
  const limits = (config?.limits ?? {}) as {
    autoResume?: boolean;
    resumePrompt?: string;
    fallbacks?: Record<string, string[]>;
    waitShortResets?: boolean;
  };
  const fallback = limits.fallbacks?.[defaultModel]?.[0];
  const kinds = KINDS.map((k) => ({
    ...k,
    def: agents.find((a) => a.name === k.agent),
  })).filter((k): k is { kind: string; agent: string; def: AgentDef } => !!k.def);

  return (
    <div className="space-y-9">
      <Group title="New sessions">
        <SettingRow label="Default model" help="New chats and sessions use it when you do not pick a model.">
          <ModelPicker look="field" label="Default model" value={defaultModel} onChange={(m) => void save({ defaultModel: m })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
        <SettingRow label="Default agent" help="The instructions and tools a new session starts with.">
          <AgentPicker look="field" value={defaultAgent} onChange={(a) => void save({ defaultAgent: a })} className="md:max-w-[300px]" />
        </SettingRow>
        <SettingRow label="Default device" help="Where a session runs when neither you nor its agent picks a device. While it is offline, sessions start on the hub.">
          <div className="w-full md:max-w-[300px]">
            <DeviceSelect look="field" label="Default device" value={defaultDevice === 'local' ? '' : defaultDevice} onChange={(d) => void save({ defaultDevice: d || 'local' })} />
          </div>
        </SettingRow>
        <SettingRow label="Small model" help="Titles, summaries and memory notes. Pick something fast and cheap.">
          <ModelPicker look="field" label="Small model" value={smallModel} onChange={(m) => void save({ smallModel: m })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
        {/* the hub's choice (PATCH /api/config is the owner's); a member's images still go through their own keys */}
        {isOwnerNow() && <SettingRow label="Image model" help="Makes pictures when you ask a chat or the assistant for one. Standard quality unless you ask for the best.">
          <div className="w-full md:max-w-[300px]">
            <ImageModelSelect value={imageModel} />
          </div>
        </SettingRow>}
        {isOwnerNow() && (
          <SettingRow label="Model that reads images" help={<>Turns pictures and PDFs into text for a model that cannot see them, such as GLM. Empty: the first of the small and default models that can see. <ClearLink set={!!vision} onClear={() => void save({ models: { vision: null } })} /></>}>
            <ModelPicker look="field" label="Model that reads images" value={vision} placeholder="Small or default model" onChange={(m) => void save({ models: { vision: m } })} harnesses={false} className="md:max-w-[300px]" />
          </SettingRow>
        )}
        <SettingRow label="Second opinions" help="The model that reviews an answer when you ask for one.">
          <ModelPicker look="field" label="Second opinion model" value={reviewer} onChange={(m) => void save({ modes: { reviewer: m } })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
      </Group>

      {/* models.tiers (core extensions/agent-model.ts): what a workflow step or subagent gets when it asks for fast, smart or deep */}
      <Group title="Model tiers" id="tiers" help="Workflow steps, subagents and agents ask for a tier instead of a model. Empty: the hub picks as shown.">
        {TIERS.map((t) => (
          <SettingRow key={t.id} label={t.label} help={<>{t.help} <ClearLink set={!!tiers[t.id]} onClear={() => void save({ models: { tiers: { [t.id]: null } } })} /></>}>
            <ModelPicker look="field" label={`${t.label} model`} value={tiers[t.id]} placeholder={t.id === 'fast' && smallModel ? modelName(smallModel) : t.empty} onChange={(m) => void save({ models: { tiers: { [t.id]: m } } })} harnesses={false} className="md:max-w-[300px]" />
          </SettingRow>
        ))}
      </Group>

      <Group title="Hidden models">
        <HiddenModels value={hidden} />
      </Group>

      {/* the model picker's old Settings drawer (design review #7): each switch is one conversation's, so it lives in that composer's Options */}
      <Group title="Per conversation" id="per-conversation">
        {/* models.sameModel: the hub starts each new chat and session pinned; the picker's switch still turns it off for one */}
        <SettingRow label="Same model for all work" help="New chats and sessions start with Delegate, Task and workflow agents on the conversation's model. Each one can still turn it off in the model picker.">
          <OnOff label="Same model for all work" checked={sameModel} onChange={(v) => void save({ models: { sameModel: v } })} size={mobile ? 'touch' : 'sm'} />
        </SettingRow>
        <SettingRow label="Security" help="Turns a conversation into a scoped hunt. In the composer's Options while Security mode is on, and always shown on the Options chip once on.">
          <span className="text-[13px] text-fg-3">In Options</span>
        </SettingRow>
        <SettingRow label="Cyber access" help="Daybreak programs for a ChatGPT plan model that takes them. In the composer's Options, and in /model.">
          <span className="text-[13px] text-fg-3">In Options</span>
        </SettingRow>
      </Group>

      <Group title="When a plan runs out">
        <SettingRow
          label="Switch models"
          help={
            <>
              Sessions on {modelName(defaultModel)} move to this model instead of waiting for the reset.
              {fallback && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link text-fg-3"
                    onClick={() =>
                      void save({
                        limits: { fallbacks: { [defaultModel]: [] } },
                      })
                    }
                  >
                    Wait instead
                  </button>
                </>
              )}
            </>
          }
        >
          <ModelPicker
            look="field"
            label="Fallback model"
            value={fallback}
            placeholder="Wait for the reset"
            onChange={(m) => void save({ limits: { fallbacks: { [defaultModel]: [m] } } })}
            className="md:max-w-[300px]"
          />
        </SettingRow>
        <SettingRow label="Resume after the reset" help="A session that hit a limit continues on its own when the window resets.">
          <OnOff label="Resume after the reset" checked={limits.autoResume !== false} onChange={(v) => void save({ limits: { autoResume: v } })} size={mobile ? 'touch' : 'sm'} />
        </SettingRow>
        {limits.autoResume !== false && <ResumePrompt value={limits.resumePrompt ?? ''} />}
        {limits.autoResume !== false && (
          <SettingRow label="Wait if the reset is under 5 minutes" help="A long chat waits for a reset that close instead of switching, since the new model would read the whole chat again with no cache.">
            <OnOff label="Wait if the reset is under 5 minutes" checked={limits.waitShortResets !== false} onChange={(v) => void save({ limits: { waitShortResets: v } })} size={mobile ? 'touch' : 'sm'} />
          </SettingRow>
        )}
        <NumberSetting path="context.switchBriefAt" label="Offer a handover over" unit="tokens" help="A model switch in a chat this long shows its price first and offers a short handover next to the full history." zero="never offers it" />
        <SettingRow
          label="Then"
          help={
            <>
              {limitChain.length ? <>When the model above is at its limit too, the Limit fallback list takes over: {limitChain.map(modelName).join(', ')}.</> : <>When no model above is set or it is at its limit too, the Limit fallback list takes over. It is empty.</>} A model above always wins over the list.
            </>
          }
        >
          <Link href="/settings/limit-fallback" className="link text-[13px]">
            {limitChain.length ? 'Edit the list' : 'Add models'}
          </Link>
        </SettingRow>
      </Group>

      {/* limits.session/routine/subagent (core session/limit-tree.ts): caps for each top-level run and all it starts */}
      <Group title="Spend and time limits" id="limits" help="Each chat, routine run or subagent stops when it, and everything it starts, reaches one of these. Empty or 0: no limit. A routine's own limits in its editor win.">
        <LimitsTable />
      </Group>

      <Group title="Prompt cache" id="cache">
        <SettingRow label="Keep the cache for" help="Claude models only. A 5 minute write costs 1.25x and a 1 hour write 2x; a read costs a tenth. Auto: 1 hour while you chat, 5 minutes for subagents, routines and loops.">
          <Segmented
            label="Keep the cache for"
            size={mobile ? 'touch' : 'sm'}
            value={ttl}
            onChange={(v) => void save({ cache: { ttl: v } })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: '5m', label: '5 min' },
              { value: '1h', label: '1 hour' },
            ]}
          />
        </SettingRow>
      </Group>

      {kinds.length > 0 && (
        <Group title="Per kind of work" count={kinds.length} help="Each kind of work has its own agent. Its model and device are what a session of that kind starts with." rows={false}>
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
              <div key={def.name} className={cn(mobile ? 'py-3' : 'grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-x-4 py-[7px]')}>
                {mobile ? (
                  <>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[15px] font-medium text-fg">{kind}</span>
                      <span className="text-[13px] text-fg-3">{def.name}</span>
                    </div>
                    <div className="mt-0.5 -ml-1.5 flex flex-wrap items-center gap-x-1 [&_button]:min-h-11">
                      <ModelPicker look="text" label={`${kind} model`} value={def.model} placeholder={modelName(defaultModel)} onChange={(m) => void saveAgent(def, { model: m })} />
                      <span className="text-fg-3">on</span>
                      <DeviceSelect label={`${kind} device`} value={def.device} inherit={defaultDevice} onChange={(d) => void saveAgent(def, { device: d || undefined })} />
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-[13.5px] font-medium text-fg">{kind}</span>
                    <span className="text-[13px] text-fg-2">{def.name}</span>
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
        </Group>
      )}

      <Group id="memory" title="Memory">
        <SettingRow label="How sessions use memory" help="Use memory, notes per turn, saving what sessions learn and the daily digest are on the Memory page now.">
          <Link href="/memory/settings" className="link text-[13px]">
            Memory settings
          </Link>
        </SettingRow>
      </Group>
    </div>
  );
}

/**
 * How sessions use memory (spec 11.7): the switches the Memory page's Settings
 * tab shows. They save to the hub's config (the owner's).
 */
export function MemorySettings() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config);
  const conns = useConnectionList();
  const memory = (config?.memory ?? {}) as {
    enabled?: boolean;
    autoInject?: boolean;
    autoExtract?: boolean;
    injectLimit?: number;
    recallEpisodes?: boolean;
  };
  const memOn = memory.enabled !== false;
  // the same line as under the Memory title: where notes go, by each connection's mode
  const store = storeWords(conns.list);
  const hasConns = !!conns.list?.length;
  return (
    <Group
      id="memory"
      title="How sessions use memory"
      help={
        <>
          {store.text || "Notes are kept in the hub's own store."}
          {store.problem && <span className="text-fault"> {store.problem}</span>} Profile notes always go to every session.{' '}
          <Link href="/memory/connections" className="link">
            {hasConns ? 'Connections' : 'Connect a store'}
          </Link>
        </>
      }
    >
      <SettingRow label="Use memory" help="Off means sessions neither read nor write notes.">
        <OnOff label="Use memory" checked={memOn} onChange={(v) => void save({ memory: { enabled: v } })} size={mobile ? 'touch' : 'sm'} />
      </SettingRow>
      <SettingRow label="Give relevant notes" help="Before each turn, the notes that match the message ride along.">
        <OnOff label="Give relevant notes" disabled={!memOn} checked={memory.autoInject !== false} onChange={(v) => void save({ memory: { autoInject: v } })} size={mobile ? 'touch' : 'sm'} />
      </SettingRow>
      {memory.autoInject !== false && (
        <SettingRow label="Notes per turn" help="More notes cost more tokens on every turn.">
          <Segmented
            label="Notes per turn"
            disabled={!memOn}
            size={mobile ? 'touch' : 'sm'}
            value={String(memory.injectLimit ?? 6)}
            onChange={(v) => void save({ memory: { injectLimit: Number(v) } })}
            options={['3', '6', '10', '15'].map((v) => ({
              value: v,
              label: v,
            }))}
          />
        </SettingRow>
      )}
      {memory.autoInject !== false && (
        <SettingRow label="Past session summaries" help="Off: past sessions are searched only when a chat asks about them, which keeps every turn smaller.">
          <OnOff label="Past session summaries" disabled={!memOn} checked={memory.recallEpisodes === true} onChange={(v) => void save({ memory: { recallEpisodes: v } })} size={mobile ? 'touch' : 'sm'} />
        </SettingRow>
      )}
      <SettingRow label="Save what sessions learn" help="When a session ends, the small model writes down facts worth keeping.">
        <OnOff label="Save what sessions learn" disabled={!memOn} checked={memory.autoExtract !== false} onChange={(v) => void save({ memory: { autoExtract: v } })} size={mobile ? 'touch' : 'sm'} />
      </SettingRow>
      <DigestRow memOn={memOn} mobile={mobile} />
    </Group>
  );
}

/** "Clear" after a help line, only when a value is saved: back to the hub's own pick. */
function ClearLink({ set, onClear }: { set: boolean; onClear: () => void }) {
  if (!set) return null;
  return (
    <button type="button" className="link text-fg-3" onClick={onClear}>
      Clear
    </button>
  );
}

const TIERS: Array<{ id: 'fast' | 'smart' | 'deep'; label: string; help: string; empty: string }> = [
  { id: 'fast', label: 'Fast', help: 'Quick lookups and small jobs. Empty: the small model.', empty: 'Small model' },
  { id: 'smart', label: 'Smart', help: "Most subagent work. Empty: the session's own model.", empty: "Session's model" },
  { id: 'deep', label: 'Deep', help: 'Hard reasoning and reviews. Empty: the strongest model you have set up.', empty: 'Picked by the hub' },
];

export const LIMIT_KINDS: Array<{ id: 'session' | 'routine' | 'subagent'; label: string }> = [
  { id: 'session', label: 'Each chat or session' },
  { id: 'routine', label: 'Each routine run' },
  { id: 'subagent', label: 'Each subagent' },
];

export const LIMIT_FIELDS: Array<{ id: 'tokens' | 'costUsd' | 'minutes'; label: string; unit: string }> = [
  { id: 'tokens', label: 'Output tokens', unit: 'tokens' },
  { id: 'costUsd', label: 'Cost', unit: 'USD' },
  { id: 'minutes', label: 'Working time', unit: 'min' },
];

/** The three kinds of run against tokens, cost and minutes; each cell saves when it loses focus. */
function LimitsTable() {
  const mobile = useIsMobile();
  return (
    <div className="rows">
      {LIMIT_KINDS.map((k) => (
        <div key={k.id} className="grid gap-x-4 gap-y-2 py-3.5 md:grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,120px))] md:items-end">
          <span className="text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px] md:pb-1.5">{k.label}</span>
          <div className={cn('grid gap-2', mobile ? 'grid-cols-3' : 'contents')}>
            {LIMIT_FIELDS.map((f) => (
              <LimitCell key={f.id} path={`limits.${k.id}.${f.id}`} label={`${k.label}, ${f.label}`} short={f.label} unit={f.unit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LimitCell({ path, label, short, unit }: { path: string; label: string; short: string; unit: string }) {
  const config = useHub((s) => s.config);
  const raw = configAt(config, path);
  const saved = typeof raw === 'number' ? raw : 0;
  return <LimitInput key={`${path}:${saved}`} path={path} label={label} short={short} unit={unit} saved={saved} />;
}

function LimitInput({ path, label, short, unit, saved }: { path: string; label: string; short: string; unit: string; saved: number }) {
  const r = CONFIG_NUMBERS[path];
  const [text, setText] = useState(saved ? String(saved) : '');
  const value = text.trim() === '' ? 0 : numberValue(text, r);
  const commit = () => {
    if (value === undefined || value === saved) return;
    void save(patchAt(path, value)).then((ok) => ok && toast({ title: value ? `${label}: ${value.toLocaleString('en-US')} ${unit}.` : `${label}: no limit.` }));
  };
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-fg-3 phone:text-[13px]">
        {short}, {unit}
      </span>
      <Input mono inputMode={r.fraction ? 'decimal' : 'numeric'} size="sm" value={text} placeholder="No limit" invalid={value === undefined} aria-label={label} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

/**
 * The daily digest (core/memory/digest.ts): one switch and its time. On
 * installs the routine; off disables it and keeps the notes already written.
 */
function DigestRow({ memOn, mobile }: { memOn: boolean; mobile: boolean }) {
  const d = useLoad(() => api().memoryDigest(), []);
  const [time, setTime] = useState<string>();
  const [busy, setBusy] = useState(false);
  const s = d.data;
  const shown = time ?? s?.time ?? '02:30';
  const set = async (input: { enabled?: boolean; time?: string }) => {
    setBusy(true);
    try {
      await api().setMemoryDigest(input);
      d.reload();
      if (input.enabled !== undefined) toast({ title: input.enabled ? `Daily digest on. It runs at ${input.time ?? shown}.` : 'Daily digest off. Notes already written stay.' });
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setTime(undefined);
    setBusy(false);
  };
  return (
    <SettingRow
      label="Daily digest"
      top
      help={
        <>
          Each night at {shown}, imports the day's Claude Code, Codex and OpenCode chats from your devices, catches up on memory, and writes one daily note to Basic Memory.
          {s?.enabled && !s.writes && ' No connection takes the note yet, so it only imports and learns.'}
          {s?.lastNote && ` Last note: ${s.lastNote.date}.`}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <div className="w-[118px]">
          <Input
            type="time"
            size="sm"
            value={shown}
            disabled={!memOn || busy || !s}
            onChange={(e) => setTime(e.target.value)}
            onBlur={() => {
              if (time && time !== s?.time) void set({ time });
            }}
            aria-label="Daily digest time"
            className={cn(mobile && 'h-11')}
          />
        </div>
        <OnOff label="Daily digest" checked={!!s?.enabled} disabled={!memOn || busy || !s} onChange={(v) => void set({ enabled: v, ...(time ? { time } : {}) })} size={mobile ? 'touch' : 'sm'} />
      </div>
    </SettingRow>
  );
}

/** One model ref or glob per line, blanks and repeats dropped. */
export function hiddenList(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** models.hidden (core config/hidden.ts): models no picker shows and nothing runs on, across the hub. */
export function HiddenModels({ value }: { value: string[] }) {
  const saved = value.join('\n');
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const dirty = hiddenList(text).join('\n') !== saved;
  return (
    <SettingRow label="Hidden models" help="One model or pattern per line, * matches anything (cliproxy/glm-*). Pickers leave them out and no tier, fallback, agent or workflow uses them." stack>
      <Textarea value={text} minRows={2} maxRows={8} placeholder="cliproxy/glm-*" onChange={(e) => setText(e.target.value)} aria-label="Hidden models" />
      {dirty && (
        <div className="mt-2 flex gap-2 anim-fade">
          <Button
            size="sm"
            variant="solid"
            busy={busy ? 'Saving' : false}
            onClick={async () => {
              setBusy(true);
              if (await save({ models: { hidden: hiddenList(text) } })) toast({ title: 'Hidden models saved.' });
              setBusy(false);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setText(saved)}>
            Undo changes
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

function ResumePrompt({ value }: { value: string }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const dirty = text.trim() !== value.trim();
  return (
    <SettingRow label="Resume message" help="What the session is told when it continues." stack>
      <Textarea value={text} minRows={2} maxRows={5} onChange={(e) => setText(e.target.value)} aria-label="Resume message" />
      {dirty && (
        <div className="mt-2 flex gap-2 anim-fade">
          <Button
            size="sm"
            variant="solid"
            disabled={!text.trim()}
            busy={busy ? 'Saving' : false}
            onClick={async () => {
              setBusy(true);
              if (await save({ limits: { resumePrompt: text.trim() } })) toast({ title: 'Resume message saved.' });
              setBusy(false);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setText(value)}>
            Undo changes
          </Button>
        </div>
      )}
    </SettingRow>
  );
}
