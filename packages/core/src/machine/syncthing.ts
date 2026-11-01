/**
 * Syncthing on this device (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.5). Runs where
 * the files are: the daemon answers the syncthingFolders and syncthingStatus
 * RPCs with it, and the hub uses it for its own disk. It reads config.xml and
 * keeps only each folder's id, label, path and paused flag. The GUI API key
 * stays on the device: it can change the whole Syncthing config, so it is
 * used here for one status call and never sent anywhere.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface SyncthingFolder {
  id: string;
  label: string;
  path: string;
  paused: boolean;
}

export interface SyncthingStatus {
  state: string;
  needFiles: number;
  needBytes: number;
  pullErrors: number;
}

interface ParsedConfig {
  folders: SyncthingFolder[];
  gui?: { address: string; tls: boolean; apiKey?: string };
}

/** Where Syncthing keeps config.xml, in the order Syncthing itself looks. */
export function syncthingConfigDirs(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const dirs: string[] = [];
  if (env.STCONFDIR) dirs.push(env.STCONFDIR);
  if (env.STHOMEDIR) dirs.push(env.STHOMEDIR);
  if (env.XDG_STATE_HOME) dirs.push(join(env.XDG_STATE_HOME, 'syncthing'));
  dirs.push(join(home, '.local', 'state', 'syncthing'));
  // before Syncthing 1.27
  if (env.XDG_CONFIG_HOME) dirs.push(join(env.XDG_CONFIG_HOME, 'syncthing'));
  dirs.push(join(home, '.config', 'syncthing'));
  dirs.push(join(home, 'Library', 'Application Support', 'Syncthing'));
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Syncthing'));
  return [...new Set(dirs)];
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/**
 * Parse config.xml. Exported for tests. One forward pass: a folder's body
 * ends at its </folder>, or at the next <folder> when the file was cut off,
 * so a broken file costs no more than a good one.
 */
export function parseSyncthingConfig(xml: string, home: string): ParsedConfig {
  const folders: SyncthingFolder[] = [];
  const open = /<folder\b([^>]*?)(\/?)>/g;
  // the next close tag at or after a position, found once per position range (-1: none left)
  let close = -2;
  const closeFrom = (from: number): number => {
    if (close === -1 || (close >= from && close !== -2)) return close;
    close = xml.indexOf('</folder>', from);
    return close;
  };
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const a = attrs(m[1]);
    let body = '';
    if (!m[2]) {
      const start = open.lastIndex;
      const end = closeFrom(start);
      const next = xml.indexOf('<folder', start);
      const stop = end >= 0 && (next < 0 || end < next) ? end : next >= 0 ? next : xml.length;
      body = xml.slice(start, stop);
      open.lastIndex = stop === end ? end + '</folder>'.length : stop;
    }
    if (!a.id || !a.path) continue;
    const pausedTag = /<paused>\s*(true|false)\s*<\/paused>/i.exec(body)?.[1];
    const paused = (pausedTag ?? a.paused ?? 'false').toLowerCase() === 'true';
    let path = expandHome(a.path, home);
    if (path.length > 1) path = path.replace(/[\\/]+$/, '');
    folders.push({ id: a.id, label: a.label || a.id, path, paused });
  }
  let gui: ParsedConfig['gui'];
  const g = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
  if (g) {
    const ga = attrs(g[1]);
    const address = decodeXml(/<address>([^<]*)<\/address>/.exec(g[2])?.[1]?.trim() ?? '127.0.0.1:8384');
    const apiKey = /<apikey>([^<]*)<\/apikey>/.exec(g[2])?.[1]?.trim();
    if (ga.enabled !== 'false') gui = { address, tls: ga.tls === 'true', apiKey: apiKey ? decodeXml(apiKey) : undefined };
  }
  return { folders, gui };
}

async function readConfig(home: string, env: Record<string, string | undefined>): Promise<ParsedConfig | undefined> {
  for (const dir of syncthingConfigDirs(home, env)) {
    try {
      const xml = await fs.readFile(join(dir, 'config.xml'), 'utf8');
      return parseSyncthingConfig(xml, home);
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** Folders from this device's config.xml. Empty when Syncthing is not set up here. */
export async function syncthingFolders(home: string, env: Record<string, string | undefined> = process.env): Promise<SyncthingFolder[]> {
  return (await readConfig(home, env))?.folders ?? [];
}

/**
 * One folder's sync state from the local Syncthing REST API, with the API key
 * from the same config.xml. Only state, needFiles, needBytes and pullErrors
 * come back.
 */
export async function syncthingStatus(folderId: string, home: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<SyncthingStatus> {
  const cfg = await readConfig(home, env);
  if (!cfg) throw Object.assign(new Error('Syncthing is not set up on this device'), { code: 'ENOENT' });
  if (!cfg.folders.some((f) => f.id === folderId)) throw Object.assign(new Error(`no Syncthing folder ${folderId} on this device`), { code: 'ENOENT' });
  if (!cfg.gui?.apiKey) throw new Error('Syncthing has no GUI API key on this device');
  let address = cfg.gui.address.replace(/^(tcp4?|tcp6?):\/\//, '');
  if (address.startsWith('unix') || address.startsWith('/')) throw new Error('Syncthing listens on a socket Conclave does not read');
  address = address.replace(/^0\.0\.0\.0(?=:)/, '127.0.0.1').replace(/^\[::\](?=:)/, '[::1]');
  const url = `${cfg.gui.tls ? 'https' : 'http'}://${address}/rest/db/status?folder=${encodeURIComponent(folderId)}`;
  const res = await fetchImpl(url, { headers: { 'X-API-Key': cfg.gui.apiKey }, signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`Syncthing answered ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const n = (k: string) => (typeof body[k] === 'number' ? (body[k] as number) : 0);
  return { state: typeof body.state === 'string' ? body.state : 'unknown', needFiles: n('needFiles'), needBytes: n('needBytes'), pullErrors: n('pullErrors') };
}

/** The Syncthing folder that holds path (the deepest one), and the path inside it ("" at its top). */
export function syncthingFolderFor(folders: SyncthingFolder[], path: string): { folder: SyncthingFolder; rel: string } | undefined {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  let best: { folder: SyncthingFolder; rel: string } | undefined;
  for (const f of folders) {
    const root = f.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    if (p !== root && !p.startsWith(root === '/' ? '/' : `${root}/`)) continue;
    if (best && best.folder.path.length >= f.path.length) continue;
    best = { folder: f, rel: p === root ? '' : p.slice(root === '/' ? 1 : root.length + 1) };
  }
  return best;
}
