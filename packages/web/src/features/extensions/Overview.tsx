/**
 * Extensions: Overview (docs/extensions/IA.md). Answers "what is loaded, and
 * is anything broken?": problems first, each linking to its tab, then what
 * is loaded, the other CLIs with their compat switches, and quick actions.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { CliName, ExtensionProblem, ExtensionSourceInfo, ExtensionsOverview, InventoryItemDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { HarnessName } from '@/components/logo';
import { OnOff } from '@/components/ui/Field';
import { ListRow, type StateTone } from '@/components/ui/List';
import { Section } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { save } from '@/features/settings/parts';
import { useExtCwd } from './project';
import { plural } from '@/lib/format';
import { LoadFailed, RefreshFailed, andList, sentence } from './shared/parts';
import { scopeWord } from './shared/SourceBadge';
import { advice } from './mcp/parts';

type CompatKey = 'claudeCode' | 'codex' | 'opencode' | 'gemini';

const OTHER_CLIS: Array<{ cli: CliName; harness: string; label: string; compat: CompatKey; reads: string }> = [
  { cli: 'claude', harness: 'claude-code', label: 'Claude Code', compat: 'claudeCode', reads: '~/.claude and .claude/' },
  { cli: 'codex', harness: 'codex', label: 'Codex', compat: 'codex', reads: '~/.codex and ~/.agents' },
  { cli: 'opencode', harness: 'opencode', label: 'OpenCode', compat: 'opencode', reads: '~/.config/opencode and .opencode/' },
  { cli: 'gemini', harness: 'gemini-cli', label: 'Gemini CLI', compat: 'gemini', reads: '~/.gemini and .gemini/' },
];

/** "2 skills and 3 commands" from a source's counts; empty when it adds nothing. */
export function addsWords(c: ExtensionSourceInfo['counts'] | undefined): string {
  if (!c) return '';
  const parts = [c.agents && plural(c.agents, 'agent'), c.skills && plural(c.skills, 'skill'), c.commands && plural(c.commands, 'command')].filter(Boolean) as string[];
  return andList(parts);
}

export function OverviewTab() {
  const cwd = useExtCwd();
  const hubName = useHub((s) => s.hub?.name) ?? 'the hub';
  const ov = useLoad(() => api().extensionsOverview(cwd), [cwd]);
  const src = useLoad(() => api().extensionSources(cwd), [cwd]);
  const inv = useLoad(() => api().extensionsInventory({ cwd }), [cwd]);
  const data = ov.data;

  if (ov.error && !data) return <LoadFailed what="the overview" error={ov.error} retry={ov.reload} />;
  if (!data) return <LoadingRows loading={ov.loading} rows={6} />;

  const reload = () => {
    ov.reload();
    src.reload();
    inv.reload();
  };

  return (
    <>
      <RefreshFailed error={ov.error} retry={reload} className="mb-4" />
      <div className="grid gap-x-14 gap-y-8 xl:grid-cols-2">
        <div className="min-w-0 space-y-8">
          <Problems problems={data.problems} />
          <Loaded data={data} items={inv.data} />
        </div>
        <div className="min-w-0 space-y-8 xl:-ml-7 xl:border-l xl:border-rule xl:pl-7">
          <OtherClis data={data} sources={src.data} hubName={hubName} onChanged={reload} />
          <QuickActions />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

/**
 * The hub sends one conflict problem per shadowed copy ("skill defined in
 * claude user is shadowed by user"). Show one row per name, in words:
 * "Skill. In use: the user copy. Shadowed: the Claude Code user copy."
 */
function mergeConflicts(problems: ExtensionProblem[]): Array<ExtensionProblem & { copies?: number }> {
  const out: Array<ExtensionProblem & { copies?: number }> = [];
  const byName = new Map<string, { kind: string; winner?: string; losers: string[]; raw: string[] }>();
  for (const p of problems) {
    if (p.kind !== 'conflict' || !p.name) {
      out.push(p);
      continue;
    }
    const m = /^(\w+) defined in (.+) is shadowed by (.+)$/.exec(p.message);
    const key = `${m?.[1] ?? ''}\u0000${p.name}`;
    let g = byName.get(key);
    if (!g) {
      g = { kind: m?.[1] ?? '', losers: [], raw: [] };
      byName.set(key, g);
      out.push({ kind: 'conflict', name: p.name, message: key });
    }
    if (m) {
      g.losers.push(scopeWord(m[2]));
      g.winner = scopeWord(m[3]);
    } else g.raw.push(p.message);
  }
  return out.map((p) => {
    if (p.kind !== 'conflict') return p;
    const g = byName.get(p.message)!;
    const kind = g.kind ? `${g.kind[0].toUpperCase()}${g.kind.slice(1)}. ` : '';
    const message = g.winner ? `${kind}In use: the ${g.winner} copy. Shadowed: ${andList(g.losers.map((l) => `the ${l} copy`))}.` : g.raw.map(sentence).join(' ');
    return { ...p, message, copies: Math.max(2, g.losers.length + 1) };
  });
}

const upFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const TIMES = ['', 'once', 'twice', 'three times', 'four times', 'five times'];

function problemRow(p: ExtensionProblem & { copies?: number }): { title: ReactNode; meta: string; state: string; tone: StateTone; href: string } {
  const mono = (s: string | undefined) => <span className="mono">{s}</span>;
  switch (p.kind) {
    case 'mcp':
      return { title: <>MCP server {mono(p.name)}</>, meta: `${upFirst(sentence(p.message))} ${advice(p.message)}`, state: 'failed', tone: 'fault', href: '/extensions/mcp' };
    case 'hook':
      return {
        title: (
          <>
            {mono(p.event)} hook {p.name && <span className="mono text-fg-2">{p.name}</span>}
          </>
        ),
        meta: `${upFirst(sentence(p.message))} ${/timed out/.test(p.message) ? 'Give it a longer timeout, or make the script return sooner.' : 'Open it to see what it printed.'}`,
        state: /timed out/.test(p.message) ? 'timed out' : 'failed',
        tone: 'fault',
        href: `/extensions/hooks${p.event ? `?event=${p.event}` : ''}`,
      };
    case 'event':
      return { title: <>{mono(p.event)} hooks</>, meta: p.message, state: 'not fired', tone: 'warn', href: `/extensions/hooks${p.event ? `?event=${p.event}` : ''}` };
    case 'conflict':
      return { title: <>{mono(p.name)} is defined {TIMES[p.copies ?? 2] ?? `${p.copies} times`}</>, meta: p.message, state: 'shadowed', tone: 'dim', href: '/extensions/sources#conflicts' };
    case 'trust':
      return { title: 'This folder is not trusted', meta: sentence(p.message), state: 'not trusted', tone: 'warn', href: '/extensions/hooks' };
    default:
      return { title: String((p as ExtensionProblem).kind), meta: (p as ExtensionProblem).message, state: '', tone: 'dim', href: '/extensions' };
  }
}

const ORDER: Record<ExtensionProblem['kind'], number> = { mcp: 0, hook: 1, trust: 2, event: 3, conflict: 4 };

function Problems({ problems }: { problems: ExtensionProblem[] }) {
  const [all, setAll] = useState(false);
  const merged = mergeConflicts(problems);
  const sorted = [...merged].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const shown = all ? sorted : sorted.slice(0, 6);
  const broken = problems.filter((p) => p.kind === 'mcp' || p.kind === 'hook').length;
  return (
    <Section title="Problems" count={merged.length || undefined} countTone={broken ? 'warn' : undefined}>
      {merged.length === 0 ? (
        <p className="py-3 text-[13px] text-fg-2 phone:text-[14px]">Nothing needs a look. No MCP server failed, no recent hook run went wrong and no name is defined twice.</p>
      ) : (
        <>
          {shown.map((p, i) => {
            const r = problemRow(p);
            return <ListRow key={i} inset={false} href={r.href} title={r.title} meta={<span className="whitespace-normal">{r.meta}</span>} state={r.state} stateTone={r.tone} />;
          })}
          {sorted.length > shown.length && (
            <button type="button" onClick={() => setAll(true)} className="tap block w-full py-2.5 text-left text-[12px] text-fg-3 hover:text-fg phone:text-[13px]">
              Show all {sorted.length}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// What is loaded
// ---------------------------------------------------------------------------

/** "7 from plugins, 3 yours, 4 from other CLIs" over the copies in use, so the parts add up to the count. */
function byOrigin(items: InventoryItemDto[] | undefined, kind: InventoryItemDto['kind']): string {
  if (!items) return '';
  const n = (ids: string[]) => items.filter((i) => i.active && i.kind === kind && ids.includes(i.source)).length;
  const parts = [
    n(['builtin']) && `${n(['builtin'])} built in`,
    n(['plugin']) && `${n(['plugin'])} from plugins`,
    n(['user', 'project']) && `${n(['user', 'project'])} yours`,
    n(['claude', 'codex', 'opencode', 'gemini', 'agents']) && `${n(['claude', 'codex', 'opencode', 'gemini', 'agents'])} from other CLIs`,
  ].filter(Boolean) as string[];
  return parts.join(', ');
}

function Count({ n }: { n: number }) {
  return <span className="num shrink-0 self-center text-[15px] font-[540] text-fg phone:text-[16px]">{n.toLocaleString('en-US')}</span>;
}

function Loaded({ data, items }: { data: ExtensionsOverview; items: InventoryItemDto[] | undefined }) {
  const c = data.counts;
  const builtin = c.tools - c.mcpTools;
  const rows: Array<{ title: string; meta: string; n: number; href: string }> = [
    { title: 'Tools', meta: c.mcpTools ? `${builtin} built in, ${c.mcpTools} from MCP servers` : `${builtin} built in, none from MCP servers`, n: c.tools, href: '/extensions/tools' },
    { title: 'Skills', meta: byOrigin(items, 'skill') || (c.skills ? '' : 'None yet'), n: c.skills, href: '/extensions/skills' },
    { title: 'Commands', meta: byOrigin(items, 'command') || (c.commands ? '' : 'None yet'), n: c.commands, href: '/extensions/commands' },
    { title: 'Agents', meta: byOrigin(items, 'agent'), n: c.agents, href: '/agents' },
    { title: 'Hook handlers', meta: c.hookHandlers ? 'Scripts that run at fixed points in a session' : 'None yet', n: c.hookHandlers, href: '/extensions/hooks' },
    { title: 'Plugins', meta: c.plugins.installed ? `${c.plugins.enabled} of ${c.plugins.installed} on` : 'None installed', n: c.plugins.installed, href: '/extensions/plugins' },
    { title: 'MCP servers', meta: c.mcpServers.enabled ? `${c.mcpServers.enabled} on, ${c.mcpServers.connected} connected` : 'None on', n: c.mcpServers.enabled, href: '/extensions/mcp' },
  ];
  return (
    <Section title="Loaded">
      {rows.map((r) => (
        <ListRow key={r.title} inset={false} href={r.href} title={r.title} meta={r.meta ? <span className="truncate">{r.meta}</span> : undefined} right={<Count n={r.n} />} />
      ))}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Other CLIs
// ---------------------------------------------------------------------------

function OtherClis({ data, sources, hubName, onChanged }: { data: ExtensionsOverview; sources: ExtensionSourceInfo[] | undefined; hubName: string; onChanged: () => void }) {
  const mobile = useIsMobile();
  const [pending, setPending] = useState<Partial<Record<CompatKey, boolean>>>({});
  // keep the chosen value until fresh data arrives, so the control never flips back for a moment
  useEffect(() => setPending({}), [data]);
  const set = async (key: CompatKey, v: boolean) => {
    setPending((p) => ({ ...p, [key]: v }));
    if (await save({ compat: { [key]: v } })) return onChanged();
    setPending((p) => {
      const n = { ...p };
      delete n[key];
      return n;
    });
  };
  return (
    <Section title="Other CLIs" right={<span className="text-[12px] text-fg-3 phone:text-[13px]">on {hubName}</span>}>
      <p className="py-2.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">When one is on, Conclave also reads that CLI's agents, skills and commands, so your agents can use them.</p>
      {OTHER_CLIS.map((x) => {
        const on = pending[x.compat] ?? data.compat[x.compat];
        const version = data.clis[x.cli];
        const adds = addsWords(sources?.find((s) => s.id === x.cli)?.counts);
        const meta = [version ? `${version} installed` : 'not installed', on ? (adds ? `adds ${adds}` : 'adds nothing yet') : `reads ${x.reads} when on`].join(', ');
        return (
          <div key={x.cli} className="flex items-center gap-4 py-[var(--row-py)] phone:flex-wrap phone:gap-y-2">
            <div className="min-w-0 flex-1">
              <HarnessName harness={x.harness} size={14} className="t-row text-fg" />
              <div className={cn('mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]')}>{meta}</div>
            </div>
            <OnOff checked={on} onChange={(v) => void set(x.compat, v)} label={`Read ${x.label} files`} size={mobile ? 'touch' : 'sm'} />
          </div>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

const ACTIONS = [
  { title: 'Discover', meta: 'Find MCP servers, skills, plugins and hook recipes on GitHub', href: '/extensions/discover' },
  { title: 'Install a plugin', meta: 'Search the marketplaces you added', href: '/extensions/plugins?view=marketplace' },
  { title: 'Add an MCP server', meta: 'A command, a URL, or paste one from another CLI', href: '/extensions/mcp?add=1' },
  { title: 'Connect memory to my CLIs', meta: 'Let Claude Code, Codex and OpenCode search your memory', href: '/memory/share' },
  { title: 'Sync to other CLIs', meta: 'Copy your skills and agents into their folders', href: '/extensions/sources#sync' },
];

function QuickActions() {
  return (
    <Section title="Quick actions">
      {ACTIONS.map((a) => (
        <ListRow key={a.href} inset={false} href={a.href} title={a.title} meta={<span className="truncate">{a.meta}</span>} />
      ))}
    </Section>
  );
}

