/**
 * A member's view of the hub's config (docs/design/ACCOUNTS.md 2), for the
 * code that reads memory connections from config: the member's own
 * connections (kept in the kv table under the account's key), the member's
 * own secrets for ${secret:name}, and nothing from the environment, so a
 * header like ${env:ANTHROPIC_API_KEY} expands to nothing. Everything else
 * reads through to the hub's config, and only memory.connections can be
 * written.
 */
import type { ConfigStore } from '../config';
import type { ConclaveConfig } from '../config/schema';
import type { KvRepo } from '../storage/repos';
import type { AccountSecrets } from './secrets';
import { accountKey } from './store';

const CONNECTIONS_KEY = 'memory.connections';

type Connections = NonNullable<ConclaveConfig['memory']['connections']>;

export function accountConfigView(config: ConfigStore, opts: { accountId: string; kv: KvRepo; secrets: AccountSecrets }): ConfigStore {
  const key = accountKey(opts.accountId, CONNECTIONS_KEY);
  const listeners = new Set<() => void>();
  const read = (): Connections => opts.kv.get<Connections>(key, []);
  const write = (conns: Connections | undefined) => {
    opts.kv.set(key, conns ?? []);
    for (const l of listeners) l();
  };
  const valueOf = (name: string): string | undefined => opts.secrets.value(opts.accountId, name);
  // ${env:...} is the hub's environment, never a member's to read
  const expand = (value: string): string => value.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, '').replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (_, n) => valueOf(n) ?? '');
  const overrides: Partial<Record<keyof ConfigStore, unknown>> = {
    get: () => {
      const c = config.get();
      // no hub MCP server by name, and no legacy hub-wide external store
      return { ...c, mcpServers: {}, memory: { ...c.memory, external: undefined, connections: read() } };
    },
    getUser: () => ({ memory: { connections: read() } }),
    update: (patch: Partial<ConclaveConfig>) => {
      if (patch.memory && 'connections' in patch.memory) write(patch.memory.connections as Connections);
      return (overrides.get as () => ConclaveConfig)();
    },
    replace: (next: Partial<ConclaveConfig>) => {
      write(next.memory?.connections as Connections | undefined);
      return (overrides.get as () => ConclaveConfig)();
    },
    setSecret: (kind: 'providers' | 'values', k: string, v: string | undefined) => opts.secrets.set(opts.accountId, kind, k, v),
    secretValue: (name: string) => valueOf(name),
    secretNames: () => opts.secrets.names(opts.accountId),
    expand,
    expandRecord: (rec: Record<string, string> | undefined) => (rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expand(v)])) : rec),
    apiKey: (provider: string) => opts.secrets.providerKey(opts.accountId, provider),
    storedKey: (name: string) => opts.secrets.stored(opts.accountId, name),
    onChange: (fn: () => void) => {
      listeners.add(fn);
      const off = config.onChange(fn);
      return () => {
        listeners.delete(fn);
        off();
      };
    },
  };
  return new Proxy(config, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop as keyof ConfigStore];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
