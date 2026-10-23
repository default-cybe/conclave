/**
 * Config keys Conclave no longer reads. Old config files and backups may
 * still have them; ConfigStore drops them when it reads the file and on
 * every update, so they load without errors and leave the file on the next
 * write.
 *
 * notifications.ntfy and notifications.telegram: notifications now stay
 * inside Conclave (in-app, Web Push, the desktop app and the Android app).
 *
 * providers.zai pinned to the old Anthropic shim default: see migrateZaiWire.
 */

const RETIRED: Array<[section: string, key: string]> = [
  ['notifications', 'ntfy'],
  ['notifications', 'telegram'],
];

const SECRET_REF = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/;

/** True for a dotted path inside a retired key ("notifications.telegram.botToken"). */
export function isRetiredPath(path: string): boolean {
  return RETIRED.some(([section, key]) => path === `${section}.${key}` || path.startsWith(`${section}.${key}.`));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Remove retired keys from a user config or patch, in place. Returns the
 * dotted paths it removed and the named secrets that only those keys used
 * (Settings saved the Telegram bot token as ${secret:TELEGRAM_BOT_TOKEN}).
 */
export function dropRetiredKeys(config: Record<string, unknown>): { dropped: string[]; secrets: string[] } {
  const dropped: string[] = [];
  const refs = new Set<string>();
  for (const [section, key] of RETIRED) {
    const block = config[section];
    if (!isObject(block) || !(key in block)) continue;
    const value = block[key];
    if (isObject(value)) {
      for (const v of Object.values(value)) {
        const m = typeof v === 'string' ? SECRET_REF.exec(v.trim()) : null;
        if (m) refs.add(m[1]);
      }
    }
    delete block[key];
    dropped.push(`${section}.${key}`);
  }
  // a secret is only theirs when nothing else in the config points at it
  const rest = refs.size ? JSON.stringify(config) : '';
  const secrets = [...refs].filter((name) => !rest.includes(`\${secret:${name}}`));
  return { dropped, secrets };
}

/** The zai default before 0.4.21: Z.ai's Anthropic shim, which drops tools from long tool lists. */
const OLD_ZAI_BASE = 'https://api.z.ai/api/anthropic';
/** providers.zai.migrated once the entry is on (or was chosen after) the /api/coding/paas/v4 move. */
const ZAI_WIRE_MARK = 'paas-v4';

/**
 * providers.zai moved from the Anthropic shim to Chat Completions at
 * /api/coding/paas/v4. A file that pinned the old default URL drops it (and
 * type "anthropic") so the new default applies; any other /anthropic URL
 * without a type gets type "anthropic" pinned, so a custom shim keeps its
 * wire. Runs on load only (ConfigStore constructor) and records
 * `migrated: "paas-v4"` on the entry it moves; an entry with that mark is
 * never moved again, so an explicit change back survives restarts. Returns
 * true when it changed the config.
 */
export function migrateZaiWire(config: Record<string, unknown>): boolean {
  const providers = config.providers;
  if (!isObject(providers) || !isObject(providers.zai)) return false;
  const zai = providers.zai;
  if (zai.migrated === ZAI_WIRE_MARK) return false;
  // a ${env:...} or ${secret:...} placeholder: the real address is unknown here, so leave it
  if (typeof zai.baseUrl === 'string' && zai.baseUrl.includes('${')) return false;
  const url = typeof zai.baseUrl === 'string' ? zai.baseUrl.trim().replace(/\/+$/, '') : undefined;
  // type "anthropic" with no URL also meant the old default shim; on the new default URL it would break
  if (url === OLD_ZAI_BASE || (url === undefined && zai.type === 'anthropic')) {
    delete zai.baseUrl;
    if (zai.type === 'anthropic') delete zai.type;
    zai.migrated = ZAI_WIRE_MARK;
    return true;
  }
  if (url?.includes('/anthropic') && zai.type === undefined) {
    zai.type = 'anthropic';
    zai.migrated = ZAI_WIRE_MARK;
    return true;
  }
  return false;
}

/**
 * Marks a providers.zai entry changed after load (Settings, `conclave config
 * set`) as chosen on the new wire, so the next load does not move it.
 * `before` is the entry as JSON before the change.
 */
export function markZaiWire(config: Record<string, unknown>, before: string | undefined): void {
  const providers = config.providers;
  if (!isObject(providers) || !isObject(providers.zai) || JSON.stringify(providers.zai) === before) return;
  providers.zai.migrated ??= ZAI_WIRE_MARK;
}
