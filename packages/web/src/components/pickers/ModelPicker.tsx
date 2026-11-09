/**
 * Model picker (spec 10.5, design PR #292): search on top, then provider
 * tabs (All, Anthropic, OpenAI, Google, Z.ai, Local, Coding agents, Other;
 * only the ones that have models). The list: Pinned (the account's pins,
 * kept on the hub in preferences.pinnedModels, shared by its devices), Recent
 * (the last three in the tab), then the tab's models under a heading per
 * maker and a small one per family, strongest family first (Mythos, Fable,
 * Opus, Sonnet, Haiku; GPT, mini and nano, o-series, Codex; Gemini Pro,
 * Flash, Flash-Lite; GLM by size), newest first inside, the ones that cannot
 * be picked last in their family with their reason. The tabs show the
 * makers' logos, their names as tooltip and label. Each row: brand mark,
 * name, the maker's logo on All, and a line with tier, context, price or
 * "plan", vision, tools, thinking. A pin at the right (on hover; a long
 * press on phones). The picker opens on the current model's tab.
 *
 * Typing searches every tab. Keys: arrows move, Enter picks, Right opens a
 * model's routes and Left closes them, else Left and Right in an empty
 * search change tabs; Esc closes. multiple: checkboxes and a "4 selected"
 * footer for jury and debate members.
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
import { Check, HardDrive, Pin, Shapes, SquareTerminal } from 'lucide-react';
import { PINS_MAX, type AccountDto, type ModelEntry, type ModelGroup } from '@conclave/core/client';
import type { Device, Session } from '@conclave/core/types';
import { MODEL_VARIANT as VARIANT } from '@conclave/core/providers/model-id';
import { cn, fuzzy } from '@/lib/text';
import { attempt, useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { api } from '@/lib/api';
import { contextLabel, HARNESSES, modelName, providerName } from '@/lib/models';
import { PROVIDERS } from '@/lib/providers';
import { Popover } from '../ui/Overlay';
import { PickerButton } from '../ui/Select';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Field';
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

/** Anthropic's families, most powerful first. */
const CLAUDE_FAMILIES = ['mythos', 'fable', 'opus', 'sonnet', 'haiku'];

/**
 * A model's family inside its maker, its power rank among the maker's
 * families (0 is the strongest), and its version. Anthropic: Mythos, Fable,
 * Opus, Sonnet, Haiku, other Claude. OpenAI: GPT, GPT mini and nano,
 * o-series, Codex. Google: Gemini Pro, Flash, Flash-Lite, other Gemini,
 * Gemma. Z.ai: GLM, GLM Air, GLM Flash (by size). A maker with no known
 * families has one, its own (rank 9).
 */
export function familyOf(id: string): { family: string; rank: number; version: number[]; dated: number } {
  let m = id.toLowerCase();
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  const date = /-(\d{8})$/.exec(m);
  const base = m.replace(/-\d{8}$/, '');
  const version = (base.match(/\d+/g) ?? []).map(Number);
  const dated = date ? Number(date[1]) : 0;
  const fam = (family: string, rank: number) => ({ family, rank, version, dated });
  for (const [i, f] of CLAUDE_FAMILIES.entries()) if (base.includes(f)) return fam(f[0].toUpperCase() + f.slice(1), i);
  if (/^claude/.test(base)) return fam('Claude', CLAUDE_FAMILIES.length);
  // Codex before GPT: gpt-5.3-codex is a Codex model
  if (/codex/.test(base)) return fam('Codex', 3);
  if (/^gpt/.test(base)) return /-(mini|nano)\b/.test(base) ? fam('GPT mini and nano', 1) : fam('GPT', 0);
  if (/^o\d/.test(base)) return fam('o-series', 2);
  if (/^gemini/.test(base)) {
    if (/flash-lite/.test(base)) return fam('Gemini Flash-Lite', 2);
    if (/flash/.test(base)) return fam('Gemini Flash', 1);
    if (/pro/.test(base)) return fam('Gemini Pro', 0);
    return fam('Gemini', 3);
  }
  if (/^gemma/.test(base)) return fam('Gemma', 4);
  if (/^glm/.test(base)) return /-air\b/.test(base) ? fam('GLM Air', 1) : /-flash\b/.test(base) ? fam('GLM Flash', 2) : fam('GLM', 0);
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
      if (m.sameAs || m.kind === 'image' || m.kind === 'embedding' || NON_CHAT.test(m.id)) continue;
      const maker = entryMaker(m) ?? g.provider;
      if (m.via || m.refs || maker !== g.provider) merged.add(maker);
      const list = byMaker.get(maker) ?? [];
      // the other ways to the same model: a choice behind the row, never rows of their own
      const routes = m.choices?.length ? [{ ref: m.ref, label: routeLabel(m.ref), first: true }, ...m.choices.map((ref): Route => ({ ref, label: planLabel(ref, maker, accounts) }))] : undefined;
      // a model of another provider (a custom one, a router) says whose it is: "GLM-5.3" alone reads as Z.ai's
      const own = g.provider === maker || VENDOR_MAKER[g.provider] === maker;
      // a row with routes or its own "via" already says how it is reached
      const source = own || routes || m.via ? undefined : g.name && g.name !== g.provider ? g.name : providerName(g.provider);
      const row: Row = { ref: m.ref, model: m, group: providerName(maker), groupKey: maker, disabled: !g.enabled || !!m.unavailable, family: familyOf(m.id).family || undefined, ...(routes ? { routes } : {}), ...(source ? { source } : {}) };
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
      disabled: off.has(ref.split('/')[0]) || !!byRef.get(ref)?.unavailable,
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

/** Where a row sits in the list: Pinned, Recent, or the tab's ranked list. Each opens its routes on its own. */
export type Section = 'pin' | 'recent' | 'list';

/** One line of the list: a heading (a maker's with its mark, or a family's), a model, or one route to a model under its row. */
export type PickerItem = { kind: 'head'; label: string; maker?: string; family?: boolean } | { kind: 'model'; row: Row; section: Section } | { kind: 'route'; row: Row; route: Route; section: Section };

/** A row's key in the list. */
export const rowKey = (r: Row) => `${r.groupKey}:${r.ref}`;
/** A row's key with its section: the key `expanded` names. */
export const lineKey = (r: Row, section: Section) => `${section}:${rowKey(r)}`;

/** A model's line, then its routes when the owner opened them. */
function withRoutes(rows: Row[], section: Section, expanded: string | null | undefined): PickerItem[] {
  return rows.flatMap((row): PickerItem[] => [{ kind: 'model', row, section }, ...(expanded === lineKey(row, section) && row.routes ? row.routes.map((route): PickerItem => ({ kind: 'route', row, route, section })) : [])]);
}

/** The provider tabs, in order; the picker shows All and the ones that have models. */
export const TABS = [
  { value: 'all', label: 'All' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'zai', label: 'Z.ai' },
  { value: 'local', label: 'Local' },
  { value: 'agents', label: 'Coding agents' },
  { value: 'other', label: 'Other' },
] as const;
export type Tab = (typeof TABS)[number]['value'];
const MAKER_TABS: readonly string[] = ['anthropic', 'openai', 'google', 'zai'];

const TAB_ICON = { local: HardDrive, agents: SquareTerminal, other: Shapes } as const;

/** A tab's face: "All" in words, a maker's logo, else a neutral icon; the name is its tooltip and label. */
function TabFace({ tab, label }: { tab: Tab; label: string }) {
  if (tab === 'all') return <>{label}</>;
  if (MAKER_TABS.includes(tab)) return <CompanyMark provider={tab} size={14} tone="brand" label={label} />;
  const Icon = TAB_ICON[tab as keyof typeof TAB_ICON];
  return <Icon className="size-3.5" strokeWidth={1.75} role="img" aria-label={label} />;
}

// shortcut: local servers by provider id, as price() reads them; a custom provider on a LAN address counts as Other until the hub says where a provider runs
const LOCAL = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama-cpp', 'vllm', 'localai', 'jan']);
export const isLocalProvider = (provider: string) => LOCAL.has(provider);

/** A row's tab: coding agents, then local servers (whoever made the model), then its maker, else Other. */
export function tabOf(r: Pick<Row, 'ref' | 'harness' | 'groupKey'>): Tab {
  if (r.harness) return 'agents';
  if (isLocalProvider(r.ref.split('/')[0])) return 'local';
  return MAKER_TABS.includes(r.groupKey) ? (r.groupKey as Tab) : 'other';
}

const TIER: Record<string, number> = { deep: 0, smart: 1, fast: 2 };
const TIER_WORD: Record<string, string> = { deep: 'Deep', smart: 'Smart', fast: 'Fast' };

/**
 * Most capable first: rows that can be picked before the rest, then the
 * catalog's tier (deep, smart, fast, none; coding agents after), then the
 * larger context window, then the higher output price, then the newer model.
 */
export function capabilityRank(a: Row, b: Row): number {
  const tier = (r: Row) => (r.harness ? 4 : (TIER[r.model?.tier ?? ''] ?? 3));
  return (
    Number(!!a.disabled) - Number(!!b.disabled) ||
    tier(a) - tier(b) ||
    (b.model?.contextWindow ?? 0) - (a.model?.contextWindow ?? 0) ||
    (b.model?.outputPrice ?? 0) - (a.model?.outputPrice ?? 0) ||
    compareModels(a.model?.id ?? a.ref, b.model?.id ?? b.ref)
  );
}

/** OpenCode's free models (big-pickle, ids ending in -free): free only inside the opencode CLI. */
export function isFreeModel(r: Pick<Row, 'ref' | 'harness'>): boolean {
  const id = r.ref.slice(r.ref.lastIndexOf('/') + 1).toLowerCase();
  return !!r.harness && (id.endsWith('-free') || id === 'big-pickle');
}
export const FREE_NOTE = 'Free inside OpenCode for a limited time; providers may keep data.';

/** "Deep, 1M context, $4 / $20, vision, tools, thinking": the row's second line. A coding agent says where it runs ("via OpenCode on Xeno" when a device listed it). */
export function capabilityLine(r: Row): string {
  if (r.harness) return [r.model?.via ?? (r.where || 'Coding agent'), isFreeModel(r) && FREE_NOTE].filter(Boolean).join('. ');
  const m = r.model;
  if (!m) return '';
  // price before the abilities: on a phone the line wraps to two lines at most, and the price matters more
  return [m.tier && TIER_WORD[m.tier], m.contextWindow ? `${contextLabel(m.contextWindow)} context` : '', price(m, r.ref.split('/')[0]), m.vision && 'vision', m.tools && 'tools', m.thinking && 'thinking'].filter(Boolean).join(', ');
}

/** Every row of every maker, once; a plan's copy of a model with no tier of its own takes the catalog's by name. */
export function allRows(p: Picker): Row[] {
  const rows = p.groups.flatMap((g) => g.rows);
  const tiers = new Map(rows.filter((r) => r.model?.tier).map((r) => [rowName(r), r.model!.tier]));
  return rows.map((r) => (r.model && !r.model.tier && tiers.has(rowName(r)) ? { ...r, model: { ...r.model, tier: tiers.get(rowName(r)) } } : r));
}

const rowFamily = (r: Row) => (r.harness ? { family: '', rank: 9 } : familyOf(r.model?.id ?? r.ref));

/** The list's order: by maker, then family by power (Mythos, Fable, Opus, Sonnet, Haiku), the ones that cannot be picked last inside it, then newest first. */
export function familyOrder(a: Row, b: Row): number {
  const x = rowFamily(a);
  const y = rowFamily(b);
  return (
    makerRank(a.groupKey) - makerRank(b.groupKey) ||
    a.groupKey.localeCompare(b.groupKey) ||
    x.rank - y.rank ||
    x.family.localeCompare(y.family) ||
    Number(!!a.disabled) - Number(!!b.disabled) ||
    compareModels(a.model?.id ?? a.ref, b.model?.id ?? b.ref)
  );
}

/** The tab's models: a heading per maker (with its account word), a small one per family, rows in familyOrder. */
function byFamily(p: Picker, rows: Row[], expanded: string | null | undefined): PickerItem[] {
  const out: PickerItem[] = [];
  let maker = '';
  let family: string | undefined;
  for (const r of [...rows].sort(familyOrder)) {
    if (r.groupKey !== maker) {
      maker = r.groupKey;
      family = undefined;
      const word = p.groups.find((g) => g.key === maker)?.word;
      out.push({ kind: 'head', label: `${r.harness ? 'Coding agents' : r.group}${word ? `, ${word}` : ''}`, ...(r.harness ? {} : { maker }) });
    }
    const f = rowFamily(r).family;
    // a model of no known family after the families goes under "Other"
    if (f !== (family ?? '') && (f || family)) out.push({ kind: 'head', label: f || 'Other', family: true });
    family = f;
    out.push(...withRoutes([r], 'list', expanded));
  }
  return out;
}

/** All, and the tabs that have a model. */
export function shownTabs(rows: Row[]): Array<(typeof TABS)[number]> {
  return TABS.filter((t) => t.value === 'all' || rows.some((r) => tabOf(r) === t.value));
}

/**
 * What the list shows under the search and the tabs: Pinned (the account's
 * pins in this tab), Recent (the last three in this tab, pins left out),
 * then the tab's models by maker and family, strongest family first, newest
 * first inside, the ones that cannot be picked last in their family. A search lists the matches of every tab (a model is never hidden
 * behind the tab the picker opened on), ranked the same, with no Pinned or
 * Recent. A model whose routes are open has them under it.
 */
export function pickerItems(p: Picker, q: string, tab: Tab, pinned: readonly string[] = [], expanded?: string | null): PickerItem[] {
  const all = allRows(p);
  const inTab = (r: Row) => tab === 'all' || tabOf(r) === tab;
  const needle = q.trim();
  const ranked = all.filter((r) => (needle || inTab(r)) && (!needle || fuzzy(needle, `${rowName(r)} ${r.model?.name ?? ''} ${r.ref} ${r.group}`) >= 0)).sort(capabilityRank);
  if (!ranked.length) return [];
  if (needle) return [{ kind: 'head', label: `Matches for "${needle}"` }, ...withRoutes(ranked, 'list', expanded)];
  const pins = ranked.filter((r) => pinned.includes(r.ref));
  const recent = p.recent
    .map((r) => all.find((x) => x.ref === r.ref) ?? r)
    .filter((r) => inTab(r) && !pinned.includes(r.ref))
    .slice(0, 3);
  return [
    ...(pins.length ? [{ kind: 'head', label: 'Pinned' } as const, ...withRoutes(pins, 'pin', expanded)] : []),
    ...(recent.length ? [{ kind: 'head', label: 'Recent' } as const, ...withRoutes(recent, 'recent', expanded)] : []),
    ...byFamily(p, ranked, expanded),
  ];
}

const canPick = (it: PickerItem | undefined) => !!it && it.kind !== 'head' && !it.row.disabled;

/** Where the highlight starts: the current model, else the first line that can be picked. */
function startAt(items: PickerItem[], current: string | undefined): number {
  if (current) {
    const i = items.findIndex((it) => it.kind === 'model' && it.row.ref === current && !it.row.disabled);
    if (i >= 0) return i;
  }
  const i = items.findIndex(canPick);
  return i >= 0 ? i : 0;
}

/** The account's pinned models (GET /api/me), shared by its devices. */
export const usePins = (): string[] => useHub((s) => s.me?.preferences?.pinnedModels) ?? NO_PINS;
const NO_PINS: string[] = [];

/** Pin or unpin a model: at once on screen, then on the hub; a refusal puts the old list back and the toast says why. */
export async function togglePin(ref: string): Promise<void> {
  const before = useHub.getState().me?.preferences?.pinnedModels ?? [];
  const next = before.includes(ref) ? before.filter((x) => x !== ref) : [...before, ref].slice(-PINS_MAX);
  const put = (pinnedModels: string[] | undefined) => {
    const me = useHub.getState().me;
    if (me) useHub.setState({ me: { ...me, preferences: { ...me.preferences, pinnedModels } } });
  };
  put(next.length ? next : undefined);
  if (!(await attempt(() => api().updateMe({ pinnedModels: next.length ? next : null })))) put(before.length ? before : undefined);
}

const ROW = 'flex min-h-[44px] items-center gap-2.5 rounded-[var(--r-1)] px-2 py-1.5 text-[13px] phone:min-h-14 phone:text-[15px]';

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
  /** Under the list (the composer's Effort for the model). */
  foot?: ReactNode;
}

/** The searchable list itself, for embedding in a popover, sheet or page. */
export function ModelList({ value, values, onChange, onChangeMany, harnesses = true, onDone, footer, autoFocus = true, foot }: ModelListProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [, navigate] = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  const picker = usePicker(harnesses);
  const phone = useIsMobile();
  const groups = useHub((s) => s.models);
  const pinned = usePins();
  const multiple = !!onChangeMany;
  const picked = (values ?? []).map((v) => shownRef(groups, v) ?? v);
  // a session that names another route's ref (anthropic/ while the plan goes first) checks the merged row
  const current = shownRef(groups, value);
  const rows = useMemo(() => allRows(picker), [picker]);
  const tabs = shownTabs(rows);

  // Opens on the current model's tab; with no model (or several), on All.
  const tabFor = (): Tab => {
    const r = !multiple && current ? rows.find((x) => x.ref === current) : undefined;
    return r ? tabOf(r) : 'all';
  };
  const [want, setWant] = useState<Tab>(tabFor);
  const tab: Tab = tabs.some((t) => t.value === want) ? want : 'all';
  const moved = useRef(false);
  // the models came after the list opened: open on the current model's tab then, unless the owner moved already
  const known = rows.length > 0;
  useEffect(() => {
    if (known && !moved.current) setWant(tabFor());
  }, [known]); // eslint-disable-line react-hooks/exhaustive-deps

  // the model whose routes are open under it (lineKey), if any
  const [expanded, setExpanded] = useState<string | null>(null);
  const items = useMemo(() => pickerItems(picker, q, tab, pinned, multiple ? null : expanded), [picker, q, tab, pinned, expanded, multiple]);
  const enabled = items.map((it, i) => (canPick(it) ? i : -1)).filter((i) => i >= 0);
  const level = `${tab}:${q.trim() ? 'search' : 'list'}`;

  const setTab = (t: Tab) => {
    moved.current = true;
    setExpanded(null);
    setWant(t);
  };

  // Each tab starts on the current model (or the first line) in view; later, only keys scroll the list, never the pointer.
  const keyMove = useRef(false);
  const reveal = (i: number) => listRef.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`)?.scrollIntoView?.({ block: 'nearest' });
  useEffect(() => {
    const start = startAt(items, q.trim() ? undefined : current);
    setSel(start);
    if (listRef.current) listRef.current.scrollTop = 0;
    reveal(start);
  }, [level, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!keyMove.current) return;
    keyMove.current = false;
    reveal(sel);
  }, [sel]);

  /** Open or close a model's routes, keeping the highlight on its row. */
  const toggleRoutes = (r: Row, section: Section) => {
    if (!r.routes || multiple) return;
    const k = lineKey(r, section);
    setExpanded((x) => (x === k ? null : k));
    const i = items.findIndex((it) => it.kind === 'model' && lineKey(it.row, it.section) === k);
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
    if (!it || it.kind === 'head') return;
    if (it.kind === 'route') {
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
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') return;
    const it = items[sel];
    const atEnd = q === '' || (e.target as HTMLInputElement).selectionStart === q.length;
    if (e.key === 'ArrowRight' && atEnd && it?.kind === 'model' && it.row.routes && !multiple && expanded !== lineKey(it.row, it.section)) {
      // a model with several routes opens them
      e.preventDefault();
      toggleRoutes(it.row, it.section);
    } else if (e.key === 'ArrowLeft' && expanded && it && it.kind !== 'head' && lineKey(it.row, it.section) === expanded) {
      // closes the routes first, back on their model
      e.preventDefault();
      const i = items.findIndex((x) => x.kind === 'model' && lineKey(x.row, x.section) === expanded);
      setExpanded(null);
      if (i >= 0) setSel(i);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && q === '') {
      // with no search, Left and Right move between the tabs
      const i = tabs.findIndex((t) => t.value === tab) + (e.key === 'ArrowRight' ? 1 : -1);
      if (tabs[i]) {
        e.preventDefault();
        setTab(tabs[i].value);
      }
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
      <div className="shrink-0 space-y-2 border-b border-rule p-2">
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search models"
          aria-label="Search models"
          className="h-8 w-full rounded-[var(--r-1)] border border-edge bg-sunk px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-signal focus:shadow-[0_0_0_1px_var(--signal)] phone:h-11 phone:text-[16px]"
        />
        {tabs.length > 2 && (
          // on a phone the row scrolls sideways rather than squeeze the makers
          <div className="no-scrollbar -mx-2 overflow-x-auto px-2">
            <Segmented size="sm" full label="Provider" value={tab} onChange={setTab} options={tabs.map((t) => ({ value: t.value, label: <TabFace tab={t.value} label={t.label} />, title: t.label }))} />
          </div>
        )}
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Models"
        aria-multiselectable={multiple || undefined}
        className="min-h-0 flex-1 overflow-y-auto p-1"
        // one height for every tab, so the popover does not jump or flip sides and the sheet keeps its top edge
        style={{ flexBasis: phone ? '52dvh' : 'min(360px, 64dvh)' }}
      >
        <div>
          {items.length === 0 && <p className="px-2 py-4 text-[13px] text-fg-3">{q.trim() ? `No model matches "${q}".` : 'No models yet. Add a key in Settings, Providers.'}</p>}
          {items.map((it, i) => {
            const on = i === sel;
            if (it.kind === 'head')
              return it.family ? (
                <div key={`h:${i}:${it.label}`} role="presentation" data-family={it.label} className="px-2 pt-1.5 pb-0.5 text-[11px] text-fg-4 phone:text-[12px]">
                  {it.label}
                </div>
              ) : (
                <div key={`h:${i}:${it.label}`} role="presentation" className="flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[12px] font-medium text-fg-3 phone:text-[13px]">
                  {it.maker && <CompanyMark provider={it.maker} size={12} />}
                  {it.label}
                </div>
              );
            const r = it.row;
            if (it.kind === 'route') {
              const rt = it.route;
              // the stored ref is this route: a pick of one account or provider; the row's own ref is the owner's order
              const here = !multiple && value === rt.ref;
              return (
                <div
                  key={`route:${lineKey(r, it.section)}:${rt.ref}`}
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
            const section = it.section;
            const checked = multiple ? picked.includes(r.ref) : r.ref === current;
            // picked through one account or provider: the row says which
            const through = !multiple && checked && value && value !== r.ref && r.routes?.some((x) => !x.first && x.ref === value) ? routeLabel(value) : undefined;
            const routesOpen = expanded === lineKey(r, section);
            const pin = pinned.includes(r.ref);
            return (
              <div key={lineKey(r, section)}>
                <div
                  role="option"
                  aria-selected={checked}
                  aria-disabled={r.disabled || undefined}
                  {...hover(i, it)}
                  onClick={() => pick(r)}
                  // phones: a long press pins, so rows carry no pin until one is pinned
                  onContextMenu={(e) => {
                    if (!phone || r.disabled) return;
                    e.preventDefault();
                    void togglePin(r.ref);
                  }}
                  title={r.model?.via}
                  className={cn(ROW, 'group/row', on && !r.disabled && 'bg-hover', r.disabled ? 'text-fg-3' : 'text-fg')}
                >
                  {multiple && (
                    <span aria-hidden className={cn('grid size-3.5 shrink-0 place-items-center rounded-[2px] border', checked ? 'border-fg bg-fg text-bg' : 'border-edge')}>
                      {checked && <Check className="size-2.5" strokeWidth={2.5} />}
                    </span>
                  )}
                  {r.harness ? <HarnessMark harness={r.ref} size={18} /> : <ModelMark model={r.ref} size={18} tone={r.disabled ? 'mono' : 'brand'} />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate font-medium">{rowName(r)}</span>
                      {isFreeModel(r) && <span className="shrink-0 self-center rounded-[var(--r-1)] border border-edge px-1 text-[10.5px] leading-4 text-fg-3">Free</span>}
                      {(tab === 'all' || q.trim()) && !r.harness && r.groupKey !== 'recent' && <CompanyMark provider={r.groupKey} size={12} label={r.group} className="self-center text-fg-3" />}
                      {(through ?? r.source) && <span className="min-w-0 truncate text-[12px] text-fg-3 phone:text-[13px]">via {through ?? r.source}</span>}
                    </span>
                    <span className={cn('block truncate text-[12px] phone:line-clamp-2 phone:text-[13px] phone:whitespace-normal', r.model?.unavailable ? 'text-warn' : 'text-fg-3')}>
                      {r.model?.unavailable ?? (r.disabled && !r.harness ? 'No key for this provider' : capabilityLine(r))}
                    </span>
                  </span>
                  {r.routes && !multiple && !r.disabled && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={routesOpen ? 'Hide routes' : 'Choose a route'}
                      aria-expanded={routesOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRoutes(r, section);
                      }}
                      className={cn('shrink-0 rounded-[var(--r-1)] px-1 text-[12px] text-fg-3 hover:text-fg phone:text-[13px]', routesOpen && 'text-fg')}
                    >
                      via
                    </button>
                  )}
                  {r.disabled && !r.harness && !r.model?.unavailable ? (
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
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-pressed={pin}
                      aria-label={pin ? `Unpin ${rowName(r)}` : `Pin ${rowName(r)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void togglePin(r.ref);
                      }}
                      className={cn('grid size-6 shrink-0 place-items-center rounded-[var(--r-1)] hov:bg-hover phone:size-9', pin ? 'text-fg-2' : 'text-fg-4 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 phone:sr-only')}
                    >
                      <Pin className="size-3.5" strokeWidth={1.75} aria-hidden />
                    </button>
                  )}
                  {!multiple && <Check className={cn('size-3.5 shrink-0', !checked && 'invisible')} strokeWidth={1.75} aria-hidden />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {foot}
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
