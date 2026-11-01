/**
 * Claude Code, Codex, Gemini CLI and OpenCode as engines are off by default
 * (v0.4.2). Conclave runs its own agent loop, and a CLI found on a machine
 * used to show up as models next to the real ones. Off, a harness is not in
 * the model pickers, is never picked as a default or a tier, and a session
 * on it is refused with words that say where to turn it on. Importing its
 * old chats does not need it.
 *
 * A hub from before keeps a harness on once, on upgrade, when the owner set
 * it by hand (its entry in config.json says enabled) or a session ran on it
 * in the last 30 days; the others take the new default. A kv row records
 * that the step ran, so a harness turned off later stays off.
 */
import type { ConfigStore } from '../config';
import type { ConclaveConfig, ProviderConfig } from '../config/schema';
import type { Db } from '../storage/db';
import type { KvRepo } from '../storage/repos';

/** The harnesses Conclave ships an entry for. */
export const BUILTIN_HARNESSES = ['claude-code', 'codex', 'gemini-cli', 'opencode'] as const;

export const HARNESSES_OFF_KEY = 'migrations.harnessesOff';

const RECENT_MS = 30 * 86_400_000;

/**
 * Run the upgrade step once. Returns the harnesses it kept on, or undefined
 * when it ran before.
 */
export function harnessesOffOnce(deps: { config: ConfigStore; db: Db; kv: KvRepo; now?: number }): string[] | undefined {
  if (deps.kv.get<unknown>(HARNESSES_OFF_KEY, null) !== null) return undefined;
  const now = deps.now ?? Date.now();
  const own = (deps.config.getUser().providers ?? {}) as Record<string, Partial<ProviderConfig> | undefined>;
  const kept: string[] = [];
  for (const id of BUILTIN_HARNESSES) {
    // set by hand, on or off: the owner's word stands
    if (typeof own[id]?.enabled === 'boolean') continue;
    if (usedSince(deps.db, id, now - RECENT_MS)) kept.push(id);
  }
  if (kept.length) deps.config.update({ providers: Object.fromEntries(kept.map((id) => [id, { enabled: true }])) } as Partial<ConclaveConfig>);
  deps.kv.set(HARNESSES_OFF_KEY, { at: now, kept });
  return kept;
}

/** A turn ran on the harness since then, or it recorded usage for a session (imported chats did neither). */
function usedSince(db: Db, id: string, since: number): boolean {
  if (db.query("SELECT 1 FROM turns WHERE started_at >= ? AND model LIKE ? ESCAPE '\\' LIMIT 1").get(since, `${id.replace(/[%_\\]/g, '\\$&')}/%`)) return true;
  return !!db.query('SELECT 1 FROM usage WHERE ts >= ? AND provider = ? AND session_id IS NOT NULL LIMIT 1').get(since, id);
}

/** What a session on a harness that is off is told. Undefined when the provider is no harness or is on. */
export function harnessOffWords(id: string, cfg: Pick<ProviderConfig, 'type' | 'name' | 'enabled'> | undefined): string | undefined {
  if (!cfg || cfg.type !== 'acp' || cfg.enabled !== false) return undefined;
  return `${cfg.name ?? id} is off as an engine. Turn it on in Settings, Providers, or pick another model for this session.`;
}
