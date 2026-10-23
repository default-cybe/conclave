/**
 * What the hub's own CLIProxyAPI runs with: a config file the hub writes on
 * every start (so a stray ~/.cli-proxy-api config never applies), and an
 * environment with nothing of the hub's in it.
 *
 * It listens on 127.0.0.1 only, its management API refuses anything that is
 * not local (allow-remote false), the management key is stored as its
 * bcrypt hash, the control panel download and LAN discovery are off, and
 * plugins, request logs and usage statistics stay off.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CliproxyFiles {
  /** <home>/cliproxy, mode 0700. */
  dir: string;
  config: string;
  /** Signed in accounts (OAuth tokens), mode 0700. */
  auth: string;
  pids: string;
}

export function cliproxyFiles(home: string): CliproxyFiles {
  const dir = join(home, 'cliproxy');
  return { dir, config: join(dir, 'config.yaml'), auth: join(dir, 'auth'), pids: join(dir, 'pids') };
}

/** Make the folders and set them to 0700, also when they were there before with looser modes. */
export function ensurePrivateDirs(files: CliproxyFiles): void {
  for (const d of [files.dir, files.auth]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      chmodSync(d, 0o700);
    } catch {
      /* windows */
    }
  }
}

/** A YAML double-quoted scalar. JSON string escapes are valid YAML escapes. */
const q = (s: string) => JSON.stringify(s);

export interface ConfigInput {
  port: number;
  /** bcrypt hash of the management key ($2b$...). */
  managementHash: string;
  clientKey: string;
  authDir: string;
}

export function renderConfig(c: ConfigInput): string {
  return [
    '# Written by the Conclave hub each time it starts CLIProxyAPI. Edits here are replaced.',
    '# Settings > Models > Subscriptions on the hub changes what matters.',
    'config-version: 8',
    'server:',
    '  host: "127.0.0.1"',
    `  port: ${Math.trunc(c.port)}`,
    '  discovery:',
    '    enabled: false',
    'management:',
    '  allow-remote: false',
    `  secret-key: ${q(c.managementHash)}`,
    '  disable-control-panel: true',
    'access:',
    '  api-keys:',
    `    - ${q(c.clientKey)}`,
    'oauth:',
    `  auth-dir: ${q(c.authDir)}`,
    // Settings > Models > Accounts: the hub writes each credential's priority from the owner's order.
    // fill-first uses the highest ready tier, so Account 1 serves until it is blocked, then Account 2.
    // A session stays on its account (X-Session-ID) so the prompt cache holds; it moves on quota or auth errors only.
    'routing:',
    '  strategy: "fill-first"',
    '  session-affinity: true',
    '  session-affinity-rebind-on: "quota"',
    'observability:',
    '  logs:',
    '    debug: false',
    '    logging-to-file: false',
    '    request-log: false',
    '  usage:',
    '    usage-statistics-enabled: false',
    'plugins:',
    '  enabled: false',
    '',
  ].join('\n');
}

export function writeConfig(files: CliproxyFiles, c: ConfigInput): void {
  ensurePrivateDirs(files);
  writeFileSync(files.config, renderConfig(c), { mode: 0o600 });
  try {
    chmodSync(files.config, 0o600);
  } catch {
    /* windows */
  }
}

/** Variables CLIProxyAPI may see: where programs and certificates are, the locale, and the owner's proxy for reaching providers. */
const KEEP = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // windows needs these to start a program at all
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMDATA',
]);

/**
 * The environment for CLIProxyAPI: only the names above (and LC_*), with
 * HOME pointed at its own folder. Nothing else of the hub's gets through:
 * not the hub token, not provider keys, not MANAGEMENT_PASSWORD (which
 * would turn on remote management) or DEPLOY.
 */
export function cliproxyEnv(base: Record<string, string | undefined>, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (KEEP.has(k) || k.startsWith('LC_')) out[k] = v;
  }
  return { ...out, HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir };
}
