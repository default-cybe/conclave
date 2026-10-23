/**
 * The Add sheet for a suggested routine (docs/design/ECOSYSTEM.md 5.2): a
 * side sheet on desktop, a bottom sheet on tablets and phones. It shows
 * exactly what the routine will be: device, folder, schedule, agent, the
 * calls it may make without asking, its precheck and prompt, then Add.
 * Add creates the agent when it is missing, then the routine.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { Routine } from '@conclave/core/types';
import type { HubGap } from '@conclave/core/scheduler/suggestions';
import { expandHome, hubPaths, offeredDevices } from '@conclave/core/scheduler/suggest';
import { api } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { describeSchedule } from '@/lib/schedule';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, Segmented, Textarea } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { TextAction } from '@/components/ui/Section';
import { DiscoverSheet } from '@/features/extensions/discover/Sheet';
import { FolderPicker } from './FolderPicker';
import { upsertRun } from './actions';
import { dayDate } from './RoutineEditor';
import { nextWords } from './words';
import { addSuggestion, addedRoutines, defaultDevices, discoverHref, loadSuggestions, shortNeed, useSuggestStore, whatWords, whenWords, type Suggestion } from './suggest';

type Notify = 'on_attention' | 'always' | 'never';

const GAP_WORD: Record<HubGap, string> = {
  'routine-allow': 'per routine permission rules',
  'bash-allow-safe': 'safe Bash rules',
  'agent-tools-allow': 'agent tools that ask before running',
  'webhook-payload': 'webhook bodies passed to the run',
  'never-schedule': 'schedules that only run from a webhook',
  'routine-env': 'secrets passed to the routine as variables',
  'routine-runs-tool': 'a tool that reads routine runs',
  'session-tools': 'tools that read past sessions',
};

function Block({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mt-7 first:mt-0">
      <div className="flex items-baseline gap-3 border-b border-rule-2 pb-[9px]">
        <h3 className="t-section min-w-0 flex-1 text-fg">{title}</h3>
        {right && <div className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{right}</div>}
      </div>
      <div className="pt-3">{children}</div>
    </section>
  );
}

const Hint = ({ children, className }: { children: ReactNode; className?: string }) => <p className={cn('mt-1.5 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]', className)}>{children}</p>;

/** The first lines of a prompt, for the collapsed view. */
function head(text: string, lines: number): string {
  return text.split('\n').slice(0, lines).join('\n');
}

interface Draft {
  devices: string[];
  cwd: string;
  schedule: string;
  prompt: string;
  notify: Notify;
  enabled: boolean;
  allow: string[];
}

function initialDraft(s: Suggestion, deviceIds: string[]): Draft {
  return {
    devices: deviceIds,
    cwd: '',
    schedule: s.schedule,
    prompt: s.prompt,
    notify: s.notify === 'always' ? 'always' : s.notify === 'never' ? 'never' : 'on_attention',
    enabled: s.enabledByDefault,
    allow: [...s.allow],
  };
}

export function AddSuggestionSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const data = useSuggestStore((s) => s.data);
  // keep the last suggestion while the sheet slides out
  const [shown, setShown] = useState(id);
  // each opening starts a fresh form, also for the suggestion that was just added
  const [opened, setOpened] = useState(0);
  const wasOpen = useRef(!!id);
  useEffect(() => {
    if (id) {
      setShown(id);
      if (!wasOpen.current) setOpened((n) => n + 1);
      void loadSuggestions();
    }
    wasOpen.current = !!id;
  }, [id]);
  const s = shown ? data?.suggestions.find((x) => x.id === shown) : undefined;
  if (s) return <AddFlow key={`${s.id}:${opened}`} s={s} open={!!id} agentExists={data?.agents[s.agent ?? '']?.exists ?? true} hubHome={data?.hubHome} hubRepos={data?.hubRepos} onClose={onClose} />;
  const missing = !!id && !!data;
  return (
    <DiscoverSheet open={!!id} onClose={onClose} title={missing ? 'Suggestion not found' : 'Suggested routine'}>
      <p className="text-[13px] text-fg-2 phone:text-[14px]">{missing ? `This hub has no suggestion called ${id}. It may come with a newer version of Conclave.` : 'Loading'}</p>
    </DiscoverSheet>
  );
}

function AddFlow({ s, open, agentExists, hubHome, hubRepos, onClose }: { s: Suggestion; open: boolean; agentExists: boolean; hubHome?: string; hubRepos?: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  const phone = useIsMobile();
  const deviceMap = useHub((st) => st.devices);
  // the machines it may run on: the hub only when it holds code, for one that reads code
  const devices = useMemo(
    () => offeredDevices(s, Object.values(deviceMap), hubRepos).sort((a, b) => Number(b.id === 'local') - Number(a.id === 'local') || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [deviceMap, s, hubRepos],
  );
  const [d, setD] = useState<Draft>(() => initialDraft(s, defaultDevices(s, devices, hubRepos)));
  const [fullPrompt, setFullPrompt] = useState(false);
  const [allDeny, setAllDeny] = useState(false);
  const [browse, setBrowse] = useState(false);
  const routineMap = useHub((st) => st.routines);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ routines: Routine[]; agentCreated?: string }>();
  const [next, setNext] = useState<{ expr: string; next: number[]; error?: string }>();
  // routines this suggestion already made (Discover links here even when it was added before)
  const already = done ? [] : addedRoutines(s, routineMap);
  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // devices arrive after the sheet opened: fill the default once
  useEffect(() => {
    if (!d.devices.length && devices.length) up({ devices: defaultDevices(s, devices, hubRepos) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.length]);

  // the next three runs, as the hub reads the schedule
  useEffect(() => {
    let live = true;
    const expr = d.schedule.trim();
    const t = setTimeout(() => {
      api()
        .previewSchedule(expr, Intl.DateTimeFormat().resolvedOptions().timeZone)
        .then((r) => live && setNext({ expr, ...r }))
        .catch((e: unknown) => live && setNext({ expr, next: [], error: e instanceof Error ? e.message : 'The hub could not read that schedule.' }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [d.schedule]);

  const waiting = s.waitingOn.length > 0;
  const each = s.deviceRole === 'each';
  const first = deviceMap[d.devices[0] ?? ''];
  // one routine per device: each expands ~ with its own home, so show it as written
  // on the hub, ~/.conclave is the hub's own folder (/data in Docker), as Add writes it
  const cwdShown = s.askCwd ? d.cwd : each ? (s.cwd === '~' ? '~ (home on each device)' : s.cwd) : expandHome(first?.id === 'local' && s.cwd ? hubPaths(s.cwd, hubHome) : s.cwd, first?.info?.home);
  const scheduleBad = !!next && next.expr === d.schedule.trim() && !!next.error;
  const blockers = [waiting && 'a hub update', !d.devices.length && (each ? 'at least one device' : 'a device'), s.askCwd && !d.cwd.trim() && 'a folder', scheduleBad && 'a schedule the hub can read'].filter(Boolean) as string[];
  const bins = s.requires.filter((n) => n.kind === 'bin' || n.kind === 'note' || n.kind === 'skill');
  const hubNeeds = s.requires.filter((n) => n.kind === 'mcp' || n.kind === 'secret');
  const missingIds = new Set(s.missing.map((m) => m.id));

  const add = async () => {
    if (blockers.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const overrides: Record<string, unknown> = { notify: d.notify, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (d.schedule.trim() !== s.schedule) overrides.schedule = d.schedule.trim();
      if (d.prompt !== s.prompt) overrides.prompt = d.prompt;
      if (d.allow.length !== s.allow.length) overrides.allow = d.allow;
      const res = await addSuggestion(s.id, { devices: d.devices, enabled: d.enabled, ...(s.askCwd ? { cwd: d.cwd.trim() } : {}), overrides });
      setDone(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ctl = phone ? 'touch' : 'md';
  const what = each && d.devices.length > 1 ? `${d.devices.length} routines, one per device` : 'the routine';
  const status = error ? error : blockers.length ? `Needs ${blockers.join(' and ')}.` : !agentExists ? `Adds the ${s.agent} agent, then ${what}.` : each && d.devices.length > 1 ? `Adds ${what}.` : '';
  const footer = done ? (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <DoneActions done={done} onClose={onClose} onOpen={(rid) => navigate(`/routines/${rid}`)} />
    </div>
  ) : (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <span className={cn('mr-auto min-w-0 flex-1 basis-[180px] text-[12.5px] leading-[1.4] phone:text-[13.5px]', error ? 'text-fault' : 'text-fg-3')} role="status">
        {status}
      </span>
      <Button variant="quiet" size={ctl} onClick={onClose}>
        Cancel
      </Button>
      <Button variant="solid" size={ctl} onClick={() => void add()} disabled={blockers.length > 0} busy={busy ? 'Adding' : false}>
        Add
      </Button>
    </div>
  );

  return (
    <DiscoverSheet open={open} onClose={onClose} title={s.name} sub={`${whenWords(s.schedule)}, ${s.agent ?? 'assistant'}`} label={`Add ${s.name}`} footer={footer}>
      {done ? <Done s={s} done={done} /> : body()}
    </DiscoverSheet>
  );

  function body() {
    return (
    <div>
      <p className="text-[13.5px] leading-[1.55] text-fg-2 phone:text-[15px]">{whatWords(s.description)}</p>
      <p className="mt-2 text-[12.5px] leading-[1.5] text-fg-3 phone:text-[13.5px]">Leaves: {s.outputs}</p>

      {already.length > 0 && (
        <p className="mt-4 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
          You already have it:{' '}
          {already.slice(0, 3).map((r, i) => (
            <span key={r.id}>
              {i > 0 && ', '}
              <Link href={`/routines/${r.id}`} className="link">
                {r.name}
              </Link>
            </span>
          ))}
          . Add makes another one{s.deviceRole === 'each' ? ', for example for a machine it does not cover yet' : ''}.
        </p>
      )}

      {waiting && (
        <p className="mt-4 text-[13px] leading-[1.5] text-warn phone:text-[14px]">
          Needs a hub update first: {s.waitingOn.map((g) => GAP_WORD[g] ?? g).join(', ')}. Add turns on once this hub has it.
        </p>
      )}

      <Block title={each ? 'Devices' : 'Device'}>
        {each ? (
          <div className="space-y-1">
            {devices.map((x) => (
              <Checkbox
                key={x.id}
                checked={d.devices.includes(x.id)}
                onChange={(v) => up({ devices: v ? [...d.devices, x.id] : d.devices.filter((y) => y !== x.id) })}
                label={x.name}
                description={x.online ? undefined : 'offline'}
              />
            ))}
            <Hint>One routine per device, named after it.</Hint>
          </div>
        ) : (
          <>
            <SelectMenu
              look="field"
              label="Device"
              value={d.devices[0] ?? ''}
              onChange={(v) => up({ devices: v ? [v] : [] })}
              options={devices.map((x) => ({ value: x.id, label: x.name, text: x.name, hint: <span className={x.online ? 'text-ok' : 'text-fg-3'}>{x.online ? 'online' : 'offline'}</span> }))}
            />
            <Hint>{ROLE_HINT[s.deviceRole]}</Hint>
          </>
        )}
      </Block>

      {(s.askCwd || cwdShown) && (
        <Block title="Folder">
          {s.askCwd ? (
            <>
              <div className="flex gap-2">
                <Input mono aria-label="Folder" value={d.cwd} onChange={(e) => up({ cwd: e.target.value })} placeholder="~/code/conclave" className="min-w-0 flex-1" spellCheck={false} />
                <Button variant="outline" size={ctl} onClick={() => setBrowse(true)} disabled={!d.devices[0]}>
                  Browse
                </Button>
              </div>
              <Hint>{s.askCwd}</Hint>
              <FolderPicker open={browse} onClose={() => setBrowse(false)} device={d.devices[0] ?? 'local'} value={d.cwd || undefined} onPick={(p) => up({ cwd: p })} />
            </>
          ) : (
            <p className="font-mono text-[12.5px] text-fg [overflow-wrap:anywhere]">{cwdShown}</p>
          )}
        </Block>
      )}

      <Block title="Schedule">
        <Input mono aria-label="Schedule" value={d.schedule} onChange={(e) => up({ schedule: e.target.value })} invalid={scheduleBad} spellCheck={false} />
        {scheduleBad ? (
          <p className="mt-1.5 text-[12.5px] text-fault phone:text-[13.5px]">{next?.error}</p>
        ) : (
          <div className="mt-2 text-[13px] text-fg-2 phone:text-[14px]">
            {whenWords(d.schedule)}
            {next && next.expr === d.schedule.trim() && next.next.length > 0 && (
              <span className="text-fg-3">
                . Next {next.next
                  .slice(0, 3)
                  .map((t) => `${dayDate(t).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase())} ${hhmm(t)}`)
                  .join(', ')}
              </span>
            )}
          </div>
        )}
      </Block>

      <Block title="Runs as">
        <p className="text-[13.5px] text-fg phone:text-[15px]">
          {agentExists ? (
            <Link href={`/agents/${encodeURIComponent(s.agent ?? 'assistant')}`} className="hover:underline">
              {s.agent ?? 'assistant'}
            </Link>
          ) : (
            (s.agent ?? 'assistant')
          )}
        </p>
        {!agentExists && <Hint>Adds the {s.agent} agent to your agents. It reads and reports, and cannot edit files.</Hint>}
      </Block>

      <Block title="Allowed without asking" right={d.allow.length < s.allow.length ? <TextAction label="Put back" onClick={() => up({ allow: [...s.allow] })} /> : undefined}>
        {d.allow.length ? (
          <ul className="divide-y divide-rule">
            {d.allow.map((r) => (
              <li key={r} className="flex items-baseline gap-3 py-1.5">
                <span className="min-w-0 flex-1 font-mono text-[12.5px] text-fg [overflow-wrap:anywhere]">{r}</span>
                <TextAction label="Remove" onClick={() => up({ allow: d.allow.filter((x) => x !== r) })} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-2">Nothing. Every call that needs approval is refused while you are away.</p>
        )}
        {!!s.deny?.length && (
          <>
            <p className="mt-3 text-[12px] text-fg-3 phone:text-[13px]">Never allowed, even when a rule above matches. ** stands for any text.</p>
            <ul className="mt-1">
              {(allDeny ? s.deny : s.deny.slice(0, DENY_SHOWN)).map((r) => (
                <li key={r} className="py-1 font-mono text-[12.5px] text-fg-2 [overflow-wrap:anywhere]">
                  {r}
                </li>
              ))}
            </ul>
            {s.deny.length > DENY_SHOWN && <TextAction className="mt-1" label={allDeny ? 'Show fewer' : `Show ${s.deny.length - DENY_SHOWN} more`} onClick={() => setAllDeny(!allDeny)} />}
          </>
        )}
        <Hint>Calls outside this list are refused while you are away, and listed on the run. Run now still asks you.</Hint>
      </Block>

      {s.precheck && (
        <Block title="Before it runs">
          <p className="font-mono text-[12px] leading-[1.55] text-fg-2 [overflow-wrap:anywhere]">{s.precheck}</p>
          <Hint>Skips the model when this prints nothing new.</Hint>
        </Block>
      )}

      <Block title="Prompt" right={<TextAction label={fullPrompt ? 'Show less' : 'Show all and edit'} onClick={() => setFullPrompt(!fullPrompt)} />}>
        {fullPrompt ? (
          <Textarea prose aria-label="Prompt" minRows={8} maxRows={20} value={d.prompt} onChange={(e) => up({ prompt: e.target.value })} />
        ) : (
          <p className="text-[13px] leading-[1.55] whitespace-pre-line text-fg-2 phone:text-[14px]">{head(d.prompt, 3)}</p>
        )}
      </Block>

      {(hubNeeds.length > 0 || bins.length > 0) && (
        <Block title="Needs">
          <ul className="space-y-1.5">
            {hubNeeds.map((n) => (
              <li key={n.id} className="text-[13px] leading-[1.45] phone:text-[14px]">
                <span className={missingIds.has(n.id) ? 'text-warn' : 'text-fg'}>{shortNeed(n.label)}</span>
                <span className="text-fg-3">{missingIds.has(n.id) ? (n.optional ? ', missing, optional' : ', missing') : ', set up'}</span>
                {missingIds.has(n.id) && n.catalog && (
                  <>
                    {' '}
                    <Link href={discoverHref(n.catalog)} className="link text-fg-2">
                      Add it
                    </Link>
                  </>
                )}
              </li>
            ))}
            {bins.map((n) => {
              const found = n.kind === 'bin' && !!first?.info?.clis?.[n.id];
              return (
                <li key={n.id} className="text-[13px] leading-[1.45] text-fg phone:text-[14px]">
                  {n.label}
                  <span className="text-fg-3">{found ? `, found on ${first?.name}` : n.optional ? ', optional' : n.kind === 'note' || n.kind === 'skill' ? ', the routine reads it' : ', checked when it runs'}</span>
                  {n.kind === 'skill' && n.catalog && (
                    <>
                      {' '}
                      <Link href={discoverHref(n.catalog)} className="link text-fg-2">
                        Find it in Discover
                      </Link>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Block>
      )}

      <Block title="Notify">
        <Segmented
          label="Notify"
          value={d.notify}
          onChange={(v) => up({ notify: v })}
          size={phone ? 'touch' : 'md'}
          options={[
            { value: 'on_attention', label: 'On problems' },
            { value: 'always', label: 'Always' },
            { value: 'never', label: 'Never' },
          ]}
        />
        <Hint>{d.notify === 'on_attention' ? 'When a run fails, or its reply starts with STATUS: attention or STATUS: problem.' : d.notify === 'always' ? 'After every run.' : 'Runs stay in the history.'}</Hint>
      </Block>

      <Block title="Start">
        <Segmented
          label="Start"
          value={d.enabled ? 'on' : 'off'}
          onChange={(v) => up({ enabled: v === 'on' })}
          size={phone ? 'touch' : 'md'}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
        <Hint>{d.enabled ? 'It runs at the next scheduled time.' : 'Saved paused. Turn it on from the routine page.'}</Hint>
      </Block>

      <Block title="Good to know">
        <p className="text-[12.5px] leading-[1.55] text-fg-2 phone:text-[13.5px]">{s.risk}</p>
      </Block>
    </div>
    );
  }
}

/** Deny rules shown before "Show N more". */
const DENY_SHOWN = 3;

const ROLE_HINT: Record<Suggestion['deviceRole'], string> = {
  hub: 'Made for the hub.',
  proxmox: 'Made for the Proxmox host.',
  workstation: 'Made for the machine that holds your code.',
  laptop: 'Made for your laptop.',
  each: 'Pick every machine it should check.',
};

function Done({ s, done }: { s: Suggestion; done: { routines: Routine[]; agentCreated?: string } }) {
  const one = done.routines.length === 1 ? done.routines[0] : undefined;
  const nextAt = one?.enabled ? one.nextRunAt : undefined;
  return (
    <div>
      <p className="text-[15px] leading-[1.5] text-fg phone:text-[16px]" role="status">
        {one ? (one.enabled ? (nextAt ? `Added. Next run ${nextWords(nextAt)}.` : 'Added.') : 'Added, paused. Turn it on from the routine page when you are ready.') : `Added ${done.routines.length} routines, one per device.`}
      </p>
      {done.agentCreated && <p className="mt-1.5 text-[13px] text-fg-2 phone:text-[14px]">The {done.agentCreated} agent was added to your agents too.</p>}
      {!one && (
        <ul className="mt-3 divide-y divide-rule border-y border-rule">
          {done.routines.map((r) => (
            <li key={r.id} className="py-2">
              <Link href={`/routines/${r.id}`} className="text-[13.5px] text-fg hover:underline">
                {r.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12.5px] text-fg-3 phone:text-[13.5px]">{describeSchedule(one?.schedule ?? s.schedule)}. Change anything later in the routine&apos;s settings.</p>
    </div>
  );
}

function DoneActions({ done, onClose, onOpen }: { done: { routines: Routine[] }; onClose: () => void; onOpen: (id: string) => void }) {
  const phone = useIsMobile();
  const [running, setRunning] = useState(false);
  const one = done.routines.length === 1 ? done.routines[0] : undefined;
  const runNow = async () => {
    if (!one) return;
    setRunning(true);
    try {
      const run = await api().runRoutine(one.id);
      upsertRun(run);
      toast({ title: `Started ${one.name}.`, level: 'info', link: run.sessionId ? `/s/${run.sessionId}` : undefined });
      onOpen(one.id);
    } catch (e) {
      toast({ title: `Failed. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    } finally {
      setRunning(false);
    }
  };
  const ctl = phone ? 'touch' : 'md';
  return (
    <>
      <Button variant="quiet" size={ctl} onClick={onClose}>
        Close
      </Button>
      {one && (
        <Button variant="outline" size={ctl} onClick={() => void runNow()} busy={running ? 'Starting' : false}>
          Run now
        </Button>
      )}
      {one && (
        <Button variant="solid" size={ctl} onClick={() => onOpen(one.id)}>
          Open
        </Button>
      )}
    </>
  );
}
