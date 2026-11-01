/**
 * Extensions: Tools (docs/extensions/IA.md). Every tool an agent can call,
 * grouped (file, shell, web, agents, memory, browser, other, then one group
 * per MCP server). A row opens to show which agents can use it and why, the
 * permission in effect with the rule that decides it, and inline Always
 * allow, Always ask and Deny. "Test a call" runs the same permission check a
 * session runs, without running the tool.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearch } from 'wouter';
import type { ToolCheckResult, ToolDetail } from '@conclave/core/client';
import type { PermissionMode } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { reloadConfig, toast, updateConfig, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { SelectMenu, type SelectOption } from '@/components/ui/Select';
import { KV, SectionHeading, TextAction } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { LoadingRows } from '@/components/ui/EmptyState';
import { useExtCwd } from './project';
import { plural } from '@/lib/format';
import { LoadFailed, RefreshFailed, TOUCH, firstSentence, sentence } from './shared/parts';
import { shortPath } from './shared/ProjectPicker';
import { TrustBanner, onTrustChange } from './shared/TrustBanner';

const GROUP_ORDER = ['file', 'shell', 'web', 'agents', 'memory', 'browser', 'other'];
const GROUP_LABEL: Record<string, string> = {
  file: 'Files',
  shell: 'Shell',
  web: 'Web',
  agents: 'Agents and planning',
  memory: 'Memory',
  browser: 'Browser',
  other: 'Other',
};
const GROUP_HELP: Record<string, string> = {
  browser: 'Opt-in: an agent gets these only when its tools list names them.',
};
const MCP_PREVIEW = 8;

type Kind = 'all' | 'builtin' | 'mcp';
type Decision = ToolDetail['permission']['decision'];
type RuleList = 'allow' | 'ask' | 'deny';
type Perms = { allow: string[]; ask: string[]; deny: string[] };

const DECISION_TONE: Record<Decision, string> = { allow: 'text-fg-3', ask: 'text-fg-2', deny: 'text-fault' };

/** "config.json", "~/.claude/settings.json", "the agent's rules". */
function ruleSourceWords(src: string | null | undefined): ReactNode {
  if (!src) return null;
  if (src === 'config') return <span className="mono">~/.conclave/config.json</span>;
  if (src === 'agent') return "the agent's own rules";
  return <span className="mono break-all">{shortPath(src)}</span>;
}

function hookWords(n: number, when: 'before' | 'after'): string {
  return `${plural(n, 'hook')} ${n === 1 ? 'runs' : 'run'} ${when} this tool`;
}

export function ToolsTab() {
  const cwd = useExtCwd();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const agents = useHub((s) => s.agents);
  const cfgPerms = useHub((s) => (s.config as { permissions?: Partial<Perms> } | undefined)?.permissions);
  // /extensions/tools?agent=coder (from an agent's page) opens with that agent picked
  const [agent, setAgent] = useState<string>(() => {
    const a = params.get('agent');
    return a && agents.some((x) => x.name === a) ? a : 'all';
  });
  const pickAgent = (a: string) => {
    setAgent(a);
    // keep ?agent= in step so a reload or a shared link shows the same view
    const p = new URLSearchParams(location.search);
    if (a === 'all') p.delete('agent');
    else p.set('agent', a);
    const qs = p.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  };
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(params.get('tool') ? [params.get('tool')!] : []));
  const [testTool, setTestTool] = useState<string | undefined>(params.get('tool') ?? undefined);
  const testRef = useRef<HTMLElement>(null);

  const tools = useLoad(() => api().toolsDetail({ cwd, agent: agent === 'all' ? undefined : agent }), [cwd, agent]);
  // trusting the folder here or on the Hooks tab turns its allow rules on
  const reloadTools = useRef(tools.reload);
  reloadTools.current = tools.reload;
  useEffect(() => onTrustChange(() => reloadTools.current()), []);

  const perms: Perms = { allow: cfgPerms?.allow ?? [], ask: cfgPerms?.ask ?? [], deny: cfgPerms?.deny ?? [] };

  const list = tools.data ?? [];
  const needle = q.trim().toLowerCase();
  const shown = list.filter((t) => (kind === 'all' ? true : t.kind === kind) && (!needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)));
  const groups = useMemo(() => {
    const m = new Map<string, ToolDetail[]>();
    for (const t of shown) m.set(t.group, [...(m.get(t.group) ?? []), t]);
    const mcp = [...m.keys()].filter((g) => !GROUP_ORDER.includes(g)).sort();
    return [...GROUP_ORDER.filter((g) => m.has(g)), ...mcp].map((g) => ({ id: g, tools: m.get(g)!, mcp: !GROUP_ORDER.includes(g) }));
  }, [shown]);

  // /extensions/tools?tool=Bash or #test: scroll once the list is in
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !tools.data) return;
    scrolled.current = true;
    const t = params.get('tool');
    if (location.hash === '#test') requestAnimationFrame(() => testRef.current?.scrollIntoView({ block: 'start' }));
    else if (t) requestAnimationFrame(() => document.getElementById(`tool-${t}`)?.scrollIntoView({ block: 'center' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools.data]);

  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const setRule = async (tool: string, to: RuleList | null) => {
    // permissions.allow/ask/deny are replaced as whole lists, so start from what the hub has now.
    // With no config loaded the lists would read empty and a save would wipe the owner's rules.
    if (!useHub.getState().config) await reloadConfig();
    const now = (useHub.getState().config as { permissions?: Partial<Perms> } | undefined)?.permissions;
    if (!now) {
      toast({ title: 'Could not read your current rules from the hub, so nothing changed. Reload the page and try again.', level: 'error' });
      return;
    }
    const prev: Perms = { allow: [...(now.allow ?? [])], ask: [...(now.ask ?? [])], deny: [...(now.deny ?? [])] };
    const next: Perms = { allow: prev.allow.filter((r) => r !== tool), ask: prev.ask.filter((r) => r !== tool), deny: prev.deny.filter((r) => r !== tool) };
    if (to) next[to] = [...next[to], tool];
    try {
      await updateConfig({ permissions: next });
    } catch (e) {
      toast({ title: `Could not save the rule. ${sentence(e instanceof Error ? e.message : String(e))} Try again.`, level: 'error' });
      return;
    }
    tools.reload();
    const title = to ? `Added ${tool} to permissions.${to}.` : `Removed the ${tool} rule.`;
    toast({
      title,
      action: {
        label: 'Undo',
        run: () =>
          void updateConfig({ permissions: prev })
            .then(() => tools.reload())
            .catch((e) => toast({ title: `Could not undo. ${sentence(e instanceof Error ? e.message : String(e))} Change the rule in Settings, Permissions.`, level: 'error' })),
      },
    });
  };

  const testWith = (name: string) => {
    setTestTool(name);
    requestAnimationFrame(() => testRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  const agentOptions: SelectOption<string>[] = [{ value: 'all', label: 'All agents' }, ...agents.map((a) => ({ value: a.name, label: a.name, detail: a.description }))];
  const counts = tools.data ? { all: list.length, builtin: list.filter((t) => t.kind === 'builtin').length, mcp: list.filter((t) => t.kind === 'mcp').length } : { all: undefined, builtin: undefined, mcp: undefined };

  return (
    <div>
      <TrustBanner cwd={cwd} className="mb-6" />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pb-4">
        <div className="w-[260px] phone:w-full">
          <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or description" aria-label="Filter tools" />
        </div>
        <FilterLinks<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'builtin', label: 'Built in', count: counts.builtin },
            { value: 'mcp', label: 'MCP', count: counts.mcp },
          ]}
        />
        <div className="ml-auto phone:-ml-1.5">
          <SelectMenu look="text" prefix="Agent" value={agent} onChange={pickAgent} options={agentOptions} label="Show access for one agent" width={280} className="phone:h-11 phone:text-[15px]" />
        </div>
        <TextAction label="Test a call" onClick={() => testRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })} />
      </div>

      {tools.error && !tools.data ? (
        <LoadFailed what="tools" error={tools.error} retry={tools.reload} />
      ) : !tools.data ? (
        <LoadingRows loading={tools.loading} rows={8} />
      ) : (
        <>
          <RefreshFailed error={tools.error} retry={tools.reload} className="mb-3" />
          {groups.length === 0 && <p className="py-4 text-[13px] text-fg-2 phone:text-[14px]">{needle ? `No tool matches "${q.trim()}".` : 'No tools of this kind.'}</p>}
          <div className={cn('space-y-7 phone:space-y-8', tools.loading && 'opacity-70')}>
            {groups.map((g) => (
              <ToolGroup key={g.id} id={g.id} mcp={g.mcp} tools={g.tools} open={open} toggle={toggle} perms={perms} onRule={setRule} onTest={testWith} single={agent === 'all' ? undefined : agent} expandAll={!!needle} />
            ))}
          </div>
        </>
      )}

      <section ref={testRef} id="test" aria-labelledby="test-h" className="mt-10 scroll-mt-6">
        <SectionHeading id="test-h">Test a call</SectionHeading>
        <TestForm tools={list} tool={testTool} onTool={setTestTool} cwd={cwd} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups and rows
// ---------------------------------------------------------------------------

const GRID = 'grid grid-cols-[minmax(170px,230px)_minmax(0,1fr)_72px_112px_40px] items-baseline gap-x-4';

function ToolGroup({
  id,
  mcp,
  tools,
  open,
  toggle,
  perms,
  onRule,
  onTest,
  single,
  expandAll,
}: {
  id: string;
  mcp: boolean;
  tools: ToolDetail[];
  open: Set<string>;
  toggle: (n: string) => void;
  perms: Perms;
  onRule: (tool: string, to: RuleList | null) => void;
  onTest: (tool: string) => void;
  /** The agent picked in the filter, or undefined for all agents. */
  single: string | undefined;
  expandAll: boolean;
}) {
  const [all, setAll] = useState(false);
  const long = mcp && !all && !expandAll && tools.length > MCP_PREVIEW;
  const shown = long ? tools.slice(0, MCP_PREVIEW) : tools;
  const title = mcp ? (
    <>
      <span className="mono font-[560]">{id}</span> <span className="font-normal text-fg-3">MCP server</span>
    </>
  ) : (
    (GROUP_LABEL[id] ?? id)
  );
  return (
    <section aria-label={mcp ? `${id} MCP server` : GROUP_LABEL[id]}>
      <SectionHeading count={tools.length} right={mcp ? <TextAction label="Server" href={`/extensions/mcp?server=${encodeURIComponent(id)}`} className="phone:py-px" /> : undefined}>
        {title}
      </SectionHeading>
      {GROUP_HELP[id] && <p className="pt-2 text-[12px] text-fg-3 phone:text-[13px]">{GROUP_HELP[id]}</p>}
      <div className="rows">
        {shown.map((t) => (
          <ToolRow key={t.name} t={t} open={open.has(t.name)} toggle={() => toggle(t.name)} perms={perms} onRule={onRule} onTest={onTest} single={single} />
        ))}
        {long && (
          <button type="button" onClick={() => setAll(true)} className="tap block w-full py-2.5 text-left text-[12px] text-fg-3 hover:text-fg phone:text-[13px]">
            Show all {tools.length}
          </button>
        )}
      </div>
    </section>
  );
}

function agentsWord(t: ToolDetail, single: string | undefined): string {
  const yes = t.agents.filter((a) => a.visible).length;
  // look the agent up by name: while a new list loads the old one may still be on screen
  const one = single ? t.agents.find((a) => a.name === single) : undefined;
  if (one) return `${one.name} ${one.visible ? 'can use' : 'cannot'}`;
  if (!t.agents.length || yes === 0) return 'no agents';
  if (yes === t.agents.length) return 'all agents';
  return `${yes} of ${t.agents.length} agents`;
}

function ToolRow({ t, open, toggle, perms, onRule, onTest, single }: { t: ToolDetail; open: boolean; toggle: () => void; perms: Perms; onRule: (tool: string, to: RuleList | null) => void; onTest: (tool: string) => void; single: string | undefined }) {
  const mobile = useIsMobile();
  const panel = `tool-${t.name}-panel`;
  const decision = <span className={cn('state-word', DECISION_TONE[t.permission.decision])}>{t.permission.decision}</span>;
  return (
    <div id={`tool-${t.name}`} className="scroll-mt-24">
      <button type="button" aria-expanded={open} aria-controls={panel} onClick={toggle} className={cn('w-full py-[var(--row-py)] text-left transition-colors duration-[var(--dur-1)] hover:bg-hover', open && 'bg-raise hover:bg-raise')}>
        {mobile ? (
          <span className="flex items-start gap-3">
            <span className="min-w-0 flex-1">
              <span className="mono block truncate text-[13px] text-fg">{t.name}</span>
              <span className="mt-0.5 block truncate text-[14px] text-fg-2">{firstSentence(t.description, 90)}</span>
              <span className="mt-0.5 block truncate text-[13px] text-fg-3">
                {t.readOnly ? 'read only' : 'writes'}, {agentsWord(t, single)}
              </span>
            </span>
            <span className="shrink-0 text-[13px]">{decision}</span>
          </span>
        ) : (
          <span className={GRID}>
            <span className="mono truncate text-[13px] text-fg" title={t.name}>
              {t.server && t.name.startsWith(`mcp__${t.server}__`) ? t.name.slice(`mcp__${t.server}__`.length) : t.name}
            </span>
            <span className="truncate text-[13px] text-fg-2">{firstSentence(t.description)}</span>
            <span className="text-[12px] text-fg-3">{t.readOnly ? 'read only' : 'writes'}</span>
            <span className="num text-[12px] text-fg-3">{agentsWord(t, single)}</span>
            <span className="text-right text-[13px]">{decision}</span>
          </span>
        )}
      </button>
      {open && <ToolPanel id={panel} t={t} perms={perms} onRule={onRule} onTest={onTest} />}
    </div>
  );
}

function ToolPanel({ id, t, perms, onRule, onTest }: { id: string; t: ToolDetail; perms: Perms; onRule: (tool: string, to: RuleList | null) => void; onTest: (tool: string) => void }) {
  const yes = t.agents.filter((a) => a.visible);
  const no = t.agents.filter((a) => !a.visible);
  const inConfig = (['allow', 'ask', 'deny'] as RuleList[]).find((l) => perms[l].includes(t.name));
  const [busy, setBusy] = useState<RuleList | 'clear' | null>(null);
  const run = async (to: RuleList | null) => {
    setBusy(to ?? 'clear');
    await onRule(t.name, to);
    setBusy(null);
  };
  const pre = t.hooks.PreToolUse ?? 0;
  const post = t.hooks.PostToolUse ?? 0;
  const p = t.permission;
  return (
    <div id={id} className="border-t border-rule bg-raise px-3 pt-3 pb-4 phone:px-0 phone:bg-transparent">
      {t.kind === 'mcp' && <p className="mono mb-1 text-[12.5px] text-fg break-all">{t.name}</p>}
      <p className="max-w-[80ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{t.description}</p>
      <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">
        {[t.readOnly ? 'Read only: it does not change files or state' : 'Changes files or state', t.optIn ? 'opt-in' : '', t.server ? `from the ${t.server} MCP server` : 'built in'].filter(Boolean).join(', ')}.
      </p>

      <div className="mt-4 grid gap-x-10 gap-y-5 md:grid-cols-2">
        <div className="min-w-0">
          <h4 className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Which agents can use it</h4>
          {t.agents.length === 0 ? (
            <p className="mt-1 text-[13px] text-fg-3">No agents loaded.</p>
          ) : (
            <ul className="mt-1.5 space-y-1 text-[13px] leading-[1.45] phone:text-[14px]">
              {yes.length > 0 && (
                <li className="text-fg-2">
                  <span className="text-fg">Yes:</span>{' '}
                  {yes.map((a, i) => (
                    <span key={a.name}>
                      {i > 0 && ', '}
                      <Link href={`/agents/${encodeURIComponent(a.name)}`} className="link tap">
                        {a.name}
                      </Link>
                    </span>
                  ))}
                </li>
              )}
              {no.map((a) => (
                <li key={a.name} className="text-fg-3">
                  <Link href={`/agents/${encodeURIComponent(a.name)}`} className="link tap text-fg-2">
                    {a.name}
                  </Link>
                  : no, {a.why ?? 'not available'}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          <h4 className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Permission now</h4>
          <p className="mt-1.5 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
            <span className={p.decision === 'deny' ? 'text-fault' : 'text-fg'}>{p.decision === 'allow' ? 'Allowed' : p.decision === 'ask' ? 'Asks first' : 'Denied'}.</span> {p.rule && /^(Allowed by rule|Denied by rule|Rule )/.test(p.reason) ? '' : sentence(p.reason)}
          </p>
          <p className="mt-0.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            {p.rule ? (
              <>
                Rule <span className="mono text-fg-2">{p.rule}</span> in {ruleSourceWords(p.ruleSource)}.
              </>
            ) : (
              'No rule matches a call without input, so the mode default applies.'
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Rule for ${t.name}`}>
            {(
              [
                ['allow', 'Always allow'],
                ['ask', 'Always ask'],
                ['deny', 'Deny'],
              ] as Array<[RuleList, string]>
            ).map(([l, label]) => (
              <Button key={l} size="sm" variant={l === 'deny' ? 'danger' : 'outline'} aria-pressed={inConfig === l} disabled={inConfig === l} busy={busy === l} onClick={() => void run(l)} className={cn(TOUCH, inConfig === l && 'bg-hover')}>
                {label}
              </Button>
            ))}
            {inConfig && (
              <Button size="sm" variant="quiet" busy={busy === 'clear'} onClick={() => void run(null)} className={TOUCH}>
                Remove rule
              </Button>
            )}
          </div>
          <p className="mt-2 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            {inConfig ? (
              <>
                <span className="mono">{t.name}</span> is in permissions.{inConfig} in config.json.{' '}
              </>
            ) : (
              <>
                Adds <span className="mono">{t.name}</span> to permissions in config.json.{' '}
              </>
            )}
            Deny beats ask, and ask beats allow.{t.name === 'Bash' ? ' Dangerous commands still ask.' : ''}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2 text-[12px] text-fg-3 phone:text-[13px]">
        {pre > 0 && (
          <Link href="/extensions/hooks?event=PreToolUse" className="link">
            {hookWords(pre, 'before')}
          </Link>
        )}
        {post > 0 && (
          <Link href="/extensions/hooks?event=PostToolUse" className="link">
            {hookWords(post, 'after')}
          </Link>
        )}
        {!pre && !post && <span>No hooks run for this tool.</span>}
        <TextAction label={`Test a call with ${t.kind === 'mcp' ? 'this tool' : t.name}`} onClick={() => onTest(t.name)} className="ml-auto phone:ml-0" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test a call
// ---------------------------------------------------------------------------

const MODES: Array<SelectOption<PermissionMode>> = [
  { value: 'default', label: 'default', detail: 'Asks before anything that changes state' },
  { value: 'acceptEdits', label: 'acceptEdits', detail: 'File edits run without asking' },
  { value: 'plan', label: 'plan', detail: 'Read only until a plan is approved' },
  { value: 'bypass', label: 'bypass', detail: 'Runs everything except deny rules' },
];

const SAMPLES: Record<string, Record<string, unknown>> = {
  Read: { file_path: '/etc/hosts' },
  Write: { file_path: 'notes/todo.md', content: '- check backups' },
  Edit: { file_path: 'src/index.ts', old_string: 'port: 7420', new_string: 'port: 7421' },
  MultiEdit: { file_path: 'src/index.ts', edits: [] },
  Glob: { pattern: '**/*.ts' },
  Grep: { pattern: 'TODO', path: '.' },
  WebFetch: { url: 'https://docs.anthropic.com/en/docs/claude-code/hooks' },
  WebSearch: { query: 'proxmox 9 release notes' },
  Task: { description: 'Find JWT usages', prompt: 'List every file that signs or verifies a JWT.', subagent_type: 'explore' },
  MemorySave: { content: 'madx runs Caddy in front of the hub', kind: 'fact' },
};

const EXAMPLES = ['git push origin main', 'rm -rf /', 'bun test', 'git status'];

function sampleFor(tool: string): string {
  const s = SAMPLES[tool];
  return s ? JSON.stringify(s, null, 2) : '{}';
}

function TestForm({ tools, tool: chosen, onTool, cwd }: { tools: ToolDetail[]; tool: string | undefined; onTool: (t: string) => void; cwd: string | undefined }) {
  const agents = useHub((s) => s.agents);
  const tool = chosen ?? 'Bash';
  const [agent, setAgent] = useState('');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [command, setCommand] = useState('git push origin main');
  const [json, setJson] = useState(() => sampleFor(tool));
  const [jsonError, setJsonError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tool: string; input: Record<string, unknown>; r?: ToolCheckResult; error?: string }>();

  useEffect(() => {
    setJson(sampleFor(tool));
    setJsonError(undefined);
    setResult(undefined);
  }, [tool]);
  // a result belongs to the agent, mode and folder it was checked with
  useEffect(() => setResult(undefined), [agent, mode, cwd]);

  const options = useMemo<SelectOption<string>[]>(() => {
    const builtin = tools.filter((t) => t.kind === 'builtin');
    const mcp = tools.filter((t) => t.kind === 'mcp');
    const base = builtin.length ? builtin : [{ name: 'Bash' } as ToolDetail];
    return [
      ...base.map((t) => ({ value: t.name, label: <span className="mono">{t.name}</span>, text: t.name, group: 'Built in' })),
      ...mcp.map((t) => ({ value: t.name, label: <span className="mono">{t.name}</span>, text: t.name, group: `${t.server ?? t.group} MCP server` })),
    ];
  }, [tools]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let input: Record<string, unknown> = {};
    if (tool === 'Bash') {
      if (!command.trim()) {
        setJsonError('Type a command to check, for example git push origin main.');
        return;
      }
      input = { command: command.trim() };
    } else if (json.trim()) {
      try {
        const v = JSON.parse(json);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The input must be a JSON object, like {"file_path": "/etc/hosts"}.');
        input = v as Record<string, unknown>;
      } catch (err) {
        setJsonError(err instanceof SyntaxError ? `This is not valid JSON: ${err.message}. Fix it or clear the box to check a call with no input.` : (err as Error).message);
        return;
      }
    }
    setJsonError(undefined);
    setBusy(true);
    try {
      const r = await api().checkTool({ tool, input, agent: agent || undefined, mode, cwd });
      setResult({ tool, input, r });
    } catch (err) {
      setResult({ tool, input, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="pt-3" noValidate>
      <p className="max-w-[72ch] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">Runs the same permission check a session runs, with the rules for {cwd ? <span className="mono">{shortPath(cwd)}</span> : 'no project'}. Nothing is executed.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Field label="Tool">
          <SelectMenu value={tool} onChange={onTool} options={options} label="Tool" width={340} />
        </Field>
        <Field label="Agent" help="Its tools list, rules and mode apply.">
          <SelectMenu value={agent} onChange={setAgent} options={[{ value: '', label: 'No agent' }, ...agents.map((a) => ({ value: a.name, label: a.name, detail: a.description }))]} label="Agent" width={300} />
        </Field>
        <Field label="Mode">
          <SelectMenu value={mode} onChange={setMode} options={MODES} label="Permission mode" width={300} />
        </Field>
      </div>
      <div className="mt-4">
        {tool === 'Bash' ? (
          <Field label="Command" error={jsonError}>
            <Input mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder="git push origin main" autoComplete="off" spellCheck={false} />
          </Field>
        ) : (
          <Field label="Input" help={jsonError ? undefined : 'JSON, as the model would send it.'} error={jsonError}>
            <Textarea mono value={json} onChange={(e) => setJson(e.target.value)} minRows={4} maxRows={14} spellCheck={false} />
          </Field>
        )}
        {tool === 'Bash' && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-fg-3 phone:text-[13px]">
            <span>Try</span>
            {EXAMPLES.map((x) => (
              <button key={x} type="button" onClick={() => setCommand(x)} className="tap mono text-fg-2 hover:text-fg phone:py-0.5">
                {x}
              </button>
            ))}
          </div>
        )}
      </div>
      <Button type="submit" variant="solid" className={cn('mt-4', TOUCH)} busy={busy ? 'Checking' : false}>
        Check
      </Button>
      {result && <CheckResult {...result} />}
    </form>
  );
}

function CheckResult({ tool, input, r, error }: { tool: string; input: Record<string, unknown>; r?: ToolCheckResult; error?: string }) {
  const mobile = useIsMobile();
  const kw = mobile ? 108 : 168;
  if (error)
    return (
      <div className="mt-5 border-t border-rule pt-3" role="status">
        <p className="text-[13px] text-fault phone:text-[14px]">
          {/^unknown tool/.test(error) ? `${tool} is not a tool on this hub. Pick one from the list.` : /^unknown agent/.test(error) ? `${error}. Pick an agent from the list.` : `Could not check the call. ${error}`}
        </p>
      </div>
    );
  if (!r) return null;
  const word = r.decision === 'allow' ? 'Allowed' : r.decision === 'ask' ? 'Asks first' : 'Denied';
  const tone = r.decision === 'allow' ? 'text-ok' : r.decision === 'ask' ? 'text-warn' : 'text-fault';
  const what = tool === 'Bash' && typeof input.command === 'string' ? <span className="mono">{input.command}</span> : <span className="mono">{tool}</span>;
  return (
    <div className="mt-5 border-t border-rule pt-3" role="status" aria-live="polite">
      <p className="text-[14px] leading-[1.45] text-fg phone:text-[15px]">
        <span className={cn('font-medium', tone)}>{word}.</span> {what}
      </p>
      <dl className="mt-2">
        <KV k="Reason" keyWidth={kw}>
          {sentence(r.reason)}
        </KV>
        <KV k="Rule" keyWidth={kw}>
          {r.rule ? <span className="mono text-[13px]">{r.rule}</span> : <span className="text-fg-2">No rule matched. The mode decides.</span>}
        </KV>
        {r.rule && (
          <KV k="Defined in" keyWidth={kw}>
            {ruleSourceWords(r.ruleSource) ?? 'unknown'}
          </KV>
        )}
        <KV k="Dangerous command guard" keyWidth={kw}>
          {r.dangerous ? (
            <span>
              <span className="text-warn">Fired.</span> {sentence(r.dangerous)} A command like this always asks, even with an allow rule.
            </span>
          ) : (
            <span className="text-fg-2">{tool === 'Bash' ? 'Did not fire.' : 'Only checks Bash commands.'}</span>
          )}
        </KV>
        <KV k="Hooks" keyWidth={kw}>
          {r.hooks ? (
            <span>
              <Link href="/extensions/hooks?event=PreToolUse" className="link">
                {plural(r.hooks, 'PreToolUse hook')}
              </Link>{' '}
              would run first. A hook can still block the call or answer the prompt.
            </span>
          ) : (
            <span className="text-fg-2">No PreToolUse hook matches this call.</span>
          )}
        </KV>
      </dl>
    </div>
  );
}

