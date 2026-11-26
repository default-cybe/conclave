/**
 * Settings > Defaults for a member: their own default model, agent and
 * computer, small and second opinion models, hidden models and memory
 * switches. All saved on their account (PATCH /api/me, core
 * people/member-defaults.ts), never the hub's config; the hub checks each
 * model is one they can call. The owner's page is defaults.tsx.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { MePatch } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useMe } from '@/lib/people';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { toast, useHub } from '@/store/store';
import { AgentPicker } from '@/components/pickers/Pickers';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { OnOff, Segmented, Select, Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { errText, Group, SettingRow } from './parts';
import { reloadMe } from './people';

async function saveMe(patch: MePatch): Promise<void> {
  try {
    await api().updateMe(patch);
    await reloadMe();
  } catch (e) {
    toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
  }
}

export function MemberDefaultsSection() {
  const me = useMe();
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const hub = useHub((s) => s.config) as { defaultModel?: string; smallModel?: string; defaultAgent?: string } | undefined;
  const devices = useLoad(() => api().devices(), []);
  const p = me?.preferences ?? {};
  const [hidden, setHidden] = useState((p.hiddenModels ?? []).join('\n'));
  useEffect(() => setHidden((p.hiddenModels ?? []).join('\n')), [p.hiddenModels]);
  if (!me) return null;
  const mem = p.memory ?? {};
  const hubMem = (useHub.getState().config as { memory?: Record<string, unknown> } | undefined)?.memory ?? {};
  const on = (k: 'enabled' | 'autoInject' | 'recallEpisodes' | 'autoExtract', dflt: boolean) => mem[k] ?? ((hubMem[k] as boolean | undefined) ?? dflt);
  const memOn = on('enabled', true);
  const hiddenList = hidden.split('\n').map((s) => s.trim()).filter(Boolean);
  const hiddenChanged = hiddenList.join('\n') !== (p.hiddenModels ?? []).join('\n');

  return (
    <div className="space-y-9">
      <Group title="New sessions" help="Left empty, the hub's default. Only models you can use are offered.">
        <SettingRow label="Default model" help="What a new chat or session runs on.">
          <ModelPicker look="field" label="Default model" value={p.defaultModel ?? hub?.defaultModel ?? ''} onChange={(m) => void saveMe({ defaultModel: m || null })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
        <SettingRow label="Default agent" help="The agent a new code session starts with.">
          <AgentPicker look="field" value={p.defaultAgent ?? hub?.defaultAgent ?? ''} onChange={(a) => void saveMe({ defaultAgent: a || null })} className="md:max-w-[300px]" />
        </SettingRow>
        <SettingRow label="Default computer" htmlFor="md-device" help="Where a new code session runs: one of your computers while it is online, else the hub.">
          <Select id="md-device" value={p.defaultDevice ?? ''} onChange={(e) => void saveMe({ defaultDevice: e.target.value || null })} className="w-full md:w-[300px]">
            <option value="">The hub</option>
            {(devices.data ?? []).filter((d) => d.id !== 'local').map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow label="Small model" help="Titles, summaries and memory notes.">
          <ModelPicker look="field" label="Small model" value={p.smallModel ?? hub?.smallModel ?? ''} onChange={(m) => void saveMe({ smallModel: m || null })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
        <SettingRow label="Second opinion model" help="Reviews an answer when you ask for a second opinion, and argues back in Debate.">
          <ModelPicker look="field" label="Second opinion model" value={p.reviewer ?? ''} onChange={(m) => void saveMe({ reviewer: m || null })} harnesses={false} className="md:max-w-[300px]" />
        </SettingRow>
        <SettingRow label="When a plan runs out" help="Your own list of models to switch to.">
          <Link href="/settings/usage" className="link text-[13px]">
            Limit fallback
          </Link>
        </SettingRow>
      </Group>

      <Group title="Hidden models" help="Left out of your pickers, and never used for you. One model or pattern per line; * matches anything, as in mock/*haiku*. The owner's hidden models stay hidden too.">
        <SettingRow label="" stack>
          <Textarea mono rows={4} value={hidden} onChange={(e) => setHidden(e.target.value)} placeholder="openrouter/*" aria-label="Hidden models" />
        </SettingRow>
        <SettingRow label="">
          <Button variant="outline" size={size} disabled={!hiddenChanged} onClick={() => void saveMe({ hiddenModels: hiddenList })}>
            Save
          </Button>
        </SettingRow>
      </Group>

      <Group title="Memory" help="How your memory works in your own sessions. Your notes are yours; nobody else's sessions read them.">
        <SettingRow label="Use memory" help="Off: your sessions neither read nor save notes.">
          <OnOff label="Use memory" checked={memOn} onChange={(v) => void saveMe({ memory: { enabled: v } })} size={size} />
        </SettingRow>
        <SettingRow label="Give relevant notes" help="Notes that match your message ride along with it.">
          <OnOff label="Give relevant notes" disabled={!memOn} checked={on('autoInject', true)} onChange={(v) => void saveMe({ memory: { autoInject: v } })} size={size} />
        </SettingRow>
        <SettingRow label="Notes per turn" help="More notes cost more tokens on every turn.">
          {/* the same choices as the owner's page (defaults.tsx) */}
          <Segmented
            label="Notes per turn"
            disabled={!memOn}
            size={size}
            value={String(mem.injectLimit ?? (hubMem.injectLimit as number | undefined) ?? 6)}
            onChange={(v) => void saveMe({ memory: { injectLimit: Number(v) } })}
            options={['3', '6', '10', '15'].map((v) => ({ value: v, label: v }))}
          />
        </SettingRow>
        <SettingRow label="Past session summaries" help="Recall may bring back what earlier sessions did.">
          <OnOff label="Past session summaries" disabled={!memOn} checked={on('recallEpisodes', false)} onChange={(v) => void saveMe({ memory: { recallEpisodes: v } })} size={size} />
        </SettingRow>
        <SettingRow label="Save what sessions learn" help="After a turn, new facts about you are saved as notes.">
          <OnOff label="Save what sessions learn" disabled={!memOn} checked={on('autoExtract', true)} onChange={(v) => void saveMe({ memory: { autoExtract: v } })} size={size} />
        </SettingRow>
      </Group>
    </div>
  );
}
