/**
 * One egress gateway (security/gateway.ts) per hunt: the topmost scope-guard
 * session of a chain (session/scope-guard.ts guardAnchor). Its shell, its Task
 * children (sec-validator) and the workflow lib.exec calls it starts get the
 * gateway as HTTP(S)_PROXY. Grants come from kv GRANTS_KV under the hunt's
 * id, and each request the gateway lets through counts on its grant.
 *
 * In-process in the hub (v1). The design's per-hunt container on Madx would
 * make the proxy the only way out; that needs Docker networks per hunt and a
 * device per container, so v1 runs the proxy here and states the gap: a
 * program that ignores the proxy variables is still stopped only by the
 * scope guard's command check.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Session } from '../types';
import { EgressGateway } from '../security/gateway';
import { countUse, grantsOf, type GrantKv } from '../security/grants';
import { classify, type ScopeState } from '../security/scope';
import { guardAnchor, loadScope, type ScopeGuardHost } from './scope-guard';

export interface EgressHost extends ScopeGuardHost {
  repos: { kv: GrantKv };
}

const gateways = new WeakMap<object, Map<string, Promise<EgressGateway>>>();
// lab tools (a fuzzer on the lab stack) send many requests: the scope files are read at most this often
const SCOPE_TTL_MS = 2_000;

/** The folder egress.log goes to: findings/<t>-hunt, where t is the target folder of the scope file that lists the host, else its program. */
export function egressLogPath(cwd: string, st: ScopeState, host: string): string {
  let t = 'hunt';
  if (st.kind === 'ok') {
    const i = Math.max(0, st.scopes.findIndex((s) => classify(s, host) !== 'unknown'));
    const m = /[/\\]targets[/\\]([^/\\]+)[/\\]scope\.ya?ml$/.exec(st.files[i] ?? '');
    t = m?.[1] ?? st.scopes[i]?.program ?? t;
  }
  return join(cwd, 'findings', `${t.replace(/[^\w.-]+/g, '-')}-hunt`, 'egress.log');
}

function startFor(host: EgressHost, anchor: Session): Promise<EgressGateway> {
  let cached: { at: number; st: Promise<ScopeState> } | undefined;
  const scope = () => {
    if (!cached || Date.now() - cached.at > SCOPE_TTL_MS) cached = { at: Date.now(), st: loadScope(host.machineFor(anchor), anchor.cwd) };
    return cached.st;
  };
  let chain: Promise<unknown> = Promise.resolve();
  const gw = new EgressGateway({
    scope,
    grants: () => grantsOf(host.repos.kv, anchor.id),
    count: (id) => void countUse(host.repos.kv, anchor.id, id),
    log: (line, h) => {
      // in order, one after another; a failed write never stops the hunt
      chain = chain
        .then(async () => {
          const path = egressLogPath(anchor.cwd, await scope(), h);
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, `${line}\n`);
        })
        .catch(() => {});
    },
  });
  return gw.start().then(() => gw);
}

/**
 * The proxy variables for a call of this session on this device, or undefined
 * when the session is not in a hunt. Throws when the gateway cannot start, so
 * the caller fails closed.
 */
export async function egressEnv(host: EgressHost, session: Session, device = session.device): Promise<Record<string, string> | undefined> {
  const anchor = guardAnchor(host, session);
  if (!anchor) return undefined;
  // shortcut: the gateway listens on the hub's loopback, so only calls on the hub's own device use it; a paired device keeps the scope guard only. Upgrade with the per-hunt Madx container (design 4.2).
  if ((device && device !== 'local') || (anchor.device && anchor.device !== 'local') || host.isMemberSession(session)) return undefined;
  let byHunt = gateways.get(host);
  if (!byHunt) gateways.set(host, (byHunt = new Map()));
  let gw = byHunt.get(anchor.id);
  if (!gw) {
    gw = startFor(host, anchor);
    byHunt.set(anchor.id, gw);
    gw.catch(() => byHunt.delete(anchor.id));
  }
  const url = (await gw).url;
  return { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: '', no_proxy: '' };
}

/** Stop every gateway of a hub (shutdown, tests). */
export async function stopEgress(host: object): Promise<void> {
  const byHunt = gateways.get(host);
  gateways.delete(host);
  for (const gw of byHunt?.values() ?? []) (await gw.catch(() => undefined))?.stop();
}
