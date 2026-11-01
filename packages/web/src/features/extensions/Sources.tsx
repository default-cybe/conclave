/**
 * Extensions: Sources (docs/extensions/IA.md). Where extensions load from,
 * in precedence order (later wins), with the compat switches; every name
 * defined more than once; and Sync to other CLIs (#sync), which writes
 * your skills and agents into each CLI's folders on a device.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CliName, ExtensionSourceInfo, InventoryItemDto } from '@conclave/core/client';
import type { Device } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { HarnessName } from '@/components/logo';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, OnOff } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { Dialog } from '@/components/ui/Overlay';
import { CodeBlock } from '@/components/ui/Code';
import { SectionHeading } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { save } from '@/features/settings/parts';
import { useExtCwd } from './project';
import { SourceBadge, scopeWord } from './shared/SourceBadge';
import { shortPath } from './shared/ProjectPicker';
import { plural } from '@/lib/format';
import { LoadFailed, RefreshFailed, TOUCH, orList, sentence, useHashScroll } from './shared/parts';
import { addsWords } from './Overview';

const CLI_ROWS: Array<{ cli: CliName; harness: string; label: string }> = [
  { cli: 'claude', harness: 'claude-code', label: 'Claude Code' },
  { cli: 'codex', harness: 'codex', label: 'Codex' },
  { cli: 'opencode', harness: 'opencode', label: 'OpenCode' },
  { cli: 'gemini', harness: 'gemini-cli', label: 'Gemini CLI' },
];

const COMPAT_WORD: Record<string, string> = { codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI', claudeCode: 'Claude Code' };

export function SourcesTab() {
  const cwd = useExtCwd();
  const src = useLoad(() => api().extensionSources(cwd), [cwd]);
  const inv = useLoad(() => api().extensionsInventory({ cwd }), [cwd]);
  // scroll once both lists are in, so rows that arrive later do not push the target down
  const settled = (!!src.data || !!src.error) && (!!inv.data || !!inv.error);
  useHashScroll('sync', settled);
  useHashScroll('conflicts', settled);
  const reload = () => {
    src.reload();
    inv.reload();
  };
  return (
    <div className="space-y-10">
      <LoadOrder src={src.data} error={src.error} loading={src.loading} retry={src.reload} onChanged={reload} />
      <Conflicts items={inv.data} error={inv.error} loading={inv.loading} retry={inv.reload} />
      <Sync onSynced={reload} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Load order
// ---------------------------------------------------------------------------

function LoadOrder({ src, error, loading, retry, onChanged }: { src: ExtensionSourceInfo[] | undefined; error?: string; loading: boolean; retry: () => void; onChanged: () => void }) {
  const mobile = useIsMobile();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // keep the chosen value until fresh data arrives, so the control never flips back for a moment
  useEffect(() => setPending({}), [src]);
  const set = async (key: string, v: boolean) => {
    setPending((p) => ({ ...p, [key]: v }));
    if (await save({ compat: { [key]: v } })) return onChanged();
    setPending((p) => {
      const n = { ...p };
      delete n[key];
      return n;
    });
  };
  return (
    <section aria-labelledby="order-h">
      <SectionHeading id="order-h" count={src?.length}>
        Load order
      </SectionHeading>
      {error && !src ? (
        <LoadFailed what="sources" error={error} retry={retry} />
      ) : !src ? (
        <LoadingRows loading={loading} rows={6} />
      ) : (
        <>
        <RefreshFailed error={error} retry={retry} className="pt-2" />
        <ol className="rows m-0 list-none p-0">
          {src.map((s, i) => {
            const toggle = typeof s.toggle === 'string' ? s.toggle : null;
            const on = toggle ? (pending[toggle] ?? s.on) : s.on;
            const adds = addsWords(s.counts);
            return (
              <li key={s.id} className={cn('grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 py-[var(--row-py)] phone:grid-cols-[22px_minmax(0,1fr)] phone:gap-y-2', !on && 'text-fg-3')}>
                <span className="num pt-px text-[12px] text-fg-3 phone:text-[13px]">{i + 1}</span>
                <div className="min-w-0">
                  <div className={cn('t-row', on ? 'text-fg' : 'text-fg-2')}>{s.label}</div>
                  <div className="mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{on ? (adds ? `Adds ${adds}` : 'Nothing found here') : 'Off, nothing is read'}</div>
                  {s.paths.length > 0 && (
                    <div className="mt-0.5 text-[11.5px] leading-[1.5] text-fg-3 phone:text-[12px]">
                      {s.paths.map((p, k) => (
                        <span key={p} className="mono [overflow-wrap:anywhere]">
                          {k > 0 && ', '}
                          {shortPath(p)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="phone:col-start-2">
                  {toggle ? (
                    <OnOff checked={on} onChange={(v) => void set(toggle, v)} label={`Read ${s.label}`} size={mobile ? 'touch' : 'sm'} />
                  ) : Array.isArray(s.toggle) ? (
                    <span className="block max-w-[220px] text-right text-[12px] leading-[1.45] text-fg-3 phone:max-w-none phone:text-left phone:text-[13px]">
                      {s.on ? 'On while' : 'Off until'} {orList(s.toggle.map((k) => COMPAT_WORD[k] ?? k))} is on
                    </span>
                  ) : (
                    <span className="text-[12px] text-fg-3 phone:text-[13px]">Always on</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

interface Conflict {
  kind: InventoryItemDto['kind'];
  name: string;
  winner?: InventoryItemDto;
  shadowed: InventoryItemDto[];
}

function Conflicts({ items, error, loading, retry }: { items: InventoryItemDto[] | undefined; error?: string; loading: boolean; retry: () => void }) {
  const [compare, setCompare] = useState<Conflict>();
  const list = useMemo<Conflict[]>(() => {
    const by = new Map<string, InventoryItemDto[]>();
    for (const i of items ?? []) by.set(`${i.kind}\u0000${i.name}`, [...(by.get(`${i.kind}\u0000${i.name}`) ?? []), i]);
    return [...by.values()]
      .filter((v) => v.length > 1)
      .map((v) => ({ kind: v[0].kind, name: v[0].name, winner: v.find((x) => x.active), shadowed: v.filter((x) => !x.active) }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }, [items]);
  return (
    <section id="conflicts" aria-labelledby="conflicts-h" className="scroll-mt-6">
      <SectionHeading id="conflicts-h" count={items ? list.length : undefined}>
        Conflicts
      </SectionHeading>
      {error && !items ? (
        <LoadFailed what="the inventory" error={error} retry={retry} className="pt-2" />
      ) : !items ? (
        <LoadingRows loading={loading} rows={3} />
      ) : list.length === 0 ? (
        <>
          <RefreshFailed error={error} retry={retry} className="pt-2" />
          <p className="py-3 text-[13px] text-fg-2 phone:text-[14px]">No name is defined twice.</p>
        </>
      ) : (
        <div className="rows">
          <RefreshFailed error={error} retry={retry} className="pt-2" />
          {list.map((c) => (
            <div key={`${c.kind}:${c.name}`} className="py-[var(--row-py)]">
              <div className="flex items-baseline gap-3">
                <span className="mono min-w-0 truncate text-[13px] text-fg">{c.kind === 'command' ? `/${c.name}` : c.name}</span>
                <span className="text-[12px] text-fg-3 phone:text-[13px]">{c.kind}</span>
                {c.winner?.path && c.shadowed.some((s) => s.path) && (
                  <button type="button" onClick={() => setCompare(c)} className="tap ml-auto shrink-0 text-[12px] text-fg-3 hover:text-fg phone:py-px phone:text-[13px]">
                    Compare files
                  </button>
                )}
              </div>
              {c.winner && (
                <p className="mt-1 text-[12px] leading-[1.45] text-fg-2 phone:text-[13px]">
                  <span className="text-fg">In use:</span> {scopeWord(c.winner.scope)}
                  {c.winner.path && (
                    <>
                      , <span className="mono break-all text-fg-3">{shortPath(c.winner.path)}</span>
                    </>
                  )}
                </p>
              )}
              {c.shadowed.map((s, i) => (
                <p key={i} className="mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                  Shadowed: {scopeWord(s.scope)}
                  {s.path && (
                    <>
                      , <span className="mono break-all">{shortPath(s.path)}</span>
                    </>
                  )}
                </p>
              ))}
              {c.shadowed.some((s) => s.source === 'builtin') && <p className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">Your copy replaces the built-in one. Delete it to get the shipped version back.</p>}
            </div>
          ))}
        </div>
      )}
      <CompareDialog c={compare} onClose={() => setCompare(undefined)} />
    </section>
  );
}

function FileText({ item }: { item: InventoryItemDto }) {
  const f = useLoad(async () => (item.path ? (await api().readDeviceFile('local', item.path)).content : ''), [item.path]);
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[12px] leading-[1.45] text-fg-3">
        <span className={cn(item.active ? 'text-fg' : 'text-fg-2')}>{item.active ? 'In use' : 'Shadowed'}</span>, <SourceBadge source={item.source} plugin={item.plugin} />
        <br />
        <span className="mono break-all">{item.path ? shortPath(item.path) : ''}</span>
      </p>
      {f.error ? <p className="text-[13px] text-fault">Could not read the file. {f.error}</p> : f.data === undefined ? <LoadingRows loading={f.loading} rows={2} /> : <CodeBlock code={f.data || '(empty file)'} wrap maxLines={40} />}
    </div>
  );
}

function CompareDialog({ c, onClose }: { c: Conflict | undefined; onClose: () => void }) {
  const mobile = useIsMobile();
  const files = c ? [c.winner, ...c.shadowed].filter((x): x is InventoryItemDto => !!x?.path) : [];
  return (
    <Dialog open={!!c} onClose={onClose} title={c ? `${c.kind === 'command' ? '/' : ''}${c.name}` : ''} description={c ? `Defined in ${files.length} places. The first one is in use.` : undefined} width={mobile ? undefined : 960} top="6vh">
      <div className={cn('grid gap-5', !mobile && files.length > 1 && 'grid-cols-2')}>
        {files.map((f, i) => (
          <FileText key={i} item={f} />
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sync to other CLIs
// ---------------------------------------------------------------------------

function installed(d: Device | undefined, cli: CliName): string | undefined {
  return (d?.info?.clis as Record<string, string> | undefined)?.[cli];
}

function Sync({ onSynced }: { onSynced: () => void }) {
  const devices = useHub((s) => s.devices);
  const list = Object.values(devices).sort((a, b) => (a.id === 'local' ? -1 : b.id === 'local' ? 1 : a.name.localeCompare(b.name)));
  const [device, setDevice] = useState('local');
  const dev = devices[device];
  const [clis, setClis] = useState<Set<CliName>>(new Set(['claude']));
  const [result, setResult] = useState<{ dryRun: boolean; written: string[]; device: string } | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'preview' | 'sync' | null>(null);

  // detected installs are pre-checked; Claude Code always. Keyed on what is installed, not on the
  // device object, so a heartbeat that refreshes the device list does not undo the owner's picks.
  const found = CLI_ROWS.filter((c) => installed(dev, c.cli)).map((c) => c.cli).join(',');
  useEffect(() => {
    setClis(new Set<CliName>(['claude', ...(found ? (found.split(',') as CliName[]) : [])]));
    setResult(null);
    setError(undefined);
  }, [device, found]);
  const offline = !!dev && !dev.online;

  const run = async (dryRun: boolean) => {
    if (!clis.size) return setError('Pick at least one CLI.');
    setBusy(dryRun ? 'preview' : 'sync');
    setError(undefined);
    try {
      const r = await api().syncClis({ device: device === 'local' ? undefined : device, only: [...clis], dryRun });
      setResult({ dryRun, written: r.written, device: dev?.name ?? device });
      // written files can add copies in ~/.claude and ~/.agents, so the lists above change
      if (!dryRun) onSynced();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/offline/i.test(msg) ? `${dev?.name ?? device} is offline. Start the Conclave daemon there, or pick another device.` : `Could not sync. ${sentence(msg)} Try again, or pick another device.`);
      setResult(null);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (c: CliName, v: boolean) =>
    setClis((s) => {
      const n = new Set(s);
      if (v) n.add(c);
      else n.delete(c);
      return n;
    });

  return (
    <section id="sync" aria-labelledby="sync-h" className="scroll-mt-6">
      <SectionHeading id="sync-h">Sync to other CLIs</SectionHeading>
      <div className="max-w-[72ch] space-y-1.5 pt-2.5 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
        <p>Copies the skills and agents you made in Conclave into each CLI's own folders on a device, so the same set works everywhere.</p>
        <p className="text-[12px] text-fg-3 phone:text-[13px]">
          Skills go to <span className="mono">~/.claude/skills</span> and <span className="mono">~/.agents/skills</span>. Agents go out in each CLI's own format. Conclave only overwrites files it created: each copy gets a <span className="mono">.conclave-managed</span> marker, and a file without one is left alone.
        </p>
      </div>

      <div className="mt-4 grid max-w-[720px] gap-x-8 gap-y-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <Field label="Device">
          <SelectMenu
            value={device}
            onChange={setDevice}
            label="Device"
            options={list.map((d) => ({ value: d.id, label: d.name, text: d.name, hint: d.online ? undefined : <span className="text-fg-3">offline</span>, detail: d.id === 'local' ? 'The hub' : d.info?.hostname }))}
          />
        </Field>
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">CLIs</legend>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {CLI_ROWS.map((c) => {
              const v = installed(dev, c.cli);
              return (
                <Checkbox
                  key={c.cli}
                  checked={clis.has(c.cli)}
                  onChange={(on) => toggle(c.cli, on)}
                  label={<HarnessName harness={c.harness} size={13} />}
                  description={v ? `${v} installed` : 'not installed'}
                  className="py-1.5 phone:py-2.5"
                />
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" className={TOUCH} busy={busy === 'preview' ? 'Checking' : false} onClick={() => void run(true)} disabled={busy === 'sync' || offline}>
          Preview
        </Button>
        <Button variant="solid" className={TOUCH} busy={busy === 'sync' ? 'Syncing' : false} onClick={() => void run(false)} disabled={busy === 'preview' || offline}>
          Sync
        </Button>
      </div>
      {offline && !error && <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">{dev.name} is offline. Preview and Sync need it online. Start the Conclave daemon there, or pick another device.</p>}
      {error && (
        <p className="mt-3 text-[13px] text-fault phone:text-[14px]" role="alert">
          {error}
        </p>
      )}
      {result && <SyncResult {...result} />}
    </section>
  );
}

function SyncResult({ dryRun, written, device }: { dryRun: boolean; written: string[]; device: string }) {
  const files = written.filter((f) => !/\.conclave-managed$/.test(f));
  const markers = written.length - files.length;
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of files) {
      const short = shortPath(f);
      const parts = short.split('/');
      const skill = parts.indexOf('skills');
      const dir = skill >= 0 ? parts.slice(0, skill + 1).join('/') : parts.slice(0, -1).join('/');
      m.set(dir, [...(m.get(dir) ?? []), short.slice(dir.length + 1)]);
    }
    return [...m];
  }, [files]);
  if (!written.length)
    return (
      <p className="mt-4 border-t border-rule pt-3 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]" role="status">
        Nothing to write on {device}. Sync copies skills and agents you made in Conclave, in ~/.conclave, and files another tool owns are skipped.
      </p>
    );
  return (
    <div className="mt-4 border-t border-rule pt-3" role="status" aria-live="polite">
      <p className="text-[13px] text-fg phone:text-[14px]">
        {dryRun ? `Preview: ${plural(files.length, 'file')} would be written on ${device}.` : `Wrote ${plural(files.length, 'file')} on ${device}.`}
        {markers > 0 && (
          <span className="text-fg-3">
            {' '}
            Plus {plural(markers, 'marker file')} (<span className="mono">.conclave-managed</span>) so a later sync knows {markers === 1 ? 'it is' : 'they are'} Conclave's.
          </span>
        )}
      </p>
      <div className="rows mt-2">
        {groups.map(([dir, names]) => (
          <div key={dir} className="py-2">
            <div className="mono text-[12px] text-fg-3 break-all">{dir}/</div>
            <div className="mono mt-0.5 text-[12.5px] leading-[1.6] text-fg break-words">
              {names.map((n, i) => (
                <span key={n}>
                  {i > 0 && ', '}
                  {n}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {dryRun && <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">Nothing was written. Press Sync to write these files.</p>}
    </div>
  );
}
