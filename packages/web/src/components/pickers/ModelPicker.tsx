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
 * One row per model (core providers/merge.ts): a model reached through
 * several providers or plans (CLIProxyAPI's main accounts, a plan's prefix
 * such as neu/, the API key, OpenRouter) shows once, under its maker, by its
 * name only. The row picks the route the owner's order in Settings puts
 * first. The other routes are a choice behind the row's "via" button (one
 * account, one key); a row picked that way says "via neu". A session or
 * agent that names another route's ref finds its row. Inside a maker the
 * models go by family (Opus, Sonnet, Haiku; GPT, o-series, Codex; Gemini
 * Pro, Flash), newest version first.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { Check, ChevronLeft, ChevronRight, SquareTerminal } from 'lucide-react';
import type { AccountDto, ModelEntry, ModelGroup } from '@conclave/core/client';
import type { Device, Session } from '@conclave/core/types';
import { MODEL_VARIANT as VARIANT } from '@conclave/core/providers/model-id';
import { cn, fuzzy } from '@/lib/text';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { api } from '@/lib/api';
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

/** One way to reach a row's model: the owner's first route, or one account or provider. */
export interface Route {
  ref: string;
  label: string;
  /** The row's own ref: the route the owner's order picks. */
  first?: boolean;
}

export interface Row {
  /** The name the row shows when it is not the model's own (a variant standing in for its model). */
  label?: string;
  ref: string;
  model?: ModelEntry;
  group: string;
  groupKey: string;
  harness?: boolean;
  disabled?: boolean;
  where?: string;
  /** The family inside its maker ("Opus", "GPT", "Gemini Flash"). */
  family?: string;
  /** Every way to reach the model, the row's own first, when there is more than one. */
  routes?: Route[];
  /** The provider's name when it is not the maker's own and the row has no routes to tell it ("Experiential Labs"). */
  source?: string;
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
  [/muse/, 'meta'],
  [/deepseek/, 'deepseek'],
  [/kimi|moonshot/, 'moonshot'],
  [/qwen/, 'qwen'],
  [/mistral|codestral|devstral/, 'mistral'],
  [/grok/, 'xai'],
];

export function makerOf(id: string): string | undefined {
  return MAKER.find(([re]) => re.test(id.toLowerCase()))?.[1];
}

/** The hub's vendor ids (ModelEntry.vendor) as makers. */
const VENDOR_MAKER: Record<string, string> = { gemini: 'google' };

/** The maker of an entry: from its id, else the vendor of the plan that lists it ("daybreak" on a ChatGPT plan). */
export function entryMaker(m: Pick<ModelEntry, 'id' | 'vendor'>): string | undefined {
  return makerOf(m.id) ?? (m.vendor ? (VENDOR_MAKER[m.vendor] ?? m.vendor) : undefined);
}

/** The gateway whose ids carry a plan's short name ("neu/claude-opus-5-5"). Elsewhere a prefix is the vendor (OpenRouter's "anthropic/"). */
const PLAN_GATEWAY = 'cliproxy';

/** A route in words: "Main accounts" or a plan's short name on CLIProxyAPI, else the provider ("Anthropic", "OpenRouter"). */
export function routeLabel(ref: string): string {
  const i = ref.indexOf('/');
  const provider = i < 0 ? ref : ref.slice(0, i);
  const id = i < 0 ? '' : ref.slice(i + 1);
  if (provider === PLAN_GATEWAY) {
    const j = id.lastIndexOf('/');
    return j < 0 ? 'Main accounts' : id.slice(0, j);
  }
  return providerName(provider);
}

/** A ref through one CLIProxyAPI plan's prefix ("cliproxy/backup-gemini/claude-opus-5-5-high"). */
const onPlan = (ref: string) => ref.startsWith(`${PLAN_GATEWAY}/`) && ref.indexOf('/', PLAN_GATEWAY.length + 1) > 0;

export type PlanAccount = Pick<AccountDto, 'prefix' | 'vendor' | 'vendorName' | 'credential'>;

/** routeLabel, with a plan of another vendor named by its service: "backup-gemini (Antigravity)" under Opus. */
export function planLabel(ref: string, maker: string, accounts?: PlanAccount[]): string {
  const label = routeLabel(ref);
  const a = onPlan(ref) ? accounts?.find((x) => x.prefix === label) : undefined;
  if (!a || (VENDOR_MAKER[a.vendor] ?? a.vendor) === maker) return label;
  // CLIProxyAPI names a credential file after its service ("antigravity-me@x.json")
  const service = a.credential?.match(/^([a-z]+)-/)?.[1];
  return `${label} (${service ? service[0].toUpperCase() + service.slice(1) : a.vendorName})`;
}

/**
 * A model's family inside its maker, its place among the families, and its
 * version: Opus, Sonnet, Haiku; GPT, o-series, Codex; Gemini Pro, Flash,
 * Flash-Lite, Gemma. A maker with no known families has one, its own.
 */
export function familyOf(id: string): { family: string; rank: number; version: number[]; dated: number } {
  let m = id.toLowerCase();
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  const date = /-(\d{8})$/.exec(m);
  const base = m.replace(/-\d{8}$/, '');
  const version = (base.match(/\d+/g) ?? []).map(Number);
  const dated = date ? Number(date[1]) : 0;
  const fam = (family: string, rank: number) => ({ family, rank, version, dated });
  for (const [i, f] of ['opus', 'sonnet', 'haiku'].entries()) if (base.includes(f)) return fam(f[0].toUpperCase() + f.slice(1), i);
  if (/^gpt/.test(base)) return fam('GPT', 0);
  if (/^o\d/.test(base)) return fam('o-series', 1);
  if (/codex/.test(base)) return fam('Codex', 2);
  if (/^gemini/.test(base)) {
    if (/flash-lite/.test(base)) return fam('Gemini Flash-Lite', 2);
    if (/flash/.test(base)) return fam('Gemini Flash', 1);
    if (/pro/.test(base)) return fam('Gemini Pro', 0);
    return fam('Gemini', 3);
  }
  if (/^gemma/.test(base)) return fam('Gemma', 4);
  return fam('', 9);
}

/** Inside a maker: by family, newest version first, a plain id before its variants ("GPT-5.5" before "GPT-5.5 mini"), undated before dated, newest date first. */
export function compareModels(a: string, b: string): number {
  const x = familyOf(a);
  const y = familyOf(b);
  if (x.rank !== y.rank) return x.rank - y.rank;
  if (x.family !== y.family) return x.family.localeCompare(y.family);
  for (let i = 0; i < Math.max(x.version.length, y.version.length); i++) {
    const d = (y.version[i] ?? -1) - (x.version[i] ?? -1);
    if (d) return d;
  }
  if (!!x.dated !== !!y.dated) return x.dated ? 1 : -1;
  if (x.dated !== y.dated) return y.dated - x.dated;
  return a.length - b.length || a.localeCompare(b);
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

/** A row's name: "Opus 5.5", never the plan's short name the hub adds ("Opus 5.5, neu"); a harness "Claude Code", or "Claude Code, Opus" for one of its models. */
/** Ids that are not chat models: image generators, review models. */
export const NON_CHAT = /(^|\/)(gpt-image|codex-auto-review|dall-e|whisper|tts-)|-image(-|$)|embedding/i;
const bareId = (r: Row) => (r.model?.id ?? r.ref.slice(r.ref.indexOf('/') + 1)).replace(/^.*\//, '').toLowerCase();

/**
 * Effort and thinking variants fold under their model's row, as choices
 * behind it ("High", "Thinking"), not rows of their own. A variant whose
 * model is not listed becomes the row, named as the model. A plan the row
 * does not reach yet that lists only a variant (Antigravity's
 * claude-opus-5-5-high) is one more "via" route, by the variant's own id.
 */
export function foldVariants(rows: Row[], name: (ref: string) => string = routeLabel): Row[] {
  const base = new Map<string, Row>();
  for (const r of rows) if (!r.harness && !VARIANT.test(bareId(r))) base.set(bareId(r), r);
  const out: Row[] = [];
  for (const r of rows) {
    const m = VARIANT.exec(bareId(r));
    if (r.harness || !m) {
      out.push(r);
      continue;
    }
    const word = m[1].toLowerCase() === 'xhigh' ? 'Extra high' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const key = bareId(r).slice(0, -m[0].length);
    const host = base.get(key);
    if (host) {
      const routes = host.routes ?? [{ ref: host.ref, label: host.label ?? 'Default', first: true }];
      const reached = new Set(routes.map((x) => routeLabel(x.ref)));
      // one route per plan: its first variant
      const plans: string[] = [];
      for (const ref of [r.ref, ...(r.model?.choices ?? [])]) {
        if (!onPlan(ref) || reached.has(routeLabel(ref))) continue;
        reached.add(routeLabel(ref));
        plans.push(ref);
      }
      host.routes = [...routes, ...(plans.includes(r.ref) ? [] : [{ ref: r.ref, label: word }]), ...plans.map((ref): Route => ({ ref, label: name(ref) }))];
      continue;
    }
    // only the variant is listed: it is the row, under the model's name, its other plans behind it
    const own = rowName(r);
    const others = (r.model?.choices ?? []).map((ref): Route => ({ ref, label: name(ref) }));
    base.set(key, { ...r, label: own.replace(new RegExp(`[\\s-]${m[1]}$`, 'i'), ''), routes: [{ ref: r.ref, label: word, first: true }, ...others] });
    out.push(base.get(key)!);
  }
  return out;
}

export function rowName(r: Pick<Row, 'ref' | 'harness' | 'label'>): string {
  if (r.label) return r.label;
  if (!r.harness) {
    // a dated snapshot reads as its model ("Claude Opus 4.5")
    const name = modelName(r.ref).replace(/[\s-]\(?\d{8}\)?$/, '');
    const id = r.ref.slice(r.ref.indexOf('/') + 1);
    const j = id.lastIndexOf('/');
    const account = j < 0 ? '' : id.slice(0, j);
    return account && name.endsWith(`, ${account}`) ? name.slice(0, -account.length - 2) : name;
  }
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
  /** Signed in plans, to name a plan of another vendor in a "via" row ("backup-gemini (Antigravity)"). */
  accounts?: PlanAccount[];
}

/** Recent and the makers, from the hub's model groups. */
export function buildPicker({ models, sessions, devices, secrets, limits, harnesses: includeHarness, accounts }: PickerInput): Picker {
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
  const ordered = [...models].sort((a, b) => makerRank(a.provider) - makerRank(b.provider));
  // every row goes under its maker (Anthropic, OpenAI, Z.ai, Google): the owner's order picks the route, so
  // the maker is what tells models apart. A maker group fed by other providers says no account word
  const byMaker = new Map<string, Row[]>();
  const merged = new Set<string>();
  const rowOf = new Map<string, Row>();
  for (const g of ordered) {
    if (HARNESSES[g.provider]) continue;
    for (const m of g.models) {
      // an image or review model is not a chat model: the chat picker has no place for it
      if (m.sameAs || NON_CHAT.test(m.id)) continue;
      const maker = entryMaker(m) ?? g.provider;
      if (m.via || m.refs || maker !== g.provider) merged.add(maker);
      const list = byMaker.get(maker) ?? [];
      // the other ways to the same model: a choice behind the row, never rows of their own
      const routes = m.choices?.length ? [{ ref: m.ref, label: routeLabel(m.ref), first: true }, ...m.choices.map((ref): Route => ({ ref, label: planLabel(ref, maker, accounts) }))] : undefined;
      // a model of another provider (a custom one, a router) says whose it is: "GLM-5.3" alone reads as Z.ai's
      const own = g.provider === maker || VENDOR_MAKER[g.provider] === maker;
      // a row with routes or its own "via" already says how it is reached
      const source = own || routes || m.via ? undefined : g.name && g.name !== g.provider ? g.name : providerName(g.provider);
      const row: Row = { ref: m.ref, model: m, group: providerName(maker), groupKey: maker, disabled: !g.enabled, family: familyOf(m.id).family || undefined, ...(routes ? { routes } : {}), ...(source ? { source } : {}) };
      list.push(row);
      rowOf.set(m.ref, row);
      byMaker.set(maker, list);
    }
  }
  const groups: PickerGroup[] = [...byMaker.keys()]
    .sort((a, b) => makerRank(a) - makerRank(b))
    .map((key) => {
      const g = ordered.find((x) => x.provider === key);
      const rows = foldVariants(byMaker.get(key)!, (ref) => planLabel(ref, key, accounts)).sort((a, b) => compareModels(a.model?.id ?? a.ref, b.model?.id ?? b.ref));
      return { key, name: providerName(key), word: merged.has(key) || !g ? undefined : accountWord(g, secrets, limits), rows };
    });
  const recent: Row[] = refs.map((ref) => {
    const row = rowOf.get(ref);
    return {
      ref,
      model: byRef.get(ref),
      group: 'Recent',
      groupKey: 'recent',
      harness: !!HARNESSES[ref.split('/')[0]],
      disabled: off.has(ref.split('/')[0]),
      ...(row?.routes ? { routes: row.routes } : {}),
    };
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
  const accounts = useHub((s) => s.accounts?.accounts);
  useEffect(() => {
    // plan names for the "via" rows; not connected or refused, they say the short name only
    if (useHub.getState().accounts) return;
    try {
      api().accounts().then((a) => useHub.setState({ accounts: a }), () => {});
    } catch {
      /* not connected */
    }
  }, []);
  return useMemo(() => buildPicker({ models, sessions, devices, secrets, limits, harnesses: includeHarness, accounts }), [models, sessions, devices, secrets, limits, includeHarness, accounts]);
}

/** One line of the list: the back row, a maker's row, a model, or one route to a model under its row. */
export type PickerItem = { kind: 'back'; group: PickerGroup } | { kind: 'group'; group: PickerGroup } | { kind: 'model'; row: Row } | { kind: 'route'; row: Row; route: Route };

/** A model's line, then its routes when the owner opened them (`expanded` is the row's key). */
function withRoutes(rows: Row[], expanded: string | null | undefined): PickerItem[] {
  return rows.flatMap((row): PickerItem[] => [{ kind: 'model', row }, ...(expanded === rowKey(row) && row.routes ? row.routes.map((route): PickerItem => ({ kind: 'route', row, route })) : [])]);
}

/** A row's key in the list: its ref in its section, so Recent's copy opens on its own. */
export const rowKey = (r: Row) => `${r.groupKey}:${r.ref}`;

/**
 * What the list shows. A search: every model that matches, as one flat
 * list (Recent left out, its rows are there already). Inside a maker: the
 * back row, then its models. Else Recent, then a row per maker. A model
 * whose routes are open has them under it.
 */
export function pickerItems(p: Picker, q: string, open: string | null, expanded?: string | null): PickerItem[] {
  if (q.trim())
    return withRoutes(
      p.groups
        .flatMap((g) => g.rows)
        .map((r) => ({ r, s: fuzzy(q, `${rowName(r)} ${r.model?.name ?? ''} ${r.ref} ${r.group}`) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.r),
      expanded,
    );
  const g = open ? p.groups.find((x) => x.key === open) : undefined;
  if (g) return [{ kind: 'back', group: g }, ...withRoutes(g.rows, expanded)];
  return [...withRoutes(p.recent, expanded), ...p.groups.map((group): PickerItem => ({ kind: 'group', group }))];
}

/** The family heading over a row inside a maker: where the family changes, in a maker with more than one. */
export function familyHead(rows: Row[], i: number): string | null {
  const r = rows[i];
  if (!r.family || new Set(rows.map((x) => x.family ?? '')).size < 2) return null;
  return i === 0 || rows[i - 1].family !== r.family ? r.family : null;
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

const canPick = (it: PickerItem | undefined) => !!it && ((it.kind !== 'model' && it.kind !== 'route') || !it.row.disabled);

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
  const rows = (rs: Row[]) => rs.length * row;
  // a family heading is 24px
  const heads = (rs: Row[]) => rs.filter((_, i) => familyHead(rs, i)).length * 24;
  const top = (p.recent.length ? 30 + rows(p.recent) + 9 : 0) + p.groups.length * row;
  const inner = Math.max(0, ...p.groups.map((g) => row + 2 + rows(g.rows) + heads(g.rows)));
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

  // the model whose routes are open under it (rowKey), if any
  const [expanded, setExpanded] = useState<string | null>(null);
  const items = useMemo(() => pickerItems(picker, q, open, multiple ? null : expanded), [picker, q, open, expanded, multiple]);
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
    setExpanded(null);
    setOpen(key);
  };

  /** Open or close a model's routes, keeping the highlight on its row. */
  const toggleRoutes = (r: Row) => {
    if (!r.routes || multiple) return;
    const k = rowKey(r);
    setExpanded((x) => (x === k ? null : k));
    const i = items.findIndex((it) => it.kind === 'model' && rowKey(it.row) === k);
    if (i >= 0) setSel(i);
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
    else if (it.kind === 'route') {
      if (it.row.disabled) return;
      // one account or provider, as the owner asked: its own ref is stored
      onChange(it.route.ref);
      onDone?.();
    } else pick(it.row);
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
    } else if (e.key === 'ArrowRight' && (q === '' || (e.target as HTMLInputElement).selectionStart === q.length) && items[sel]?.kind === 'model') {
      // a model with several routes opens them
      const it = items[sel] as Extract<PickerItem, { kind: 'model' }>;
      if (it.row.routes && !multiple && expanded !== rowKey(it.row)) {
        e.preventDefault();
        toggleRoutes(it.row);
      }
    } else if (e.key === 'ArrowLeft' && expanded && (items[sel]?.kind === 'route' || (items[sel]?.kind === 'model' && rowKey((items[sel] as Extract<PickerItem, { kind: 'model' }>).row) === expanded))) {
      // closes the routes first, back on their model
      e.preventDefault();
      const i = items.findIndex((it) => it.kind === 'model' && rowKey(it.row) === expanded);
      setExpanded(null);
      if (i >= 0) setSel(i);
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
            if (it.kind === 'route') {
              const rt = it.route;
              // the stored ref is this route: a pick of one account or provider; the row's own ref is the owner's order
              const here = !multiple && value === rt.ref;
              return (
                <div
                  key={`route:${rowKey(r)}:${rt.ref}`}
                  role="option"
                  aria-selected={here}
                  aria-disabled={r.disabled || undefined}
                  aria-label={rt.first ? `${rt.label}, the first route` : `via ${rt.label}`}
                  {...hover(i, it)}
                  onClick={() => choose(it)}
                  className={cn(ROW, 'min-h-[28px] pl-9 text-[12.5px] phone:min-h-10 phone:text-[14px]', on && !r.disabled && 'bg-hover', r.disabled ? 'text-fg-3' : 'text-fg-2')}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {rt.first ? 'Default' : `via ${rt.label}`}
                    <span className="ml-2 text-fg-3">{rt.first ? (r.model?.via ?? rt.label) : ''}</span>
                  </span>
                  <Check className={cn('size-3.5 shrink-0', !here && 'invisible')} strokeWidth={1.75} aria-hidden />
                </div>
              );
            }
            const head = level === 'top' && i === 0 ? 'Recent' : null;
            const inMaker = level !== 'top' && level !== 'search' ? picker.groups.find((g) => g.key === open) : undefined;
            const family = inMaker ? familyHead(inMaker.rows, inMaker.rows.indexOf(r)) : null;
            const checked = multiple ? picked.includes(r.ref) : r.ref === current;
            // picked through one account or provider: the row says which
            const through = !multiple && checked && value && value !== r.ref && r.routes?.some((x) => !x.first && x.ref === value) ? routeLabel(value) : undefined;
            const routesOpen = expanded === rowKey(r);
            return (
              <div key={`${r.groupKey}:${r.ref}`}>
                {head && <div className="px-2 pt-1.5 pb-1 text-[13px] font-semibold text-fg">{head}</div>}
                {family && <div className="px-2 pt-1.5 pb-0.5 text-[11.5px] font-medium text-fg-3 phone:text-[13px]">{family}</div>}
                <div
                  role="option"
                  aria-selected={checked}
                  aria-disabled={r.disabled || undefined}
                  {...hover(i, it)}
                  onClick={() => pick(r)}
                  title={r.model?.via}
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
                    {(through ?? r.source) && <span className="ml-2 text-[12px] font-normal text-fg-3">via {through ?? r.source}</span>}
                  </span>
                  {r.routes && !multiple && !r.disabled && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={routesOpen ? 'Hide routes' : 'Choose a route'}
                      aria-expanded={routesOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRoutes(r);
                      }}
                      className={cn('shrink-0 rounded-[var(--r-1)] px-1 text-[11.5px] text-fg-3 hover:text-fg phone:text-[13px]', routesOpen && 'text-fg')}
                    >
                      via
                    </button>
                  )}
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
