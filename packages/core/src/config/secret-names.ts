/**
 * Named secrets (secrets.json values) that ${secret:name} reads: the rule
 * for a name the owner picks, and which names another page of the app keeps
 * for itself. Pure, so the web app uses the same rule (Settings > Secrets).
 */

/** A name the owner saves from Settings > Secrets, the CLI or PUT /api/secrets. */
// __proto__ and constructor are Object.prototype keys: a value saved under them is lost or reads back a function
export const SECRET_NAME = /^(?!(?:__proto__|constructor)$)[a-z0-9._-]{1,64}$/;

/** The first 4 characters as the hub shows them: none for a short value, which 4 characters would nearly give away. */
export const secretPrefix = (v: string): string | undefined => (v.length >= 12 ? v.slice(0, 4) : undefined);

/** Every ${secret:name} in a string, as config.expand reads them. */
export const SECRET_REF = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

/** One named secret as Settings > Secrets lists it (GET /api/secrets): never its value. */
export interface SecretInfo {
  name: string;
  /** The first 4 characters, as `conclave secret` prints them; none for a short value or one the hub manages. */
  prefix?: string;
  setAt?: number;
  /** Where the hub sets it, for a name another page manages. */
  managedBy?: string;
}

/** Names other pages save and manage, with where. Listed read-only on the Secrets page. */
const MANAGED: Array<[RegExp, string]> = [
  [/^search\./, 'Settings > Web search'],
  [/^plugin\./, 'Extensions > Plugins'],
  [/^github$/, 'Settings > GitHub'],
  [/^github-pat$/, 'Extensions > Discover'],
  [/^catalog\.github-token$/, 'Extensions > Discover'],
  [/^stt\./, 'Settings > Meetings'],
  [/^pim\./, 'Settings > Calendar and mail'],
  [/^mcp\..+\.oauth$/, 'Extensions > MCP servers, Connect'],
  [/^cliproxy\./, 'Settings > Subscriptions'],
  [/^cloudflare\./, 'Settings > Remote access'],
  [/^browser\./, 'Settings > Browser'],
  [/^memory\./, 'Settings > Defaults, memory'],
];

/** Where a hub-managed secret is set, or undefined for one the owner named. */
export function managedBy(name: string): string | undefined {
  return MANAGED.find(([re]) => re.test(name))?.[1];
}

/** The secret names a set of config strings reference, each once, in order. */
export function secretRefs(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(SECRET_REF)) out.add(m[1]!);
  return [...out];
}
