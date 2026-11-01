/**
 * Step 4, Coding agents (spec 11.11), optional: which CLI harnesses each
 * machine has, their versions and who they are signed in as, and a switch
 * per harness found to use it as the engine for a session. They are off
 * until turned on: Conclave runs its own agent loop. Detection runs when
 * the step opens, with a strip per machine while it looks.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Device } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { harnessLabel } from '@/lib/models';
import { cn } from '@/lib/text';
import { reloadDevices, reloadModels, updateConfig, useHub } from '@/store/store';
import { HarnessName } from '@/components/logo';
import { Button } from '@/components/ui/Button';
import { Command } from '@/components/ui/Code';
import { OnOff } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';
import { LiveStatus } from '@/components/motion';
import { StepFrame } from '../StepLayout';
import { andList, useCtlSize } from '../parts';
import { HARNESS_CLI, HARNESS_ORDER } from '../progress';

const INSTALL: Record<string, string> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  'gemini-cli': 'npm install -g @google/gemini-cli',
  opencode: 'curl -fsSL https://opencode.ai/install | bash',
};

/** "Signed in, Claude Max" -> "Claude Max"; "Signed in with Google" -> "Google account". */
function signedInAs(r: { ok: boolean; detail: string } | undefined): string | undefined {
  if (!r?.ok) return undefined;
  const d = r.detail;
  return d.match(/^Signed in,\s*(.+)$/i)?.[1] ?? (d.match(/^Signed in with (.+)$/i) ? `${d.match(/^Signed in with (.+)$/i)![1]} account` : undefined) ?? d.match(/uses (?:the )?(.+)$/i)?.[1] ?? 'Signed in';
}

const COLS = 'grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)]';

function DeviceTable({ device, looking, tests }: { device: Device; looking: boolean; tests: Record<string, { ok: boolean; detail: string }> }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState<string | null>(null);
  const clis = device.info?.clis ?? {};
  const found = HARNESS_ORDER.filter((h) => clis[HARNESS_CLI[h]]);
  const state = looking ? <LiveStatus state="tool" label={`Looking on ${device.name}`} still /> : <span className={cn('text-[12px] phone:text-[13px]', device.online ? 'text-ok' : 'text-fg-3')}>{device.online ? 'online' : 'offline'}</span>;

  return (
    <section className="mt-9 first:mt-0">
      <SectionHeading right={state} count={looking ? undefined : found.length ? `${found.length} of 4` : undefined}>
        {device.name}
      </SectionHeading>
      {looking ? (
        <div className="h-[132px]" aria-hidden />
      ) : !found.length ? (
        <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">None of the four are installed here. Install one, or run coding sessions on another machine.</p>
      ) : (
        <>
          {!mobile && (
            <div className={cn('grid gap-x-4 border-b border-rule py-[7px] text-[12px] text-fg-3', COLS)}>
              <span>Harness</span>
              <span>Version</span>
              <span>Signed in as</span>
              <span className="text-right">State</span>
            </div>
          )}
          <div className="rows anim-fade">
            {HARNESS_ORDER.map((h) => {
              const v = clis[HARNESS_CLI[h]];
              const who = v ? signedInAs(tests[h]) : undefined;
              const expanded = open === h;
              const stateCell = v ? (
                <span className="text-ok">Found</span>
              ) : (
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : h)} className="text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                  {expanded ? 'Hide command' : 'Not installed'}
                </button>
              );
              return (
                <div key={h}>
                  {mobile ? (
                    <div className="flex items-start gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <HarnessName harness={h} size={14} className={cn('text-[15px] font-medium', v ? 'text-fg' : 'text-fg-3')} />
                        <div className="mt-0.5 text-[13px] text-fg-3">{v ? [v, who ?? 'not signed in'].join(', ') : 'Not on this machine'}</div>
                      </div>
                      <span className="shrink-0 text-[14px]">{stateCell}</span>
                    </div>
                  ) : (
                    <div className={cn('grid items-center gap-x-4 py-[9px] text-[13.5px]', COLS)}>
                      <HarnessName harness={h} size={14} className={cn('font-medium', v ? 'text-fg' : 'text-fg-3')} />
                      <span className={cn('truncate font-mono text-[12.5px]', v ? 'text-fg-2' : 'text-fg-3')}>{v ?? 'none'}</span>
                      <span className={cn('truncate text-[13px]', who ? 'text-fg-2' : 'text-fg-3')}>{v ? (who ?? 'not signed in') : ''}</span>
                      <span className="text-right text-[13px]">{stateCell}</span>
                    </div>
                  )}
                  {expanded && !v && (
                    <div className="pb-3 anim-fade">
                      <Command command={INSTALL[h]} copy />
                      <p className="m-0 mt-2 text-[12px] text-fg-3 phone:text-[13px]">
                        Run it on {device.name}, then press Look again. {harnessLabel(h)} signs in the first time you start it.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** One switch per harness found: off by default, on to use it as the engine for a session. */
function Engines({ harnesses }: { harnesses: string[] }) {
  const providers = useHub((s) => s.config?.providers as Record<string, { enabled?: boolean } | undefined> | undefined);
  const ctl = useCtlSize('sm');
  const set = async (id: string, on: boolean) => {
    await updateConfig({ providers: { [id]: { enabled: on } } }).catch(() => undefined);
    void reloadModels();
  };
  return (
    <section className="mb-9">
      <SectionHeading>Use as an engine</SectionHeading>
      <div className="rows">
        {harnesses.map((h) => (
          <div key={h} className="flex items-center gap-4 py-2.5">
            <span className="min-w-0 flex-1">
              <HarnessName harness={h} size={14} className="text-[13.5px] font-medium text-fg phone:text-[15px]" />
              <span className="block text-[12px] text-fg-3 phone:text-[13px]">Use {harnessLabel(h)} as the engine for a session, with its own login.</span>
            </span>
            <OnOff label={`Use ${harnessLabel(h)} as an engine`} size={ctl === 'touch' ? 'touch' : 'sm'} checked={providers?.[h]?.enabled === true} onChange={(on) => void set(h, on)} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function AgentsStep() {
  const devices = useHub((s) => s.devices);
  const ctl = useCtlSize();
  const [looking, setLooking] = useState(true);
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [round, setRound] = useState(0);

  const machines = useMemo(
    () =>
      Object.values(devices)
        .filter((d) => d.info)
        // machines with harnesses first, the hub last
        .sort((a, b) => Number(a.id === 'local') - Number(b.id === 'local') || a.name.localeCompare(b.name)),
    [devices],
  );

  useEffect(() => {
    let alive = true;
    setLooking(true);
    const started = Date.now();
    (async () => {
      await reloadDevices();
      const list = Object.values(useHub.getState().devices);
      const present = HARNESS_ORDER.filter((h) => list.some((d) => d.info?.clis?.[HARNESS_CLI[h]]));
      const results = await Promise.all(present.map((h) => api().testProvider(h).catch((e) => ({ ok: false, detail: String(e) }))));
      // keep the strip up long enough to read, so a fast answer does not flash
      await new Promise((r) => setTimeout(r, Math.max(0, 900 - (Date.now() - started))));
      if (!alive) return;
      setTests(Object.fromEntries(present.map((h, i) => [h, results[i]])));
      setLooking(false);
    })();
    return () => {
      alive = false;
    };
  }, [round]);

  const withAny = machines.filter((d) => HARNESS_ORDER.some((h) => d.info?.clis?.[HARNESS_CLI[h]]));
  const total = new Set(withAny.flatMap((d) => HARNESS_ORDER.filter((h) => d.info?.clis?.[HARNESS_CLI[h]]))).size;
  const summary = looking ? 'Looking for Claude Code, Codex, Gemini CLI and OpenCode.' : total ? `${total} found on ${andList(withAny.map((d) => d.name))}.` : 'None found yet.';

  const found = HARNESS_ORDER.filter((h) => withAny.some((d) => d.info?.clis?.[HARNESS_CLI[h]]));
  return (
    <StepFrame summary={summary}>
      {!looking && found.length > 0 && <Engines harnesses={found} />}
      {machines.map((d) => (
        <DeviceTable key={d.id} device={d} looking={looking} tests={tests} />
      ))}
      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Button variant="outline" size={ctl} onClick={() => setRound((r) => r + 1)} disabled={looking}>
          Look again
        </Button>
        <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">Pair another computer in the Devices step and its CLIs show up here.</p>
      </div>
    </StepFrame>
  );
}
