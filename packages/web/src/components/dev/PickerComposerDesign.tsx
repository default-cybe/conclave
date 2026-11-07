/**
 * Design mock, not wired to sessions (docs/design/PICKER-COMPOSER.md), at
 * /dev/picker-composer:
 *
 * - Model picker: search, then a row of maker segments (All, Anthropic,
 *   OpenAI, Google, Z.ai, Other), then the maker's models most capable first
 *   with a capability line under each, pinned and recent on top, Effort at
 *   the foot. Routes ("via"), the unavailable reason and Add key stay.
 * - Composer: agent, mode (with Ultra) and memory as text pickers in the
 *   quiet row next to the model; "+" keeps files and add-ons only.
 * - Two quieter versions of busy places: the session panel as Settings-like
 *   rows, and sidebar session rows without the device column and dots.
 *
 * `?part=picker|composer|panel|sidebar` opens one part, for screenshots.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Folder, Pin } from 'lucide-react';
import type { SessionMode } from '@conclave/core/types';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { contextLabel, modelName } from '@/lib/models';
import { useModelEffort, type EffortSetting } from '@/lib/effort';
import { Page, PageHeader } from '@/components/ui/Page';
import { FilterLinks } from '@/components/ui/Tags';
import { Segmented } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { MenuList, Popover, type MenuItem } from '@/components/ui/Overlay';
import { PickerButton, SelectMenu } from '@/components/ui/Select';
import { ModelMark, HarnessMark } from '@/components/logo/Logo';
import { SendStopButton } from '@/components/motion';
import { AgentPicker, DevicePicker } from '@/components/pickers/Pickers';
import { buildPicker, compareModels, price, rowKey, rowName, type Row } from '@/components/pickers/ModelPicker';
import { EffortSegments, ContextRing, effortShown, modelEffortWords, PlusMenu } from '@/features/conversation/ComposerParts';
import { PermissionPicker } from '@/features/chat/pickers';
import { MODES } from '@/features/chat/modes';
import { ULTRA_LINE } from '@/features/workflows/UltraSwitch';

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const TIER: Record<string, number> = { deep: 0, smart: 1, fast: 2 };
const TIER_WORD: Record<string, string> = { deep: 'Deep', smart: 'Smart', fast: 'Fast' };

/**
 * Most capable first: rows that can be picked before the rest, then the
 * catalog's tier (deep, smart, fast, none), then the larger context window,
 * then the higher output price, then the newer model.
 */
export function capabilityRank(a: Row, b: Row): number {
  const tier = (r: Row) => (r.harness ? 4 : (TIER[r.model?.tier ?? ''] ?? 3));
  return (
    Number(!!a.disabled) - Number(!!b.disabled) ||
    tier(a) - tier(b) ||
    (b.model?.contextWindow ?? 0) - (a.model?.contextWindow ?? 0) ||
    (b.model?.outputPrice ?? 0) - (a.model?.outputPrice ?? 0) ||
    compareModels(a.ref, b.ref)
  );
}

/** The maker segments; every other maker, local models and coding agents are Other. */
const TABS = [
  { value: 'all', label: 'All' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'zai', label: 'Z.ai' },
  { value: 'other', label: 'Other' },
] as const;
type Tab = (typeof TABS)[number]['value'];
const tabOf = (groupKey: string): Tab => (TABS.some((t) => t.value === groupKey) ? (groupKey as Tab) : 'other');

/** "Deep, 1M context, vision, tools, thinking, $4 / $20": words in fg-3, as the spec has tags (10.6). */
function capabilityLine(r: Row): string {
  if (r.harness) return r.where ?? 'Coding agent';
  const m = r.model;
  if (!m) return '';
  const can = [m.vision && 'vision', m.tools && 'tools', m.thinking && 'thinking'].filter(Boolean);
  // price before the abilities: on a phone the line wraps to two lines at most, and the price matters more
  return [m.tier && TIER_WORD[m.tier], `${contextLabel(m.contextWindow)} context`, price(m, r.ref.split('/')[0]), ...can].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

const ROW = 'flex min-h-[44px] items-center gap-2.5 rounded-[var(--r-1)] px-2 py-1.5 text-[13px] phone:min-h-14 phone:text-[15px]';

function ModelCatalog({ value, onChange, effort, onEffort, onDone }: { value: string; onChange: (ref: string) => void; effort: EffortSetting | undefined; onEffort: (v: EffortSetting) => void; onDone?: () => void }) {
  const phone = useIsMobile();
  const models = useHub((s) => s.models);
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const secrets = useHub((s) => s.secrets?.providers);
  const limits = useHub((s) => s.limits);
  const accounts = useHub((s) => s.accounts?.accounts);
  const picker = useMemo(() => buildPicker({ models, sessions, devices, secrets, limits, harnesses: true, accounts }), [models, sessions, devices, secrets, limits, accounts]);
  const e = useModelEffort(value);

  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>(() => tabOf(picker.groups.find((g) => g.rows.some((r) => r.ref === value))?.key ?? 'all'));
  // shortcut: pins live in this mock's state; the real picker keeps them in the hub's kv per owner
  const [pinned, setPinned] = useState<string[]>(['anthropic/claude-opus-5-5']);
  const [expanded, setExpanded] = useState<string | null>(null);

  const all = useMemo(() => {
    const rows = picker.groups.flatMap((g) => g.rows);
    // a plan's copy of a model has no tier of its own: it takes the catalog's by name
    const tiers = new Map(rows.filter((r) => r.model?.tier).map((r) => [rowName(r), r.model!.tier]));
    return rows.map((r) => (r.model && !r.model.tier && tiers.has(rowName(r)) ? { ...r, model: { ...r.model, tier: tiers.get(rowName(r)) } } : r));
  }, [picker]);
  const togglePin = (r: Row) => setPinned((p) => (p.includes(r.ref) ? p.filter((x) => x !== r.ref) : [...p, r.ref]));
  const inTab = (r: Row) => tab === 'all' || tabOf(r.groupKey) === tab;
  const needle = q.trim().toLowerCase();
  const found = (r: Row) => !needle || `${rowName(r)} ${r.ref} ${r.group}`.toLowerCase().includes(needle);
  const ranked = all.filter((r) => inTab(r) && found(r)).sort(capabilityRank);
  const pins = needle ? [] : ranked.filter((r) => pinned.includes(r.ref));
  // Recent only on All: a maker's own list is short enough to scan
  const recent = needle || tab !== 'all' ? [] : picker.recent.filter((r) => !pinned.includes(r.ref)).slice(0, 3);
  const group = picker.groups.find((g) => g.key === tab);
  const head = needle ? `Matches for "${q.trim()}"` : tab === 'all' ? 'All models, most capable first' : `${group?.name ?? 'Other'}${group?.word ? `, ${group.word}` : ''}, most capable first`;

  const row = (r: Row, where: string) => {
    const on = r.ref === value;
    const pin = pinned.includes(r.ref);
    const open = expanded === rowKey(r);
    return (
      <div key={`${where}:${rowKey(r)}`}>
        <div
          role="option"
          aria-selected={on}
          aria-disabled={r.disabled || undefined}
          onClick={() => {
            if (r.disabled) return;
            onChange(r.ref);
          }}
          // phones: a long press pins, so rows carry no pin until one is pinned
          onContextMenu={(ev) => {
            if (!phone || r.disabled) return;
            ev.preventDefault();
            togglePin(r);
          }}
          className={cn(ROW, 'group/row cursor-default', !r.disabled && 'hov:bg-hover', r.disabled ? 'text-fg-3' : 'text-fg')}
        >
          {r.harness ? <HarnessMark harness={r.ref} size={18} /> : <ModelMark model={r.ref} size={18} tone={r.disabled ? 'mono' : 'brand'} />}
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="truncate font-medium">{rowName(r)}</span>
              {tab === 'all' && where !== 'recent' && r.groupKey !== 'harness' && <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{r.group}</span>}
              {r.source && <span className="min-w-0 truncate text-[12px] text-fg-3 phone:text-[13px]">via {r.source}</span>}
            </span>
            <span className={cn('block truncate text-[12px] phone:line-clamp-2 phone:text-[13px] phone:whitespace-normal', r.model?.unavailable ? 'text-warn' : 'text-fg-3')}>{r.model?.unavailable ?? (r.disabled && !r.harness ? 'No key for this provider' : capabilityLine(r))}</span>
          </span>
          {r.routes && !r.disabled && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? 'Hide routes' : 'Choose a route'}
              onClick={(ev) => {
                ev.stopPropagation();
                setExpanded(open ? null : rowKey(r));
              }}
              className={cn('shrink-0 rounded-[var(--r-1)] px-1 text-[12px] text-fg-3 hov:text-fg phone:text-[13px]', open && 'text-fg')}
            >
              via
            </button>
          )}
          {r.disabled && !r.harness && !r.model?.unavailable ? (
            <Button variant="quiet" size="sm" onClick={(ev) => ev.stopPropagation()}>
              Add key
            </Button>
          ) : (
            <button
              type="button"
              aria-pressed={pin}
              aria-label={pin ? `Unpin ${rowName(r)}` : `Pin ${rowName(r)}`}
              onClick={(ev) => {
                ev.stopPropagation();
                togglePin(r);
              }}
              className={cn('grid size-6 shrink-0 place-items-center rounded-[var(--r-1)] hov:bg-hover phone:size-9', pin ? 'text-fg-2' : 'text-fg-4 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 phone:hidden')}
            >
              <Pin className="size-3.5" strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <Check className={cn('size-3.5 shrink-0', !on && 'invisible')} strokeWidth={1.75} aria-hidden />
        </div>
        {open &&
          r.routes?.map((rt) => (
            <div key={rt.ref} role="option" aria-selected={value === rt.ref} onClick={() => onChange(rt.ref)} className={cn(ROW, 'min-h-[30px] pl-10 text-[12.5px] text-fg-2 hov:bg-hover phone:min-h-11 phone:text-[14px]')}>
              <span className="min-w-0 flex-1 truncate">
                {rt.first ? 'Default' : `via ${rt.label}`}
                {rt.first && <span className="ml-2 text-fg-3">{r.model?.via ?? rt.label}</span>}
              </span>
              <Check className={cn('size-3.5 shrink-0', value !== rt.ref && 'invisible')} strokeWidth={1.75} aria-hidden />
            </div>
          ))}
      </div>
    );
  };

  const heading = (t: string) => <div className="px-2 pt-2.5 pb-1 text-[12px] font-medium text-fg-3 phone:text-[13px]">{t}</div>;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-rule p-2">
        <input
          value={q}
          onChange={(ev) => setQ(ev.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          className="h-8 w-full rounded-[var(--r-1)] border border-edge bg-sunk px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)] phone:h-11 phone:text-[16px]"
        />
        {/* the effort selector's look; on a phone the row scrolls sideways rather than squeeze six makers */}
        <div className="no-scrollbar -mx-2 overflow-x-auto px-2">
          <Segmented size="sm" full label="Maker" value={tab} onChange={setTab} options={TABS.map((t) => ({ value: t.value, label: t.label }))} />
        </div>
      </div>
      <div role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto p-1" style={{ flexBasis: phone ? '52dvh' : 360 }}>
        {pins.length > 0 && heading('Pinned')}
        {pins.map((r) => row(r, 'pin'))}
        {recent.length > 0 && heading('Recent')}
        {recent.map((r) => row(r, 'recent'))}
        {heading(head)}
        {ranked.length === 0 && <p className="px-2 py-3 text-[13px] text-fg-3">No model matches.</p>}
        {ranked.map((r) => row(r, 'list'))}
      </div>
      {e && (
        <div className="shrink-0 space-y-2 border-t border-rule px-3 pt-2 pb-2.5">
          <div className="flex items-center justify-between text-[12px] text-fg-3 phone:text-[13px]">
            <span>Effort for {modelName(value)}</span>
            {onDone && (
              <button type="button" className="text-fg-3 hov:text-fg" onClick={onDone}>
                Done
              </button>
            )}
          </div>
          <EffortSegments effort={e} value={effortShown(effort, e)} onChange={onEffort} size={phone ? 'touch' : 'sm'} />
        </div>
      )}
    </div>
  );
}

/** The model chip: "Sonnet 5.5 High", opening the catalog (a sheet on phones). */
function ModelChip({ value, onChange, effort, onEffort }: { value: string; onChange: (ref: string) => void; effort: EffortSetting | undefined; onEffort: (v: EffortSetting) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const e = useModelEffort(value);
  const words = modelEffortWords(value, effortShown(effort, e), e);
  return (
    <>
      <PickerButton ref={ref} look="text" aria-label={`Model and effort, ${words}`} aria-haspopup="dialog" aria-expanded={open} className={CHIP} onClick={() => setOpen((o) => !o)}>
        {words}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-end" width={440} maxHeight={600} label="Model and effort" sheetTitle="Model">
        <ModelCatalog value={value} onChange={onChange} effort={effort} onEffort={onEffort} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

type Memory = 'save' | 'use' | 'off';
const MEMORY = [
  { value: 'save' as const, label: 'Use and save', text: 'Memory', detail: 'Recall what it knows and save what you tell it' },
  { value: 'use' as const, label: 'Use only', text: 'Memory, use only', detail: 'Recall what it knows, save nothing' },
  { value: 'off' as const, label: 'Off', text: 'No memory', detail: 'No recall, nothing saved' },
];

const CHIP = 'h-[24px] text-[12px] phone:h-9 phone:shrink-0 phone:text-[14px]';

/** Mode with Ultra under it: "Agent mode", "Plan mode", "Agent mode, Ultra" ("mode" keeps it apart from the agent's name). */
function ModeChip({ mode, ultra, onMode, onUltra }: { mode: SessionMode; ultra: boolean; onMode: (m: SessionMode) => void; onUltra: (on: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = MODES.find((m) => m.value === mode)?.label ?? mode;
  const items: MenuItem[] = [
    { group: true, label: 'Mode' },
    ...MODES.map((m) => ({ label: m.label, detail: m.description, checked: mode === m.value, onSelect: () => onMode(m.value) })),
    ...(mode !== 'chat' ? [{ separator: true, label: '' }, { label: 'Ultra', detail: ULTRA_LINE, checked: ultra, keep: true, onSelect: () => onUltra(!ultra) }] : []),
  ];
  return (
    <>
      <PickerButton ref={ref} look="text" aria-label={`Mode, ${label}${ultra ? ', Ultra' : ''}`} aria-haspopup="menu" aria-expanded={open} className={CHIP} onClick={() => setOpen((o) => !o)}>
        {ultra && mode !== 'chat' ? `${label} mode, Ultra` : `${label} mode`}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-end" width={300} maxHeight={520} label="Mode" sheetTitle="Mode">
        <MenuList items={items} onDone={() => setOpen(false)} label="Mode" />
      </Popover>
    </>
  );
}

function DesignComposer({ code = true }: { code?: boolean }) {
  const phone = useIsMobile();
  const [text, setText] = useState('');
  const [agent, setAgent] = useState('coder');
  const [mode, setMode] = useState<SessionMode>('agent');
  const [ultra, setUltra] = useState(false);
  const [memory, setMemory] = useState<Memory>('save');
  const [model, setModel] = useState('anthropic/claude-sonnet-5-5');
  const [effort, setEffort] = useState<EffortSetting | undefined>('high');
  const [permission, setPermission] = useState<'default' | 'acceptEdits' | 'plan' | 'bypass'>('acceptEdits');
  const [web, setWeb] = useState(false);
  const [device, setDevice] = useState('arch-desktop');
  // "+" is files and add-ons only: what the message brings, never who answers or how
  const plus: MenuItem[] = [{ group: true, label: 'Add-ons' }, { label: 'Search the web', detail: 'Looks things up before it answers', checked: web, keep: true, onSelect: () => setWeb(!web) }, ...(code ? [{ label: 'Design direction', detail: 'A visual brief for UI work' }, { label: 'A GitHub repository', detail: 'A new worktree on its own branch' }] : [])];

  const controls = (
    <>
      {/* a chat has no agent or mode to pick: memory and the model only */}
      {code && <AgentPicker look="text" value={agent} onChange={setAgent} className={CHIP} />}
      {code && <ModeChip mode={mode} ultra={ultra} onMode={setMode} onUltra={setUltra} />}
      <SelectMenu look="text" label="Memory" value={memory} onChange={setMemory} width={280} options={MEMORY} className={cn(CHIP, memory === 'off' && 'text-fg-3')} />
      <ModelChip value={model} onChange={setModel} effort={effort} onEffort={setEffort} />
    </>
  );

  return (
    <div className="w-full">
      <div className="relative rounded-[var(--r-2)] border border-rule-2 bg-sunk has-[textarea:focus-visible]:border-edge">
        <textarea
          rows={phone ? 1 : 2}
          value={text}
          aria-label="Message"
          onChange={(ev) => setText(ev.target.value)}
          placeholder={code ? 'Reply, or steer the running turn' : 'Reply'}
          className="t-chat block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <PlusMenu items={plus} accept="*/*" onFiles={() => {}} label="Attach files and add-ons" />
          {web && <span className="text-[12px] text-fg-3 phone:text-[13px]">Web search on</span>}
          <span className="flex-1" />
          <SendStopButton running={false} ready={!!text.trim()} size={16} className="size-[30px]" />
        </div>
      </div>
      {phone ? (
        // the controls wrap under the box, never clipped; each opens its sheet
        <div className="mt-1 flex flex-wrap items-center gap-x-1 px-0.5">
          {code && <PermissionPicker look="text" value={permission} onChange={setPermission} className={CHIP} />}
          {controls}
        </div>
      ) : (
        <div className="mt-1 flex min-h-[26px] items-center gap-2 px-0.5 text-[12px] text-fg-3">
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {code && <PermissionPicker look="text" value={permission} onChange={setPermission} className="h-[24px] text-[12px]" />}
            {code && (
              <PickerButton look="text" lead={<Folder className="size-3.5 text-fg-3" strokeWidth={1.75} aria-hidden />} className="h-[24px] font-mono text-[12px]">
                ~/code/conclave
              </PickerButton>
            )}
            {code && <DevicePicker look="text" prefix="on" value={device} onChange={setDevice} className="h-[24px] text-[12px]" />}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {controls}
            <ContextRing model={model} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Busy fixes
// ---------------------------------------------------------------------------

/** The session panel as Settings rows: one line each, the value at the right, details one click away. */
function QuietPanel() {
  const rows: Array<[string, ReactNode]> = [
    ['Context', '1%, 345K tokens, $0.71'],
    ['Environment', 'arch-desktop'],
    ['Plan', '3 of 5'],
    ['Changes', <span key="c" className="num"><span className="text-ok">+8</span> <span className="text-fault">-6</span></span>],
    ['Outputs', '1 file'],
    ['Background tasks', '3 finished'],
    ['Connectors', '5 connected'],
    ['Memory used', '1'],
  ];
  return (
    <div className="divide-y divide-rule border-y border-rule">
      {rows.map(([k, v]) => (
        <button key={k} type="button" className="flex min-h-11 w-full items-center gap-3 px-1 text-left text-[13.5px] hov:bg-hover phone:min-h-12 phone:text-[15px]">
          <span className="min-w-0 flex-1 truncate text-fg">{k}</span>
          <span className="num shrink-0 text-fg-2">{v}</span>
          <ChevronRight className="size-3.5 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden />
        </button>
      ))}
    </div>
  );
}

const SIDE_ROWS: Array<{ group: string; rows: Array<{ title: string; state?: 'running' | 'waiting' | 'unread' }> }> = [
  { group: 'conclave', rows: [{ title: 'Move auth middleware to jose', state: 'running' }, { title: 'Group the session list by project' }, { title: 'Run the core tests on the hub' }, { title: 'Slash menu like Claude Code' }, { title: 'Audit for unsafe deserialization' }] },
  { group: 'os', rows: [{ title: 'OS assignment: MLFQ scheduler', state: 'running' }] },
  { group: 'acme', rows: [{ title: 'Hunt: acme app IDOR leads', state: 'waiting' }] },
  { group: 'router-fw', rows: [{ title: 'Router firmware overflow write-up', state: 'unread' }] },
];

/** Sidebar session rows as Settings has its list: the title only; a state word only when it runs or waits on you. */
function QuietSessions({ active = 'Move auth middleware to jose' }: { active?: string }) {
  return (
    <div className="space-y-3">
      {SIDE_ROWS.map((g) => (
        <div key={g.group}>
          <div className="px-2.5 pb-1 text-[12.5px] text-fg-3 phone:text-[14px]">{g.group}</div>
          {g.rows.map((r) => (
            <div key={r.title} className={cn('flex h-8 items-center gap-2 rounded-[8px] px-2.5 text-[13.5px] phone:h-11 phone:text-[16px]', r.title === active ? 'bg-side-active text-fg' : 'text-fg-2', r.state === 'unread' && 'font-semibold text-fg')}>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              {r.state === 'running' && <span className="shrink-0 text-[12px] text-signal phone:text-[13px]">running</span>}
              {r.state === 'waiting' && <span className="shrink-0 text-[12px] text-warn phone:text-[13px]">waiting</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Part = 'picker' | 'composer' | 'panel' | 'sidebar';
const PARTS: Array<{ value: Part; label: string }> = [
  { value: 'picker', label: 'Model picker' },
  { value: 'composer', label: 'Composer' },
  { value: 'panel', label: 'Session panel' },
  { value: 'sidebar', label: 'Sidebar' },
];

function Frame({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2', className)}>
      <h2 className="text-[13px] font-medium text-fg-3">{title}</h2>
      {children}
    </section>
  );
}

export default function PickerComposerDesign() {
  const phone = useIsMobile();
  const [part, setPart] = useState<Part>(() => (new URLSearchParams(location.search).get('part') as Part) || 'picker');
  const [model, setModel] = useState('anthropic/claude-sonnet-5-5');
  const [effort, setEffort] = useState<EffortSetting | undefined>('high');
  return (
    <Page width="wide">
      <PageHeader title="Model picker and composer" sub="Design mock. Picks here change nothing." />
      <FilterLinks value={part} onChange={setPart} options={PARTS} label="Part" className="mb-5" />
      {part === 'picker' && (
        <div className="grid grid-cols-[440px_1fr] gap-8 phone:grid-cols-1">
          <Frame title="Open picker">
            <div className="flex max-h-[680px] flex-col overflow-hidden rounded-[var(--r-2)] border border-rule-2 bg-raise">
              <ModelCatalog value={model} onChange={setModel} effort={effort} onEffort={setEffort} />
            </div>
          </Frame>
          {!phone && (
            <Frame title="How it ranks">
              <ul className="m-0 list-none space-y-2 p-0 text-[13px] text-fg-2">
                <li>Pinned, then Recent, then the maker&apos;s models.</li>
                <li>Most capable first: tier (Deep, Smart, Fast), then context window, then output price.</li>
                <li>Models that cannot be picked go last, with the reason in their line.</li>
                <li>All lists every maker in one ranking, with the maker after the name.</li>
                <li>Effort for the picked model sits at the foot, as before.</li>
              </ul>
            </Frame>
          )}
        </div>
      )}
      {part === 'composer' && (
        <div className="max-w-[924px] space-y-10">
          <Frame title="Code session">
            <DesignComposer />
          </Frame>
          <Frame title="Chat">
            <DesignComposer code={false} />
          </Frame>
        </div>
      )}
      {part === 'panel' && (
        <div className="grid grid-cols-[1fr_320px] gap-8 phone:grid-cols-1">
          {!phone && (
            <Frame title="Conversation">
              <p className="t-chat m-0 text-fg">All 46 tests pass. The middleware now verifies with jose and the claims are unchanged.</p>
              <div className="pt-6">
                <DesignComposer />
              </div>
            </Frame>
          )}
          <Frame title="Session panel, after">
            <QuietPanel />
          </Frame>
        </div>
      )}
      {part === 'sidebar' && (
        <div className={cn(!phone && 'w-[288px] rounded-[var(--r-2)] bg-side p-2')}>
          <Frame title="Sessions, after" className="px-0.5">
            <QuietSessions />
          </Frame>
        </div>
      )}
    </Page>
  );
}
