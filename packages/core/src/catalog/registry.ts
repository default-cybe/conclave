/**
 * Official MCP registry (registry.modelcontextprotocol.io): search, one
 * server, the daily sync, the trust rule and the server.json to
 * McpServerConfig derivation (docs/design/ECOSYSTEM.md 1.3 and 1.5).
 *
 * Derivation is wrong often enough (subcommands in runtimeArguments, package
 * and executable names that differ) that the preview always shows the exact
 * config and runs a test connect before anything is saved.
 */
import type { McpServerConfig } from '../config/schema';
import type { CatalogHttp } from './http';
import type { CatalogInput, CatalogItem, McpInstall } from './recommended';
import { guessCategory } from './github';

export const REGISTRY = 'https://registry.modelcontextprotocol.io';
const TTL = 6 * 3_600_000;

interface Argument {
  type?: 'positional' | 'named';
  name?: string;
  value?: string;
  valueHint?: string;
  default?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  isRepeated?: boolean;
  variables?: Record<string, Variable>;
}

interface Variable {
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  format?: string;
  choices?: string[];
}

interface EnvVar extends Variable {
  name: string;
  value?: string;
  variables?: Record<string, Variable>;
}

export interface RegistryPackage {
  registryType: 'npm' | 'pypi' | 'oci' | 'nuget' | 'mcpb' | string;
  registryBaseUrl?: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string; url?: string; headers?: EnvVar[] };
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
  environmentVariables?: EnvVar[];
}

export interface RegistryRemote {
  type: 'streamable-http' | 'sse' | string;
  url: string;
  headers?: EnvVar[];
  variables?: Record<string, Variable>;
}

export interface ServerJson {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  websiteUrl?: string;
  packages?: RegistryPackage[] | null;
  remotes?: RegistryRemote[] | null;
}

export interface RegistryEntry {
  server: ServerJson;
  _meta?: Record<string, { status?: string; updatedAt?: string; publishedAt?: string; isLatest?: boolean }>;
}

/** owner/repo from a repository URL on GitHub, or undefined. */
export function repoFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** True when the io.github.<owner>/ namespace names the repo's owner (ignoring case). */
export function namespaceMatches(name: string, repoUrl?: string): boolean {
  const repo = repoFromUrl(repoUrl);
  const m = /^io\.github\.([^/]+)\//i.exec(name);
  if (!repo || !m) return false;
  return m[1].toLowerCase() === repo.split('/')[0].toLowerCase();
}

function slug(name: string): string {
  const last = name.split('/').pop() ?? name;
  return last.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'server';
}

/** Secret key for an input: "<server>.<name>" in lower case. */
function secretKey(server: string, name: string): string {
  return `${server}.${name}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
}

class Inputs {
  list: CatalogInput[] = [];
  constructor(private server: string) {}
  add(name: string, v: Variable, label?: string): string {
    const key = name.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
    if (!this.list.some((i) => i.name === key)) {
      this.list.push({
        name: key,
        label: label ?? name,
        description: v.description ?? '',
        required: v.isRequired === true,
        secret: v.isSecret === true,
        secretKey: v.isSecret ? secretKey(this.server, key) : undefined,
        default: v.default,
        example: v.choices?.join(', '),
      });
    }
    return `{{${key}}}`;
  }
}

/** Replace {var} in a value with input placeholders, or defaults for vars nobody must fill. */
function expandVars(value: string, vars: Record<string, Variable> | undefined, inputs: Inputs): string {
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, v: string) => {
    const spec = vars?.[v];
    if (!spec) return whole;
    if (!spec.isRequired && !spec.isSecret && spec.default !== undefined) return spec.default;
    return inputs.add(v, spec);
  });
}

function argList(args: Argument[] | undefined, inputs: Inputs, warn: string[]): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    const raw = a.value ?? a.default;
    let val: string | undefined;
    if (raw !== undefined) val = expandVars(raw, a.variables, inputs);
    else if (a.isRequired || a.isSecret) val = inputs.add(a.name?.replace(/^-+/, '') ?? 'ARG', a, a.name);
    if (a.type === 'named' && a.name) {
      if (val === undefined) continue;
      out.push(a.name, val);
    } else if (val !== undefined) out.push(val);
  }
  return out;
}

function envFrom(vars: EnvVar[] | undefined, inputs: Inputs): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const v of vars ?? []) {
    if (v.value !== undefined) {
      env[v.name] = expandVars(v.value, v.variables, inputs);
      continue;
    }
    // vars with only defaults are left out; required and secret ones become inputs
    if (!v.isRequired && !v.isSecret) continue;
    env[v.name] = inputs.add(v.name, v);
  }
  return Object.keys(env).length ? env : undefined;
}

/** One package as a stdio config, or undefined for types Conclave cannot run (mcpb). */
function packageConfig(pkg: RegistryPackage, inputs: Inputs, warn: string[]): { config: McpServerConfig; label: string } | undefined {
  const pkgArgs = argList(pkg.packageArguments, inputs, warn);
  const env = envFrom(pkg.environmentVariables, inputs);
  const transport = pkg.transport?.type ?? 'stdio';
  if (transport === 'streamable-http' || transport === 'sse') {
    warn.push(`${pkg.identifier} runs as a local ${transport} server. Start it yourself, then add its URL.`);
    return undefined;
  }
  // registry entries often put the subcommand in runtimeArguments; positionals and what follows them go after the package
  const rt = pkg.runtimeArguments ?? [];
  const firstPos = rt.findIndex((a) => a.type === 'positional');
  const flags = argList(firstPos < 0 ? rt : rt.slice(0, firstPos), inputs, warn);
  const moved = firstPos < 0 ? [] : argList(rt.slice(firstPos), inputs, warn);
  const ver = pkg.version;
  switch (pkg.registryType) {
    case 'npm': {
      if (moved.length) warn.push('The registry entry lists arguments for npx that read like server arguments. They were moved after the package.');
      return { label: 'npx on the hub', config: { command: 'npx', args: ['-y', ...flags, ver ? `${pkg.identifier}@${ver}` : pkg.identifier, ...moved, ...pkgArgs], ...(env ? { env } : {}) } };
    }
    case 'pypi': {
      let tail = moved;
      // "uvx basic-memory mcp": the first positional repeats the package or names its executable
      if (tail[0] === pkg.identifier) tail = tail.slice(1);
      if (moved.length) warn.push('The registry entry puts server arguments in runtimeArguments. They were moved after the package; check the command.');
      const spec = ver ? `${pkg.identifier}==${ver}` : pkg.identifier;
      return { label: 'uvx on the hub', config: { command: 'uvx', args: [...flags, spec, ...tail, ...pkgArgs], ...(env ? { env } : {}) } };
    }
    case 'oci': {
      // "-e NAME={token}" hides a secret in args; pass it as "-e NAME" and put the value in env
      const dockerEnv: Record<string, string> = { ...(env ?? {}) };
      const runArgs = [...flags, ...moved];
      for (let i = 0; i < runArgs.length - 1; i++) {
        const m = runArgs[i] === '-e' ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*\{\{.*)$/.exec(runArgs[i + 1]) : null;
        if (!m) continue;
        runArgs[i + 1] = m[1];
        dockerEnv[m[1]] = m[2];
      }
      const envFlags = Object.keys(env ?? {}).flatMap((k) => ['-e', k]);
      const hasEnv = Object.keys(dockerEnv).length > 0;
      return { label: 'Docker on the hub', config: { command: 'docker', args: ['run', '-i', '--rm', ...envFlags, ...runArgs, pkg.identifier, ...pkgArgs], ...(hasEnv ? { env: dockerEnv } : {}) } };
    }
    case 'nuget':
      return { label: 'dnx on the hub', config: { command: 'dnx', args: [ver ? `${pkg.identifier}@${ver}` : pkg.identifier, '--yes', '--', ...pkgArgs], ...(env ? { env } : {}) } };
    default:
      return undefined;
  }
}

function remoteConfig(r: RegistryRemote, inputs: Inputs): McpServerConfig {
  const headers: Record<string, string> = {};
  for (const h of r.headers ?? []) {
    if (h.value !== undefined) headers[h.name] = expandVars(h.value, h.variables, inputs);
    else if (h.isSecret || h.isRequired) {
      const ph = inputs.add(h.name === 'Authorization' ? 'TOKEN' : h.name, { ...h, isRequired: h.isRequired ?? true }, h.name === 'Authorization' ? 'Token' : h.name);
      headers[h.name] = h.name === 'Authorization' ? `Bearer ${ph}` : ph;
    }
  }
  const url = expandVars(r.url, r.variables, inputs);
  return { type: r.type === 'sse' ? 'sse' : 'http', url, ...(Object.keys(headers).length ? { headers } : {}) };
}

export interface Derived {
  install: McpInstall;
  variants: McpInstall[];
  inputs: CatalogInput[];
  warnings: string[];
  needs: Array<{ bin: string; where: 'hub'; why: string }>;
}

/** Turn a server.json into install specs: remotes first (nothing to run on the hub), then packages. */
export function deriveFromServerJson(s: ServerJson, serverName?: string): Derived | undefined {
  const server = serverName ?? slug(s.name);
  const inputs = new Inputs(server);
  const warnings: string[] = [];
  const specs: McpInstall[] = [];
  const needs: Derived['needs'] = [];
  for (const r of s.remotes ?? []) {
    if (!r?.url) continue;
    let host: string;
    try {
      host = new URL(r.url.replace(/\{[^}]+\}/g, 'x')).host;
    } catch {
      continue; // not a URL Conclave can call
    }
    specs.push({ type: 'mcp', server, label: `Remote, ${host}`, config: remoteConfig(r, inputs) });
  }
  for (const p of s.packages ?? []) {
    const c = packageConfig(p, inputs, warnings);
    if (!c) continue;
    specs.push({ type: 'mcp', server, label: c.label, config: c.config });
    const bin = c.config.command!;
    if (!needs.some((n) => n.bin === bin)) needs.push({ bin, where: 'hub', why: `Conclave starts stdio servers on the hub, and this one runs through ${bin}.` });
  }
  if (!specs.length) return undefined;
  return { install: specs[0], variants: specs.slice(1), inputs: inputs.list, warnings, needs };
}

/** A registry entry as a catalog item. verified stays false until the preview checks the ownership marker. */
export function registryToItem(e: RegistryEntry, at: number): CatalogItem | undefined {
  try {
    return toItem(e, at);
  } catch {
    // one malformed entry must not stop a sync
    return undefined;
  }
}

function toItem(e: RegistryEntry, _at: number): CatalogItem | undefined {
  const s = e.server;
  const d = deriveFromServerJson(s);
  if (!d) return undefined;
  const repo = repoFromUrl(s.repository?.url);
  const meta = e._meta?.['io.modelcontextprotocol.registry/official'];
  const github = /^io\.github\./i.test(s.name);
  // io.github names must match the repo owner; other names are domains the registry checked itself
  const matches = !github || namespaceMatches(s.name, s.repository?.url);
  const warnings = [...d.warnings];
  if (!matches) warnings.unshift(`The registry name ${s.name} does not match the repository owner. It may be a copy of another project.`);
  return {
    id: `reg:${s.name}`,
    kind: 'mcp',
    name: s.title || slug(s.name),
    repo,
    url: s.websiteUrl ?? s.repository?.url,
    description: s.description ?? '',
    category: guessCategory(`${s.name} ${s.description ?? ''}`),
    tags: ['mcp registry', ...(s.version ? [`v${s.version}`] : [])],
    updatedAt: meta?.updatedAt?.slice(0, 10),
    install: d.install,
    variants: d.variants.length ? d.variants : undefined,
    inputs: d.inputs.length ? d.inputs : undefined,
    touches: d.install.config.command ? ['hub-code', 'network'] : ['network'],
    needs: d.needs.length ? d.needs : undefined,
    recommended: false,
    source: 'mcp-registry',
    verified: false,
    warnings: warnings.length ? warnings : undefined,
    risk: matches ? undefined : 'Not verified: the registry namespace does not match the repository owner.',
  };
}

export class McpRegistry {
  constructor(
    private http: CatalogHttp,
    readonly base = REGISTRY,
  ) {}

  async search(q: string, limit = 30): Promise<{ entries: RegistryEntry[]; fromCache: boolean; error?: string }> {
    const params = new URLSearchParams({ search: q, version: 'latest', limit: String(limit) });
    const { data, res } = await this.http.json<{ servers?: RegistryEntry[] }>(`${this.base}/v0.1/servers?${params}`, { ttlMs: TTL });
    return { entries: (data?.servers ?? []).filter((e) => e?.server?.name), fromCache: res.fromCache, error: res.error };
  }

  async get(name: string): Promise<RegistryEntry | undefined> {
    const { data } = await this.http.json<RegistryEntry>(`${this.base}/v0.1/servers/${encodeURIComponent(name)}/versions/latest`, { ttlMs: TTL });
    return data?.server?.name ? data : undefined;
  }

  /** Every server changed since `since` (ISO), following cursors. Capped so one sync stays small. */
  async changedSince(since?: string, maxPages = 20): Promise<RegistryEntry[]> {
    const out: RegistryEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ version: 'latest', limit: '100' });
      if (since) params.set('updated_since', since);
      if (cursor) params.set('cursor', cursor);
      const { data } = await this.http.json<{ servers?: RegistryEntry[]; metadata?: { nextCursor?: string } }>(`${this.base}/v0.1/servers?${params}`, { ttlMs: TTL });
      out.push(...(data?.servers ?? []).filter((e) => e?.server?.name));
      cursor = data?.metadata?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * The registry's ownership marker for a package: mcpName in the npm
   * package.json, or an "mcp-name: <name>" line in the PyPI description.
   * null when it cannot be checked (OCI labels, nuget, network).
   */
  async ownershipMarker(pkg: RegistryPackage, name: string): Promise<boolean | null> {
    try {
      if (pkg.registryType === 'npm') {
        const url = `https://registry.npmjs.org/${pkg.identifier.replace('/', '%2F')}/${pkg.version ?? 'latest'}`;
        const { data } = await this.http.json<{ mcpName?: string }>(url, { ttlMs: Infinity, maxBytes: 5_000_000 });
        if (!data) return null;
        return data.mcpName === name;
      }
      if (pkg.registryType === 'pypi') {
        const url = `https://pypi.org/pypi/${pkg.identifier}/${pkg.version ? `${pkg.version}/` : ''}json`;
        const { data } = await this.http.json<{ info?: { description?: string } }>(url, { ttlMs: Infinity, maxBytes: 10_000_000 });
        if (!data) return null;
        return new RegExp(`mcp-name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(data.info?.description ?? '');
      }
    } catch {
      return null;
    }
    return null;
  }
}
