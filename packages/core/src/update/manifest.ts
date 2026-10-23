/**
 * The update manifest: conclave-update.json on each public release
 * (default-cybe/conclave), written by scripts/releases/updates.ts in
 * the Publish public workflow. It names, for one version, each file an
 * updater may install, with its URL, SHA-256, size and minisign signature.
 *
 *   https://github.com/<repo>/releases/latest/download/conclave-update.json   the newest release
 *   https://github.com/<repo>/releases/download/v<version>/conclave-update.json one version
 *
 * The hub reads it (Settings > About), and hands the one for its own version
 * to its devices' daemons. The Android app reads it too. The desktop app
 * reads latest.json next to it, the same data in the Tauri updater's shape.
 */

export const RELEASES_REPO = 'default-cybe/conclave';
export const MANIFEST_FILE = 'conclave-update.json';
export const TAURI_MANIFEST_FILE = 'latest.json';

/** Where releases are read from. CONCLAVE_RELEASES_URL replaces it (tests, a mirror): <base>/latest/download/<file> and <base>/download/v<version>/<file>. */
export function releasesBase(env: Record<string, string | undefined> = process.env): string {
  return (env.CONCLAVE_RELEASES_URL || `https://github.com/${RELEASES_REPO}/releases`).replace(/\/+$/, '');
}

/** The newest release's manifest, or the one of `version`. */
export function manifestUrl(version?: string, env?: Record<string, string | undefined>): string {
  const base = releasesBase(env);
  return version ? `${base}/download/v${version.replace(/^v/, '')}/${MANIFEST_FILE}` : `${base}/latest/download/${MANIFEST_FILE}`;
}

export interface UpdateArtifact {
  /** The file name in the release. */
  file: string;
  url: string;
  /** Hex. */
  sha256: string;
  size: number;
  /** The .sig file's text (Tauri's base64 form). Absent on an unsigned release. */
  signature?: string;
}

export interface UpdateManifest {
  schema: 1;
  /** "0.5.0", without the v. */
  version: string;
  tag: string;
  /** The release notes, plain text or Markdown, cut short. */
  notes: string;
  /** ISO time. */
  pubDate: string;
  /** False when the release was built without the signing key: updaters install nothing from it. */
  signed: boolean;
  /** The hub and CLI (and the TypeScript daemon in it), by release target: linux-x64, linux-x64-baseline, linux-arm64, darwin-x64, darwin-arm64, windows-x64. */
  hub: Record<string, UpdateArtifact>;
  /** The Rust daemon, by Rust target triple. */
  daemon: Record<string, UpdateArtifact>;
  /** The desktop app's updater bundles, by Tauri platform key (darwin-aarch64, linux-x86_64, windows-x86_64...). */
  desktop: Record<string, UpdateArtifact>;
  android?: UpdateArtifact;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** "1.2.3-rc.1" -> parts. A leading v is dropped. Undefined for a version that is not one (a test build). */
export function parseVersion(v: string): { nums: number[]; pre: string[] } | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return { nums: [m[1], m[2] ?? '0', m[3] ?? '0'].map((x) => Number.parseInt(x, 10)), pre: m[4] ? m[4].split('.') : [] };
}

export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && !!parseVersion(v);
}

/** Semver order: 0.10.0 > 0.9.9, 1.0.0 > 1.0.0-rc.2 > 1.0.0-rc.1. A string that is not a version sorts first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d) return d < 0 ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** `latest` is newer than `current`. A current version that is not one (a test build) never is behind. */
export function isNewer(latest: string, current: string): boolean {
  return !!parseVersion(current) && !!parseVersion(latest) && compareVersions(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** The hub release target for this system (the conclave-<target> archive), as install.sh picks it. */
export function hubTarget(platform: string = process.platform, arch: string = process.arch, avx2?: boolean): string | undefined {
  const os = ({ linux: 'linux', darwin: 'darwin', win32: 'windows' } as Record<string, string>)[platform];
  const cpu = ({ x64: 'x64', arm64: 'arm64' } as Record<string, string>)[arch];
  if (!os || !cpu) return undefined;
  if (os === 'windows' && cpu !== 'x64') return undefined;
  // older x64 CPUs without AVX2 need Bun's baseline build
  if (os === 'linux' && cpu === 'x64' && avx2 === false) return 'linux-x64-baseline';
  return `${os}-${cpu}`;
}

/** The archive name of a hub target. */
export function hubArchive(target: string): string {
  return target.startsWith('windows-') ? `conclave-${target}.zip` : `conclave-${target}.tar.gz`;
}

/** The Rust daemon's target triple for a system. */
export function daemonTriple(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const map: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  return map[`${platform}-${arch}`];
}

// ---------------------------------------------------------------------------
// Reading a manifest
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

/** https anywhere; plain http only to this machine (tests). */
export function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname));
  } catch {
    return false;
  }
}

function artifact(v: unknown, where: string): UpdateArtifact {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const file = typeof a.file === 'string' ? a.file : '';
  const url = typeof a.url === 'string' ? a.url : '';
  const sha256 = typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
  const size = typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : -1;
  if (!file || /[/\\]/.test(file)) throw new ManifestError(`The update manifest has a bad file name for ${where}.`);
  if (!allowedUrl(url)) throw new ManifestError(`The update manifest has a bad address for ${where}.`);
  if (!HEX64.test(sha256)) throw new ManifestError(`The update manifest has a bad SHA-256 for ${where}.`);
  if (size <= 0) throw new ManifestError(`The update manifest has a bad size for ${where}.`);
  const signature = typeof a.signature === 'string' && a.signature.trim() ? a.signature.trim() : undefined;
  return { file, url, sha256, size, ...(signature ? { signature } : {}) };
}

function table(v: unknown, where: string): Record<string, UpdateArtifact> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ManifestError(`The update manifest's ${where} list is broken.`);
  const out: Record<string, UpdateArtifact> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 64)) out[k.slice(0, 64)] = artifact(x, `${where} ${k}`);
  return out;
}

/** Check a manifest's shape. Throws a ManifestError with a plain sentence. */
export function parseManifest(raw: unknown): UpdateManifest {
  const m = (raw && typeof raw === 'object' ? raw : undefined) as Record<string, unknown> | undefined;
  if (!m) throw new ManifestError('The update manifest is not JSON.');
  if (m.schema !== 1) throw new ManifestError(`The update manifest is a newer kind (${String(m.schema)}). Update Conclave by hand once.`);
  const version = typeof m.version === 'string' ? m.version.replace(/^v/, '') : '';
  if (!isVersion(version)) throw new ManifestError('The update manifest has no version.');
  return {
    schema: 1,
    version,
    tag: typeof m.tag === 'string' ? m.tag : `v${version}`,
    notes: typeof m.notes === 'string' ? m.notes.slice(0, 8000) : '',
    pubDate: typeof m.pubDate === 'string' ? m.pubDate : '',
    signed: m.signed === true,
    hub: table(m.hub, 'hub'),
    daemon: table(m.daemon, 'daemon'),
    desktop: table(m.desktop, 'desktop'),
    ...(m.android ? { android: artifact(m.android, 'android') } : {}),
  };
}

/** Fetch and check a manifest. `f` is fetch (tests pass a fake). */
export async function fetchManifest(url: string, f: typeof fetch = fetch, timeoutMs = 20_000): Promise<UpdateManifest> {
  let res: Response;
  try {
    res = await f(url, { headers: { 'user-agent': 'conclave-updater', accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ManifestError(`Could not reach the release server (${(err as Error).message}).`);
  }
  if (res.status === 404) throw new ManifestError('No release has an update manifest yet.');
  if (!res.ok) throw new ManifestError(`The release server answered ${res.status}.`);
  const text = await res.text();
  if (text.length > 512 * 1024) throw new ManifestError('The update manifest is too large.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ManifestError('The update manifest is not JSON.');
  }
  return parseManifest(json);
}
