/** Words for Discover rows and the preview: kinds, categories, stars, dates, needs. */
import { shortDate } from '@/lib/format';
import type { CatalogCategory, CatalogItemDto, CatalogKind, CatalogNeed, Touch } from '@conclave/core/client';

/** Filter order (spec 3.2). */
export const KIND_ORDER: CatalogKind[] = ['mcp', 'skill', 'plugin', 'subagent', 'command', 'hook', 'routine'];

/** The kind word in a meta line ("plugin", "MCP server"). */
export const KIND_WORD: Record<CatalogKind, string> = {
  mcp: 'MCP server',
  skill: 'skill',
  plugin: 'plugin',
  subagent: 'subagent',
  command: 'command',
  hook: 'hook recipe',
  routine: 'routine',
};

/** Filter links and subheadings ("MCP servers", "Hooks"). */
export const KIND_PLURAL: Record<CatalogKind, string> = {
  mcp: 'MCP servers',
  skill: 'Skills',
  plugin: 'Plugins',
  subagent: 'Subagents',
  command: 'Commands',
  hook: 'Hooks',
  routine: 'Routines',
};

/** Lower case plural for sentences ("No MCP servers match"). */
export const KIND_PLURAL_LOWER: Record<CatalogKind, string> = {
  mcp: 'MCP servers',
  skill: 'skills',
  plugin: 'plugins',
  subagent: 'subagents',
  command: 'commands',
  hook: 'hook recipes',
  routine: 'routines',
};

/** Where an item of each kind lives once it is added. */
export const KIND_TAB: Record<CatalogKind, { label: string; href: string }> = {
  mcp: { label: 'MCP servers', href: '/extensions/mcp' },
  skill: { label: 'Skills', href: '/extensions/skills' },
  plugin: { label: 'Plugins', href: '/extensions/plugins' },
  subagent: { label: 'Agents', href: '/agents' },
  command: { label: 'Commands', href: '/extensions/commands' },
  hook: { label: 'Hooks', href: '/extensions/hooks' },
  routine: { label: 'Routines', href: '/routines' },
};

const CATEGORY_WORDS: Partial<Record<CatalogCategory, string>> = {
  'github-git': 'GitHub and git',
  'calendar-mail': 'calendar and mail',
  ctf: 'CTF',
  'code-intelligence': 'code intelligence',
  'self-improvement': 'self improvement',
};

export function categoryWord(c: CatalogCategory | string): string {
  return CATEGORY_WORDS[c as CatalogCategory] ?? c.replace(/-/g, ' ');
}

/** "165k stars", "33.7k stars", "597 stars", "1 star". */
export function starsWords(n: number | undefined): string {
  if (n === undefined) return '';
  if (n === 1) return '1 star';
  if (n < 1000) return `${n} stars`;
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k stars`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k stars`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M stars`;
}

/** A YYYY-MM-DD date as a local timestamp at noon, so time zones never move the day. */
function dayTs(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
}

/** "17 Oct" for a YYYY-MM-DD date. */
export function dayWords(date: string | undefined): string {
  const ts = dayTs(date);
  return ts ? shortDate(ts) : '';
}

/** "updated today", "updated 3 days ago", "updated 5 months ago". */
export function updatedWords(date: string | undefined, now = Date.now()): string {
  const ts = dayTs(date);
  if (!ts) return '';
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  const days = Math.round((today.getTime() - ts) / 86_400_000);
  if (days <= 0) return 'updated today';
  if (days === 1) return 'updated yesterday';
  if (days < 14) return `updated ${days} days ago`;
  if (days < 60) return `updated ${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `updated ${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? 'updated a year ago' : `updated ${years} years ago`;
}

/** Updated more than 180 days ago: the daily refresh calls it stale. */
export function isStale(date: string | undefined, now = Date.now()): boolean {
  const ts = dayTs(date);
  return !!ts && now - ts > 180 * 86_400_000;
}

const TOUCH_WORDS: Record<Touch, string> = {
  network: 'network',
  files: 'files',
  shell: 'shell',
  'hub-code': 'hub code',
  'cloud-account': 'a cloud account',
  'real-devices': 'real devices',
  browser: 'a browser',
  memory: 'memory',
  mail: 'mail',
  repos: 'repos',
};

export function touchWords(t: Touch[] | undefined): string {
  return (t ?? []).map((x) => TOUCH_WORDS[x] ?? x).join(', ');
}

/** "on the hub", "on the device", "on every device". */
export function whereWords(where: CatalogNeed['where'], hub = 'the hub'): string {
  return where === 'hub' ? `on ${hub}` : where === 'device' ? 'on the device' : 'on every device';
}

/** "Needs uv on the hub." for the missing ones, joined. */
export function missingWords(missing: CatalogNeed[], hub = 'the hub'): string {
  if (!missing.length) return '';
  const byWhere = new Map<string, string[]>();
  for (const n of missing) {
    const k = whereWords(n.where, hub);
    byWhere.set(k, [...(byWhere.get(k) ?? []), n.bin]);
  }
  return `Needs ${[...byWhere].map(([w, bins]) => `${listWords(bins)} ${w}`).join(' and ')}.`;
}

/** "a, b and c". */
export function listWords(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export const shortSha = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '');

export function repoUrl(item: Pick<CatalogItemDto, 'repo' | 'url'>): string | undefined {
  if (item.repo) return `https://github.com/${item.repo}`;
  return item.url;
}

/** Licenses that are not OSI open source, as the preview warns (spec 1.6). */
export function licenseOpen(license: string | undefined): boolean | undefined {
  if (!license) return undefined;
  if (/elastic|busl|business source|source.available|commons clause|sspl|cc-by-nc|proprietary|fair.code/i.test(license)) return false;
  return true;
}

/**
 * A live result (GitHub search, the star index, the awesome list) has no install spec until the
 * preview reads the repo and works one out, so its "manual" spec is a placeholder, not steps.
 */
export function isLive(item: Pick<CatalogItemDto, 'install' | 'repo' | 'source'>): boolean {
  return item.install.type === 'manual' && !!item.repo && ['github', 'awesome-list', 'star-index'].includes(item.source);
}

/** The label of the Add action for one item. */
export function addLabel(item: CatalogItemDto): string {
  return item.install.type === 'manual' && !isLive(item) ? 'How to add' : 'Add';
}

/** The folder every path shares, ending in "/", or "" when they share none. */
export function commonDir(paths: string[]): string {
  if (paths.length < 2) return paths.length === 1 && paths[0].includes('/') ? paths[0].slice(0, paths[0].lastIndexOf('/') + 1) : '';
  let pre = paths[0].slice(0, paths[0].lastIndexOf('/') + 1);
  for (const x of paths) while (pre && !x.startsWith(pre)) pre = pre.slice(0, pre.slice(0, -1).lastIndexOf('/') + 1);
  return pre;
}

/** A path the preview gives "under ~/.conclave", with the folder in front when it is not there yet. */
export const underHome = (path: string) => (/^(~|\/)/.test(path) ? path : `~/.conclave/${path}`);

/** Saved items that match every word of a search, shown when live search cannot run. */
export function localMatches<T extends Pick<CatalogItemDto, 'kind' | 'name' | 'description' | 'repo' | 'category' | 'tags'>>(items: T[], q: string, kind?: CatalogKind): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return items.filter((x) => (!kind || x.kind === kind) && words.every((w) => [x.name, x.description, x.repo ?? '', x.category, ...(x.tags ?? [])].join(' ').toLowerCase().includes(w)));
}

/** README text without images and raw HTML, which the sheet cannot show well. */
export function cleanReadme(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    // images load from any host the README names (badges, tracking pixels), so they go, inline and reference style
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    // and the links that only wrapped a badge
    .replace(/\[\s*\]\([^)]*\)|\[\s*\]\[[^\]]*\]/g, '')
    .replace(/<\/?(?:p|div|span|img|picture|source|a|br|hr|h[1-6]|details|summary|sup|sub|b|i|em|strong|table|thead|tbody|tr|td|th|ul|ol|li|code|pre|kbd|center|video|svg|path)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Skills, agents and commands that load from these paths: skills/<name>/SKILL.md,
 * agents/<name>.md and commands/**.md at the root of ~/.conclave or of one plugin
 * folder. Copies for other tools deeper in a repo do not load and are not counted.
 */
export function loadedCounts(paths: string[]): { skills: number; agents: number; commands: number } {
  const rel = paths.map((p) => p.replace(/^~\/\.conclave\/(?:plugins\/[^/]+\/)?/, ''));
  return {
    skills: rel.filter((p) => /^skills\/[^/]+\/SKILL\.md$/i.test(p)).length,
    agents: rel.filter((p) => /^agents\/[^/]+\.md$/i.test(p)).length,
    commands: rel.filter((p) => /^commands\/.+\.md$/i.test(p)).length,
  };
}
