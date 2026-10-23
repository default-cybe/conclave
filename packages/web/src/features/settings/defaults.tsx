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
import { AgentPicker } from '@/components/pickers/Pickers';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { SelectMenu } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { useConnectionList } from '@/features/memory/store';
import { storeWords } from '@/features/memory/words';
import { errText, Group, save, SettingRow } from './parts';

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

export function DefaultsSection() {
  const mobile = useIsMobile();
  const config = useHub((s) => s.config);
  const agents = useHub((s) => s.agents);
  const conns = useConnectionList();
  const defaultModel = (config?.defaultModel as string | undefined) ?? 'anthropic/claude-sonnet-5-5';
  const smallModel = config?.smallModel as string | undefined;
  const defaultAgent = config?.defaultAgent as string | undefined;
  const defaultDevice = config?.defaultDevice as string | undefined;
  const reviewer = (config?.modes as { reviewer?: string } | undefined)?.reviewer;
  const hidden = (config?.models as { hidden?: string[] } | undefined)?.hidden ?? [];
  const limits = (config?.limits ?? {}) as {
    autoResume?: boolean;
    resumePrompt?: string;
    fallbacks?: Record<string, string[]>;
  };
  const fallback = limits.fallbacks?.[defaultModel]?.[0];
  const memory = (config?.memory ?? {}) as {
    enabled?: boolean;
    autoInject?: boolean;
    autoExtract?: boolean;
    injectLimit?: number;
    recallEpisodes?: boolean;
  };
  const kinds = KINDS.map((k) => ({
    ...k,
    def: agents.find((a) => a.name === k.agent),
  })).filter((k): k is { kind: string; agent: string; def: AgentDef } => !!k.def);
  const memOn = memory.enabled !== false;
  // the same line as under the Memory title: where notes go, by each connection's mode
  const store = storeWords(conns.list);
  const hasConns = !!conns.list?.length;

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
        <SettingRow label="Second opinions" help="The model that reviews an answer when you ask for one.">
          <ModelPicker look="field" label="Second opinion model" value={reviewer} onChange={(m) => void save({ modes: { reviewer: m } })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
      </Group>

      <Group title="Hidden models">
        <HiddenModels value={hidden} />
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

      <Group
        id="memory"
        title="Memory"
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
    </div>
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
