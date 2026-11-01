/**
 * Views of the hub's stores that stay inside one account, for services
 * built per account (the assistant). A row of another account reads as one
 * that is not there.
 */
import type { KvRepo, TaskRepo } from '../storage/repos';
import type { RoutineService } from '../scheduler/types';
import { accountKey } from './store';

/** The kv store under an account's keys (the owner keeps the old keys). */
export function accountKv(kv: KvRepo, accountId: string): KvRepo {
  return {
    get: <T>(key: string, fallback: T) => kv.get<T>(accountKey(accountId, key), fallback),
    set: (key: string, value: unknown) => kv.set(accountKey(accountId, key), value),
    delete: (key: string) => kv.delete(accountKey(accountId, key)),
    keys: (prefix: string) => kv.keys(accountKey(accountId, prefix)).map((k) => k.slice(accountKey(accountId, '').length)),
  } as KvRepo;
}

/** An account's tasks. */
export function accountTasks(tasks: TaskRepo, accountId: string): TaskRepo {
  const own = <T extends { accountId?: string }>(t: T | undefined) => (t && (t.accountId ?? 'owner') === accountId ? t : undefined);
  return {
    get: (id: string) => own(tasks.get(id)),
    list: (f: Parameters<TaskRepo['list']>[0] = {}) => tasks.list({ ...f, accountId }),
    upsert: (t: Parameters<TaskRepo['upsert']>[0]) => tasks.upsert({ ...t, accountId }),
    delete: (id: string) => {
      if (own(tasks.get(id))) tasks.delete(id);
    },
  } as TaskRepo;
}

/** An account's routines: lists and new ones are its own, another account's id is not found. */
export function accountRoutines(routines: RoutineService, accountId: string): RoutineService {
  const own = (id: string) => {
    const r = routines.get(id);
    return r && (r.accountId ?? 'owner') === accountId ? r : undefined;
  };
  const must = (id: string) => {
    if (!own(id)) throw new Error(`Routine not found: ${id}`);
  };
  return {
    ...routines,
    list: () => routines.list(accountId),
    get: own,
    create: (input) => routines.create(input, accountId),
    update: (id, patch) => (must(id), routines.update(id, patch)),
    remove: (id) => (must(id), routines.remove(id)),
    runNow: (id, trigger, extra, opts) => (must(id), routines.runNow(id, trigger, extra, opts)),
    runs: (id, limit) => (own(id) ? routines.runs(id, limit) : []),
    preview: (s, tz, n) => routines.preview(s, tz, n),
    templates: () => routines.templates(),
    ...(routines.upgrade ? { upgrade: (id: string) => (must(id), routines.upgrade!(id)) } : {}),
  };
}
