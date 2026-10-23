/**
 * Config keys Conclave no longer reads. Old config files and backups may
 * still have them; ConfigStore drops them when it reads the file and on
 * every update, so they load without errors and leave the file on the next
 * write.
 *
 * notifications.ntfy and notifications.telegram: notifications now stay
 * inside Conclave (in-app, Web Push, the desktop app and the Android app).
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
