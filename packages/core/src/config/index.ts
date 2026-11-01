import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG, type ConclaveConfig, type ProviderConfig } from './schema';
import { paths, ensureDirs, type Paths } from './paths';
import { dropRetiredKeys, markZaiWire, migrateZaiWire } from './retired';

export * from './schema';
export * from './paths';

export interface Secrets {
  /** Provider id -> API key. */
  providers: Record<string, string>;
  /** Arbitrary named secrets referenced as ${secret:name} in config strings. */
  values: Record<string, string>;
}

/** Strip // and /* *\/ comments and trailing commas so config files can be JSONC. */
export function parseJsonc<T = unknown>(text: string): T {
  let out = '';
  let inStr = false;
  let quote = '';
  // commas outside strings, so a value like "a, ]" keeps its comma
  const commas: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === ',') commas.push(out.length);
    out += c;
  }
  for (const at of commas.reverse()) {
    let j = at + 1;
    while (/\s/.test(out[j] ?? '')) j++;
    if (out[j] === '}' || out[j] === ']') out = out.slice(0, at) + out.slice(at + 1);
  }
  return JSON.parse(out) as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge, arrays and scalars from `b` replace `a`. */
export function deepMerge<T>(a: T, b: unknown): T {
  if (!isPlainObject(a) || !isPlainObject(b)) return (b === undefined ? a : (b as T));
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseJsonc<T>(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

function writePrivate(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

/**
 * Holds the merged config. User file values win over defaults. The file only
 * stores what the user changed, so new defaults reach existing installs.
 */
export class ConfigStore {
  readonly paths: Paths;
  private userConfig: Partial<ConclaveConfig> = {};
  private merged: ConclaveConfig;
  private secrets: Secrets = { providers: {}, values: {} };
  private listeners = new Set<() => void>();
  private overrides?: Partial<ConclaveConfig>;
  /** Values the running hub sets for itself (the remote access address, the CLIProxyAPI provider), one layer per part of the hub. Never written to disk. */
  private runtime = new Map<string, Partial<ConclaveConfig>>();

  constructor(home?: string, overrides?: Partial<ConclaveConfig>) {
    this.paths = paths(home);
    ensureDirs(this.paths);
    this.overrides = overrides;
    this.userConfig = readJsonFile<Partial<ConclaveConfig>>(this.paths.config) ?? {};
    this.secrets = deepMerge({ providers: {}, values: {} }, readJsonFile<Secrets>(this.paths.secrets) ?? {});
    // the zai move runs on load only, so a later explicit `config set` back to the Anthropic shim stays
    const migrated = migrateZaiWire(this.userConfig as Record<string, unknown>);
    if (this.dropRetired() || migrated) writePrivate(this.paths.config, this.userConfig);
    this.merged = this.compute();
    if (!this.merged.server.token) {
      const token = randomBytes(24).toString('base64url');
      // only the token: writing host and port here would pin them and hide later defaults
      this.update({ server: { token } } as Partial<ConclaveConfig>);
    }
  }

  private compute(): ConclaveConfig {
    let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), this.userConfig);
    if (this.overrides) cfg = deepMerge(cfg, this.overrides);
    for (const layer of this.runtime.values()) cfg = deepMerge(cfg, layer);
    if (process.env.CONCLAVE_PORT) cfg.server.port = Number(process.env.CONCLAVE_PORT);
    if (process.env.CONCLAVE_HOST) cfg.server.host = process.env.CONCLAVE_HOST;
    if (process.env.CONCLAVE_TOKEN) cfg.server.token = process.env.CONCLAVE_TOKEN;
    if (process.env.CONCLAVE_MODEL) cfg.defaultModel = process.env.CONCLAVE_MODEL;
    return cfg;
  }

  get(): ConclaveConfig {
    return this.merged;
  }

  /** Raw user-edited config (what is on disk). */
  getUser(): Partial<ConclaveConfig> {
    return this.userConfig;
  }

  update(patch: Partial<ConclaveConfig>): ConclaveConfig {
    const zai = JSON.stringify(this.userConfig.providers?.zai);
    this.userConfig = deepMerge(this.userConfig, patch);
    this.dropRetired();
    markZaiWire(this.userConfig as Record<string, unknown>, zai);
    writePrivate(this.paths.config, this.userConfig);
    this.merged = this.compute();
    for (const fn of this.listeners) fn();
    return this.merged;
  }

  /** Replace the user config entirely (used by the settings editor). */
  replace(next: Partial<ConclaveConfig>): ConclaveConfig {
    const zai = JSON.stringify(this.userConfig.providers?.zai);
    this.userConfig = next;
    this.dropRetired();
    markZaiWire(this.userConfig as Record<string, unknown>, zai);
    writePrivate(this.paths.config, this.userConfig);
    this.merged = this.compute();
    for (const fn of this.listeners) fn();
    return this.merged;
  }

  /**
   * Replace one runtime layer: values the hub works out while it runs, such
   * as server.publicUrl from the remote access tunnel ("remote", the default)
   * or the CLIProxyAPI provider entry ("cliproxy"). get() sees every layer on
   * top of the user config; getUser() and the file never do.
   */
  setRuntime(next: Partial<ConclaveConfig>, layer = 'remote'): void {
    if (JSON.stringify(next) === JSON.stringify(this.runtime.get(layer) ?? {})) return;
    if (Object.keys(next).length) this.runtime.set(layer, structuredClone(next));
    else this.runtime.delete(layer);
    this.merged = this.compute();
    for (const fn of this.listeners) fn();
  }

  /** Drop config keys Conclave no longer reads (config/retired.ts) and the named secrets only they used. */
  private dropRetired(): boolean {
    const { dropped, secrets } = dropRetiredKeys(this.userConfig as Record<string, unknown>);
    for (const name of secrets) delete this.secrets.values[name];
    if (secrets.length) writePrivate(this.paths.secrets, this.secrets);
    return dropped.length > 0;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setSecret(kind: 'providers' | 'values', key: string, value: string | undefined): void {
    if (value === undefined || value === '') delete this.secrets[kind][key];
    else this.secrets[kind][key] = value;
    writePrivate(this.paths.secrets, this.secrets);
    for (const fn of this.listeners) fn();
  }

  hasProviderKey(id: string): boolean {
    return !!this.apiKey(id);
  }

  /** Resolve a provider API key: literal, secrets store, then env var. */
  apiKey(providerId: string): string | undefined {
    const p: ProviderConfig | undefined = this.merged.providers[providerId];
    if (!p) return undefined;
    if (p.apiKey) return this.expand(p.apiKey);
    if (this.secrets.providers[providerId]) return this.secrets.providers[providerId];
    if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv];
    return undefined;
  }

  /** A key saved with `conclave secret <name>` that belongs to no model provider (google-maps). */
  storedKey(name: string): string | undefined {
    return this.secrets.providers[name] || undefined;
  }

  /** Expand ${env:NAME} and ${secret:name} placeholders. */
  expand(value: string): string {
    return value
      .replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] ?? '')
      .replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (_, n) => this.secrets.values[n] ?? '');
  }

  expandRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!rec) return rec;
    return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, this.expand(v)]));
  }

  /** One named secret (secrets.json values), for hub code that uses it itself. */
  secretValue(name: string): string | undefined {
    return this.secrets.values[name] || undefined;
  }

  secretNames(): { providers: string[]; values: string[] } {
    return { providers: Object.keys(this.secrets.providers), values: Object.keys(this.secrets.values) };
  }
}
