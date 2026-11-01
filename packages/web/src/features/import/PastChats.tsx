/**
 * Past chats (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.4, 1.5, 1.14): the
 * scan of one device grouped by project, filters, the mode, the cost line and
 * Start. Used on Memory, in the Sessions import sheet, in onboarding and in
 * Settings. The hub reads the device; the list shows the last scan when the
 * device is offline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExternalSessionInfo, ImportBatchInput, ImportEstimate, ImportMode, ImportProjectGroup, ImportRetention, ImportScanPage, ImportScanQuery, ImportSource } from '@conclave/core/client';
import type { Device } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { relTime, shortDate } from '@/lib/format';
import { cn } from '@/lib/text';
import { toast, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Checkbox, Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { Notice, TextAction } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { StateWord } from '@/components/ui/List';
import { HarnessMark } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { addUpload, loadBatches, upsertBatch, useImport } from './store';
import { MODE_HELP, MODES, SOURCE_HARNESS, SOURCE_NAME, dateRange, estimateLine, rowState, skippedLine } from './words';
import { errText } from '@/features/settings/parts';

const DAY = 86_400_000;
const CLIS = ['claude', 'codex', 'gemini'];
type Since = 'any' | '30' | '90' | '365';
type SourceFilter = 'all' | ImportSource;

interface Selection {
  all: boolean;
  groups: Set<string>;
  keys: Set<string>;
  exclude: Set<string>;
}
const EMPTY: Selection = { all: false, groups: new Set(), keys: new Set(), exclude: new Set() };

/** Devices worth scanning: the hub and paired computers with a coding CLI, online first. */
function useScanDevices(): Device[] {
  const devices = useHub((s) => s.devices);
  return useMemo(
    () =>
      Object.values(devices)
        .filter((d) => d.id === 'local' || CLIS.some((c) => d.info?.clis?.[c]))
        .sort((a, b) => Number(b.online) - Number(a.online) || Number(CLIS.some((c) => b.info?.clis?.[c])) - Number(CLIS.some((c) => a.info?.clis?.[c])) || a.name.localeCompare(b.name)),
    [devices],
  );
}

export function useDeviceNames(): Record<string, string> {
  const devices = useHub((s) => s.devices);
  return useMemo(() => Object.fromEntries(Object.values(devices).map((d) => [d.id, d.name])), [devices]);
}

export interface PastChatsProps {
  /** Start on this device (else the first online computer with a coding CLI). */
  device?: string;
  /** Tighter layout for the onboarding step and the sheet. */
  compact?: boolean;
  /** Called with the batch once the hub started it. */
  onStarted?: (batchId: string) => void;
  /** Hide the upload line (onboarding). */
  noUpload?: boolean;
}

export function PastChats({ device: initial, compact, onStarted, noUpload }: PastChatsProps) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const devices = useScanDevices();
  const uploads = useImport((s) => s.uploads);
  const memoryOn = useHub((s) => (s.config as { memory?: { enabled?: boolean } } | undefined)?.memory?.enabled !== false);
  const [device, setDevice] = useState<string | undefined>(initial);
  const dev = device ?? devices.find((d) => d.online && d.id !== 'local')?.id ?? devices[0]?.id ?? 'local';
  const [source, setSource] = useState<SourceFilter>('all');
  const [since, setSince] = useState<Since>('any');
  const [hideImported, setHideImported] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [page, setPage] = useState<ImportScanPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [rows, setRows] = useState<Record<string, ExternalSessionInfo[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Selection>(EMPTY);
  const [mode, setMode] = useState<ImportMode>(memoryOn ? 'chats-learn' : 'chats');
  const [estimate, setEstimate] = useState<ImportEstimate>();
  const [starting, setStarting] = useState(false);
  const [fixing, setFixing] = useState<string>();
  const seq = useRef(0);

  useEffect(() => {
    if (initial) setDevice(initial);
  }, [initial]);

  const query: Omit<ImportScanQuery, 'cursor' | 'limit' | 'refresh' | 'device'> = useMemo(
    () => ({
      ...(source !== 'all' ? { sources: [source] } : {}),
      ...(since !== 'any' ? { since: Date.now() - Number(since) * DAY } : {}),
      includeImported: !hideImported,
      includeSkipped: showSkipped,
    }),
    // since is a window from now; recomputing it on every render would refetch forever
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, since, hideImported, showSkipped],
  );

  const load = async (refresh = false) => {
    const n = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      const p = await api().importScan({ device: dev, ...query, limit: 1, refresh });
      if (n !== seq.current) return;
      setPage(p);
      setRows({});
      setOpen(new Set());
    } catch (e) {
      if (n === seq.current) setError(errText(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  };

  // a new device or filter starts the selection over
  useEffect(() => {
    setSel(EMPTY);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev, query]);

  const groupRows = async (g: ImportProjectGroup): Promise<ExternalSessionInfo[]> => {
    if (rows[g.key]) return rows[g.key];
    const r = await api().importScan({ device: dev, ...query, project: g.key, limit: 500 });
    setRows((m) => ({ ...m, [g.key]: r.items }));
    return r.items;
  };

  const toggleOpen = (g: ImportProjectGroup) => {
    const next = new Set(open);
    if (next.has(g.key)) next.delete(g.key);
    else {
      next.add(g.key);
      void groupRows(g).catch((e) => toast({ title: errText(e), level: 'error' }));
    }
    setOpen(next);
  };

  const groups = page?.groups ?? [];
  const pickable = (x: ExternalSessionInfo) => !x.parentKey && (!x.skip || showSkipped);
  const isPicked = (x: ExternalSessionInfo, groupKey: string) => (sel.all || sel.groups.has(groupKey) ? !sel.exclude.has(x.key) && !x.skip : sel.keys.has(x.key));
  const groupState = (g: ImportProjectGroup): 'all' | 'some' | 'none' => {
    if (sel.all || sel.groups.has(g.key)) return [...sel.exclude].some((k) => rows[g.key]?.some((x) => x.key === k)) ? 'some' : 'all';
    return rows[g.key]?.some((x) => sel.keys.has(x.key)) ? 'some' : 'none';
  };

  const pickGroup = (g: ImportProjectGroup, on: boolean) => {
    setSel((s) => {
      const groupsSet = new Set(s.groups);
      const keys = new Set(s.keys);
      const exclude = new Set(s.exclude);
      for (const x of rows[g.key] ?? []) {
        keys.delete(x.key);
        exclude.delete(x.key);
      }
      if (s.all) {
        if (!on) for (const x of rows[g.key] ?? []) exclude.add(x.key);
        if (!on && !rows[g.key]) groupsSet.add(`!${g.key}`);
        else groupsSet.delete(`!${g.key}`);
        return { ...s, groups: groupsSet, keys, exclude };
      }
      if (on) groupsSet.add(g.key);
      else groupsSet.delete(g.key);
      return { ...s, groups: groupsSet, keys, exclude };
    });
    if (on || sel.all) void groupRows(g).catch(() => {});
  };

  const pickRow = (x: ExternalSessionInfo, groupKey: string, on: boolean) => {
    setSel((s) => {
      if (s.all || s.groups.has(groupKey)) {
        const exclude = new Set(s.exclude);
        if (on) exclude.delete(x.key);
        else exclude.add(x.key);
        const keys = new Set(s.keys);
        if (on && x.skip) keys.add(x.key);
        return { ...s, exclude, keys };
      }
      const keys = new Set(s.keys);
      if (on) keys.add(x.key);
      else keys.delete(x.key);
      return { ...s, keys };
    });
  };

  const nothing = !sel.all && !sel.groups.size && !sel.keys.size;

  /** The selection as the hub takes it: the whole query, or keys. */
  const toInput = async (): Promise<Omit<ImportBatchInput, 'mode'> | undefined> => {
    if (nothing) return undefined;
    const skippedPicked = [...sel.keys].some((k) => Object.values(rows).some((list) => list.some((x) => x.key === k && x.skip)));
    if (sel.all) {
      const outGroups = [...sel.groups].filter((k) => k.startsWith('!')).map((k) => k.slice(1));
      const exclude = new Set(sel.exclude);
      for (const gk of outGroups) {
        const g = groups.find((x) => x.key === gk);
        if (g) for (const x of await groupRows(g)) exclude.add(x.key);
      }
      return { device: dev, query, ...(exclude.size ? { exclude: [...exclude] } : {}) };
    }
    const keys = new Set(sel.keys);
    for (const gk of sel.groups) {
      const g = groups.find((x) => x.key === gk);
      if (!g) continue;
      for (const x of await groupRows(g)) if (!x.skip && !x.parentKey && !sel.exclude.has(x.key)) keys.add(x.key);
    }
    return { device: dev, keys: [...keys], ...(skippedPicked ? { includeSkipped: true } : {}) };
  };

  // the cost line follows the selection and the mode
  useEffect(() => {
    if (nothing) {
      setEstimate(undefined);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const input = await toInput();
        if (!input || !alive) return;
        const e = await api().importEstimate({ ...input, mode });
        if (alive) setEstimate(e);
      } catch {
        if (alive) setEstimate(undefined);
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, mode, dev, query]);

  const start = async () => {
    setStarting(true);
    try {
      const input = await toInput();
      if (!input) return;
      const b = await api().startImport({ ...input, mode });
      upsertBatch(b);
      void loadBatches(true);
      toast({ title: `${MODES.find((m) => m.value === mode)!.label} started for ${b.total - b.skipped} chats.`, body: 'It keeps going when you leave this page.', level: 'success' });
      setSel(EMPTY);
      onStarted?.(b.id);
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const fix = async (r: ImportRetention) => {
    setFixing(r.tool);
    try {
      const after = await api().fixImportRetention(r.device, r.tool);
      setPage((p) => (p ? { ...p, retention: after } : p));
      toast({ title: `${SOURCE_NAME[r.tool]} keeps chats for 10 years now.`, level: 'success' });
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    } finally {
      setFixing(undefined);
    }
  };

  const deviceOptions = [
    ...devices.map((d) => ({
      value: d.id,
      label: d.name,
      text: d.name,
      detail: d.online ? CLIS.filter((c) => d.info?.clis?.[c]).map((c) => ({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' })[c as 'claude']).join(', ') || 'the hub' : 'offline, last scan kept',
      hint: <span className={d.online ? 'text-ok' : 'text-fg-3'}>{d.online ? 'online' : 'offline'}</span>,
    })),
    ...uploads.map((u, i) => ({
      value: `upload:${u.uploadId}`,
      label: `${SOURCE_NAME[u.source]} export`,
      text: `${SOURCE_NAME[u.source]} export`,
      detail: `${u.items} conversations${u.name ? `, ${u.name}` : ''}`,
      ...(i === 0 ? { group: 'Uploaded exports' } : {}),
    })),
  ];

  const counts = page?.counts;
  const total = groups.reduce((n, g) => n + g.sessions, 0);
  const risky = (page?.retention ?? []).filter((r) => r.risk === 'high');
  const sources = [...new Set(groups.flatMap((g) => g.sources))];
  const est = estimate ? estimateLine(estimate, mode) : undefined;
  const skippedText = estimate ? skippedLine(estimate) : '';
  const scanWord = page?.offline ? `Offline, last read ${page.scannedAt ? `${relTime(page.scannedAt)} ago` : 'never'}` : page?.scannedAt ? `Read ${relTime(page.scannedAt) === 'now' ? 'just now' : `${relTime(page.scannedAt)} ago`}` : '';
  const chosen = estimate?.sessions ?? (sel.keys.size || 0);

  return (
    <div className={cn('min-w-0', compact ? 'space-y-5' : 'space-y-6')}>
      <div className={cn('flex gap-x-5 gap-y-3', mobile ? 'flex-col' : 'flex-wrap items-end')}>
        <div className={cn(mobile ? 'w-full' : 'w-[300px]')}>
          <span className="mb-1.5 block text-[12px] text-fg-2 phone:text-[13px]">Device</span>
          <SelectMenu label="Device" value={dev} onChange={setDevice} width={320} options={deviceOptions} />
        </div>
        <div className="flex min-h-[30px] flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-3 phone:text-[13px]">
          {loading ? <LiveStatus state="tool" label="Reading the chats" size={14} /> : scanWord && <span>{scanWord}</span>}
          {!dev.startsWith('upload:') && !loading && <TextAction label="Read again" onClick={() => void load(true)} />}
        </div>
      </div>

      {!noUpload && <UploadLine onUploaded={(id) => setDevice(`upload:${id}`)} />}

      {risky.map((r) => (
        <Notice key={`${r.device}:${r.tool}`} tone="warn" action={r.fixable ? { label: fixing === r.tool ? 'Saving' : 'Keep 10 years', onClick: () => void fix(r) } : undefined}>
          {r.text}
        </Notice>
      ))}

      {error && (
        <Notice tone="fault" action={{ label: 'Try again', onClick: () => void load(true) }}>
          {`Failed. ${error}`}
        </Notice>
      )}
      {(page?.failed ?? []).map((f) => (
        <Notice key={f.source} tone="fault">{`Failed. ${SOURCE_NAME[f.source]} chats could not be read. ${errText(f.error)}`}</Notice>
      ))}

      {page && (
        <div className="space-y-3">
          <div className={cn('flex gap-x-5 gap-y-2.5', mobile ? 'flex-col' : 'flex-wrap items-center')}>
            {sources.length > 1 && (
              <FilterLinks
                label="Source"
                value={source}
                onChange={setSource}
                options={[{ value: 'all' as SourceFilter, label: 'All' }, ...sources.map((s) => ({ value: s as SourceFilter, label: SOURCE_NAME[s] }))]}
              />
            )}
            <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-2', !mobile && 'ml-auto')}>
              <SelectMenu
                look="text"
                prefix="Since"
                label="Since"
                value={since}
                onChange={setSince}
                width={200}
                options={[
                  { value: 'any', label: 'any time' },
                  { value: '30', label: 'the last 30 days' },
                  { value: '90', label: 'the last 90 days' },
                  { value: '365', label: 'the last year' },
                ]}
              />
              <Checkbox checked={hideImported} onChange={setHideImported} label="Hide imported" />
              <Checkbox checked={showSkipped} onChange={setShowSkipped} label="Show skipped" />
            </div>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="m-0 min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">
              {total ? (
                <>
                  <span className="num">{total}</span> {total === 1 ? 'chat' : 'chats'} in <span className="num">{groups.length}</span> {groups.length === 1 ? 'project' : 'projects'}
                  {counts?.imported ? <>, <span className="num">{counts.imported}</span> imported</> : null}
                  {counts?.behind ? <>, <span className="num">{counts.behind}</span> with new messages</> : null}
                  {counts?.diverged ? <>, <span className="num">{counts.diverged}</span> continued in both places</> : null}
                  {counts?.skipped ? <>, <span className="num">{counts.skipped}</span> skipped</> : null}.
                </>
              ) : (
                'No past chats here with these filters.'
              )}
            </p>
            {total > 0 && (
              <span className="flex gap-4">
                <TextAction label={sel.all ? 'Clear' : 'Select all'} onClick={() => setSel(sel.all ? EMPTY : { ...EMPTY, all: true })} />
                {!sel.all && !nothing && <TextAction label="Clear" onClick={() => setSel(EMPTY)} />}
              </span>
            )}
          </div>

          {groups.length > 0 && (
            <div className={cn('scroll-y border-y border-rule', compact ? 'max-h-[380px]' : 'max-h-[520px]', mobile && 'max-h-none')} role="group" aria-label="Past chats by project">
              <div className="rows">
                {groups.map((g) => (
                  <GroupRow
                    key={g.key}
                    group={g}
                    open={open.has(g.key)}
                    rows={rows[g.key]}
                    state={groupState(g)}
                    onOpen={() => toggleOpen(g)}
                    onPick={(on) => pickGroup(g, on)}
                    picked={(x) => isPicked(x, g.key)}
                    pickable={pickable}
                    onPickRow={(x, on) => pickRow(x, g.key, on)}
                    mobile={mobile}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {page && total > 0 && (
        <div className="space-y-4 border-t border-rule-2 pt-5">
          <div>
            <Segmented label="What to import" value={mode} onChange={setMode} size={size} full={mobile} options={MODES.map((m) => ({ value: m.value, label: mobile ? m.short : m.label }))} />
            <p className="m-0 mt-2 max-w-[64ch] text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
              {MODE_HELP[mode]}
              {mode !== 'chats' && !memoryOn && ' Memory is off on this hub, so turn it on in Memory first.'}
            </p>
          </div>
          <div className={cn('flex gap-x-5 gap-y-3', mobile ? 'flex-col items-stretch' : 'flex-wrap items-center')}>
            <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={() => void start()} disabled={nothing || starting || !chosen} busy={starting ? 'Starting' : false} full={mobile}>
              {nothing ? 'Pick chats first' : mode === 'learn' ? `Learn from ${chosen} ${chosen === 1 ? 'chat' : 'chats'}` : `Import ${chosen} ${chosen === 1 ? 'chat' : 'chats'}`}
            </Button>
            <div className="min-w-0 flex-1 text-[13px] leading-[1.5] phone:text-[14px]">
              {est ? (
                <>
                  <span className="text-fg-2">{est.lead}</span>
                  {est.rest && <span className="text-fg-3"> {est.rest}</span>}
                  {skippedText && <span className="block text-[12px] text-fg-3 phone:text-[13px]">{skippedText}</span>}
                </>
              ) : (
                <span className="text-fg-3">{nothing ? 'Tick a project or a chat, or Select all.' : 'Working out the cost.'}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupRow({
  group: g,
  open,
  rows,
  state,
  onOpen,
  onPick,
  picked,
  pickable,
  onPickRow,
  mobile,
}: {
  group: ImportProjectGroup;
  open: boolean;
  rows?: ExternalSessionInfo[];
  state: 'all' | 'some' | 'none';
  onOpen: () => void;
  onPick: (on: boolean) => void;
  picked: (x: ExternalSessionInfo) => boolean;
  pickable: (x: ExternalSessionInfo) => boolean;
  onPickRow: (x: ExternalSessionInfo, on: boolean) => void;
  mobile: boolean;
}) {
  const where = g.repo ?? g.cwd;
  const meta = [g.sources.map((s) => SOURCE_NAME[s]).join(', '), `${g.sessions} ${g.sessions === 1 ? 'chat' : 'chats'}`, g.imported ? `${g.imported} imported` : '', g.skipped ? `${g.skipped} skipped` : '', dateRange(g.first, g.last)].filter(Boolean).join(', ');
  return (
    <div className="py-2.5">
      <div className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-3">
        <PickBox checked={state === 'all'} indeterminate={state === 'some'} onChange={onPick} label={`Import the ${g.name} chats`} />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{g.name}</div>
          <div className="truncate text-[12px] text-fg-3 phone:text-[13px]">
            {where && where !== g.name && <span className="mono">{where}</span>}
            {where && where !== g.name && ', '}
            {meta}
          </div>
        </div>
        <TextAction label={open ? 'Hide' : 'Show'} onClick={onOpen} className="pt-0.5" />
      </div>
      {open && (
        <div className="mt-2 ml-[26px] anim-fade">
          {!rows && <p className="m-0 py-1.5 text-[12px] text-fg-3">Loading the chats.</p>}
          {rows && (
            <div className="rows border-t border-rule">
              {rows.map((x) => {
                const st = rowState(x);
                const harness = SOURCE_HARNESS[x.source];
                const can = pickable(x);
                return (
                  <div key={x.key} className={cn('grid cursor-default items-start gap-x-3 py-[7px] hov:bg-hover', x.parentKey && 'pl-5', mobile ? 'grid-cols-[14px_minmax(0,1fr)]' : 'grid-cols-[14px_minmax(0,1fr)_auto]')}>
                    <PickBox checked={can && picked(x)} disabled={!can} onChange={(v) => onPickRow(x, v)} label={`Import ${x.title}`} />
                    <span className="min-w-0">
                      <span className={cn('block truncate text-[13px] phone:text-[14.5px]', x.skip ? 'text-fg-2' : 'text-fg')}>{x.title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-fg-3 phone:text-[13px]">
                        {harness && <HarnessMark harness={harness} size={13} />}
                        <span className="truncate">
                          {SOURCE_NAME[x.source]}, {shortDate(x.updatedAt)}, {x.humanPrompts} {x.humanPrompts === 1 ? 'prompt' : 'prompts'}
                          {mobile && <>, {st.word}</>}
                        </span>
                      </span>
                    </span>
                    {!mobile && (
                      <StateWord tone={st.tone} className="pt-0.5 text-right text-[12px]">
                        {st.word}
                      </StateWord>
                    )}
                  </div>
                );
              })}
              {!rows.length && <p className="m-0 py-2 text-[12px] text-fg-3">No chats in this project with these filters.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A checkbox in a row, named for screen readers only (the row says what it is). */
function PickBox({ label, ...p }: { label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex">
      <Checkbox {...p} />
      <span className="sr-only">{label}</span>
    </label>
  );
}

/** Upload a claude.ai or ChatGPT export: the zip as it came, or its conversations.json. */
function UploadLine({ onUploaded }: { onUploaded: (uploadId: string) => void }) {
  const mobile = useIsMobile();
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<'claude-ai' | 'chatgpt'>('claude-ai');
  const [busy, setBusy] = useState(false);
  const pick = (s: 'claude-ai' | 'chatgpt') => {
    setSource(s);
    input.current?.click();
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api().uploadImport(source, file, file.name);
      addUpload(r, file.name);
      toast({ title: `Found ${r.items} ${SOURCE_NAME[r.source]} conversations.`, body: 'Pick the ones to import below.', level: 'success' });
      onUploaded(r.uploadId);
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <p className={cn('m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]', mobile && 'max-w-none')}>
      {busy ? (
        <LiveStatus state="tool" label="Reading the export" size={14} />
      ) : (
        <>
          Chats from the web apps come as an export.{' '}
          <button type="button" className="link" onClick={() => pick('claude-ai')}>
            Upload a claude.ai export
          </button>{' '}
          or{' '}
          <button type="button" className="link" onClick={() => pick('chatgpt')}>
            a ChatGPT export
          </button>
          .
        </>
      )}
      <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} aria-label="Export file" />
    </p>
  );
}
