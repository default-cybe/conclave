/**
 * Where an extension comes from, as a word (spec 10.6: tags are words, no
 * chips). Takes an ExtensionSourceId or a hook origin such as claude-user.
 * The title attribute names the folder so people can find the file.
 */
import type { ExtensionSourceId } from '@conclave/core/client';
import { cn } from '@/lib/text';

const WORDS: Record<string, string> = {
  builtin: 'built in',
  user: 'user',
  project: 'project',
  plugin: 'plugin',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  agents: 'shared .agents',
  config: 'user',
  'claude-user': 'Claude Code user',
  'claude-project': 'Claude Code project',
};

const PLACES: Record<string, string> = {
  builtin: 'Ships with Conclave',
  user: '~/.conclave',
  project: '.conclave/ in this project',
  claude: '~/.claude or .claude/ in this project',
  codex: '~/.codex',
  opencode: '~/.config/opencode or .opencode/',
  gemini: '~/.gemini or .gemini/',
  agents: '~/.agents or .agents/',
  config: '~/.conclave/config.json',
  'claude-user': '~/.claude/settings.json',
  'claude-project': '.claude/settings.json in this project',
};

/** "plugin hookify", "Claude Code", "built in". */
export function sourceWord(source: ExtensionSourceId | string, plugin?: string): string {
  if (source === 'plugin') return plugin ? `plugin ${plugin}` : 'plugin';
  return WORDS[source] ?? source;
}

const SCOPE_CLI: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI' };

/**
 * The hub's scope label in words: "builtin" -> "built in", "claude user" ->
 * "Claude Code user", "~/.agents" -> "shared ~/.agents",
 * "opencode project /repo" -> "OpenCode project /repo".
 */
export function scopeWord(scope: string): string {
  if (scope === 'builtin') return 'built in';
  if (scope === '~/.agents') return 'shared ~/.agents';
  const agents = /^\.agents (.+)$/.exec(scope);
  if (agents) return `shared .agents in ${agents[1]}`;
  const m = /^(claude|codex|opencode|gemini) (user|project)(?: (.+))?$/.exec(scope);
  if (m) return [SCOPE_CLI[m[1]], m[2], m[3]].filter(Boolean).join(' ');
  return scope;
}

/** True when the scope says more than the source word does (a project, a folder). */
function scopeAddsInfo(scope: string | undefined): boolean {
  return !!scope && /\s/.test(scope) && /project|\/| in /.test(scope);
}

/** Source and scope in one phrase for a detail header: "plugin superpowers", "Claude Code project", "user". */
export function WhereFrom({ item }: { item: { source: ExtensionSourceId | string; plugin?: string; scope?: string } }) {
  const word = sourceWord(item.source, item.plugin);
  const scope = scopeAddsInfo(item.scope) ? scopeWord(item.scope!) : undefined;
  if (scope && scope.startsWith(word)) return <SourceBadge source={item.source} plugin={item.plugin} label={scope} />;
  return (
    <>
      <SourceBadge source={item.source} plugin={item.plugin} />
      {scope && `, ${scope}`}
    </>
  );
}

export function SourceBadge({ source, plugin, className, label }: { source: ExtensionSourceId | string; plugin?: string; className?: string; label?: string }) {
  const place = source === 'plugin' ? (plugin ? `From the ${plugin} plugin` : 'From a plugin') : PLACES[source];
  return (
    <span className={cn('whitespace-nowrap text-fg-3', className)} title={place}>
      {label ?? sourceWord(source, plugin)}
    </span>
  );
}
