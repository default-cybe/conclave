/**
 * Continue as a session (docs/design/CHAT-AND-MOTION.md 2.9): the chat moves
 * to Sessions with an agent that can work on a device. The transcript stays;
 * the next turn runs with the new agent's tools.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import type { PermissionMode } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Segmented } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { SelectMenu } from '@/components/ui/Select';
import { AgentPicker, DevicePicker } from '@/components/pickers/Pickers';
import { PERMISSION_MODES } from '@/features/chat/modes';
import { keepSession } from './actions';
import { openContinue, useChatUi } from './state';

export function ContinueDialog() {
  const id = useChatUi((s) => s.continuing);
  const session = useHub((s) => (id ? s.sessions[id] : undefined));
  const config = useHub((s) => s.config) as { defaultAgent?: string; defaultDevice?: string; permissions?: { mode?: PermissionMode } } | undefined;
  const devices = useHub((s) => s.devices);
  const agents = useHub((s) => s.agents);
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const [agent, setAgent] = useState<string>();
  const [device, setDevice] = useState<string>();
  const [cwd, setCwd] = useState('~');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!id) return;
    const fallbackAgent = agents.find((a) => a.name === config?.defaultAgent && a.name !== 'chat')?.name ?? agents.find((a) => a.primary !== false && a.name !== 'chat')?.name;
    const online = Object.values(devices).filter((d) => d.online);
    setAgent(fallbackAgent);
    setDevice(online.find((d) => d.id === config?.defaultDevice)?.id ?? online.find((d) => d.id === 'local')?.id ?? online[0]?.id);
    setCwd('~');
    setMode(config?.permissions?.mode ?? 'default');
    setKeep(false);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const close = () => openContinue(undefined);

  const go = async () => {
    if (!session || !agent || !device) {
      setError(!agent ? 'Pick an agent to continue.' : 'Pick a device that is online to continue.');
      return;
    }
    setBusy(true);
    let target = session.id;
    if (keep) {
      const fork = await attempt(() => api().forkSession(session.id));
      if (!fork) return setBusy(false);
      keepSession(fork);
      target = fork.id;
    }
    const moved = await attempt(() => api().updateSession(target, { kind: 'agent', agent, device, cwd: cwd.trim() || '~', permissionMode: mode }));
    setBusy(false);
    if (!moved) return;
    keepSession(moved);
    close();
    navigate(`/s/${moved.id}`);
  };

  return (
    <Dialog
      open={!!id && !!session}
      onClose={close}
      title="Continue as a session"
      description="The conversation so far moves to Sessions with an agent that can work on a device."
      width={480}
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} busy={busy ? 'Moving' : false} onClick={go}>
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-4 pt-2">
        <Field label="Agent">
          <AgentPicker look="field" value={agent} onChange={setAgent} />
        </Field>
        <Field label="Device" help="Only devices that are online.">
          <DevicePicker look="field" onlineOnly value={device} onChange={setDevice} />
        </Field>
        <Field label="Folder">
          <Input mono value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
        </Field>
        <Field label="Permissions">
          {mobile ? (
            <SelectMenu look="field" label="Permissions" value={mode} onChange={setMode} options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label, detail: p.description }))} />
          ) : (
            <Segmented size="sm" label="Permissions" value={mode} onChange={setMode} options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label, title: p.description }))} />
          )}
        </Field>
        <Checkbox checked={keep} onChange={setKeep} label="Keep this chat in Chat" description="A copy moves to Sessions and this chat stays here." />
        {error && (
          <p role="alert" className="text-[13px] text-fault">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
