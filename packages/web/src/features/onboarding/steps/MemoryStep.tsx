/**
 * Step 6, Memory (spec 11.11): memory on or off, learning from sessions,
 * where notes live (the hub, or a Basic Memory vault over MCP, tested and
 * saved through the memory connections API), and a short profile every
 * model gets. A vault on the hub is saved as the hub's basic-memory MCP
 * server (memory/connections/service.ts), so agents and routines use the
 * same notes.
 */
import { useEffect, useState } from 'react';
import { ApiError, type MemoryConnectionInfo, type MemoryConnectionInputDto, type MemoryConnectionPreset, type MemoryConnectionTestResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { reloadConfig, toast, updateConfig, upsertMemory, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Field, Input, OnOff, Radio, Textarea } from '@/components/ui/Field';
import { Quote, SectionHeading } from '@/components/ui/Section';
import { reloadConnections } from '@/features/memory/store';
import { StepFrame } from '../StepLayout';
import { errText, OutcomeWords, SettingRow, useCtlSize, type Outcome } from '../parts';

const NO_API = 'This hub is older and cannot connect memory stores. Update the hub, or keep notes in the hub for now.';

function plainError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return NO_API;
  const m = errText(e).trim();
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

function ms(n: number): string {
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

/** "connect 2.4 s, list tools 14 ms, search failed" */
function stepWords(r: MemoryConnectionTestResult): string {
  return r.steps.map((s) => `${s.step} ${s.ok ? (s.ms !== undefined ? ms(s.ms) : 'ok') : 'failed'}`).join(', ');
}

export function MemoryStep() {
  const config = useHub((s) => s.config);
  const hub = useHub((s) => s.hub);
  const memories = useHub((s) => s.memories);
  const ctl = useCtlSize();
  const mem = (config?.memory ?? {}) as { enabled?: boolean; autoExtract?: boolean };
  const enabled = mem.enabled !== false;
  const learning = mem.autoExtract !== false;
  const [loaded, setLoaded] = useState(false);
  const [vault, setVault] = useState<MemoryConnectionInfo>();
  const [presets, setPresets] = useState<MemoryConnectionPreset[]>();
  const [where, setWhere] = useState<'hub' | 'vault'>('hub');
  const [url, setUrl] = useState('');
  const [project, setProject] = useState('main');
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });
  const [hint, setHint] = useState<string>();
  const [steps, setSteps] = useState<string>();
  const [profile, setProfile] = useState('');
  const profiles = Object.values(memories).filter((m) => m.kind === 'profile');

  // the Basic Memory connection a past run of setup made, if any
  useEffect(() => {
    let alive = true;
    Promise.all([api().memoryConnections(), api().memoryConnectionPresets()])
      .then(([list, p]) => {
        if (!alive) return;
        setPresets(p);
        const bm = list.find((c) => c.type === 'basic-memory');
        if (bm) {
          setVault(bm);
          setWhere('vault');
          setUrl(typeof bm.options.url === 'string' ? bm.options.url : '');
          setProject(typeof bm.options.project === 'string' && bm.options.project ? bm.options.project : 'main');
        }
      })
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    try {
      await updateConfig(patch);
      return true;
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
      return false;
    }
  };

  /** The connection from a preset: on the hub with uvx, or a Basic Memory server over HTTP. */
  const input = (): MemoryConnectionInputDto => {
    const key = url.trim() ? 'basic-memory-http' : 'basic-memory-local';
    const t = presets?.find((p) => p.key === key)?.template;
    const options: Record<string, unknown> = { ...(t?.options ?? {}), project: project.trim() || 'main' };
    if (url.trim()) options.url = url.trim();
    else delete options.url;
    return { ...(vault ? { id: vault.id } : {}), type: 'basic-memory', name: t?.name ?? 'Basic Memory', mode: 'mirror', options };
  };

  const changed = () => !vault || (typeof vault.options.url === 'string' ? vault.options.url : '') !== url.trim() || (vault.options.project ?? 'main') !== (project.trim() || 'main') || !vault.enabled;

  /** Add the connection, or change the one setup made before. */
  const saveVault = async (): Promise<boolean> => {
    try {
      const body = input();
      const c = vault ? await api().updateMemoryConnection(vault.id, { name: body.name, mode: body.mode, enabled: true, options: body.options }) : await api().addMemoryConnection(body);
      setVault(c);
      await reloadConfig();
      void reloadConnections();
      return true;
    } catch (e) {
      setOutcome({ state: 'fail', word: 'Not saved', detail: plainError(e) });
      return false;
    }
  };

  /** Picking the hub only marks the choice; Continue removes the vault connection, so a misclick costs nothing. */
  const useHubStore = () => {
    setWhere('hub');
    setOutcome({ state: 'idle' });
    setHint(undefined);
    setSteps(undefined);
  };

  /** Remove the vault connection and keep the notes it imported. */
  const dropVault = async (): Promise<boolean> => {
    if (!vault) return true;
    try {
      await api().removeMemoryConnection(vault.id, true);
      setVault(undefined);
      await reloadConfig();
      void reloadConnections();
      return true;
    } catch (e) {
      toast({ title: `Could not remove the ${vault.name} connection. ${plainError(e)} Try again, or pick the vault to keep it.`, level: 'error' });
      return false;
    }
  };

  const test = async () => {
    setOutcome({ state: 'working', word: 'Testing', detail: url.trim() ? url.trim().replace(/^https?:\/\//, '') : 'uvx basic-memory on the hub', startedAt: Date.now() });
    setHint(undefined);
    setSteps(undefined);
    try {
      const r = await api().testMemoryConnectionConfig(input());
      if (r.ok) {
        if (!(await saveVault())) return;
        setOutcome({ state: 'ok', word: 'Works', detail: `${r.tools?.length ? `${r.tools.length} tools, ` : ''}${ms(r.latencyMs)}` });
      } else {
        setOutcome({ state: 'fail', word: 'Failed', detail: r.error });
        setHint(r.hint);
        setSteps(r.steps.length > 1 ? stepWords(r) : undefined);
      }
    } catch (e) {
      setOutcome({ state: 'fail', word: 'Failed', detail: plainError(e) });
    }
  };

  const onContinue = async () => {
    if (enabled && where === 'vault' && changed() && !(await saveVault())) return false;
    if (enabled && where === 'hub' && !(await dropVault())) return false;
    const text = profile.trim();
    if (text) {
      try {
        const m = await api().saveMemory({ content: text, kind: 'profile', scope: 'global' });
        upsertMemory(m);
        setProfile('');
      } catch (e) {
        toast({ title: `Could not save the profile. ${errText(e)}`, level: 'error' });
        return false;
      }
    }
    return true;
  };

  const summary = !enabled ? 'Memory is off.' : `${where === 'vault' ? 'Basic Memory vault' : 'Notes in the hub'}, learning ${learning ? 'on' : 'off'}.`;

  return (
    <StepFrame summary={summary} onContinue={onContinue}>
      <div className="rows border-y border-rule">
        <SettingRow label="Memory" help="Each session gets the notes that matter for its request.">
          <OnOff label="Memory" size={ctl === 'touch' ? 'touch' : 'sm'} checked={enabled} onChange={(v) => void save({ memory: { enabled: v } })} />
        </SettingRow>
        <SettingRow label="Learn from sessions" help="When a session ends, save the facts and procedures it found.">
          <OnOff label="Learn from sessions" size={ctl === 'touch' ? 'touch' : 'sm'} checked={enabled && learning} disabled={!enabled} onChange={(v) => void save({ memory: { autoExtract: v } })} />
        </SettingRow>
      </div>

      {enabled && (
        <>
          <section className="mt-10">
            <SectionHeading>Where notes live</SectionHeading>
            <div className="pt-3" aria-busy={!loaded || undefined}>
              <Radio
                name="memory-store"
                checked={where === 'hub'}
                onChange={useHubStore}
                label="Keep notes in the hub"
                description={`In the database on ${hub?.name ?? 'the hub'}. Nothing else to run.`}
                className="phone:py-2"
              >
                {vault && where === 'hub' && <p className="max-w-[60ch] text-[12px] text-fg-3 phone:text-[13px]">Continue removes the {vault.name} connection. Notes it already imported stay in the hub.</p>}
              </Radio>
              <Radio
                name="memory-store"
                className="mt-2 phone:py-2"
                checked={where === 'vault'}
                onChange={() => setWhere('vault')}
                label="Use a Basic Memory vault"
                description="Markdown notes you can open in any editor, served by the Basic Memory MCP server. Conclave keeps its own copy too."
              >
                <div className="grid max-w-[560px] gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
                  <Field label="Server URL" optional help={<>Leave empty to run it on the hub with <span className="mono">uvx</span>. Agents and routines get its tools too.</>}>
                    <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://basic-memory:8000/mcp" spellCheck={false} autoCapitalize="off" />
                  </Field>
                  <Field label="Project">
                    <Input mono value={project} onChange={(e) => setProject(e.target.value)} spellCheck={false} autoCapitalize="off" />
                  </Field>
                </div>
                <div className="mt-4 flex min-h-[30px] flex-wrap items-center gap-x-4 gap-y-2">
                  <Button variant="outline" size={ctl} onClick={() => void test()} busy={outcome.state === 'working' ? 'Testing' : false}>
                    Test
                  </Button>
                  <OutcomeWords outcome={outcome} />
                </div>
                {outcome.state === 'working' && !url.trim() && <p className="mt-2 max-w-[60ch] text-[12px] text-fg-3 phone:text-[13px]">The first start downloads Basic Memory. It can take a minute.</p>}
                {steps && <p className="mt-2 max-w-[60ch] text-[12px] text-fg-3 phone:text-[13px]">{steps}</p>}
                {hint && <p className="mt-1 max-w-[60ch] text-[12px] text-fg-2 phone:text-[13px]">{hint}</p>}
                {vault && outcome.state === 'idle' && <p className="mt-2 max-w-[60ch] text-[12px] text-fg-3 phone:text-[13px]">Saved as the connection {vault.name}. Test again after a change.</p>}
              </Radio>
            </div>
            <p className="mt-4 max-w-[64ch] text-[12px] text-fg-3 phone:text-[13px]">mem0, Cognee and other MCP memory servers can be connected later in Memory, Connections.</p>
          </section>

          <section className="mt-10">
            <SectionHeading count={profiles.length || undefined}>Profile</SectionHeading>
            {profiles.length > 0 && (
              <div className="space-y-2.5 pt-4">
                {profiles.slice(0, 4).map((m) => (
                  <Quote key={m.id}>{m.content}</Quote>
                ))}
              </div>
            )}
            <Field
              className="pt-4"
              label={profiles.length ? 'Add a line' : 'A few lines about you that every model should know'}
              help="For example: security student, homelab on Proxmox, short answers. Saved as a profile note when you continue."
            >
              <Textarea prose minRows={3} maxRows={8} value={profile} onChange={(e) => setProfile(e.target.value)} />
            </Field>
          </section>
        </>
      )}
    </StepFrame>
  );
}
