/** Words for plugins: what a plugin adds, where it came from, how to install it in other CLIs. */
import type { PluginDetailDto } from '@conclave/core/client';
import type { InstalledPlugin } from '@conclave/core/extensions/types';
import { plural } from '@/lib/format';

export function hookCount(d: Pick<PluginDetailDto, 'hooks'>): number {
  return Object.values(d.hooks ?? {}).reduce((n, list) => n + (list ?? []).reduce((m, g) => m + (g.hooks?.length ?? 0), 0), 0);
}

/** ["3 agents", "4 commands", "1 skill", "4 hooks", "1 MCP server"], empty parts left out. */
export function addsWords(d: PluginDetailDto): string[] {
  const mcp = Object.keys(d.mcpServers ?? {}).length;
  return [
    d.agents.length ? plural(d.agents.length, 'agent') : '',
    d.commands.length ? plural(d.commands.length, 'command') : '',
    d.skills.length ? plural(d.skills.length, 'skill') : '',
    hookCount(d) ? plural(hookCount(d), 'hook') : '',
    mcp ? plural(mcp, 'MCP server') : '',
  ].filter(Boolean);
}

/** True when the plugin runs code on the hub on its own: hooks or MCP servers. */
export function runsCode(d: PluginDetailDto): boolean {
  return hookCount(d) > 0 || Object.keys(d.mcpServers ?? {}).length > 0;
}

/** "hookify@claude-plugins-official" -> "claude-plugins-official". */
export function marketplaceOf(source: string): string | undefined {
  const m = /^[^@/\s][^@\s]*@([A-Za-z0-9._-]+)$/.exec(source);
  return m && !source.startsWith('git@') ? m[1] : undefined;
}

/** Where an installed plugin came from, in words. */
export function sourceWords(p: Pick<InstalledPlugin, 'source'>): string {
  const mk = marketplaceOf(p.source);
  if (mk) return mk;
  if (/^(\/|~|\.)/.test(p.source)) return 'local folder';
  if (/^github:/.test(p.source) || /^[\w.-]+\/[\w.-]+$/.test(p.source)) return 'GitHub';
  return 'git';
}

/** Marketplace search sourceKind in words. */
export function kindWords(kind: string): string {
  switch (kind) {
    case 'path':
      return 'in the marketplace repo';
    case 'github':
      return 'GitHub';
    case 'git':
      return 'git';
    case 'url':
      return 'git URL';
    case 'git-subdir':
      return 'folder of a git repo';
    default:
      return kind;
  }
}

/** Marketplaces whose repo we know, for the "add the marketplace first" hint. */
export const KNOWN_MARKETPLACES: Record<string, string> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
  'superpowers-marketplace': 'obra/superpowers-marketplace',
  'anthropic-agent-skills': 'anthropics/skills',
};

/** The plugin's data folder: <plugins>/.data/<name>, next to its own folder. */
export function dataFolder(p: Pick<InstalledPlugin, 'dir' | 'name'>): string {
  const base = p.dir.replace(/\/[^/]+\/?$/, '');
  return `${base}/.data/${p.name}`;
}

/** Check a marketplace source before sending it: owner/repo, a git URL or a path. */
export function marketplaceSourceError(s: string): string | undefined {
  const v = s.trim();
  if (!v) return undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) return undefined;
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(v)) return undefined;
  if (/^(\/|~)/.test(v)) return undefined;
  return 'Use owner/repo for GitHub, a git URL, or a full path on the hub that starts with / or ~.';
}

/** A next step for a failed "Add marketplace", from the hub's git or file error. */
export function marketplaceErrorHint(msg: string): string {
  if (/could not read Username|Repository not found|not found|404/i.test(msg)) return 'The repo does not exist, or it is private. Check owner/repo, or give a git URL the hub can clone with its own credentials.';
  if (/marketplace\.json/i.test(msg)) return 'Point at the folder that holds .claude-plugin/marketplace.json.';
  if (/Could not resolve host|network|timed out/i.test(msg)) return 'The hub cannot reach the internet. Check its network, then try again.';
  return 'Check the source, then try again.';
}
