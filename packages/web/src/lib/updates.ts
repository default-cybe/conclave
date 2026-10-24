/**
 * Updates in the web app (docs/DESIGN.md, Updates): the words for Settings >
 * About, the owner's popup at start, the dot on the account row, the
 * "Conclave was updated" line and each device's daemon. Pure, so
 * test/updates.test.ts checks them.
 */
import { ApiError, type DeviceUpdateDto, type HubInstallDto, type UpdateJobDto, type UpdateStatusDto } from '@conclave/core/client';

/** Update now was refused because work runs (409 with busy): what runs, in a sentence. */
export function busyMessage(e: unknown): string | undefined {
  return e instanceof ApiError && e.status === 409 && (e.body as { busy?: unknown } | undefined)?.busy ? e.message : undefined;
}

/** The hub's version changed since this page loaded: the page runs old code, so it offers Reload. */
export function versionChanged(loaded: string | undefined, now: string | undefined): boolean {
  return !!loaded && !!now && loaded !== now;
}

/** The reload line shows for a change it was not closed for, once per new version. */
export function showReload(loaded: string | undefined, now: string | undefined, closedFor: string | undefined): boolean {
  return versionChanged(loaded, now) && closedFor !== now;
}

export const RELOAD_WORDS = 'Conclave was updated.';

/** The update running now: started and not finished. */
export function jobRunning(job: UpdateJobDto | undefined): boolean {
  return !!job && !['done', 'rolled-back', 'failed'].includes(job.phase);
}

/** One line for an update job. */
export function jobWords(job: UpdateJobDto): string {
  switch (job.phase) {
    case 'downloading': {
      const pct = job.total ? Math.floor(((job.done ?? 0) / job.total) * 100) : undefined;
      return `Downloading Conclave ${job.version}${pct !== undefined ? `, ${pct}%` : ''}.`;
    }
    case 'checking':
      return `Checking the signature of Conclave ${job.version}.`;
    case 'installing':
      return `Installing Conclave ${job.version}.`;
    case 'restarting':
      return `Restarting on Conclave ${job.version}.`;
    case 'verifying':
      return `Waiting for Conclave ${job.version} to answer.`;
    case 'done':
      return job.message ?? `Updated to ${job.version}.`;
    case 'rolled-back':
      return job.message ?? `Conclave ${job.version} did not start, so the hub went back to ${job.from}.`;
    case 'failed':
      return job.message ?? `The update to ${job.version} failed.`;
  }
}

export function jobTone(job: UpdateJobDto): 'ok' | 'fault' | 'warn' | 'dim' {
  return job.phase === 'done' ? 'ok' : job.phase === 'failed' ? 'fault' : job.phase === 'rolled-back' ? 'warn' : 'dim';
}

/** How this hub was installed, in a few words. */
export function installWords(i: HubInstallDto): string {
  switch (i.kind) {
    case 'systemd-user':
      return 'Install script, as a service of your user';
    case 'systemd-system':
      return 'Container or VM, as a system service';
    case 'docker':
      return 'Docker';
    case 'desktop':
      return 'The desktop app';
    case 'source':
      return 'A source checkout';
    case 'manual':
      return 'A release, not run by a service';
  }
}

/** The banner for the owner, or undefined: a newer release that was not put off. */
export function hubBanner(s: UpdateStatusDto | undefined, dismissed: string | undefined): { version: string; canUpdate: boolean; running: boolean } | undefined {
  if (!s) return undefined;
  const running = jobRunning(s.job);
  if (running && s.job) return { version: s.job.version, canUpdate: true, running };
  if (!s.available || !s.latest) return undefined;
  if (dismissed === s.latest.version) return undefined;
  // nothing a click here can do while the key is missing or the release unsigned: About says why
  const canUpdate = s.install.canUpdate && !s.keyMissing && s.latest.signed;
  return { version: s.latest.version, canUpdate, running: false };
}

/**
 * -1, 0 or 1 for two versions ("0.4.10" after "0.4.9"). A pre-release comes
 * before its release ("0.5.0-rc.1" before "0.5.0"); a leading v is fine.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** What the owner chose about the popup: a version skipped, and whether it shows at start. */
export interface UpdatePrefs {
  /** Skip this version: no popup and no dot until a newer one. */
  skipped?: string;
  /** Don't show at startup turns this off; Settings > About turns it back on. */
  startup: boolean;
}

/** A newer release the owner has not skipped (a newer one than the skipped one counts again). */
export function updateWaiting(s: UpdateStatusDto | undefined, prefs: Pick<UpdatePrefs, 'skipped'>): boolean {
  if (!s?.available || !s.latest) return false;
  return !prefs.skipped || compareVersions(s.latest.version, prefs.skipped) > 0;
}

/** The popup at start: a release waiting, with the popup on. While an update runs, the popup that started it stays. */
export function popupFor(s: UpdateStatusDto | undefined, prefs: UpdatePrefs): { version: string; canUpdate: boolean; notes?: string } | undefined {
  if (!prefs.startup || !updateWaiting(s, prefs) || !s?.latest) return undefined;
  const b = hubBanner(s, undefined);
  if (!b || b.running) return undefined;
  const notes = notesLine(s.latest.notes);
  return { version: s.latest.version, canUpdate: b.canUpdate, ...(notes ? { notes } : {}) };
}

/** The dot on the account row: a release waiting that was not skipped. */
export function updateDot(s: UpdateStatusDto | undefined, prefs: Pick<UpdatePrefs, 'skipped'>): boolean {
  return updateWaiting(s, prefs) || jobRunning(s?.job);
}

/** The first line of the release notes, short: what the popup says is new. */
export function notesLine(notes: string | undefined, max = 140): string | undefined {
  const line = notes
    ?.split('\n')
    .map((l) => l.replace(/^[\s#*-]+/, '').trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : line;
}

/** "Conclave 0.5.0 is ready", the popup's title. */
export function popupTitle(version: string): string {
  return `Conclave ${version} is ready`;
}

export function bannerWords(b: { version: string; canUpdate: boolean; running: boolean }, job?: UpdateJobDto): string {
  if (b.running && job) return jobWords(job);
  return b.canUpdate ? `Conclave ${b.version} is ready to install.` : `Conclave ${b.version} is out.`;
}

/** The newest release line in Settings > About. */
export function latestWords(s: UpdateStatusDto): string {
  if (s.checking) return 'Checking';
  if (s.checkError && !s.latest) return `Could not check. ${s.checkError}`;
  if (!s.latest) return 'Not checked yet';
  if (s.available) return `${s.latest.version} is out`;
  return `${s.current} is the newest`;
}

/** Why Update now is not there, when it is not. */
export function cannotWords(s: UpdateStatusDto): string | undefined {
  if (!s.available || !s.latest) return undefined;
  if (s.keyMissing) return 'This hub has no update key yet, so it installs no updates. Update it by hand this time.';
  if (!s.latest.signed) return 'This release is unsigned, so it is not installed from here. Update by hand, or wait for a signed release.';
  if (!s.install.canUpdate) return s.install.why ?? 'This hub cannot update itself.';
  return undefined;
}

/** What the Devices page says about a device's daemon, and whether Update is offered. */
export function deviceUpdateView(u: DeviceUpdateDto | undefined, online: boolean): { words?: string; tone: 'ok' | 'fault' | 'warn' | 'dim'; action: boolean } {
  if (!u) return { tone: 'dim', action: false };
  if (u.state === 'sent' || u.state === 'updating') return { words: u.message ?? `Updating to ${u.target}.`, tone: 'dim', action: false };
  if (u.state === 'failed') return { words: u.message ?? 'The update failed.', tone: 'fault', action: u.behind && u.mode === 'self' && online };
  if (!u.behind) return u.state === 'done' ? { words: u.message ?? `Updated to ${u.current}.`, tone: 'ok', action: false } : { tone: 'dim', action: false };
  if (u.mode === 'app') return { words: `Older than the hub (${u.target}). The desktop app updates it with itself.`, tone: 'dim', action: false };
  if (u.mode === 'manual') return { words: `Older than the hub (${u.target}). ${u.why ?? 'Update it by hand.'}`, tone: 'warn', action: false };
  return { words: online ? `Older than the hub. Update to ${u.target}.` : `Older than the hub. Update it when it is online.`, tone: 'warn', action: online };
}
