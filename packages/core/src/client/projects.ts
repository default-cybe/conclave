/**
 * Folders across devices: the HTTP contract (ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 2.12). A project is a stable identity (git roots, remotes, a Syncthing
 * folder or a marker) plus a location per device. Moving a session to
 * another device resolves where the project lives there.
 */
import type { Session } from '../types';

/**
 * How sure Conclave is that a folder is the same project.
 * exact: same marker, same Syncthing folder, or same git roots and a shared remote.
 * strong: same git roots, or it has the last commit seen elsewhere.
 * weak: same folder or package name only. none: nothing in common.
 * mismatch: both are git repos with different histories.
 */
export type MatchLevel = 'exact' | 'strong' | 'weak' | 'none' | 'mismatch';

/** How a location was found. */
export type LocationVia = 'origin' | 'same-path' | 'pinned' | 'syncthing' | 'prefix' | 'search' | 'chosen';

/** What one folder on one device is, as read through its Machine. */
export interface FolderIdentity {
  path: string;
  /** False when the folder does not exist on the device. */
  exists: boolean;
  isGit: boolean;
  /** git rev-parse --show-toplevel. */
  toplevel?: string;
  /** Root commits (the shallow boundary for a shallow clone). */
  roots: string[];
  /** Normalized remotes: host/owner/repo, lower-case host, no scheme, user, port or .git. */
  remotes: string[];
  shallow: boolean;
  head?: string;
  branch?: string;
  /** Id from .conclave/project.json. */
  marker?: string;
  /** Syncthing folder holding the path, and the path inside it. */
  syncthing?: { folderId: string; rel: string };
  /** Folder name. */
  name: string;
  /** name from package.json, when there is one. */
  packageName?: string;
}

/** The identity a project keeps, merged from every location seen. */
export interface ProjectIdentity {
  gitRoots: string[];
  remotes: string[];
  shallow: boolean;
  syncthing?: { folderId: string; rel: string };
  marker?: string;
  /** Last HEAD seen anywhere, for shallow clones and rewritten histories. */
  head?: string;
}

export interface ProjectLocationDto {
  projectId: string;
  device: string;
  deviceName?: string;
  path: string;
  via: LocationVia;
  pinned: boolean;
  verifiedAt?: number;
  head?: string;
}

export interface ProjectDto {
  id: string;
  /** Whose project (docs/design/ACCOUNTS.md). */
  accountId?: string;
  name: string;
  identity: ProjectIdentity;
  createdAt: number;
  updatedAt: number;
  locations: ProjectLocationDto[];
}

/** A learned path pair: from_prefix on one device is to_prefix on the other, both ways. */
export interface PathPrefixDto {
  id: string;
  fromDevice: string;
  fromPrefix: string;
  toDevice: string;
  toPrefix: string;
  confirmations: number;
  createdAt: number;
}

/** How current the copy on the target is, compared with where the session was. */
export interface Freshness {
  /** True when the owner should look before going on. */
  stale: boolean;
  /** One line for the owner, e.g. "The macbook copy is 3 commits behind." */
  line?: string;
  behind?: number;
  ahead?: number;
  /** The last commit seen on the old device is not here. */
  missingCommit?: boolean;
  /** Uncommitted files on the old device at the end of its last turn. */
  dirtyElsewhere?: number;
  syncState?: string;
  needFiles?: number;
  /** *.sync-conflict-* files under the folder. */
  conflicts?: number;
}

export interface FolderCandidate {
  device: string;
  path: string;
  level: MatchLevel;
  via: LocationVia;
  /** One line, e.g. "Same git history and remote as the arch-desktop copy". */
  line: string;
}

export interface MoveInput {
  device: string;
  /** A folder the owner chose. Without it, Conclave resolves one. */
  cwd?: string;
  /** Pin the location and learn the path pair. */
  remember?: boolean;
  /** Use a folder whose git history differs (Use once, Use and remember). */
  allowMismatch?: boolean;
  /** Continue on the device with no project folder (its home). */
  withoutFiles?: boolean;
  /** Clone the project's remote into this folder first. */
  clone?: { url: string; into: string };
  /**
   * With device "local" (the hub): copy the session's whole project folder from
   * its device into <projects.hubRoot>/<device>/<folder name> first, byte for
   * byte, then run the session on the copy (projects/hubcopy.ts).
   */
  copy?: boolean;
}

/** One file or symlink of a copied folder, as it was right after the copy (projects/hubcopy.ts). */
export interface ManifestEntry {
  /** Path relative to the folder, "/" separated. */
  p: string;
  /** f: file, l: symlink. */
  t: 'f' | 'l';
  /** Size in bytes. */
  s: number;
  /** mtime in whole seconds. */
  m: number;
  /** sha256 hex of files under 50 MB. */
  h?: string;
  /** Symlink target. */
  l?: string;
}

/** meta.hubCopy of a session that was copied to the hub: where it came from, for Move back. */
export interface HubCopyRecord {
  device: string;
  deviceName: string;
  /** The project folder on the device. */
  root: string;
  /** The session's cwd inside it ("" at the root). */
  rel: string;
  /** The copy on the hub. */
  hubPath: string;
  copiedAt: number;
  /** The manifest file on the hub (a JSON array of ManifestEntry), kept next to the copies. */
  manifest: string;
  bytes: number;
  files: number;
}

/** GET /api/sessions/:id/hub-copy: what Move to hub would copy, and where. */
export interface HubCopyPreview {
  device: string;
  deviceName: string;
  /** The folder copied (the project root on the device). */
  path: string;
  target: string;
  /** du -sk of the folder, in bytes. */
  bytes: number;
  files: number;
  freeBytes: number;
  fits: boolean;
  /** "1.2 GB, 48,113 files to /srv/conclave-projects/pc/portfolio", or why it cannot. */
  line: string;
  /** A copy or copy back is running now. */
  running?: boolean;
  /** Set once the session was copied: Move back is offered. */
  record?: HubCopyRecord;
}

export type HubChange = 'added' | 'changed' | 'deleted';

export interface HubBackFile {
  path: string;
  change: HubChange;
  /** Changed on the device since the copy too: copying it back overwrites the device's change. */
  conflict: boolean;
  binary?: boolean;
  /** Size on the device (before) and on the hub (after). */
  before?: number;
  after?: number;
  /** Unified diff for text files (the first ones only). */
  diff?: string;
}

/** GET /api/sessions/:id/hub-copy/back: what changed on the hub since the copy. */
export interface HubBackPreview {
  device: string;
  deviceName: string;
  online: boolean;
  devicePath: string;
  hubPath: string;
  files: HubBackFile[];
  conflicts: number;
  /** Files that changed on the device only (not touched by a copy back). */
  deviceOnly: number;
  /** More files changed than are listed. */
  truncated: boolean;
  line: string;
}

/** POST /api/sessions/:id/hub-copy/back. */
export interface HubBackInput {
  /** Leave files that also changed on the device as the device has them. */
  skipConflicts?: boolean;
  /** Delete files on the device that were deleted on the hub. Default off: nothing on the device is deleted. */
  deleteRemoved?: boolean;
}

export type MoveResult =
  | {
      resolved: true;
      cwd: string;
      via: LocationVia;
      level: MatchLevel;
      freshness?: Freshness;
      session: Session;
      /** "Moved to macbook at ~/Developer/portfolio (Syncthing)." */
      line: string;
    }
  | {
      resolved: false;
      /** offline: the target is not connected. not-found: no folder matched. mismatch: the chosen folder has another history. */
      reason: 'offline' | 'not-found' | 'mismatch';
      line: string;
      candidates: FolderCandidate[];
      /** A remote to clone when nothing was found. */
      cloneUrl?: string;
      /** Where the Choose folder sheet starts browsing. */
      browseFrom?: string;
    };

export type LocationState = 'ok' | 'offline' | 'missing' | 'stale' | 'mismatch';

export interface LocationMove {
  fromSeq: number;
  device: string;
  deviceName?: string;
  root: string;
  via?: LocationVia;
  level?: MatchLevel;
  at?: number;
}

export interface SessionLocationDto {
  sessionId: string;
  device: string;
  deviceName: string;
  online: boolean;
  cwd: string;
  /** Unknown (undefined) while the device is offline. */
  exists?: boolean;
  projectId?: string;
  projectName?: string;
  level?: MatchLevel;
  via?: LocationVia;
  freshness?: Freshness;
  /** What the banner shows. ok means it shows nothing. */
  state: LocationState;
  /** The banner's line, for any state but ok. */
  line?: string;
  history: LocationMove[];
  /** Where to run instead: another online device that has the folder. */
  suggestion?: { device: string; deviceName: string; cwd: string; via: LocationVia; level: MatchLevel };
  cloneUrl?: string;
  browseFrom?: string;
}

export interface IdentifyResult {
  device: string;
  path: string;
  identity: FolderIdentity;
  project?: ProjectDto;
  level: MatchLevel;
  line: string;
}

export interface SyncthingFolderDto {
  id: string;
  label: string;
  path: string;
  paused: boolean;
}

export interface SyncthingStatusDto {
  state: string;
  needFiles: number;
  needBytes: number;
  pullErrors: number;
}

export interface MappingSuggestion {
  id: string;
  projectId: string;
  projectName: string;
  fromDevice: string;
  fromPath: string;
  toDevice: string;
  toPath: string;
  /** "From the imported Claude Code session \"portfolio\"". */
  reason: string;
}

export interface DeviceFoldersDto {
  device: string;
  deviceName: string;
  online: boolean;
  /** The hub only: where Move to hub puts copied folders (config projects.hubRoot or its default). */
  hubRoot?: string;
  locations: Array<ProjectLocationDto & { projectName: string }>;
  prefixes: PathPrefixDto[];
  suggestions: MappingSuggestion[];
  syncthing: {
    /** False when the device has no Syncthing config or its daemon is too old to say. */
    available: boolean;
    folders: SyncthingFolderDto[];
    /** "12 folders, all up to date". */
    line: string;
  };
}
