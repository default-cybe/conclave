/**
 * Agent editor (spec 11.6): a 720px column of sections with a sticky
 * footer. Built in, plugin and Claude Code agents open read only with
 * "Duplicate to edit"; a copy that keeps the name replaces the original.
 * Codex, OpenCode, Gemini CLI and shared .agents files open read only with
 * "Copy to user". A built-in agent shows its shipped default, and when a
 * copy replaces it, the diff and "Reset to default".
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { AgentDef } from '@conclave/core/extensions/types';
import type { PermissionMode, SessionMode } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { openNewChat } from '@/store/ui';
import { cn, fuzzy } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button, IconButton } from '@/components/ui/Button';
import { Checkbox, Input, OnOff, Segmented, Textarea } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { Dialog, Menu } from '@/components/ui/Overlay';
import { Notice, TextAction } from '@/components/ui/Section';
import { CodeBlock } from '@/components/ui/Code';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { EditorFooter, EditorSection, FormRow, SectionIndex } from '@/features/routines/form';
import { fileWord, isOtherCli, isReadOnly, sourcePlace, useAgentDelete, useCopyToUser } from './agentWords';
import { ShippedDefault, useAgentDefault } from './ShippedDefault';
import { EFFORT_SETTINGS, effortLabel } from '@conclave/core/providers/effort';

const BLANK: AgentDef = { name: '', description: '', prompt: '', source: 'user', primary: true, mode: 'agent' };

const PERMISSION: Array<{ value: PermissionMode; label: string; help: string }> = [
  { value: 'default', label: 'Ask before edits', help: 'Edits and commands wait for your OK.' },
  { value: 'acceptEdits', label: 'Accept edits', help: 'File edits run, commands still ask.' },
  { value: 'plan', label: 'Plan only', help: 'Nothing that changes state runs.' },
  { value: 'bypass', label: 'Bypass', help: 'Everything runs without asking. Use it in sandboxes only.' },
];

const MODES: Array<{ value: SessionMode; label: string; help: string }> = [
  { value: 'agent', label: 'Agent', help: 'Uses tools and works until done.' },
  { value: 'chat', label: 'Chat', help: 'Answers without tools.' },
  { value: 'plan', label: 'Plan', help: 'Reads and proposes a plan, changes nothing.' },
];

// every level an agent can name: a session sends the nearest one its model has (lib/effort.ts). Ultra is a ChatGPT plan's, set per session
const EFFORT: Array<{ value: NonNullable<AgentDef['thinking']>; label: string }> = EFFORT_SETTINGS.filter((v): v is NonNullable<AgentDef['thinking']> => v !== 'ultra').map((v) => ({ value: v, label: effortLabel(v) }));

const MEMORY: Array<{ value: 'global' | 'agent' | 'none'; label: string; help: string }> = [
  { value: 'global', label: 'Shared', help: 'Reads and writes your global and project notes.' },
  { value: 'agent', label: 'Its own', help: 'Keeps notes only this agent sees.' },
  { value: 'none', label: 'Off', help: 'Nothing is recalled or saved.' },
];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function AgentEditor({ name }: { name: string }) {
  const agents = useHub((s) => s.agents);
  const booted = useHub((s) => s.booted);
  const search = useSearch();
  const [, navigate] = useLocation();
  const isNew = name === 'new';
  const from = isNew ? new URLSearchParams(search).get('from') : null;
  const existing = agents.find((a) => a.name === name);
  const source = from ? agents.find((a) => a.name === from) : undefined;
  usePageHeader(isNew ? 'New agent' : name, '/agents');

  if (!isNew && !existing)
    return (
      <Page width="column">
        <PageHeader title="Agent not found" />
        {booted && (
          <EmptyState wave={false} action={{ label: 'All agents', onClick: () => navigate('/agents') }}>
            No agent is called {name}. It may have been renamed or deleted.
          </EmptyState>
        )}
      </Page>
    );

  let initial: AgentDef = existing ?? BLANK;
  if (isNew && source) {
    const { path: _p, plugin: _pl, ...rest } = source;
    initial = { ...rest, name: isReadOnly(source) ? source.name : `${source.name}-copy`, source: 'user' };
  }
  return <Editor key={`${name}:${from ?? ''}:${booted}`} initial={initial} isNew={isNew} copiedFrom={source} />;
}

function Editor({ initial, isNew, copiedFrom }: { initial: AgentDef; isNew: boolean; copiedFrom?: AgentDef }) {
  const [, navigate] = useLocation();
  const size = useIsMobile() ? 'touch' : 'md';
  const agents = useHub((s) => s.agents);
  const devices = useHub((s) => s.devices);
  const [d, setD] = useState<AgentDef>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [scope, setScope] = useState<'user' | 'project'>(initial.source === 'project' ? 'project' : 'user');
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState(false);
  const readOnly = !isNew && isReadOnly(initial);
  const del = useAgentDelete(initial, '/agents');
  const copy = useCopyToUser(initial);
  // plugin agents (plugin:name) are never built in, so they skip the lookup
  const shipped = useAgentDefault(isNew || initial.name.includes(':') ? undefined : initial.name, `${initial.source}:${initial.path ?? ''}:${initial.prompt}`);
  const resettable = !!shipped.info?.resettable;
  const dirty = JSON.stringify(d) !== baseline || (isNew && scope !== 'user');

  // pick up a reload of the agent list while nothing is edited
  useEffect(() => {
    if (JSON.stringify(d) === baseline) {
      setD(initial);
      setBaseline(JSON.stringify(initial));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial)]);

  const up = (p: Partial<AgentDef>) => setD((x) => ({ ...x, ...p }));
  const nameError = !d.name.trim() ? 'Give it a name.' : !NAME_RE.test(d.name) ? 'Use lowercase letters, numbers and dashes.' : isNew && agents.some((a) => a.name === d.name && !(copiedFrom && isReadOnly(copiedFrom) && a.name === copiedFrom.name)) ? `There is already an agent called ${d.name}.` : undefined;
  const replaces = isNew && copiedFrom && isReadOnly(copiedFrom) && d.name === copiedFrom.name;

  const save = async () => {
    setTried(true);
    if (readOnly || nameError) return;
    setSaving(true);
    const { source: _s, path: _p, plugin: _pl, ...def } = d;
    const r = await attempt(() => api().saveAgent({ ...def, name: d.name.trim() }, scope), isNew ? `Saved ${d.name}.` : undefined);
    setSaving(false);
    if (!r) return;
    useHub.setState((s) => ({ agents: [...s.agents.filter((a) => a.name !== r.name), r] }));
    setD(r);
    setBaseline(JSON.stringify(r));
    setTried(false);
    if (isNew) navigate(`/agents/${encodeURIComponent(r.name)}`, { replace: true });
  };

  const sections: Array<[string, string]> = [
    ['identity', 'Identity'],
    ['instructions', 'Instructions'],
    ...(shipped.info ? [['shipped', 'Shipped default'] as [string, string]] : []),
    ['model', 'Model'],
    ['tools', 'Tools'],
    ['permissions', 'Permissions'],
    ['context', 'Skills and MCP'],
    ['memory', 'Memory'],
    ['visibility', 'Where it shows'],
  ];

  return (
    <Page>
      <nav aria-label="Breadcrumb" className="pt-6 text-[12px] phone:hidden">
        <Link href="/agents" className="text-fg-3 hover:text-fg">
          Agents
        </Link>
      </nav>
      <PageHeader
        className="pt-1 phone:pt-4"
        title={<span className="phone:sr-only">{isNew ? (copiedFrom ? `Copy of ${copiedFrom.name}` : 'New agent') : initial.name}</span>}
        sub={isNew ? (copiedFrom ? `From ${copiedFrom.name}. Change what you need, then save.` : undefined) : sourcePlace(initial)}
        actions={
          !isNew && (
            <>
              <Button variant="outline" size={size} onClick={() => openNewChat({ agent: initial.name })}>
                Start a session
              </Button>
              <Menu
                label={`${initial.name} actions`}
                items={[
                  ...(readOnly ? [] : [{ label: 'Duplicate', onSelect: () => navigate(`/agents/new?from=${encodeURIComponent(initial.name)}`) }]),
                  { label: 'Preview the prompt', onSelect: () => setPreview(true) },
                  ...(readOnly || resettable ? [] : [{ separator: true, label: '' }, { label: 'Delete', danger: true, onSelect: del.ask }]),
                ]}
                trigger={({ ref, props }) => (
                  <IconButton ref={ref} label="More actions" size={size} {...props}>
                    <MoreHorizontal />
                  </IconButton>
                )}
              />
            </>
          )
        }
      />
      {readOnly && (
        <Notice className="-mt-2 mb-4 max-w-[720px]">
          {initial.source === 'builtin'
            ? 'Built in agents are read only. Duplicate it to change it. A copy with the same name replaces this one.'
            : isOtherCli(initial)
              ? `This agent is ${fileWord(initial)} and is read only here. Copy it to your agents to change it. Your copy replaces this one in Conclave; the file itself stays as it is.`
              : `This agent is ${fileWord(initial)} and is read only here. Duplicate it to change it. A copy with the same name replaces this one.`}
        </Notice>
      )}

      <div className="grid grid-cols-[minmax(0,720px)_minmax(0,1fr)] gap-x-12 max-xl:grid-cols-1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              void save();
            }
          }}
          className="space-y-9 phone:space-y-8"
        >
          <div className={cn('min-w-0 space-y-9 phone:space-y-8', readOnly && '[&_input:not([type=checkbox])]:border-rule! [&_input:not([type=checkbox])]:bg-transparent! [&_input[type=checkbox]:checked]:border-fg-3! [&_input[type=checkbox]:checked]:bg-fg-3! [&_textarea]:border-rule! [&_textarea]:bg-transparent! [&_textarea]:text-fg-2!')}>
            <EditorSection title="Identity" id="identity">
              <FormRow
                label="Name"
                htmlFor="ag-name"
                help={
                  replaces ? (
                    <span className="text-warn">Same name as the {copiedFrom?.source === 'builtin' ? 'built in' : copiedFrom?.source} agent, so yours replaces it.</span>
                  ) : isNew ? (
                    'Lowercase letters, numbers and dashes. Used in the picker and in @mentions.'
                  ) : readOnly ? (
                    'Used in the picker and in @mentions.'
                  ) : (
                    'Used in the picker and in @mentions. To rename it, duplicate it under the new name and delete this one.'
                  )
                }
                error={tried && nameError ? nameError : undefined}
              >
                <Input
                  id="ag-name"
                  value={d.name}
                  readOnly={!isNew}
                  className={isNew ? undefined : 'border-rule! bg-transparent! text-fg-2'}
                  onChange={(e) => up({ name: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                  placeholder="homelab"
                  autoFocus={isNew && !d.name}
                  invalid={tried && !!nameError}
                  spellCheck={false}
                  autoComplete="off"
                />
              </FormRow>
              <FormRow label="Purpose" htmlFor="ag-desc" help="One line. The picker shows it, and other agents read it to decide when to hand work over.">
                {/* one line of text that wraps instead of scrolling out of sight */}
                <Textarea
                  id="ag-desc"
                  minRows={1}
                  maxRows={4}
                  className="py-[6.5px] leading-[1.5]"
                  value={d.description}
                  onChange={(e) => up({ description: e.target.value.replace(/\n/g, ' ') })}
                  onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                  placeholder="Arch and Proxmox admin. Explains destructive commands first."
                  readOnly={readOnly}
                />
              </FormRow>
              {isNew && (
                <FormRow label="Save to" help={scope === 'user' ? 'Your agents, in ~/.conclave/agents on the hub. Every project sees it.' : 'The current project, in .conclave/agents. Only that project sees it.'}>
                  <Segmented
                    label="Save to"
                    value={scope}
                    onChange={setScope}
                    options={[
                      { value: 'user', label: 'Your agents' },
                      { value: 'project', label: 'This project' },
                    ]}
                  />
                </FormRow>
              )}
            </EditorSection>

            <EditorSection title="Instructions" id="instructions" right={<TextAction label="Preview with memory" onClick={() => setPreview(true)} />}>
              <FormRow label="System prompt" htmlFor="ag-prompt" help="Markdown is fine. Profile notes from memory are added after it." stack>
                <Textarea id="ag-prompt" prose minRows={8} maxRows={24} value={d.prompt} onChange={(e) => up({ prompt: e.target.value })} placeholder="You administer an Arch Linux desktop and a Proxmox cluster. Explain every destructive command before you run it." readOnly={readOnly} />
              </FormRow>
              <PlatformAwareness d={d} up={up} readOnly={readOnly} />
            </EditorSection>

            {shipped.info && <ShippedDefault d={shipped.info} onReset={shipped.reload} />}
            {shipped.error && (
              <Notice tone="fault" action={{ label: 'Try again', onClick: shipped.reload }}>
                {`Failed. Could not load the shipped default: ${shipped.error.replace(/\.?$/, '.')} Check that the hub is online.`}
              </Notice>
            )}

            <EditorSection title="Model" id="model">
              <FormRow label="Default model" help={d.model ? 'Sessions with this agent start on it. You can switch per session.' : 'Uses the default model from Settings.'}>
                <ModelPicker look="field" value={d.model} onChange={(v) => up({ model: v })} placeholder="Default model" disabled={readOnly} />
              </FormRow>
              <FormRow label="Effort" help="How hard the model thinks before it answers. A model without this level gets the nearest one it has.">
                <Segmented label="Effort" value={d.thinking ?? 'medium'} onChange={(v) => up({ thinking: v })} options={EFFORT} disabled={readOnly} />
              </FormRow>
              <FormRow label="Mode" help={MODES.find((m) => m.value === (d.mode ?? 'agent'))?.help}>
                <Segmented label="Mode" value={(d.mode ?? 'agent') as SessionMode} onChange={(v) => up({ mode: v })} options={MODES.some((m) => m.value === (d.mode ?? 'agent')) ? MODES : [...MODES, { value: d.mode!, label: d.mode!, help: '' }]} disabled={readOnly} />
              </FormRow>
              <FormRow label="Device" help="Where its tools run unless a session picks another.">
                <SelectMenu
                  label="Device"
                  value={d.device ?? ''}
                  onChange={(v) => up({ device: v || undefined })}
                  disabled={readOnly}
                  options={[
                    { value: '', label: 'Session default', text: 'Session default' },
                    ...Object.values(devices).map((x) => ({ value: x.id, label: x.name, text: x.name, hint: <span className={x.online ? 'text-ok' : 'text-fg-3'}>{x.online ? 'online' : 'offline'}</span> })),
                  ]}
                />
              </FormRow>
            </EditorSection>

            <ToolsSection d={d} up={up} readOnly={readOnly} name={isNew ? undefined : initial.name} />

            <EditorSection title="Permissions" id="permissions">
              <FormRow label="Permission mode" help={PERMISSION.find((p) => p.value === (d.permissionMode ?? 'default'))?.help} stack>
                <Segmented
                  label="Permission mode"
                  value={d.permissionMode ?? 'default'}
                  onChange={(v) => up({ permissionMode: v })}
                  disabled={readOnly}
                  options={PERMISSION.map((p) => ({ value: p.value, label: p.value === 'bypass' ? <span className={d.permissionMode === 'bypass' ? 'text-fault' : undefined}>{p.label}</span> : p.label }))}
                />
              </FormRow>
              <FormRow label="Untrusted input" help="For email and web pages. No shell, no file writes, and instructions found in content are never followed.">
                <OnOff label="Untrusted input" checked={!!d.untrusted} onChange={(v) => up({ untrusted: v })} disabled={readOnly} />
              </FormRow>
              <DenyRules d={d} up={up} readOnly={readOnly} />
            </EditorSection>

            <ContextSection d={d} up={up} readOnly={readOnly} />

            <EditorSection title="Memory" id="memory">
              <FormRow label="Notes" help={MEMORY.find((m) => m.value === (d.memory ?? 'global'))?.help}>
                <Segmented label="Memory" value={d.memory ?? 'global'} onChange={(v) => up({ memory: v })} options={MEMORY} disabled={readOnly} />
              </FormRow>
            </EditorSection>

            <EditorSection title="Where it shows" id="visibility">
              <FormRow label="Agent picker" help="Show it when you start a session.">
                <OnOff label="Show in the agent picker" checked={d.primary !== false} onChange={(v) => up({ primary: v })} onLabel="Shown" offLabel="Hidden" disabled={readOnly} />
              </FormRow>
              <FormRow label="Subagent" help="Other agents can hand it work with the Task tool.">
                <OnOff label="Usable as a subagent" checked={!!d.subagent} onChange={(v) => up({ subagent: v })} disabled={readOnly} />
              </FormRow>
            </EditorSection>
          </div>

          {!isNew && !readOnly && !resettable && (
            <EditorSection title="Delete" id="danger">
              <FormRow label="Delete this agent" help="Sessions that used it keep their history.">
                <div className="flex justify-end phone:justify-start">
                  <Button variant="danger" onClick={del.ask}>
                    Delete agent
                  </Button>
                </div>
              </FormRow>
            </EditorSection>
          )}

          {readOnly ? (
            <EditorFooter note="Read only.">
              {isOtherCli(initial) ? (
                <Button variant="solid" size={size} busy={copy.busy ? 'Copying' : false} onClick={() => void copy.run()}>
                  Copy to user
                </Button>
              ) : (
                <Button variant="solid" size={size} onClick={() => navigate(`/agents/new?from=${encodeURIComponent(initial.name)}`)}>
                  Duplicate to edit
                </Button>
              )}
            </EditorFooter>
          ) : (
            <EditorFooter note={<span className={cn(tried && nameError && 'text-fault')}>{saving ? 'Saving' : tried && nameError ? 'Fix the name to save.' : dirty ? 'Unsaved changes.' : isNew ? '' : 'Saved.'}</span>}>
              <Button
                variant="quiet"
                size={size}
                onClick={() => {
                  if (isNew || !dirty) return navigate('/agents');
                  setD(JSON.parse(baseline) as AgentDef);
                  setTried(false);
                }}
              >
                {dirty && !isNew ? 'Discard changes' : 'Cancel'}
              </Button>
              <Button type="submit" variant="solid" size={size} busy={saving ? 'Saving' : false} disabled={!dirty && !isNew}>
                {isNew ? 'Create agent' : 'Save'}
              </Button>
            </EditorFooter>
          )}
        </form>
        <SectionIndex items={!isNew && !readOnly && !resettable ? [...sections, ['danger', 'Delete']] : sections} />
      </div>

      {!isNew && !readOnly && del.dialog}
      <PromptPreview open={preview} onClose={() => setPreview(false)} agent={d} />
    </Page>
  );
}

/**
 * Platform awareness (core platform/card.ts): the Conclave card in this
 * agent's prompt. On unless the agent says false; the hub's
 * agents.platformCard turns it off for every agent.
 */
function PlatformAwareness({ d, up, readOnly }: { d: AgentDef; up: (p: Partial<AgentDef>) => void; readOnly: boolean }) {
  const hubOff = useHub((s) => (s.config?.agents as { platformCard?: boolean } | undefined)?.platformCard === false);
  return (
    <FormRow
      label="Platform awareness"
      help={
        hubOff
          ? 'Off for every agent in the hub config (agents.platformCard).'
          : 'A short card about Conclave in its prompt: the modes, where things are in the app, and what the session can do now. Subagents get two lines.'
      }
    >
      <OnOff label="Platform awareness" checked={d.platformCard !== false && !hubOff} onChange={(v) => up({ platformCard: v ? undefined : false })} disabled={readOnly || hubOff} />
    </FormRow>
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function ToolsSection({ d, up, readOnly, name }: { d: AgentDef; up: (p: Partial<AgentDef>) => void; readOnly: boolean; name?: string }) {
  const tools = useHub((s) => s.toolList);
  const [q, setQ] = useState('');
  const all = tools.map((t) => t.name);
  const on = (n: string) => !d.tools || d.tools.includes(n);
  const toggle = (n: string) => {
    const cur = d.tools ?? all;
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
    up({ tools: next.length === all.length && all.every((x) => next.includes(x)) ? undefined : next });
  };
  const shown = tools.filter((t) => !q || fuzzy(q, `${t.name} ${t.description} ${t.server ?? ''}`) >= 0);
  const groups = useMemo(() => {
    const out: Array<{ title: string; list: typeof tools }> = [];
    const builtin = shown.filter((t) => t.source === 'builtin');
    if (builtin.length) out.push({ title: 'Built in', list: builtin });
    const servers = [...new Set(shown.filter((t) => t.source === 'mcp').map((t) => t.server ?? 'mcp'))];
    for (const s of servers) out.push({ title: `MCP server ${s}`, list: shown.filter((t) => t.source === 'mcp' && (t.server ?? 'mcp') === s) });
    return out;
  }, [shown]);
  const count = d.tools ? d.tools.length : all.length;

  return (
    <EditorSection
      title="Tools"
      id="tools"
      right={
        <span className="flex items-baseline gap-4">
          {name && <TextAction label="Permissions per tool" href={`/extensions/tools?agent=${encodeURIComponent(name)}`} />}
          {!readOnly && <TextAction label="Allow all" onClick={() => up({ tools: undefined })} />}
          {!readOnly && <TextAction label="None" onClick={() => up({ tools: [] })} />}
        </span>
      }
    >
      <div className="py-3.5">
        <div className="flex items-center gap-4 phone:flex-col phone:items-stretch">
          <p className="min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">{!d.tools ? `Every tool, ${all.length} now. Untick one to limit it.` : d.tools.length === 0 ? 'No tools. It can only answer.' : `${count} of ${all.length} tools.`}</p>
          <div className="w-52 shrink-0 phone:w-full">
            <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tools" aria-label="Filter tools" />
          </div>
        </div>
        {groups.map((g) => (
          <div key={g.title} className="mt-4">
            <p className="mb-1 text-[12px] text-fg-3 phone:text-[13px]">{g.title}</p>
            <div className="grid grid-cols-2 gap-x-6 phone:grid-cols-1">
              {g.list.map((t) => (
                <Checkbox
                  key={t.name}
                  mono
                  checked={on(t.name)}
                  onChange={() => toggle(t.name)}
                  disabled={readOnly}
                  label={t.source === 'mcp' ? t.name.replace(/^mcp__[^_]+__/, '') : t.name}
                  description={`${t.description.replace(/\.\s*$/, '')}.${t.readOnly ? '' : ' Can change things.'}`}
                  className="py-1.5"
                />
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <p className="mt-3 text-[13px] text-fg-3">No tool matches "{q}".</p>}
      </div>
    </EditorSection>
  );
}

/** Tools this agent may never use, stored as disallowedTools. */
function DenyRules({ d, up, readOnly }: { d: AgentDef; up: (p: Partial<AgentDef>) => void; readOnly: boolean }) {
  const [rule, setRule] = useState('');
  const list = d.disallowedTools ?? [];
  const add = () => {
    const r = rule.trim();
    if (!r || list.includes(r)) return setRule('');
    up({ disallowedTools: [...list, r] });
    setRule('');
  };
  return (
    <FormRow label="Never allowed" help="Tool names or patterns this agent cannot use, even when you approve. For example Bash(rm:*) or WebFetch." stack>
      {list.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">Pattern</th>
              <th scope="col">Decision</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p}>
                <td className="w-full font-mono text-[12.5px] text-fg">{p}</td>
                <td className="text-fg-2">deny</td>
                <td className="r py-0 align-middle">
                  {!readOnly && (
                    <Button variant="quiet" size="sm" onClick={() => up({ disallowedTools: list.filter((x) => x !== p) })} aria-label={`Remove ${p}`}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!readOnly && (
        <div className="flex gap-2">
          <Input
            mono
            size="md"
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Bash(rm:*)"
            aria-label="Tool or pattern to deny"
            className="min-w-0 flex-1"
            spellCheck={false}
          />
          <Button variant="outline" onClick={add} disabled={!rule.trim()} className="h-[34px] phone:h-11">
            Add rule
          </Button>
        </div>
      )}
      {readOnly && list.length === 0 && <p className="text-[13px] text-fg-3">None.</p>}
    </FormRow>
  );
}

// ---------------------------------------------------------------------------
// Skills and MCP servers
// ---------------------------------------------------------------------------

function ContextSection({ d, up, readOnly }: { d: AgentDef; up: (p: Partial<AgentDef>) => void; readOnly: boolean }) {
  const skills = useHub((s) => s.skills);
  const mcp = useHub((s) => s.mcp);
  const allMcp = mcp.map((m) => m.name);
  const toggleSkill = (n: string) => {
    const cur = d.skills ?? [];
    up({ skills: cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n] });
  };
  const toggleMcp = (n: string) => {
    const cur = d.mcpServers ?? allMcp;
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
    up({ mcpServers: next.length === allMcp.length && allMcp.every((x) => next.includes(x)) ? undefined : next });
  };
  return (
    <EditorSection title="Skills and MCP" id="context">
      <FormRow label="Skills" help="Loaded into the prompt so the agent knows these procedures from the start." stack>
        {skills.length === 0 ? (
          <p className="text-[13px] text-fg-3">
            No skills installed. Add them in{' '}
            <Link href="/extensions/plugins" className="link">
              Plugins
            </Link>
            .
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 phone:grid-cols-1">
            {skills.map((s) => (
              <Checkbox key={s.name} mono checked={!!d.skills?.includes(s.name)} onChange={() => toggleSkill(s.name)} disabled={readOnly} label={s.name} description={s.description} className="py-1.5" />
            ))}
          </div>
        )}
      </FormRow>
      <FormRow label="MCP servers" help={d.mcpServers ? `${d.mcpServers.length} of ${allMcp.length} servers.` : 'Every enabled server. Untick one to limit it.'} stack>
        <div className="grid grid-cols-2 gap-x-6 phone:grid-cols-1">
          {mcp.map((m) => (
            <Checkbox
              key={m.name}
              mono
              checked={!d.mcpServers || d.mcpServers.includes(m.name)}
              onChange={() => toggleMcp(m.name)}
              disabled={readOnly}
              label={m.name}
              description={
                m.status === 'connected' ? (
                  <>
                    <span className="text-ok">connected</span>, {m.tools} tools
                  </>
                ) : m.status === 'failed' ? (
                  <span className="text-fault">failed</span>
                ) : (
                  m.status
                )
              }
              className="py-1.5"
            />
          ))}
        </div>
      </FormRow>
    </EditorSection>
  );
}

// ---------------------------------------------------------------------------
// Prompt preview and section index
// ---------------------------------------------------------------------------

function PromptPreview({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: AgentDef }) {
  const memories = useHub((s) => s.memories);
  const skills = useHub((s) => s.skills);
  const profile = Object.values(memories)
    .filter((m) => m.kind === 'profile' && (agent.memory !== 'none') && (m.scope === 'global' || (m.scope === 'agent' && m.scopeKey === agent.name)))
    .sort((a, b) => b.importance - a.importance);
  const used = skills.filter((s) => agent.skills?.includes(s.name));
  const parts = [agent.prompt.trim() || '(no system prompt yet)'];
  if (profile.length) parts.push(`## About the owner\n${profile.map((m) => `- ${m.content}`).join('\n')}`);
  if (used.length) parts.push(`## Skills\n${used.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`);
  const text = parts.join('\n\n');
  return (
    <Dialog open={open} onClose={onClose} title="The prompt it starts with" description={agent.memory === 'none' ? 'Memory is off for this agent, so no notes are added.' : 'Profile notes are always added. Other notes are added per message when they are relevant, so they are not shown here.'} width={640}>
      <CodeBlock code={text} lang="markdown" wrap title={`${text.length.toLocaleString('en-GB')} characters`} />
    </Dialog>
  );
}
