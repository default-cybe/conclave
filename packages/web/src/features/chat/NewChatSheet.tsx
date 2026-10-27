/**
 * New session (⌘N, New, the phone New button). One dialog: the mode, who
 * answers (agent and model, or jurors, or debaters), where it runs, and an
 * optional first message. A bottom sheet on phones.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { PermissionMode, SessionMode } from '@conclave/core/types';
import { useUi } from '@/store/ui';
import { attempt, upsertSession, useHub } from '@/store/store';
import { api } from '@/lib/api';
import { Dialog } from '@/components/ui/Overlay';
import { Button } from '@/components/ui/Button';
import { Segmented, Textarea } from '@/components/ui/Field';
import { MOD } from '@/components/ui/Kbd';
import { useIsMobile } from '@/lib/hooks';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { AgentPicker, ModePicker, DEFAULT_DEBATE, DEFAULT_JURY, DEFAULT_LOOP, DebatersPicker, DeviceFolderPicker, JudgePicker, JurorsPicker, LoopPicker, PermissionPicker, type ModeValue } from './pickers';
import { MODES } from './modes';

export function NewChatSheet() {
  const open = useUi((s) => s.newChatOpen);
  const preset = useUi((s) => s.newChatPreset);
  const set = useUi((s) => s.set);
  const agents = useHub((s) => s.agents);
  const hub = useHub((s) => s.hub);
  const mobile = useIsMobile();
  const [, navigate] = useLocation();

  const [agent, setAgent] = useState('assistant');
  const [model, setModel] = useState<string | undefined>();
  const [device, setDevice] = useState('local');
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState<ModeValue>({ mode: 'agent' });
  const [perm, setPerm] = useState<PermissionMode>('default');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const a = agents.find((x) => x.name === preset?.agent) ?? agents.find((x) => x.name === 'assistant') ?? agents[0];
    setAgent(a?.name ?? 'assistant');
    setModel(preset?.model ?? a?.model ?? hub?.defaultModel);
    // the hub's default device when neither the preset nor the agent names one; like the hub, only while it is online
    const { config, devices } = useHub.getState();
    const byDefault = config?.defaultDevice as string | undefined;
    setDevice(preset?.device ?? a?.device ?? (byDefault && devices[byDefault]?.online ? byDefault : 'local'));
    // a mode asked for (the palette's "New session in Jury") opens with that mode's defaults
    const m = preset?.mode ?? a?.mode ?? 'agent';
    setMode({ mode: m, ...(m === 'jury' ? { jury: DEFAULT_JURY } : m === 'debate' ? { debate: DEFAULT_DEBATE } : m === 'loop' ? { loop: DEFAULT_LOOP } : {}) });
    setPerm(a?.permissionMode ?? 'default');
    setPrompt(preset?.prompt ?? '');
    setCwd('');
  }, [open, preset, agents, hub]);

  const pickAgent = (name: string) => {
    const a = agents.find((x) => x.name === name);
    setAgent(name);
    if (a?.model && !preset?.model) setModel(a.model);
    if (a?.device) setDevice(a.device);
    if (a?.mode) setMode((m) => ({ ...m, mode: a.mode! }));
    if (a?.permissionMode) setPerm(a.permissionMode);
  };

  const pickMode = (m: SessionMode) =>
    setMode((v) => ({
      ...v,
      mode: m,
      jury: m === 'jury' ? (v.jury ?? DEFAULT_JURY) : v.jury,
      debate: m === 'debate' ? (v.debate ?? DEFAULT_DEBATE) : v.debate,
      loop: m === 'loop' ? (v.loop ?? DEFAULT_LOOP) : v.loop,
    }));

  const close = () => set({ newChatOpen: false, newChatPreset: undefined });

  const create = async () => {
    if (busy) return;
    setBusy(true);
    const s = await attempt(() =>
      api().createSession({
        agent,
        model,
        device,
        cwd: cwd || undefined,
        mode: mode.mode,
        permissionMode: perm,
        modeConfig: { jury: mode.jury, debate: mode.debate, loop: mode.loop },
        prompt: prompt.trim() || undefined,
        taskId: preset?.taskId,
      }),
    );
    setBusy(false);
    if (s) {
      upsertSession(s);
      close();
      navigate(`/s/${s.id}`);
    }
  };

  const m = mode.mode;
  const desc = MODES.find((x) => x.value === m)?.description;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New session"
      width={560}
      footer={
        <>
          {!mobile && <span className="mr-auto text-[12px] text-fg-3">{MOD}↵ starts it</span>}
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={create} busy={busy ? 'Starting' : false}>
            Start session
          </Button>
        </>
      }
    >
      <div
        className="space-y-4"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void create();
          }
        }}
      >
        <div>
          {mobile ? (
            <>
              <div className="mb-1 text-[13px] font-medium text-fg-2">Mode</div>
              <ModePicker look="field" value={m} onChange={pickMode} />
            </>
          ) : (
            <Segmented full size="md" label="Mode" value={m} onChange={pickMode} options={MODES.map((x) => ({ value: x.value, label: x.label, title: x.description }))} />
          )}
          <p className="mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">{desc}.</p>
        </div>

        <div className="space-y-2.5">
          {m === 'jury' ? (
            <>
              <Row label="Jurors">
                <JurorsPicker look="field" value={mode.jury} onChange={(jury) => setMode((v) => ({ ...v, jury }))} />
              </Row>
              <Row label="Judge">
                <JudgePicker look="field" value={mode.jury?.judge} fallback={model} onChange={(judge) => setMode((v) => ({ ...v, jury: { ...(v.jury ?? DEFAULT_JURY), judge } }))} />
              </Row>
            </>
          ) : m === 'debate' ? (
            <>
              <Row label="Debaters">
                <DebatersPicker look="field" value={mode.debate} onChange={(debate) => setMode((v) => ({ ...v, debate }))} />
              </Row>
              <Row label="Judge">
                <JudgePicker look="field" value={mode.debate?.judge} fallback={model} onChange={(judge) => setMode((v) => ({ ...v, debate: { ...(v.debate ?? DEFAULT_DEBATE), judge } }))} />
              </Row>
            </>
          ) : (
            <>
              <Row label="Agent">
                <AgentPicker look="field" value={agent} onChange={pickAgent} />
              </Row>
              <Row label="Model">
                <ModelPicker look="field" value={model} onChange={setModel} />
              </Row>
              {m === 'loop' && (
                <Row label="Until">
                  <LoopPicker look="field" value={mode.loop} onChange={(loop) => setMode((v) => ({ ...v, loop }))} />
                </Row>
              )}
            </>
          )}
          <Row label="Runs on">
            <DeviceFolderPicker look="field" device={device} cwd={cwd} onDevice={setDevice} onCwd={setCwd} />
          </Row>
          {m !== 'chat' && m !== 'jury' && m !== 'debate' && (
            <Row label="Permissions">
              <PermissionPicker look="field" value={perm} onChange={setPerm} />
            </Row>
          )}
        </div>

        <div>
          <label htmlFor="new-session-prompt" className="mb-1.5 block text-[12px] font-medium text-fg-2 phone:text-[13px]">
            First message
          </label>
          <Textarea id="new-session-prompt" autoFocus={!mobile} prose minRows={3} maxRows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Optional. Start empty and write in the session instead." className="w-full" />
        </div>
      </div>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 phone:grid-cols-1 phone:gap-1">
      <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
