/**
 * Model picker (spec 10.5): a 380px popover with search on top, in two
 * levels like the Claude app's picker. The first level: Recent (the last
 * five models used, each picks at once), then one row per maker (Anthropic,
 * OpenAI, Google, Z.ai, then the others) and "Coding agents" (harnesses that
 * are turned on) last. A maker's row shows its mark, its name, and the
 * current model's name when it is there, else how many models it has.
 * Tapping it opens its models in place, under a back row ("< Anthropic")
 * that carries the account word. Model rows 34px: brand model mark 16,
 * display name, context and price per million at the right, a check on the
 * current model. The picker opens on the current model's maker.
 *
 * Typing searches every model and shows one flat list; clearing the search
 * goes back to the makers. Keys: arrows move, Enter opens a maker or picks a
 * model, Right opens a maker, Left or Backspace in an empty search goes
 * back, Esc closes. multiple: checkboxes and a "4 selected" footer for jury
 * and debate members.
 *
 * One row per model (core providers/merge.ts): a model the owner's order of
 * plans and keys reaches through several providers shows once, under its
 * maker, with the route as a quiet hint ("your Claude plan, then API key").
 * A session or agent that names another route's ref finds its row.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { Check, ChevronLeft, ChevronRight, SquareTerminal } from 'lucide-react';
import type { ModelEntry, ModelGroup } from '@conclave/core/client';
import type { Device, Session } from '@conclave/core/types';
import { cn, fuzzy } from '@/lib/text';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { contextLabel, HARNESSES, modelName, providerName } from '@/lib/models';
import { PROVIDERS } from '@/lib/providers';
import { Popover } from '../ui/Overlay';
import { PickerButton } from '../ui/Select';
import { Button } from '../ui/Button';
import { planParts } from '../ui/Meter';
import { CompanyMark, HarnessMark, ModelMark, ModelName } from '../logo';

const HARNESS_CLI: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
  opencode: 'opencode',
  cursor: 'cursor-agent',
  cline: 'cline',
  openhands: 'openhands',
};

export interface Row {
  ref: string;
  model?: ModelEntry;
  group: string;
  groupKey: string;
  harness?: boolean;
  disabled?: boolean;
  where?: string;
}

/** A row of the first level: a maker (or "Coding agents") and its models. */
export interface PickerGroup {
  /** The maker's id ("anthropic"), or "harness" for the coding agents. */
  key: string;
  name: string;
  /** The account word the back row shows: "key set", "Max", "rejected". None for a maker fed by other providers. */
  word?: string;
  rows: Row[];
}

export interface Picker {
  recent: Row[];
  groups: PickerGroup[];
}

/** The maker a row sits under: Claude under Anthropic, GLM under Z.ai, wherever the route that reaches it is. */
const MAKER: Array<[RegExp, string]> = [
  [/claude/, 'anthropic'],
  [/gpt|(^|\/)o\d|codex/, 'openai'],
  [/gemini|gemma/, 'google'],
  [/glm/, 'zai'],
  [/deepseek/, 'deepseek'],
  [/kimi|moonshot/, 'moonshot'],
  [/qwen/, 'qwen'],
  [/mistral|codestral|devstral/, 'mistral'],
  [/grok/, 'xai'],
];

export function makerOf(id: string): string | undefined {
  return MAKER.find(([re]) => re.test(id.toLowerCase()))?.[1];
}

/** The first level's order: Anthropic, OpenAI, Google, Z.ai, then the others as Settings lists providers, coding agents last. */
const FIRST = ['anthropic', 'openai', 'google', 'zai'];
export function makerRank(key: string): number {
  if (key === 'harness') return 10_000;
  const i = FIRST.indexOf(key);
  if (i >= 0) return i;
  const p = PROVIDERS.findIndex((x) => x.id === key);
  return p < 0 ? 1_000 : FIRST.length + p;
}

/** The ref a picker shows for a stored one: the merged row it points at, else itself. */
export function shownRef(groups: ModelGroup[], ref: string | undefined): string | undefined {
  if (!ref) return ref;
  for (const g of groups) for (const m of g.models) if (m.ref === ref) return m.sameAs ?? ref;
  return ref;
}

function price(m: ModelEntry | undefined, provider: string): string {
  if (!m) return '';
  if (provider === 'ollama' || provider === 'lmstudio') return 'local';
  if (!m.inputPrice && !m.outputPrice) return 'plan';
  const f = (n: number) => `$${n >= 10 ? Math.round(n) : +n.toFixed(2)}`;
  return `${f(m.inputPrice ?? 0)} / ${f(m.outputPrice ?? 0)}`;
}

/** Account state word for a provider group. */
function accountWord(g: ModelGroup, secrets: string[] | undefined, limits: Record<string, { label: string }>): string {
  if (g.provider === 'ollama' || g.provider === 'lmstudio') return 'local';
  if (g.error) return 'rejected';
  const plan = Object.entries(limits).find(([id]) => id.startsWith(g.provider === 'zai' ? 'zai' : g.provider))?.[1]?.label;
  if (plan && g.provider !== 'anthropic' && g.provider !== 'google') return planParts(plan)[1] || plan;
  if (secrets?.includes(g.provider) || g.configured) return 'key set';
  return 'not set';
}

/** A row's name: "Opus 5.5"; a harness "Claude Code", or "Claude Code, Opus" for one of its models. */
export function rowName(r: Pick<Row, 'ref' | 'harness'>): string {
  if (!r.harness) return modelName(r.ref);
  const label = HARNESSES[r.ref.split('/')[0]]?.label ?? modelName(r.ref);
  return r.ref.endsWith('/default') ? label : `${label}, ${modelName(r.ref)}`;
}

export interface PickerInput {
  models: ModelGroup[];
  sessions: Record<string, Pick<Session, 'model' | 'updatedAt'>>;
  devices: Record<string, Pick<Device, 'name' | 'info'>>;
  secrets?: string[];
  limits: Record<string, { label: string }>;
  /** Offer the coding agents. */
  harnesses: boolean;
}

/** Recent and the makers, from the hub's model groups. */
export function buildPicker({ models, sessions, devices, secrets, limits, harnesses: includeHarness }: PickerInput): Picker {
  const byRef = new Map<string, ModelEntry>();
  for (const g of models) for (const m of g.models) byRef.set(m.ref, m);
  // a recent model of a provider that is off since cannot be picked, as in its own group; a harness that is off is not offered at all
  const off = new Set(models.filter((g) => !g.enabled).map((g) => g.provider));
  // recent: last five distinct models used, each as the row it merged into
  const refs: string[] = [];
  for (const s of Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const ref = s.model ? (byRef.get(s.model)?.sameAs ?? s.model) : undefined;
    const harness = !!ref && !!HARNESSES[ref.split('/')[0]];
    if (ref && !refs.includes(ref) && (includeHarness || !harness) && !(harness && off.has(ref.split('/')[0]))) refs.push(ref);
    if (refs.length >= 5) break;
  }
  const recent: Row[] = refs.map((ref) => ({
    ref,
    model: byRef.get(ref),
    group: 'Recent',
    groupKey: 'recent',
    harness: !!HARNESSES[ref.split('/')[0]],
    disabled: off.has(ref.split('/')[0]),
  }));
  const ordered = [...models].sort((a, b) => makerRank(a.provider) - makerRank(b.provider));
  // every row goes under its maker (Anthropic, OpenAI, Z.ai, Google): the owner's provider order picks the route, so
  // the maker is what tells models apart. A maker group fed by other providers says no account word: each row says its route
  const byMaker = new Map<string, Row[]>();
  const merged = new Set<string>();
  for (const g of ordered) {
    if (HARNESSES[g.provider]) continue;
    for (const m of g.models) {
      if (m.sameAs) continue;
      const maker = makerOf(m.id) ?? g.provider;
      if (m.via || maker !== g.provider) merged.add(maker);
      // a model reached through another provider (GLM through OpenRouter) names that route, as a merged row does
      const model = m.via || maker === g.provider ? m : { ...m, via: providerName(g.provider) };
      const list = byMaker.get(maker) ?? [];
      list.push({ ref: m.ref, model, group: providerName(maker), groupKey: maker, disabled: !g.enabled });
      byMaker.set(maker, list);
    }
  }
  const groups: PickerGroup[] = [...byMaker.keys()]
    .sort((a, b) => makerRank(a) - makerRank(b))
    .map((key) => {
      const g = ordered.find((x) => x.provider === key);
      return { key, name: providerName(key), word: merged.has(key) || !g ? undefined : accountWord(g, secrets, limits), rows: byMaker.get(key)! };
    });
  if (includeHarness) {
    const rows: Row[] = [];
    for (const g of ordered) {
      // a harness is an engine the owner turns on (Settings, Providers); off, it is not offered
      if (!HARNESSES[g.provider] || !g.enabled) continue;
      const cli = HARNESS_CLI[g.provider];
      const where = Object.values(devices)
        .filter((d) => (cli && d.info?.clis?.[cli]) || false)
        .map((d) => d.name)
        .join(', ');
      for (const m of g.models)
        rows.push({ ref: m.ref, model: m, group: 'Coding agents', groupKey: 'harness', harness: true, disabled: !g.enabled, where: where || (g.error ? 'not installed' : '') });
    }
    if (rows.length) groups.push({ key: 'harness', name: 'Coding agents', rows });
  }
  return { recent, groups };
}

function usePicker(includeHarness: boolean): Picker {
  const models = useHub((s) => s.models);
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const secrets = useHub((s) => s.secrets?.providers);
  const limits = useHub((s) => s.limits);
  return useMemo(() => buildPicker({ models, sessions, devices, secrets, limits, harnesses: includeHarness }), [models, sessions, devices, secrets, limits, includeHarness]);
}

/** One line of the list: the back row, a maker's row, or a model. */
export type PickerItem = { kind: 'back'; group: PickerGroup } | { kind: 'group'; group: PickerGroup } | { kind: 'model'; row: Row };

/**
 * What the list shows. A search: every model that matches, as one flat
 * list (Recent left out, its rows are there already). Inside a maker: the
 * back row, then its models. Else Recent, then a row per maker.
 */
export function pickerItems(p: Picker, q: string, open: string | null): PickerItem[] {
  if (q.trim())
    return p.groups
      .flatMap((g) => g.rows)
      .map((r) => ({ r, s: fuzzy(q, `${modelName(r.ref)} ${r.model?.name ?? ''} ${r.ref} ${r.group}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ kind: 'model', row: x.r }));
  const g = open ? p.groups.find((x) => x.key === open) : undefined;
  if (g) return [{ kind: 'back', group: g }, ...g.rows.map((row): PickerItem => ({ kind: 'model', row }))];
  return [...p.recent.map((row): PickerItem => ({ kind: 'model', row })), ...p.groups.map((group): PickerItem => ({ kind: 'group', group }))];
}

/** The maker that holds a model: where the picker opens. None for no model, or one no maker offers. */
export function groupOf(groups: PickerGroup[], ref: string | undefined): string | null {
  if (!ref) return null;
  return groups.find((g) => g.rows.some((r) => r.ref === ref))?.key ?? null;
}

/** What a maker's row says at the right: the current model's name when it is there, else how many models it has. */
export function groupNote(g: PickerGroup, current: string | undefined, picked?: string[]): string {
  if (picked) {
    const on = g.rows.filter((r) => picked.includes(r.ref));
    if (on.length > 1) return `${on.length} selected`;
    if (on.length === 1) return rowName(on[0]);
    return String(g.rows.length);
  }
  const cur = current ? g.rows.find((r) => r.ref === current) : undefined;
  return cur ? rowName(cur) : String(g.rows.length);
}

const canPick = (it: PickerItem | undefined) => !!it && (it.kind !== 'model' || !it.row.disabled);

/** Where the highlight starts: the maker just left, else the current model, else the first line that is not the back row. */
function startAt(items: PickerItem[], current: string | undefined, from: string | null): number {
  if (from) {
    const i = items.findIndex((it) => it.kind === 'group' && it.group.key === from);
    if (i >= 0) return i;
  }
  if (current) {
    const i = items.findIndex((it) => it.kind === 'model' && it.row.ref === current && !it.row.disabled);
    if (i >= 0) return i;
  }
  const i = items.findIndex((it) => it.kind !== 'back' && canPick(it));
  return i >= 0 ? i : 0;
}

/**
 * The height of the tallest level, in px: the list keeps it while it moves
 * between levels, so the popover does not jump or flip sides and the sheet
 * keeps its top edge. Rows are 34px (44 on phones), a model with its route
 * under the name 37.
 */
export function listHeight(p: Picker, phone: boolean): number {
  const row = phone ? 44 : 34;
  const rows = (rs: Row[]) => rs.reduce((n, r) => n + (r.model?.via && !phone ? 37 : row), 0);
  const top = (p.recent.length ? 30 + rows(p.recent) + 9 : 0) + p.groups.length * row;
  const inner = Math.max(0, ...p.groups.map((g) => row + 2 + rows(g.rows)));
  return Math.max(80, 8 + Math.max(top, inner));
}

function GroupMark({ group }: { group: PickerGroup }) {
  return group.key === 'harness' ? <SquareTerminal className="size-4 shrink-0 text-fg-2" strokeWidth={1.5} aria-hidden /> : <CompanyMark provider={group.key} size={16} tone="brand" />;
}

const ROW = 'flex min-h-[34px] items-center gap-2 rounded-[var(--r-1)] px-2 text-[13px] phone:min-h-11 phone:text-[15px]';

export interface ModelListProps {
  value?: string;
  /** Multiple selection (jury and debate members). */
  values?: string[];
  onChange: (ref: string) => void;
  onChangeMany?: (refs: string[]) => void;
  /** Show the "Coding agents" group. Default true. */
  harnesses?: boolean;
  /** Close the popover (after a single pick). */
  onDone?: () => void;
  /** Footer content in multiple mode, after the count (the judge picker). */
  footer?: ReactNode;
  autoFocus?: boolean;
}

/** The searchable list itself, for embedding in a popover, sheet or page. */
export function ModelList({ value, values, onChange, onChangeMany, harnesses = true, onDone, footer, autoFocus = true }: ModelListProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [, navigate] = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  const picker = usePicker(harnesses);
  const phone = useIsMobile();
  const groups = useHub((s) => s.models);
  const multiple = !!onChangeMany;
  const picked = (values ?? []).map((v) => shownRef(groups, v) ?? v);
  // a session that names another route's ref (anthropic/ while the plan goes first) checks the merged row
  const current = shownRef(groups, value);

  // Opens on the current model's maker; with no model (or several), on the makers.
  const [open, setOpen] = useState<string | null>(() => (multiple ? null : groupOf(picker.groups, current)));
  // which way the list last moved, for its slide: into a maker, or back out
  const [dir, setDir] = useState<'in' | 'back' | null>(null);
  const moved = useRef(false);
  const left = useRef<string | null>(null);
  // the models came after the list opened: open on the current maker then, unless the owner moved already
  const known = picker.groups.length > 0;
  useEffect(() => {
    if (known && !moved.current && !multiple && !open) setOpen(groupOf(picker.groups, current));
  }, [known]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => pickerItems(picker, q, open), [picker, q, open]);
  const enabled = items.map((it, i) => (canPick(it) ? i : -1)).filter((i) => i >= 0);
  const level = q.trim() ? 'search' : (items[0]?.kind === 'back' && open) || 'top';
  const size = picker.recent.length + picker.groups.reduce((n, g) => n + g.rows.length + 1, 0);

  // Each level starts on the current model (or the first line) in view; later, only keys scroll the list, never the pointer.
  const keyMove = useRef(false);
  const reveal = (i: number) => listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`)?.scrollIntoView?.({ block: 'nearest' });
  useEffect(() => {
    const start = startAt(items, q.trim() ? undefined : current, left.current);
    left.current = null;
    setSel(start);
    if (listRef.current) listRef.current.scrollTop = 0;
    reveal(start);
  }, [level, size]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!keyMove.current) return;
    keyMove.current = false;
    reveal(sel);
  }, [sel]);

  const go = (key: string | null) => {
    moved.current = true;
    if (key === null) left.current = open;
    setDir(key ? 'in' : 'back');
    setOpen(key);
  };

  const pick = (r: Row) => {
    if (r.disabled) return;
    if (multiple) {
      const was = values ?? [];
      onChangeMany!(picked.includes(r.ref) ? was.filter((x) => (shownRef(groups, x) ?? x) !== r.ref) : [...was, r.ref]);
      return;
    }
    onChange(r.ref);
    onDone?.();
  };

  const choose = (it: PickerItem | undefined) => {
    if (!it) return;
    if (it.kind === 'group') go(it.group.key);
    else if (it.kind === 'back') go(null);
    else pick(it.row);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const pos = enabled.indexOf(sel);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      keyMove.current = true;
      setSel(enabled[Math.min(enabled.length - 1, pos + 1)] ?? sel);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      keyMove.current = true;
      setSel(enabled[Math.max(0, pos - 1)] ?? sel);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[sel]);
    } else if (e.key === 'ArrowRight' && q === '' && items[sel]?.kind === 'group') {
      e.preventDefault();
      choose(items[sel]);
    } else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && q === '' && open && level !== 'top') {
      e.preventDefault();
      go(null);
    }
  };

  // the pointer moves the highlight, but a press keeps the focus in the search box, so keys go on working
  const hover = (i: number, it: PickerItem) => ({
    'data-idx': i,
    onMouseMove: () => canPick(it) && i !== sel && setSel(i),
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  });

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKey}>
      <div className="shrink-0 border-b border-rule p-2">
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => {
            const v = e.target.value;
            // clearing the search goes back to the makers
            if (q.trim() && !v.trim()) {
              moved.current = true;
              setOpen(null);
              setDir(null);
            }
            setQ(v);
          }}
          placeholder="Search models"
          aria-label="Search models"
          className="h-8 w-full rounded-[var(--r-1)] border border-edge bg-sunk px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)] phone:h-11 phone:text-[16px]"
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Models"
        aria-multiselectable={multiple || undefined}
        className="min-h-0 flex-1 overflow-y-auto p-1"
        // the tallest level's height, shrunk to what the popover or sheet has room for
        style={{ flexBasis: `min(${listHeight(picker, phone)}px, 64dvh)` }}
      >
        <div key={level} className={level === 'search' ? undefined : dir === 'in' ? 'anim-right' : dir === 'back' ? 'anim-left' : undefined}>
          {items.length === 0 && <p className="px-2 py-4 text-[13px] text-fg-3">{q.trim() ? `No model matches "${q}".` : 'No models yet. Add a key in Settings, Providers.'}</p>}
          {items.map((it, i) => {
            const on = i === sel;
            if (it.kind === 'back') {
              const g = it.group;
              return (
                <div key="back" role="option" aria-selected={false} aria-label={`Back from ${g.name}`} {...hover(i, it)} onClick={() => go(null)} className={cn(ROW, 'mb-0.5 font-semibold text-fg', on && 'bg-hover')}>
                  <ChevronLeft className="-mx-0.5 size-4 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
                  <GroupMark group={g} />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  {g.word && <span className={cn('shrink-0 text-[12px] font-normal', g.word === 'rejected' ? 'text-fault' : 'text-fg-3')}>{g.word}</span>}
                </div>
              );
            }
            if (it.kind === 'group') {
              const g = it.group;
              const note = groupNote(g, current, multiple ? picked : undefined);
              const named = !/^\d+$/.test(note);
              return (
                <div key={`g:${g.key}`}>
                  {i > 0 && items[i - 1].kind === 'model' && <div aria-hidden className="mx-2 my-1 h-px bg-rule" />}
                  <div role="option" aria-selected={false} {...hover(i, it)} onClick={() => go(g.key)} className={cn(ROW, 'text-fg', on && 'bg-hover')}>
                    <GroupMark group={g} />
                    <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                    <span className={cn('min-w-0 shrink truncate text-[12px] phone:text-[13px]', named ? 'text-fg-2' : 'num text-fg-3')}>{note}</span>
                    <ChevronRight className="-mr-0.5 size-3.5 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden />
                  </div>
                </div>
              );
            }
            const r = it.row;
            const head = level === 'top' && i === 0 ? 'Recent' : null;
            const checked = multiple ? picked.includes(r.ref) : r.ref === current;
            return (
              <div key={`${r.groupKey}:${r.ref}`}>
                {head && <div className="px-2 pt-1.5 pb-1 text-[13px] font-semibold text-fg">{head}</div>}
                <div
                  role="option"
                  aria-selected={checked}
                  aria-disabled={r.disabled || undefined}
                  {...hover(i, it)}
                  onClick={() => pick(r)}
                  className={cn(ROW, on && !r.disabled && 'bg-hover', r.disabled ? 'text-fg-3' : 'text-fg')}
                >
                  {multiple && (
                    <span aria-hidden className={cn('grid size-3.5 shrink-0 place-items-center rounded-[2px] border', checked ? 'border-fg bg-fg text-bg' : 'border-edge')}>
                      {checked && <Check className="size-2.5" strokeWidth={2.5} />}
                    </span>
                  )}
                  {r.harness ? <HarnessMark harness={r.ref} size={16} /> : <ModelMark model={r.ref} size={16} tone={r.disabled ? 'mono' : 'brand'} />}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {rowName(r)}
                    {level === 'search' && r.groupKey !== 'harness' && <span className="ml-2 text-[12px] font-normal text-fg-3">{r.group}</span>}
                    {r.model?.via && <span className="block truncate text-[11.5px] font-normal text-fg-3 phone:text-[13px]">{r.model.via}</span>}
                  </span>
                  {r.disabled && !r.harness ? (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDone?.();
                        navigate('/settings/providers');
                      }}
                    >
                      Add key
                    </Button>
                  ) : (
                    <span className="num shrink-0 text-[12px] text-fg-3">{r.harness ? r.where : `${r.model ? contextLabel(r.model.contextWindow) : ''}${r.model ? `, ${price(r.model, r.ref.split('/')[0])}` : ''}`}</span>
                  )}
                  {!multiple && <Check className={cn('size-3.5 shrink-0', !checked && 'invisible')} strokeWidth={1.75} aria-hidden />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {multiple && (
        <div className="flex shrink-0 items-center gap-3 border-t border-rule px-3 py-2 text-[12px] text-fg-3">
          <span className="num">{picked.length} selected</span>
          <span className="ml-auto flex items-center gap-2">{footer}</span>
        </div>
      )}
    </div>
  );
}

/**
 * A model picker trigger plus its popover.
 * look="text" for composers (Home, Chat, sessions), "field" in forms.
 */
export function ModelPicker({
  value,
  onChange,
  look = 'text',
  harnesses = true,
  prefix,
  placeholder = 'Choose a model',
  className,
  label = 'Model',
  disabled,
}: {
  value: string | undefined;
  onChange: (ref: string) => void;
  look?: 'text' | 'field';
  harnesses?: boolean;
  prefix?: ReactNode;
  placeholder?: string;
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PickerButton ref={ref} look={look} prefix={prefix} aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} className={className} onClick={() => setOpen((o) => !o)}>
        {value ? <ModelName model={value} size={look === 'field' ? 16 : 14} tone={look === 'field' ? 'brand' : 'mono'} /> : <span className="text-fg-3">{placeholder}</span>}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={380} maxHeight={480} label="Choose a model" sheetTitle="Model">
        <ModelList value={value} onChange={onChange} harnesses={harnesses} onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}
