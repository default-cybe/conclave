/**
 * Which accounts service belongs to which engine. The engine makes one in
 * create.ts; a server over another EngineApi (tests) makes one on first use.
 */
import type { ConfigStore } from '../config';
import type { Repos } from '../storage/repos';
import type { EventBus } from '../util/bus';
import { AccountsService, type AccountsDeps } from './service';

const attached = new WeakMap<object, AccountsService>();

export function setAccounts(engine: object, svc: AccountsService): void {
  attached.set(engine, svc);
}

/** The accounts service of an engine, when it has one. */
export function accountsOf(engine: object): AccountsService | undefined {
  return attached.get(engine);
}

/** The engine's accounts service, made now if it has none. */
export function ensureAccounts(engine: { config: ConfigStore; repos: Repos; bus: EventBus }, extra: Partial<AccountsDeps> = {}): AccountsService {
  let svc = attached.get(engine);
  if (!svc) {
    svc = new AccountsService({ config: engine.config, repos: engine.repos, bus: engine.bus, ...extra });
    attached.set(engine, svc);
  }
  return svc;
}
