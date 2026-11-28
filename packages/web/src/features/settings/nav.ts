/**
 * How Settings is found and reached (SettingsPage.tsx, docs/design/SPEC.md 5.3):
 * the index's groups, the search over its sections, and where an address
 * under /settings goes when it is not a section here. Pure, so
 * test/settings-overlay.test.ts checks it.
 */

/**
 * The index's groups, in order, by section id. A section not named here goes
 * under the first group. A folded group shows only its name until opened, or
 * while a search runs or one of its sections is open.
 */
export const SETTINGS_GROUPS: Array<{ label: string; ids: string[]; folded?: boolean }> = [
  { label: 'You', ids: ['account', 'appearance', 'modes', 'notifications'] },
  { label: 'AI connections', ids: ['subscriptions', 'accounts', 'providers', 'secrets', 'defaults', 'permissions'] },
  { label: 'Assistant', ids: ['assistant', 'calmail', 'meetings', 'maps'] },
  { label: 'Tools and apps', ids: ['websearch', 'github', 'browser', 'apps'] },
  { label: 'Hub and people', ids: ['people', 'friends', 'remote', 'computer', 'about'] },
  { label: 'Data', ids: ['data', 'audit'] },
  { label: 'Advanced', ids: ['refusal', 'limit-fallback', 'security', 'gateway', 'workflows', 'logs'], folded: true },
];

/** The group names before the regroup: docs and old habits still use them, so search finds their sections. */
const OLD_GROUPS: Record<string, string[]> = {
  settings: ['account', 'people', 'appearance', 'modes', 'notifications', 'assistant', 'data'],
  models: ['providers', 'subscriptions', 'accounts', 'refusal', 'limit-fallback', 'security', 'defaults'],
  customize: ['permissions', 'apps', 'github', 'maps', 'websearch', 'meetings', 'calmail', 'browser', 'gateway', 'secrets'],
  platform: ['remote', 'friends', 'computer', 'audit', 'logs', 'about'],
};

/** The sections in their groups, the empty groups left out. */
export function groupSections<T extends { id: string }>(sections: T[]): Array<{ label: string; folded?: boolean; items: T[] }> {
  const named = new Set(SETTINGS_GROUPS.flatMap((g) => g.ids));
  return SETTINGS_GROUPS.map((g, i) => ({
    label: g.label,
    folded: g.folded,
    items: [...g.ids.map((id) => sections.find((s) => s.id === id)).filter((s): s is T => !!s), ...(i === 0 ? sections.filter((s) => !named.has(s.id)) : [])],
  })).filter((g) => g.items.length);
}

/** Words people search for, beyond a section's name and line. */
const KEYWORDS: Record<string, string> = {
  account: 'name password sign out switch email',
  people: 'members family invite person budget access',
  providers: 'keys api plans logins anthropic openai',
  subscriptions: 'claude chatgpt google plan sign in',
  accounts: 'accounts limits reset budget order plan priority try now prefix window',
  refusal: 'refuse refused declined safety priority fallback next model',
  'limit-fallback': 'usage limit quota fallback chain next model',
  security: 'roles routing sec hunter validator refuter reporter recon exploit hunt lane',
  defaults: 'default model agent device same model for all work cyber access daybreak security per conversation tiers fast smart deep vision images read image cache ttl spend cost budget tokens minutes limits routine subagent handover wait reset',
  permissions: 'rules allow ask deny mode file conflict another chat edited',
  notifications: 'notify push alerts phone browser hold stuck minutes slow',
  assistant: 'proactive quiet hours heartbeat reflection timezone',
  data: 'import export backup claude chatgpt conversations.json zip download memory notes migrate',
  maps: 'google openstreetmap directions places',
  websearch: 'brave tavily exa langsearch linkup firecrawl you.com serper serpapi jina searxng duckduckgo api key internet',
  calmail: 'calendar mail email events',
  meetings: 'speech to text transcription stt assemblyai deepgram parakeet overlay',
  browser: 'chromium profiles sites sign in logins passwords program binary executable profile folder',
  gateway: 'claude code codex opencode usage keys',
  secrets: 'secret token api key mcp env header password value',
  apps: 'mcp chatbot claude.ai chatgpt oauth connector',
  github: 'token pull request repo clone folder poll check interval',
  appearance: 'theme dark light density motion logos text size font',
  modes: 'modes security canvas meetings hide show turn on',
  audit: 'history actions blocked pairings',
  remote: 'phone away tunnel cloudflare tailscale address network',
  friends: 'friend invite safety code notes share',
  computer: 'files shells desktop app',
  about: 'version update updates startup hub client connection backup setup run setup again set up later extension packs coding agents past chats starter routines',
  logs: 'debug download errors report a problem bug retention keep days size',
  workflows: 'subagents agents parallel concurrency limit per provider workflow max queue hub at once rate ultra auto approve steps model calls per turn heavy commands tests upload size',
};

/** The sections whose name, line or keywords hold every word typed. */
export function searchSections<T extends { id: string; label: string; desc: string }>(sections: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  return sections.filter((s) => {
    const groups = [SETTINGS_GROUPS.find((g) => g.ids.includes(s.id))?.label, ...Object.keys(OLD_GROUPS).filter((g) => OLD_GROUPS[g].includes(s.id))].join(' ');
    const text = `${s.label} ${s.desc} ${KEYWORDS[s.id] ?? ''} ${groups}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Sections that moved to Extensions keep working as links. */
const MOVED: Record<string, string> = {
  hooks: '/extensions/hooks',
  mcp: '/extensions/mcp',
  plugins: '/extensions/plugins',
  // Reflect is a page next to Memory now; the old id keeps its links
  reflect: '/reflect',
  // Limit fallback's old id clashed with /usage
  usage: '/settings/limit-fallback',
};

/** Sections with pages under them (/settings/<section>/<item>). */
export const ITEM_SECTIONS = new Set(['friends']);

/**
 * Where an address under /settings goes when it is not a section here: a
 * section that moved goes to its new page, an unknown one to the first
 * section (to the index on a phone), an item of a section without items to
 * the section, and bare /settings on a computer to the first section.
 * Undefined: it stays.
 */
export function settingsRedirect(section: string | undefined, item: string | undefined, known: string[], phone: boolean, search = ''): string | undefined {
  if (section && MOVED[section]) return MOVED[section] + search;
  if (!section) return phone ? undefined : `/settings/${known[0] ?? 'account'}`;
  if (!known.includes(section)) return phone ? '/settings' : `/settings/${known[0] ?? 'account'}`;
  if (item && !ITEM_SECTIONS.has(section)) return `/settings/${section}`;
  return undefined;
}
