/**
 * Security mode scope files and the scope guard's decision
 * (docs/design/SECURITY-MODE.md section 4, items 1, 3 and 4).
 *
 * - parseScope reads a target's scope.yaml. Lab is only named docker networks
 *   (sec-lab-<t>) plus loopback: an IP or an IP range is never lab, since a
 *   homelab range such as 10.0.0.0/8 holds live services. CIDR ranges are
 *   refused everywhere.
 * - ScopeGrant is the approval grant record the guard reads. The issuing side
 *   (lib.approve, the grant card, the gateway) is PR 1b; grants live in the
 *   hub's kv under GRANTS_KV, which no route and no tool writes, so only hub
 *   code acting for the owner can add one.
 * - decide() applies the design's table to one tool call. It is pure, so the
 *   tests cover every row without a hub.
 */
import YAML from 'yaml';

export const VENUES = ['hackerone', 'bugcrowd', 'apple', 'ghsa', 'vendor', 'own', 'ctf'] as const;
export type Venue = (typeof VENUES)[number];

/** Owner decision on PR #271: a grant covers at most 24 h and 500 requests. */
export const GRANT_MAX_MS = 24 * 3_600_000;
export const GRANT_MAX_REQUESTS = 500;

export interface Scope {
  program: string;
  venue?: Venue;
  /** Hosts or globs ("*.api.example.com"); an entry may carry a path ("app.example.com/api/**"). */
  inScope: string[];
  /** Path globs the in-scope hosts are limited to. Empty: every path. */
  paths: string[];
  /** Hosts, globs, "/path/**" (any host) or "host/path/**". */
  outOfScope: string[];
  /** Docker network names the workflow created for this target. */
  lab: string[];
  callback: string[];
  rateLimitRps: number;
  requestBudget: number;
  accounts: string[];
  no: string[];
  /** YYYY-MM-DD, last day the scope holds (UTC). */
  expires?: string;
}

export class ScopeError extends Error {}

const CIDR = /^[0-9a-f.:]+\/\d{1,3}$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const NET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function list(doc: Record<string, unknown>, key: string, required = false): string[] {
  const v = doc[key];
  if (v === undefined || v === null) {
    if (required) throw new ScopeError(`${key} is required (a list of hosts or globs)`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new ScopeError(`${key} must be a list of strings`);
  return v.map((x: string) => x.trim());
}

function positive(doc: Record<string, unknown>, key: string, fallback: number): number {
  const v = doc[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ScopeError(`${key} must be a number above 0`);
  return v;
}

/** Parse and check a scope.yaml. Throws ScopeError with the reason. */
export function parseScope(text: string): Scope {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new ScopeError(`not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ScopeError('the file must be a YAML mapping');
  const d = doc as Record<string, unknown>;
  if (typeof d.program !== 'string' || !d.program.trim()) throw new ScopeError('program is required');
  const venue = d.venue;
  if (venue !== undefined && !VENUES.includes(venue as Venue)) throw new ScopeError(`venue must be one of ${VENUES.join(', ')}`);
  const inScope = list(d, 'in_scope', true);
  const outOfScope = list(d, 'out_of_scope');
  const lab = list(d, 'lab');
  const callback = list(d, 'callback');
  for (const [key, entries] of [['in_scope', inScope], ['out_of_scope', outOfScope], ['callback', callback]] as const) {
    const bad = entries.find((e) => CIDR.test(e));
    if (bad) throw new ScopeError(`${key} has an IP range (${bad}); list hosts, not ranges`);
  }
  for (const n of lab) {
    if (CIDR.test(n) || IPV4.test(n) || n.includes(':')) throw new ScopeError(`lab has ${n}: lab is docker network names (sec-lab-<target>), never IPs or ranges`);
    if (!NET_NAME.test(n)) throw new ScopeError(`lab has ${n}, which is not a docker network name`);
  }
  let expires: string | undefined;
  if (d.expires !== undefined && d.expires !== null) {
    const raw = d.expires instanceof Date ? d.expires.toISOString().slice(0, 10) : String(d.expires);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new ScopeError('expires must be a date, YYYY-MM-DD');
    expires = raw;
  }
  return {
    program: d.program.trim(),
    ...(venue ? { venue: venue as Venue } : {}),
    inScope,
    paths: list(d, 'paths'),
    outOfScope,
    lab,
    callback,
    rateLimitRps: positive(d, 'rate_limit_rps', 1),
    requestBudget: Math.min(positive(d, 'request_budget', GRANT_MAX_REQUESTS), GRANT_MAX_REQUESTS),
    accounts: list(d, 'accounts'),
    no: list(d, 'no'),
    ...(expires ? { expires } : {}),
  };
}

/** Whether the scope's last day is over. */
export function scopeExpired(s: Scope, now = Date.now()): boolean {
  return !!s.expires && now >= Date.parse(`${s.expires}T00:00:00Z`) + 86_400_000;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** kv key: Record<sessionId, ScopeGrant[]>. The session is the security session the owner approved in. */
export const GRANTS_KV = 'security.grants';

/** An approval grant for live hosts of one target (design 4.3). Written by PR 1b; read here. */
export interface ScopeGrant {
  id: string;
  /** Hosts or globs it covers; each must also be in the scope's in_scope. */
  hosts: string[];
  /** Account labels from scope.yaml it covers. */
  accounts: string[];
  /** Most requests; at most GRANT_MAX_REQUESTS. */
  requestBudget: number;
  /** Requests counted so far by the egress gateway (PR 1b). */
  used?: number;
  rateRps: number;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

/** Whether a stored grant is live: not revoked, not expired, inside the 24 h / 500 request caps, budget left. */
export function grantLive(g: ScopeGrant, now = Date.now()): boolean {
  if (!g || !Array.isArray(g.hosts) || typeof g.expiresAt !== 'number' || typeof g.issuedAt !== 'number') return false;
  if (g.revokedAt || now >= g.expiresAt || now < g.issuedAt) return false;
  if (g.expiresAt - g.issuedAt > GRANT_MAX_MS) return false;
  if (!(g.requestBudget > 0) || g.requestBudget > GRANT_MAX_REQUESTS) return false;
  return (g.used ?? 0) < g.requestBudget;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** "user@Host.Example.com:8443" -> "host.example.com"; "[::1]:80" -> "::1". */
export function normHost(h: string): string {
  let s = h.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/^.*@/, '');
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
  if ((s.match(/:/g) ?? []).length === 1) s = s.replace(/:\d*$/, '');
  return s.replace(/\.$/, '');
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/;

function globRe(glob: string, segment: string): RegExp {
  const body = glob
    .split('**')
    .map((p) => p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join(segment))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

function hostMatches(pattern: string, host: string): boolean {
  const p = normHost(pattern);
  return p.includes('*') ? globRe(p, '.+').test(host) : p === host;
}

function pathMatches(glob: string, path: string): boolean {
  const g = glob.endsWith('/**') ? glob.slice(0, -3) : undefined;
  if (g !== undefined && (path === g || path === `${g}/`)) return true;
  return globRe(glob, '[^/]*').test(path);
}

/** "host/path/**" -> { host, path }; "/billing/**" -> { path }. */
function splitEntry(e: string): { host?: string; path?: string } {
  const s = e.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (s.startsWith('/')) return { path: s };
  const i = s.indexOf('/');
  return i < 0 ? { host: s } : { host: s.slice(0, i), path: s.slice(i) };
}

export type HostClass = 'lab' | 'out' | 'in' | 'in-bad-path' | 'unknown';

/** One host (and the path when known) against one scope. Out of scope wins over everything. */
export function classify(scope: Scope, rawHost: string, path?: string): HostClass {
  const host = normHost(rawHost);
  for (const e of scope.outOfScope) {
    const { host: h, path: p } = splitEntry(e);
    if (h && !hostMatches(h, host)) continue;
    if (!p) return 'out';
    if (path && pathMatches(p, path)) return 'out';
  }
  if (LOOPBACK.test(host)) return 'lab';
  // a lab network name, or <container>.<network> (docker's embedded DNS)
  if (scope.lab.some((n) => host === n.toLowerCase() || host.endsWith(`.${n.toLowerCase()}`))) return 'lab';
  let hit: HostClass = 'unknown';
  for (const e of scope.inScope) {
    const { host: h, path: p } = splitEntry(e);
    if (!h || !hostMatches(h, host)) continue;
    const allowed = p ? [p] : scope.paths;
    if (!path || !allowed.length || allowed.some((g) => pathMatches(g, path))) return 'in';
    hit = 'in-bad-path';
  }
  return hit;
}

/** Several scope files (scope.yaml and targets/<t>/scope.yaml) as one: out anywhere wins, then lab, then in. */
export function classifyAll(scopes: Scope[], host: string, path?: string): HostClass {
  const all = scopes.map((s) => classify(s, host, path));
  for (const c of ['out', 'lab', 'in', 'in-bad-path'] as const) if (all.includes(c)) return c;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Pulling targets out of a tool call
// ---------------------------------------------------------------------------

export interface Target {
  host: string;
  path?: string;
}

const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/([^\s'"<>`/?#\\)]+)([^\s'"<>`\\)]*)/gi;
const HOST_HDR = /^[ \t]*host:[ \t]*([^\s]+)/gim;
const REQ_LINE = /^[ \t]*[A-Z]{3,10}[ \t]+(\/[^\s]*)[ \t]+HTTP\/[\d.]+/m;
const IPV4_ANY = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g;
const HOSTISH = /^(?:[\w.+-]+@)?(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+|localhost)(?::\d+)?(\/\S*)?$/i;
// shortcut: file names on a network command line (curl -o out.json) look like hosts; this list drops the common ones. Widen it when a hunt prompts on a file name.
const FILE_EXT = /\.(txt|json|xml|html?|ya?ml|csv|log|js|ts|py|sh|md|out|pcap|gz|tgz|zip|tar|jpg|png|pdf|conf|cfg|ini|key|pem|crt|req|har|lst|list)$/i;
const NET_CMDS = /^(curl|wget|httpx|nmap|ffuf|nc|ncat|netcat|ssh|scp|sftp|telnet|sqlmap|nuclei|gobuster|feroxbuster|masscan|http|xh|openssl|websocat|grpcurl)$/;
// flags of those commands whose value is a file, a body or a header, not a host
const VALUE_FLAG = /^-(o|O|w|i|iL|oN|oX|oA|oG|d|e|F|T|u|A|b|c|x|l|p|U|P|t|H|-output|-data[\w-]*|-wordlist|-user-agent|-cookie|-header)$/;

function addUrl(out: Target[], authority: string, path: string): void {
  const host = normHost(authority);
  if (host) out.push({ host, ...(path ? { path: path.replace(/[?#].*$/, '') || '/' } : {}) });
}

/** URLs and raw HTTP requests (Host header plus request line) in a string. */
export function targetsInText(text: string): Target[] {
  const out: Target[] = [];
  for (const m of text.matchAll(URL_RE)) addUrl(out, m[1], m[2]);
  const reqPath = REQ_LINE.exec(text)?.[1];
  for (const m of text.matchAll(HOST_HDR)) addUrl(out, m[1], reqPath ?? '');
  return out;
}

/**
 * Hosts a shell command reaches: URLs anywhere, IPv4 literals anywhere, and
 * host arguments of network commands (curl, wget, httpx, nmap, ffuf, nc, ssh...).
 * shortcut: regex on the command text misses hosts built at runtime; the egress gateway (PR 1b) is the boundary.
 */
export function targetsInCommand(cmd: string): Target[] {
  const out = targetsInText(cmd);
  for (const m of cmd.matchAll(IPV4_ANY)) out.push({ host: m[1] });
  for (const seg of cmd.split(/[;&|\n]+|\$\(|`/)) {
    const words = seg.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''));
    const at = words.findIndex((w) => NET_CMDS.test(w.replace(/^.*\//, '')));
    if (at < 0) continue;
    let skip = false;
    for (const w of words.slice(at + 1)) {
      if (skip) {
        skip = false;
        continue;
      }
      if (VALUE_FLAG.test(w)) {
        skip = true;
        continue;
      }
      if (w.startsWith('-') || w.includes('://') || FILE_EXT.test(w.replace(/\/.*$/, ''))) continue;
      const hm = HOSTISH.exec(w);
      if (hm) out.push({ host: normHost(hm[1]), ...(hm[2] ? { path: hm[2] } : {}) });
    }
  }
  return out;
}

const HOST_KEYS = new Set(['url', 'uri', 'href', 'host', 'hostname', 'domain', 'target', 'address', 'endpoint', 'baseurl', 'base_url', 'origin']);

/** Targets in a structured tool input (WebFetch, browser, MCP): URL and host fields, and URLs or raw requests in any string. */
export function targetsInInput(input: unknown, depth = 0): Target[] {
  const out: Target[] = [];
  if (depth > 5 || input === null || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const found = targetsInText(v);
      out.push(...found);
      const s = v.trim();
      if (!found.length && HOST_KEYS.has(k.toLowerCase())) {
        const hm = HOSTISH.exec(s);
        if (hm) out.push({ host: normHost(hm[1]), ...(hm[2] ? { path: hm[2] } : {}) });
        else if (IPV4.test(s)) out.push({ host: s });
      }
    } else if (v && typeof v === 'object') out.push(...targetsInInput(v, depth + 1));
  }
  return out;
}

/** Words in free text that a scope file names (a Delegate brief, a python -c line): only listed hosts count, so prose does not prompt. */
export function listedHostsInText(text: string, scopes: Scope[]): Target[] {
  const out: Target[] = [];
  for (const w of text.split(/[\s'"`()[\]{},;<>]+/)) {
    const hm = HOSTISH.exec(w.replace(/[.:]+$/, ''));
    if (!hm || FILE_EXT.test(hm[1])) continue;
    const host = normHost(hm[1]);
    if (classifyAll(scopes, host, hm[2]) !== 'unknown') out.push({ host, ...(hm[2] ? { path: hm[2] } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type ScopeState = { kind: 'none' } | { kind: 'bad'; why: string } | { kind: 'ok'; scopes: Scope[]; files: string[] };

export interface GuardCall {
  tool: string;
  input: Record<string, unknown>;
  scope: ScopeState;
  /** Grants of the security session. A member's are ignored: lab only in v1. */
  grants: ScopeGrant[];
  member: boolean;
  now?: number;
}

export interface GuardVerdict {
  decision: 'deny' | 'ask';
  reason: string;
}

/** Caido MCP tools that send traffic (send, replay, batch, race, automate, fuzz). Reads (list, get, search) are left alone. */
export const CAIDO_SEND = /^mcp__caido__caido_(?!(?:list|get|delete|rename|search|export|update)_).*(send|replay|batch|race|fuzz|automate|resend|forward)/;
const RACE = /^mcp__caido__caido_race_window_send$/;

/** Tools that can reach the network: the shell, WebFetch, the browser, Delegate, and every MCP tool. */
export function guardedTool(name: string): boolean {
  return name === 'Bash' || name === 'WebFetch' || name === 'Delegate' || name.startsWith('browser_') || name.startsWith('mcp__');
}

function targetsOf(call: GuardCall, scopes: Scope[]): Target[] {
  const { tool, input } = call;
  if (tool === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    return [...targetsInCommand(cmd), ...listedHostsInText(cmd, scopes)];
  }
  if (tool === 'Delegate') {
    const text = [input.prompt, input.description].filter((x) => typeof x === 'string').join('\n');
    // the brief carries the network task to another device: URLs, IPs and listed hosts count, other prose does not
    return [...targetsInText(text), ...[...text.matchAll(IPV4_ANY)].map((m) => ({ host: m[1] })), ...listedHostsInText(text, scopes)];
  }
  return targetsInInput(input);
}

/**
 * The guard's answer for one call, or undefined to pass (no decision: the
 * normal permission rules apply). Table, design 4.4:
 *
 * | host          | WebFetch (on the hub)  | Bash, browser, MCP, Delegate        |
 * | lab           | pass                   | pass                                |
 * | out_of_scope  | deny                   | deny                                |
 * | in_scope      | deny (use validator)   | pass with a live grant, else ask    |
 * | not listed    | pass (research)        | ask                                 |
 * | no scope file | ask                    | ask                                 |
 *
 * A member's in-scope call is denied (lab only in v1). Caido
 * race_window_send is denied unless every host is lab (it sends from raw
 * sockets, around the proxy). A Caido send with no host it can read asks.
 */
export function decide(call: GuardCall): GuardVerdict | undefined {
  const { tool } = call;
  if (!guardedTool(tool)) return undefined;
  const now = call.now ?? Date.now();
  const scopes = call.scope.kind === 'ok' ? call.scope.scopes : [];
  const seen = new Map<string, Target>();
  for (const t of targetsOf(call, scopes)) if (t.host) seen.set(`${t.host}\u0000${t.path ?? ''}`, t);
  const targets = [...seen.values()];
  const race = RACE.test(tool);

  if (!targets.length) {
    if (race) return { decision: 'deny', reason: 'Scope guard: Caido race_window_send sends from raw sockets around the proxy, and no lab host was named. Run races only against the lab stack.' };
    if (CAIDO_SEND.test(tool)) return { decision: 'ask', reason: `Scope guard: ${tool} sends traffic and the target host is not in the call. Check it is a lab host or covered by an approval grant.` };
    return undefined;
  }
  if (call.scope.kind !== 'ok') {
    const why = call.scope.kind === 'bad' ? `the scope file is not usable (${call.scope.why})` : 'no scope.yaml was found for this hunt';
    if (race) return { decision: 'deny', reason: `Scope guard: Caido race_window_send is only for lab hosts, and ${why}.` };
    return { decision: 'ask', reason: `Scope guard: ${why}. ${tool} would reach ${targets.map((t) => t.host).join(', ')}.` };
  }

  const live = call.member ? [] : call.grants.filter((g) => grantLive(g, now));
  let deny: string | undefined;
  let ask: string | undefined;
  for (const t of targets) {
    const where = `${t.host}${t.path ?? ''}`;
    const c = classifyAll(scopes, t.host, t.path);
    if (c === 'lab') continue;
    if (race) deny ??= `Caido race_window_send to ${where} is refused: it bypasses the proxy, so it runs only against lab hosts.`;
    else if (c === 'out') deny ??= `${where} is out of scope in scope.yaml.`;
    else if (c === 'in-bad-path') deny ??= `${where} is outside the in-scope paths in scope.yaml.`;
    else if (c === 'in') {
      if (tool === 'WebFetch') deny ??= `${t.host} is a live in-scope target. WebFetch runs on the hub, outside the egress gateway; send it through the validator in the hunt container.`;
      else if (call.member) deny ??= `${t.host} is a live target. Security mode is lab-only for members in v1.`;
      else if (!live.some((g) => g.hosts.some((h) => hostMatches(h, t.host)))) ask ??= `${t.host} is in scope but no live approval grant covers it. Approve this call, or issue a grant (hosts, accounts, budget, rate, at most 24 h).`;
    } else if (tool !== 'WebFetch') ask ??= `${t.host} is not listed in scope.yaml. Approve only if it is not a target (docs, a package registry).`;
  }
  if (deny) return { decision: 'deny', reason: `Scope guard: ${deny}` };
  if (ask) return { decision: 'ask', reason: `Scope guard: ${ask}` };
  return undefined;
}
