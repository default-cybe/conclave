/**
 * A member's own keys (docs/design/ACCOUNTS.md 2 and 6): provider API keys
 * and named values such as the GitHub token, in
 * <home>/accounts/<id>/secrets.json at mode 0600, like the hub's own
 * secrets.json. The owner's keys are the hub's (ConfigStore), so this store
 * hands owner calls to it. Tools never read these files (machine/private.ts).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigStore } from '../config';
import { markHubHome, markHubPrivate } from '../machine/private';
import { OWNER_ID } from './context';

interface Secrets {
  providers: Record<string, string>;
  values: Record<string, string>;
  /** Keys the hub keeps for the account's own CLIProxyAPI (server/src/cliproxy/member.ts). ${secret:name} in the account's own config never reads them. */
  hub: Record<string, string>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class AccountSecrets {
  private cache = new Map<string, Secrets>();
  private listeners = new Set<(accountId: string) => void>();
  readonly dir: string;

  constructor(private readonly config: ConfigStore) {
    this.dir = join(config.paths.home, 'accounts');
    markHubPrivate(this.dir);
    // each account's own secrets file and CLIProxyAPI, for every session (machine/private.ts)
    markHubHome(config.paths.home);
  }

  private file(accountId: string): string {
    if (!SAFE_ID.test(accountId)) throw new Error('bad account id');
    return join(this.dir, accountId, 'secrets.json');
  }

  private read(accountId: string): Secrets {
    const hit = this.cache.get(accountId);
    if (hit) return hit;
    let data: Secrets = { providers: {}, values: {}, hub: {} };
    const f = this.file(accountId);
    if (existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<Secrets>;
        data = { providers: { ...(raw.providers ?? {}) }, values: { ...(raw.values ?? {}) }, hub: { ...(raw.hub ?? {}) } };
      } catch {
        /* a broken file reads as empty; the next write replaces it */
      }
    }
    this.cache.set(accountId, data);
    return data;
  }

  private write(accountId: string, data: Secrets): void {
    const f = this.file(accountId);
    mkdirSync(join(this.dir, accountId), { recursive: true, mode: 0o700 });
    writeFileSync(f, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(f, 0o600);
    } catch {
      /* windows */
    }
    this.cache.set(accountId, data);
    for (const l of this.listeners) l(accountId);
  }

  /** Called with the account id after its keys changed. */
  onChange(fn: (accountId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The account's own key for a provider. The owner's is the hub's. */
  providerKey(accountId: string, provider: string): string | undefined {
    if (accountId === OWNER_ID) return this.config.apiKey(provider);
    return this.read(accountId).providers[provider] || undefined;
  }

  /** A named value of the account's own (the GitHub token is "github" in providers, as on the hub). */
  stored(accountId: string, name: string): string | undefined {
    if (accountId === OWNER_ID) return this.config.storedKey(name);
    return this.read(accountId).providers[name] || undefined;
  }

  /** A named value (secrets.json values) of the account's own, for ${secret:name}. */
  value(accountId: string, name: string): string | undefined {
    if (accountId === OWNER_ID) return this.config.secretValue(name);
    return this.read(accountId).values[name] || undefined;
  }

  set(accountId: string, kind: 'providers' | 'values', key: string, value: string | undefined): void {
    if (accountId === OWNER_ID) {
      this.config.setSecret(kind, key, value);
      for (const l of this.listeners) l(accountId);
      return;
    }
    const cur = this.read(accountId);
    const next: Secrets = { providers: { ...cur.providers }, values: { ...cur.values }, hub: { ...cur.hub } };
    if (value === undefined || value === '') delete next[kind][key];
    else next[kind][key] = value;
    this.write(accountId, next);
  }

  /** A key the hub keeps for a member's own CLIProxyAPI. The owner's are the hub's own secrets. */
  hubValue(accountId: string, name: string): string | undefined {
    if (accountId === OWNER_ID) return undefined;
    return this.read(accountId).hub[name] || undefined;
  }

  hubNames(accountId: string): string[] {
    return accountId === OWNER_ID ? [] : Object.keys(this.read(accountId).hub);
  }

  /** Save or drop (undefined) such a key. */
  setHubValue(accountId: string, name: string, value: string | undefined): void {
    if (accountId === OWNER_ID) return;
    const cur = this.read(accountId);
    if (!value && !cur.hub[name]) return;
    const next: Secrets = { providers: { ...cur.providers }, values: { ...cur.values }, hub: { ...cur.hub } };
    if (value) next.hub[name] = value;
    else delete next.hub[name];
    this.write(accountId, next);
  }

  names(accountId: string): { providers: string[]; values: string[] } {
    if (accountId === OWNER_ID) return this.config.secretNames();
    const s = this.read(accountId);
    return { providers: Object.keys(s.providers), values: Object.keys(s.values) };
  }

  /** Forget a removed member's keys. */
  remove(accountId: string): void {
    if (accountId === OWNER_ID) return;
    this.cache.delete(accountId);
    try {
      rmSync(join(this.dir, accountId), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
