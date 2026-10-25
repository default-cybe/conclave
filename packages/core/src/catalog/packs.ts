/**
 * Extension packs for setup's "Make Conclave better" step: named sets of
 * RECOMMENDED ids the owner installs in one go. Data only; the web app runs
 * each id through the same preview and install routes as Discover.
 *
 * Left out because the hub cannot get what they need by itself
 * (catalog/hub-setup.ts installs only user-level programs):
 * - mcp:grafana runs through docker, which needs root.
 * - mcp:radare2 needs r2pm from the radare2 system package.
 * - mcp:ghidra needs the Ghidra desktop app with the GhidraMCP extension on a device.
 * - mcp:mcp-proxy needs a proxy started by hand on a device for one named server.
 */
export interface ExtensionPack {
  id: string;
  name: string;
  /** One neutral line under the name. */
  line: string;
  /** Checked when the step opens. */
  defaultOn: boolean;
  /** RECOMMENDED ids, installed in this order. */
  items: string[];
  /** Tool preset per item id (McpInstall.toolPresets). */
  presets?: Record<string, string>;
}

export const EXTENSION_PACKS: ExtensionPack[] = [
  {
    id: 'starter',
    name: 'Starter',
    line: 'Library docs, GitHub, notes, code navigation, a browser, documents and writing rules. Useful on any project.',
    defaultOn: true,
    items: [
      'mcp:context7',
      'mcp:github',
      'mcp:basic-memory',
      'mcp:serena',
      'plugin:superpowers',
      'plugin:ponytail',
      'plugin:caveman',
      'skill:karpathy-guidelines',
      'skill:avoid-ai-writing',
      'subagent:code-simplifier',
      'mcp:playwright',
      'mcp:markitdown',
      'skill:document-skills',
      'plugin:claude-md-management',
    ],
  },
  {
    id: 'security',
    name: 'Security and CTF',
    line: 'Code auditing, static analysis, and helpers for CTF challenges and reverse engineering.',
    defaultOn: false,
    items: ['plugin:trailofbits', 'mcp:semgrep', 'skill:ctf-skills', 'subagent:reverse-engineering'],
  },
  {
    id: 'homelab',
    name: 'Homelab',
    line: 'Read-only Proxmox access, search through your own SearXNG, and database queries.',
    defaultOn: false,
    items: ['mcp:proxmox', 'mcp:searxng', 'mcp:dbhub'],
    presets: { 'mcp:proxmox': 'read-only' },
  },
  {
    id: 'study',
    name: 'Study',
    line: 'Search and cite papers in a Zotero library.',
    defaultOn: false,
    items: ['mcp:zotero'],
  },
  {
    id: 'google-microsoft',
    name: 'Google and Microsoft',
    line: 'Mail, calendar and files in Google Workspace and Microsoft 365.',
    defaultOn: false,
    items: ['mcp:google-workspace', 'mcp:ms-365'],
  },
];

/** Where to get a value the packs ask for, by input name. Inputs not listed use their own description. */
export const KEY_HELP: Record<string, { url?: string; how: string }> = {
  GITHUB_PAT: { url: 'https://github.com/settings/personal-access-tokens/new', how: 'Create a fine-grained token with read-only access to the repos you pick.' },
  CONTEXT7_API_KEY: { url: 'https://context7.com/dashboard', how: 'Optional. A free key raises the rate limit.' },
  SEMGREP_APP_TOKEN: { url: 'https://semgrep.dev/orgs/-/settings/tokens', how: 'Optional. Adds the Semgrep AppSec Platform rules.' },
  PROXMOX_TOKEN_VALUE: { url: 'https://pve.proxmox.com/wiki/User_Management#pveum_tokens', how: 'In Proxmox: Datacenter, Permissions, API Tokens. Give the user the PVEAuditor role.' },
  DSN: { how: 'A connection string such as postgres://user:pass@host:5432/db. Use a read-only database user.' },
  ZOTERO_API_KEY: { url: 'https://www.zotero.org/settings/keys', how: 'Create a read-only key. The same page shows your user ID for the library ID.' },
  ZOTERO_LIBRARY_ID: { url: 'https://www.zotero.org/settings/keys', how: 'Your userID, shown above the key list.' },
  GOOGLE_OAUTH_CLIENT_ID: { url: 'https://console.cloud.google.com/apis/credentials', how: 'Create an OAuth client of type Desktop app.' },
  GOOGLE_OAUTH_CLIENT_SECRET: { url: 'https://console.cloud.google.com/apis/credentials', how: 'Shown with the client ID when you create the OAuth client.' },
};
