/**
 * The TypeScript daemon updates itself (protocol 4, selfUpdate; docs/DESIGN.md,
 * Updates). `conclave daemon` runs from the release folder install.sh made
 * (~/.local/share/conclave), the same files as the hub. The hub sends its own
 * version and that release's manifest; the daemon picks the archive for this
 * system, checks its size, SHA-256 and signature with the key built into it,
 * unpacks it next to the folder, asks the new conclave its version, swaps the
 * folders (the old one stays as <folder>.prev) and exits. Its service
 * (systemd Restart=always, launchd KeepAlive) starts the new binary, which
 * says in its hello that the update went through.
 *
 * The desktop app's copy is left to the app; a checkout, a copy outside a
 * release folder or one not run by its service says how to update by hand.
 * The Rust daemon does the same in packages/daemon-rs/src/update.rs, with the
 * same checks in the same order.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonSelf } from '@conclave/core/types.ts';
import type { RpcParams, SelfUpdateResult } from '@conclave/core/machine/protocol.ts';
import {
  checkUnpacked,
  detectDaemonInstall,
  downloadArtifact,
  hasAvx2,
  hubArchive,
  hubTarget,
  isNewer,
  isVersion,
  makeStage,
  parseManifest,
  swapIn,
  unpackHub,
  updateKey,
  UpdateError,
  verifyArtifact,
  type DaemonInstall,
  type KeyState,
} from '@conclave/core/update/index.ts';
import { conclaveHome } from '@conclave/core/config/paths.ts';
import { VERSION } from './version';

/** An error the hub shows as it is, with a code it can tell apart. */
function refuse(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

/** <home>/daemon-update.json: the update in flight, then its result as the new binary saw it. */
export function updateFile(home = conclaveHome()): string {
  return join(home, 'daemon-update.json');
}

type UpdateMark = { from: string; to: string; at: number; pending?: boolean; ok?: boolean; message?: string };

function readMark(file: string): UpdateMark | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as UpdateMark;
  } catch {
    return undefined;
  }
}

/** On start: a pending update is done when this binary is the version it was for. */
export function settleUpdate(file = updateFile(), version = VERSION): DaemonSelf['lastUpdate'] {
  const m = readMark(file);
  if (!m) return undefined;
  if (m.pending) {
    const ok = m.to === version;
    const done: UpdateMark = { from: m.from, to: m.to, at: Date.now(), ok, ...(ok ? {} : { message: `The service started ${version}, not ${m.to}.` }) };
    try {
      writeFileSync(file, JSON.stringify(done) + '\n');
    } catch {
      /* shown once at least */
    }
    return { from: done.from, to: done.to, ok, at: done.at, ...(done.message ? { message: done.message } : {}) };
  }
  return { from: m.from, to: m.to, ok: m.ok === true, at: m.at, ...(m.message ? { message: m.message } : {}) };
}

/** What this daemon says about itself in its hello. */
export function daemonSelf(install: DaemonInstall = detectDaemonInstall(), lastUpdate = settleUpdate()): DaemonSelf {
  return { impl: 'ts', version: VERSION, update: install.mode, ...(install.why ? { updateWhy: install.why } : {}), ...(lastUpdate ? { lastUpdate } : {}) };
}

export interface SelfUpdateDeps {
  install?: DaemonInstall;
  key?: KeyState;
  fetch?: typeof fetch;
  current?: string;
  platform?: string;
  arch?: string;
  avx2?: boolean;
  probe?: (bin: string) => Promise<string | undefined>;
  markFile?: string;
  /** Called once the new folder is in place: exit, so the service starts it. */
  restart?: () => void;
  log?: (line: string) => void;
}

/**
 * The selfUpdate RPC. The first two checks (the request, and that it is newer)
 * come before anything that differs between daemons, so both answer them
 * alike (the conformance test asks).
 */
export async function selfUpdate(params: RpcParams['selfUpdate'], deps: SelfUpdateDeps = {}): Promise<SelfUpdateResult> {
  const current = deps.current ?? VERSION;
  const version = typeof params?.version === 'string' ? params.version.replace(/^v/, '') : '';
  if (!isVersion(version)) refuse('selfUpdate needs a version.', 'EINVAL');
  if (!isNewer(version, current)) refuse(`Conclave ${version} is not newer than this daemon (${current}).`, 'EUPTODATE');
  let manifest;
  try {
    manifest = parseManifest(params.manifest);
  } catch (err) {
    refuse((err as Error).message, 'EINVAL');
  }
  if (manifest.version !== version) refuse(`The update manifest is for ${manifest.version}, not ${version}.`, 'EINVAL');

  const install = deps.install ?? detectDaemonInstall();
  if (install.mode !== 'self' || !install.dir) refuse(install.why ?? 'This daemon cannot update itself.', install.mode === 'app' ? 'EAPP' : 'EMANUAL');
  const key = deps.key ?? updateKey();
  if (!key.ok) refuse(key.why, 'ENOKEY');
  if (!manifest.signed) refuse('This release is unsigned, so it is not installed. Update by hand, or wait for a signed release.', 'EUNSIGNED');
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = hubTarget(platform, arch, deps.avx2 ?? hasAvx2());
  const artifact = target ? manifest.hub[target] : undefined;
  if (!target || !artifact) refuse(`Release ${version} has no build for ${platform} ${arch}.`, 'ENOENT');
  if (artifact.file !== hubArchive(target)) refuse(`The update manifest names ${artifact.file} for ${target}, not ${hubArchive(target)}.`, 'EINVAL');

  const log = deps.log ?? (() => {});
  const stage = makeStage(install.dir);
  try {
    log(`update: downloading ${artifact.file} (${version})`);
    const archive = join(stage, artifact.file);
    const hashes = await downloadArtifact(artifact, archive, { fetch: deps.fetch });
    verifyArtifact(hashes, artifact, key);
    const { dir } = await unpackHub(archive, target, stage);
    await checkUnpacked(join(dir, 'conclave'), version, current, deps.probe);
    swapIn(install.dir, dir);
  } catch (err) {
    if (err instanceof UpdateError) refuse(err.message, 'EUPDATE');
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const file = deps.markFile ?? updateFile();
  try {
    writeFileSync(file, JSON.stringify({ from: current, to: version, at: Date.now(), pending: true } satisfies UpdateMark) + '\n');
  } catch {
    /* the hub sees the new version either way */
  }
  log(`update: ${current} -> ${version} in place, restarting`);
  // after the answer has gone out: the service starts the new binary
  if (deps.restart) setTimeout(deps.restart, 800);
  return { from: current, to: version, restarting: !!deps.restart };
}

