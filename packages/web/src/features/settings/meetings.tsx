/**
 * Settings > Meetings: where a meeting's speech becomes text (config
 * meetings.stt). Local runs Parakeet in the desktop app; AssemblyAI and
 * Deepgram stream from the desktop app straight to the provider on a
 * short-lived token the hub mints (POST /api/meetings/:id/stt-token), so
 * the key itself (hub secret stt.assemblyai or stt.deepgram) never leaves
 * the hub. Local is only ever the owner's explicit choice: with no key, or a
 * provider that fails, the overlay says so and keeps retrying the cloud; the
 * Parakeet model is never downloaded or loaded unless Local is picked here.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented } from '@/components/ui/Field';
import { readPlacement, writePlacement } from '@/overlay/dock';
import type { Mode } from '@/overlay/place';
import { LoadingRows } from '@/components/ui/EmptyState';
import { toast, useHub } from '@/store/store';
import { meetings } from '@/features/meeting/api';
import type { SttProvider, SttTestResult } from '@/overlay/wire';
import { errText, Group, Outcome, SettingRow } from './parts';

interface Choice {
  id: SttProvider;
  name: string;
  line: string;
  free?: string;
  signup?: string;
  recommended?: boolean;
}

/** Prices are per audio hour; a meeting streams two (you and them). */
export const STT_CHOICES: Choice[] = [
  { id: 'deepgram', name: 'Deepgram', recommended: true, line: 'Nova-3. About 0.3 s behind speech, the fastest finals. About $0.46 per audio hour.', free: '$200 free credit for a new account, no card.', signup: 'https://console.deepgram.com/signup' },
  { id: 'assemblyai', name: 'AssemblyAI', line: 'Universal-Streaming. About 0.3 s behind speech, strong on names and accents. About $0.15 per audio hour.', free: '$50 free credit for a new account, no card.', signup: 'https://www.assemblyai.com/dashboard/signup' },
  { id: 'local', name: 'Local', line: 'Slower, uses your computer. Parakeet runs in the desktop app: free, private, works offline, but about 1 to 2 s behind speech, it loads your CPU during the meeting, and it is a 650 MB download before the first one. Never used unless you pick it.' },
];

export const sttSecret = (p: SttProvider) => `stt.${p}`;

/**
 * The service a member's meetings use: their own first saved key, else Deepgram (which then
 * asks for a key). The hub's meetings.stt is the owner's (PATCH /api/config is admin only);
 * core/src/meeting/index.ts sttToken.
 */
export function memberStt(values: string[]): SttProvider {
  return values.includes(sttSecret('assemblyai')) && !values.includes(sttSecret('deepgram')) ? 'assemblyai' : 'deepgram';
}

/** What the desktop app will use: the choice. A cloud choice with no key does not listen until one is saved. */
export function sttInUse(chosen: SttProvider, keyed: (p: SttProvider) => boolean): { provider: SttProvider; words: string; missing?: boolean } {
  if (chosen === 'local') return { provider: 'local', words: 'Local, on this computer (slower, uses your computer).' };
  const name = STT_CHOICES.find((c) => c.id === chosen)!.name;
  if (!keyed(chosen)) return { provider: chosen, missing: true, words: `${name}, once you save a key. Until then the overlay says no key is set; it never switches to Local by itself.` };
  return { provider: chosen, words: `${name}. If it cannot connect, the overlay says why with a Retry and keeps trying; it never switches to Local by itself.` };
}

/** Where the overlay sits on this device (overlay/dock.ts); the overlay reads the same key. */
export function PlacementGroup({ mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) }: { mac?: boolean }) {
  const [p, setP] = useState(readPlacement);
  const set = (v: Partial<typeof p>) => {
    writePlacement(v);
    setP(readPlacement());
  };
  const options: { value: Mode; label: string }[] = [
    { value: 'free', label: 'Free' },
    { value: 'edge', label: 'Dock to edge' },
    ...(mac ? [{ value: 'notch' as Mode, label: 'Notch' }] : []),
  ];
  return (
    <Group title="Meeting overlay" help="Saved on this device. Ctrl or Cmd + Alt + Shift + Right or Left, or the tray menu, moves it to another display.">
      <SettingRow label="Placement" help={mac ? 'Notch sits on the menu bar like the Dynamic Island and grows down when an answer comes.' : 'Dragged within 24 px of a screen edge, a docked overlay snaps there.'}>
        <Segmented<Mode> label="Placement" size="sm" value={p.mode === 'notch' && !mac ? 'edge' : p.mode} onChange={(v) => set({ mode: v })} options={options} />
      </SettingRow>
      <SettingRow label="Auto-hide" help="Docked, it hides to a slim tab (or the notch pill) and slides out on hover, Ctrl or Cmd + Alt + O, or a new answer.">
        <OnOff label="Auto-hide" checked={p.autoHide} onChange={(v) => set({ autoHide: v })} />
      </SettingRow>
    </Group>
  );
}

export function MeetingsSection() {
  const member = useHub((s) => s.me?.role === 'member');
  const [cfg, setCfg] = useState<{ stt: SttProvider; values: string[] }>();
  const [error, setError] = useState<string>();
  const load = () =>
    api()
      .config()
      .then((r) => {
        const set = (r.config.meetings as { stt?: SttProvider } | undefined)?.stt;
        // unset: the hub takes the first service with a key, Deepgram first (core/src/meeting/stt.ts sttChoice)
        const stt = member || !set ? memberStt(r.secrets.values) : set;
        setCfg({ stt, values: r.secrets.values });
      })
      .catch((e) => setError(errText(e)));
  useEffect(() => void load(), [member]);
  if (error) return <p className="text-[13px] text-fault">Could not load the meeting settings. {error}</p>;
  if (!cfg) return <LoadingRows loading rows={4} />;
  return <SttBody chosen={cfg.stt} values={cfg.values} reload={load} member={member} />;
}

export function SttBody({ chosen, values, reload, member, first }: { chosen: SttProvider; values: string[]; reload: () => Promise<void>; member?: boolean; first?: SttProvider }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [open, setOpen] = useState<SttProvider>(first ?? chosen);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string>();
  const [test, setTest] = useState<SttTestResult & { provider: SttProvider }>();
  const keyed = (p: SttProvider) => p === 'local' || values.includes(sttSecret(p));
  const p = STT_CHOICES.find((c) => c.id === open)!;
  const inUse = sttInUse(chosen, keyed);

  const run = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(what);
    let ok = false;
    try {
      await fn();
      await reload();
      ok = true;
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
    return ok;
  };
  const use = (id: SttProvider) => run('use', () => api().updateConfig({ meetings: { stt: id } }));
  const runTest = async () => {
    if (p.id === 'local') return;
    setBusy('test');
    setTest(undefined);
    try {
      setTest({ ...(await meetings().sttTest(p.id)), provider: p.id });
    } catch (e) {
      setTest({ ok: false, message: errText(e), provider: p.id });
    }
    setBusy(undefined);
  };

  return (
    <div className="space-y-9">
      <Group title="Speech to text" help="Where what is said in a meeting becomes text. A cloud service is faster and more accurate; the desktop app streams the audio straight to it with a short-lived token, and your key stays on the hub.">
        <SettingRow label="In use" help={inUse.words}>
          {null}
        </SettingRow>
        <ul className="m-0 list-none space-y-1 p-0 py-3" aria-label="Speech to text">
          {STT_CHOICES.map((c) => (
            <li key={c.id}>
              <button type="button" aria-pressed={c.id === open} onClick={() => (setOpen(c.id), setKey(''), setTest(undefined))} className={cn('w-full rounded-md px-3 py-2.5 text-left hover:bg-hover', c.id === open && 'bg-hover')}>
                <span className="text-[13.5px] font-medium text-fg phone:text-[15px]">{c.name}</span>
                {c.recommended && <span className="ml-2 text-[12px] font-medium text-fg-2">Recommended</span>}
                {c.id === chosen && <span className="ml-2 text-[12px] text-ok">Chosen</span>}
                {c.id !== 'local' && keyed(c.id) && <span className="ml-2 text-[12px] text-fg-3">Key saved</span>}
                <span className="mt-0.5 block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                  {c.line}
                  {c.free && <span className="ml-1 text-fg-2">{c.free}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Group>

      <Group title={p.name} help={p.id === 'local' ? 'Slower, uses your computer. The model downloads in the desktop app the first time you pick Local, never before.' : undefined}>
        {p.signup && (
          <SettingRow label="Get a key" help="Sign up, then copy the API key from the dashboard." top>
            <a href={p.signup} target="_blank" rel="noreferrer" className="link text-[13px] phone:text-[15px]">
              {p.signup.replace(/^https:\/\//, '').split('/')[0]}
            </a>
          </SettingRow>
        )}
        {p.id !== 'local' && (
          <SettingRow label="Key" help={keyed(p.id) ? 'Saved on the hub. Paste a new one to replace it.' : 'Not saved.'} top>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <Input mono type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyed(p.id) ? 'Paste a new key' : 'API key'} aria-label={`${p.name} API key`} className="w-[200px]!" size="sm" />
              <Button
                variant="solid"
                size={size}
                disabled={!key.trim()}
                busy={busy === 'key' ? 'Saving' : false}
                onClick={async () => {
                  if (await run('key', () => api().setSecret('values', sttSecret(p.id), key.trim()))) setKey('');
                }}
              >
                Save
              </Button>
              {keyed(p.id) && (
                <Button variant="danger" size={size} busy={busy === 'rmkey' ? 'Removing' : false} onClick={() => void run('rmkey', () => api().setSecret('values', sttSecret(p.id), null))}>
                  Remove
                </Button>
              )}
            </div>
          </SettingRow>
        )}
        <SettingRow label={p.id === chosen ? 'In use' : 'Use it'} help={p.id === chosen ? `Meetings use ${p.name}.` : member ? 'Your meetings use your first saved key: Deepgram, then AssemblyAI.' : `Make meetings use ${p.name}.`}>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {p.id !== 'local' && (
              <Button size={size} disabled={!keyed(p.id)} busy={busy === 'test' ? 'Testing' : false} onClick={() => void runTest()}>
                Test
              </Button>
            )}
            {p.id !== chosen && !member && (
              <Button variant="solid" size={size} busy={busy === 'use' ? 'Saving' : false} onClick={() => void use(p.id)}>
                Use {p.name}
              </Button>
            )}
          </div>
        </SettingRow>
        {test && test.provider === p.id && (
          <p className="m-0 py-3" aria-label="Test result">
            <Outcome word={test.ok ? 'Works' : 'Failed'} tone={test.ok ? 'ok' : 'fault'}>
              {test.ok ? test.message.replace(/^Works\.\s*/, '') : test.message}
            </Outcome>
          </p>
        )}
      </Group>
      <PlacementGroup />
    </div>
  );
}
