/**
 * Updates (docs/DESIGN.md, Updates): the hub's own version against the newest
 * release, how this hub was installed and so how it updates, and the update
 * of each paired device's daemon. The owner's only (route-policy.ts).
 *
 *   GET  /api/update                 UpdateStatusDto
 *   POST /api/update/check           check the newest release now
 *   POST /api/update/apply           { version }: download, check, swap, restart
 *   PUT  /api/update/settings        { auto }: install updates automatically at night
 *   POST /api/devices/:id/update     the device's daemon updates itself to the hub's version
 */

/**
 * How the hub was installed, which decides how it updates:
 *   systemd-user    install.sh with the user service: the hub updates itself
 *   systemd-system  setup.sh or conclave-lxc.sh: a root helper unit swaps it in
 *   docker          pull the new image; the hub never changes its own container
 *   desktop         the desktop app runs it and updates it with itself
 *   source          a checkout run with bun: git pull, or setup.sh again
 *   manual          a binary not run by a service: the install script again
 */
export type HubInstallKind = 'systemd-user' | 'systemd-system' | 'docker' | 'desktop' | 'source' | 'manual';

export interface HubInstallDto {
  kind: HubInstallKind;
  /** Update now can run here. */
  canUpdate: boolean;
  /** Why it cannot, in a sentence. */
  why?: string;
  /** The command that updates it by hand (Docker, a manual install, a checkout). */
  command?: string;
  /** The folder the hub runs from, when it is a release. */
  dir?: string;
}

export type UpdateJobPhase = 'downloading' | 'checking' | 'installing' | 'restarting' | 'verifying' | 'done' | 'rolled-back' | 'failed';

export interface UpdateJobDto {
  id: string;
  version: string;
  from: string;
  phase: UpdateJobPhase;
  /** A sentence for people. */
  message?: string;
  /** Bytes downloaded and the total, while downloading. */
  done?: number;
  total?: number;
  startedAt: number;
  finishedAt?: number;
  /** owner, or auto (the night window). */
  by: string;
}

export interface UpdateStatusDto {
  /** The running hub. */
  current: string;
  /** The newest release, once checked. */
  latest?: { version: string; notes: string; pubDate?: string; signed: boolean };
  /** latest is newer than current. */
  available: boolean;
  checkedAt?: number;
  checking: boolean;
  /** The last check failed: why. */
  checkError?: string;
  install: HubInstallDto;
  /** The update key is still the placeholder: nothing installs until a release has one. */
  keyMissing: boolean;
  /** "Install updates automatically": at night, owner's setting, off unless set. */
  auto: { on: boolean; window: string };
  /** The update running now, or the last one. */
  job?: UpdateJobDto;
}

export type DeviceUpdateState = 'sent' | 'updating' | 'done' | 'failed';

/** A device daemon's update, as the Devices page shows it. */
export interface DeviceUpdateDto {
  deviceId: string;
  /** The daemon says it is this version. */
  current?: string;
  /** The hub's version, which the daemon updates to. */
  target: string;
  /** self: it can update itself. app: the desktop app updates it. manual: by hand (why says how). */
  mode: 'self' | 'app' | 'manual';
  /** Older than the hub. */
  behind: boolean;
  why?: string;
  state?: DeviceUpdateState;
  message?: string;
  at?: number;
}

export interface DeviceUpdatesDto {
  hubVersion: string;
  devices: DeviceUpdateDto[];
}
