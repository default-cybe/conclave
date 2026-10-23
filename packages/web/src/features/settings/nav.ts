/**
 * How Settings is found and reached (SettingsPage.tsx, docs/design/SPEC.md 5.3):
 * the index's groups, the search over its sections, and where an address
 * under /settings goes when it is not a section here. Pure, so
 * test/settings-overlay.test.ts checks it.
 */

/** The index's groups, in order, by section id. A section not named here goes under the first group. */
export const SETTINGS_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: 'Settings', ids: ['account', 'people', 'appearance', 'notifications', 'assistant', 'reflect'] },
  { label: 'Models', ids: ['providers', 'subscriptions', 'accounts', 'refusal', 'defaults'] },
  { label: 'Customize', ids: ['permissions', 'apps', 'github', 'maps', 'calmail', 'browser', 'gateway'] },
  { label: 'Platform', ids: ['remote', 'friends', 'computer', 'audit', 'logs', 'about'] },
];

/** The sections in their groups, the empty groups left out. */
export function groupSections<T extends { id: string }>(sections: T[]): Array<{ label: string; items: T[] }> {
  const named = new Set(SETTINGS_GROUPS.flatMap((g) => g.ids));
  return SETTINGS_GROUPS.map((g, i) => ({
    label: g.label,
    items: [...g.ids.map((id) => sections.find((s) => s.id === id)).filter((s): s is T => !!s), ...(i === 0 ? sections.filter((s) => !named.has(s.id)) : [])],
  })).filter((g) => g.items.length);
}

/** Words people search for, beyond a section's name and line. */
const KEYWORDS: Record<string, string> = {
  account: 'name password sign out switch email',
  people: 'members family invite person budget access',
  providers: 'keys api plans logins anthropic openai',
  subscriptions: 'claude chatgpt google plan sign in',
  accounts: 'limits reset budget order',
  refusal: 'refuse refused declined safety priority fallback next model',
  defaults: 'default model agent device memory',
  permissions: 'rules allow ask deny mode',
  notifications: 'notify push alerts phone browser hold',
  assistant: 'proactive quiet hours heartbeat reflection timezone',
  reflect: 'reflection nightly notes learn memory how to work with me',
  maps: 'google openstreetmap directions places',
  calmail: 'calendar mail email events',
  browser: 'chromium profiles sites sign in logins passwords',
  gateway: 'claude code codex opencode usage keys',
  apps: 'mcp chatbot claude.ai chatgpt oauth connector',
  github: 'token pull request repo',
  appearance: 'theme dark light density motion logos text size font',
  audit: 'history actions blocked pairings',
  remote: 'phone away tunnel cloudflare tailscale address network',
  friends: 'friend invite safety code notes share',
  computer: 'files shells desktop app',
  about: 'version update updates startup hub client connection backup',
  logs: 'debug download errors',
};

/** The sections whose name, line or keywords hold every word typed. */
export function searchSections<T extends { id: string; label: string; desc: string }>(sections: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  return sections.filter((s) => {
    const text = `${s.label} ${s.desc} ${KEYWORDS[s.id] ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Sections that moved to Extensions keep working as links. */
const MOVED: Record<string, string> = { hooks: '/extensions/hooks', mcp: '/extensions/mcp', plugins: '/extensions/plugins' };

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
