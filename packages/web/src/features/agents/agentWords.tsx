/** Words and shared actions for agents. */
import { useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { AgentDef } from '@conclave/core/extensions/types';
import { api } from '@/lib/api';
import { attempt, toast, useHub } from '@/store/store';
import { Confirm } from '@/features/memory/parts';

/** Files from another CLI or the shared ~/.agents folder: read only here, with "Copy to user". */
export function isOtherCli(a: Pick<AgentDef, 'source'>): boolean {
  return a.source === 'codex' || a.source === 'opencode' || a.source === 'gemini' || a.source === 'agents';
}

/** Built in, plugin, Claude Code and other CLIs' agents are files Conclave does not own. */
export function isReadOnly(a: Pick<AgentDef, 'source'>): boolean {
  return a.source === 'builtin' || a.source === 'plugin' || a.source === 'claude' || isOtherCli(a);
}

const SOURCE_WORD: Record<string, string> = {
  builtin: 'Conclave',
  user: 'user',
  project: 'project',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  agents: 'shared .agents',
};

export function sourceWord(a: Pick<AgentDef, 'source' | 'plugin'>): string {
  if (a.source === 'plugin') return a.plugin ? `plugin ${a.plugin}` : 'plugin';
  return SOURCE_WORD[a.source] ?? String(a.source);
}

/** The CLI or folder a read-only file belongs to, in a sentence: "an OpenCode file". */
export function fileWord(a: Pick<AgentDef, 'source' | 'plugin'>): string {
  switch (a.source) {
    case 'claude':
      return 'a Claude Code file';
    case 'codex':
      return 'a Codex file';
    case 'opencode':
      return 'an OpenCode file';
    case 'gemini':
      return 'a Gemini CLI file';
    case 'agents':
      return 'a file in the shared .agents folder';
    case 'plugin':
      return a.plugin ? `part of the ${a.plugin} plugin` : 'part of a plugin';
    default:
      return 'built into Conclave';
  }
}

/** ~/ for the hub's and the owner's home folders. */
export function homePath(p: string): string {
  return p.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~');
}

/** Where a saved agent file lives, for the editor's subtitle. Paths in mono. */
export function sourcePlace(a: AgentDef): ReactNode {
  const path = (p: string) => <span className="mono">{homePath(p)}</span>;
  switch (a.source) {
    case 'builtin':
      return 'Built into Conclave';
    case 'user':
      return <>Your agents, {path(a.path ?? '~/.conclave/agents')}</>;
    case 'project':
      return <>This project, {path(a.path ?? '.conclave/agents')}</>;
    case 'plugin':
      return `From the ${a.plugin ?? 'a'} plugin`;
    case 'claude':
      return <>Claude Code, {path(a.path ?? '~/.claude/agents')}</>;
    case 'codex':
      return <>Codex, {path(a.path ?? '~/.codex/agents')}</>;
    case 'opencode':
      return <>OpenCode, {path(a.path ?? '~/.config/opencode/agent')}</>;
    case 'gemini':
      return <>Gemini CLI, {path(a.path ?? '~/.gemini/agents')}</>;
    case 'agents':
      return <>Shared .agents folder, {path(a.path ?? '~/.agents/agents')}</>;
    default:
      return a.path ? path(a.path) : '';
  }
}

export function toolsWord(a: AgentDef): string {
  if (!a.tools) return 'all tools';
  return a.tools.length === 1 ? '1 tool' : `${a.tools.length} tools`;
}

export function memoryWord(m: AgentDef['memory']): string {
  return m === 'agent' ? 'its own' : m === 'none' ? 'off' : 'shared';
}

/** Reload the agent list from the hub (after a reset brings a shipped agent back). */
export async function reloadAgents() {
  try {
    useHub.setState({ agents: await api().agents() });
  } catch {
    /* the next config.updated reloads everything */
  }
}

/**
 * "Copy to user": save a read-only agent (another CLI's file) as the
 * owner's own, with the same name, so it replaces that file here.
 */
export function useCopyToUser(agent: AgentDef) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const { source: _s, path: _p, plugin: _pl, ...def } = agent;
    const r = await attempt(() => api().saveAgent({ ...def, name: agent.name }, 'user'), `Copied ${agent.name} to your agents. Edit it here.`);
    setBusy(false);
    if (!r) return;
    useHub.setState((s) => ({ agents: [...s.agents.filter((a) => a.name !== r.name), r] }));
    navigate(`/agents/${encodeURIComponent(r.name)}`, { replace: true });
  };
  return { run, busy };
}

/** Delete with a confirm that names the agent. */
export function useAgentDelete(agent: AgentDef, after?: string) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const remove = async () => {
    const ok = await attempt(() => api().deleteAgent(agent.name));
    if (!ok) return;
    useHub.setState((s) => ({ agents: s.agents.filter((a) => a.name !== agent.name) }));
    // a deleted copy of a built-in agent brings the shipped one back
    await reloadAgents();
    const back = useHub.getState().agents.some((a) => a.name === agent.name);
    toast({ title: back ? `Deleted your ${agent.name}. The shipped ${agent.name} is back.` : `Deleted ${agent.name}.`, level: 'success' });
    if (after) navigate(after);
  };
  const dialog = (
    // the memory Confirm: 44px buttons on phones, which the shared dialog lacks
    <Confirm
      open={open}
      onClose={() => setOpen(false)}
      onConfirm={remove}
      title={`Delete agent ${agent.name}?`}
      body="Sessions that used it keep their history."
      confirm="Delete"
      busy="Deleting"
    />
  );
  return { ask: () => setOpen(true), dialog };
}
