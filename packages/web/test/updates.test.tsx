/**
 * Updates in the web app (docs/DESIGN.md, Updates): the "Conclave was
 * updated" line once per new hub version, the owner's banner, the words of
 * Settings > About and of a device's daemon, and the lines as HTML. The words
 * have no em or en dashes.
 *
 *   bun test packages/web/test/updates.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { DeviceUpdateDto, UpdateJobDto, UpdateStatusDto } from '@conclave/core/client';
import { bannerWords, cannotWords, compareVersions, deviceUpdateView, hubBanner, installWords, jobRunning, jobWords, latestWords, notesLine, popupFor, popupTitle, showReload, updateDot, updateWaiting, versionChanged } from '../src/lib/updates';
import { ReloadLine, UpdatePopupBody } from '../src/components/UpdateBanners';

function status(p: Partial<UpdateStatusDto> = {}): UpdateStatusDto {
  return {
    current: '0.4.1',
    latest: { version: '0.5.0', notes: 'What changed', signed: true },
    available: true,
    checkedAt: 1,
    checking: false,
    install: { kind: 'systemd-user', canUpdate: true },
    keyMissing: false,
    auto: { on: false, window: '03:00 to 05:00' },
    ...p,
  };
}

const job = (p: Partial<UpdateJobDto>): UpdateJobDto => ({ id: 'j', version: '0.5.0', from: '0.4.1', phase: 'downloading', startedAt: 1, by: 'owner', ...p });

describe('Conclave was updated. Reload', () => {
  test('shows when the hub version changed since the page loaded, once per version', () => {
    expect(versionChanged(undefined, '0.5.0')).toBe(false);
    expect(versionChanged('0.4.1', '0.4.1')).toBe(false);
    expect(versionChanged('0.4.1', '0.5.0')).toBe(true);
    expect(showReload('0.4.1', '0.5.0', undefined)).toBe(true);
    // closed for this version: it stays away; a later update shows it again
    expect(showReload('0.4.1', '0.5.0', '0.5.0')).toBe(false);
    expect(showReload('0.4.1', '0.6.0', '0.5.0')).toBe(true);
  });

  test('the line says it plainly, with Reload', () => {
    const html = renderToStaticMarkup(<ReloadLine onReload={() => {}} onLater={() => {}} />);
    expect(html).toContain('Conclave was updated.');
    expect(html).toContain('Reload');
    expect(html).toContain('role="status"');
  });
});

describe("the owner's banner", () => {
  test('a newer release shows until it is put off; Update now only where the hub can do it', () => {
    expect(hubBanner(status(), undefined)).toEqual({ version: '0.5.0', canUpdate: true, running: false });
    expect(hubBanner(status(), '0.5.0')).toBeUndefined();
    expect(hubBanner(status({ available: false }), undefined)).toBeUndefined();
    expect(hubBanner(undefined, undefined)).toBeUndefined();
    expect(hubBanner(status({ install: { kind: 'docker', canUpdate: false, command: 'docker compose pull && docker compose up -d' } }), undefined)?.canUpdate).toBe(false);
    expect(hubBanner(status({ keyMissing: true }), undefined)?.canUpdate).toBe(false);
    expect(hubBanner(status({ latest: { version: '0.5.0', notes: '', signed: false } }), undefined)?.canUpdate).toBe(false);
    // an update that runs shows even after Later
    expect(hubBanner(status({ job: job({ phase: 'installing' }) }), '0.5.0')).toEqual({ version: '0.5.0', canUpdate: true, running: true });
  });

  test('its words', () => {
    expect(bannerWords({ version: '0.5.0', canUpdate: true, running: false })).toBe('Conclave 0.5.0 is ready to install.');
    expect(bannerWords({ version: '0.5.0', canUpdate: false, running: false })).toBe('Conclave 0.5.0 is out.');
  });
});

describe('the popup at start', () => {
  const on = { startup: true };

  test('versions compare by their numbers, a pre-release before its release', () => {
    expect(compareVersions('0.4.10', '0.4.9')).toBe(1);
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0);
    expect(compareVersions('v0.5.0', '0.5.0')).toBe(0);
    expect(compareVersions('0.5', '0.5.0')).toBe(0);
    expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });

  test('a newer release pops up at start, with the first line of its notes', () => {
    expect(popupFor(status(), on)).toEqual({ version: '0.5.0', canUpdate: true, notes: 'What changed' });
    expect(popupFor(status({ available: false }), on)).toBeUndefined();
    expect(popupFor(undefined, on)).toBeUndefined();
    expect(popupTitle('0.5.0')).toBe('Conclave 0.5.0 is ready');
    // a hub that updates another way still says so, without Update now
    expect(popupFor(status({ install: { kind: 'docker', canUpdate: false } }), on)?.canUpdate).toBe(false);
    // an update that already runs does not pop up again
    expect(popupFor(status({ job: job({ phase: 'installing' }) }), on)).toBeUndefined();
  });

  test('Skip this version hides it until a newer one', () => {
    expect(updateWaiting(status(), { skipped: '0.5.0' })).toBe(false);
    expect(popupFor(status(), { startup: true, skipped: '0.5.0' })).toBeUndefined();
    expect(updateDot(status(), { skipped: '0.5.0' })).toBe(false);
    // 0.5.1 is newer than the skipped 0.5.0: it shows again
    const newer = status({ latest: { version: '0.5.1', notes: '', signed: true } });
    expect(popupFor(newer, { startup: true, skipped: '0.5.0' })?.version).toBe('0.5.1');
    expect(updateDot(newer, { skipped: '0.5.0' })).toBe(true);
    // an older skip (from before) does not hide a newer release
    expect(updateWaiting(status(), { skipped: '0.4.9' })).toBe(true);
  });

  test("Don't show at startup leaves only the dot on the account row", () => {
    expect(popupFor(status(), { startup: false })).toBeUndefined();
    expect(updateDot(status(), {})).toBe(true);
    expect(updateDot(status({ available: false }), {})).toBe(false);
    // while an update runs the dot stays
    expect(updateDot(status({ available: false, job: job({ phase: 'restarting' }) }), {})).toBe(true);
  });

  test('the notes line is the first line, short, without list marks', () => {
    expect(notesLine('## New\n- Updates from the app.\n- More')).toBe('New');
    expect(notesLine('\n\n- Updates from the app: Settings, About.\nDevices too.')).toBe('Updates from the app: Settings, About.');
    expect(notesLine('')).toBeUndefined();
    expect(notesLine(undefined)).toBeUndefined();
    const long = notesLine('word '.repeat(60));
    expect(long!.length).toBeLessThanOrEqual(140);
    expect(long!.endsWith('…')).toBe(true);
  });

  test('its buttons: Update now, Skip this version and the startup switch; How to update where the hub cannot', () => {
    const wrap = (s: UpdateStatusDto, started = false) =>
      renderToStaticMarkup(
        <Router ssrPath="/">
          <UpdatePopupBody status={s} started={started} hideAtStart={false} onHideAtStart={() => {}} onUpdate={() => {}} onSkip={() => {}} onClose={() => {}} />
        </Router>,
      );
    const html = wrap(status());
    expect(html).toContain('Update now');
    expect(html).toContain('Skip this version');
    expect(html).toContain('Don&#x27;t show at startup');
    expect(html).toContain('What changed');
    const docker = wrap(status({ install: { kind: 'docker', canUpdate: false } }));
    expect(docker).not.toContain('Update now');
    expect(docker).toContain('How to update');
    expect(docker).toContain('/settings/about');
    // after Update now it follows the update
    expect(wrap(status({ job: job({ phase: 'restarting' }) }), true)).toContain('Restarting on Conclave 0.5.0.');
    expect(wrap(status({ available: false }))).toBe('');
  });
});

describe('Settings > About', () => {
  test('the newest release, and why Update now is not there', () => {
    expect(latestWords(status())).toBe('0.5.0 is out');
    expect(latestWords(status({ available: false, latest: { version: '0.4.1', notes: '', signed: true } }))).toBe('0.4.1 is the newest');
    expect(latestWords(status({ latest: undefined, checkError: 'No release has an update manifest yet.' }))).toBe('Could not check. No release has an update manifest yet.');
    expect(latestWords(status({ checking: true }))).toBe('Checking');
    expect(cannotWords(status())).toBeUndefined();
    expect(cannotWords(status({ keyMissing: true }))).toContain('no update key');
    expect(cannotWords(status({ install: { kind: 'docker', canUpdate: false, why: 'This hub runs in Docker.' } }))).toBe('This hub runs in Docker.');
    expect(installWords({ kind: 'systemd-system', canUpdate: true })).toBe('Container or VM, as a system service');
  });

  test('each step of an update, and its end', () => {
    expect(jobRunning(job({}))).toBe(true);
    expect(jobRunning(job({ phase: 'done' }))).toBe(false);
    expect(jobWords(job({ done: 50, total: 200 }))).toBe('Downloading Conclave 0.5.0, 25%.');
    expect(jobWords(job({ phase: 'checking' }))).toBe('Checking the signature of Conclave 0.5.0.');
    expect(jobWords(job({ phase: 'rolled-back' }))).toBe('Conclave 0.5.0 did not start, so the hub went back to 0.4.1.');
    expect(jobWords(job({ phase: 'failed', message: 'The update signature does not match the file. Nothing was installed.' }))).toContain('signature');
  });
});

describe('a device daemon', () => {
  const u = (p: Partial<DeviceUpdateDto>): DeviceUpdateDto => ({ deviceId: 'd', current: '0.4.1', target: '0.5.0', mode: 'self', behind: true, ...p });

  test('Update for an older daemon that can do it, online', () => {
    expect(deviceUpdateView(u({}), true)).toEqual({ words: 'Older than the hub. Update to 0.5.0.', tone: 'warn', action: true });
    expect(deviceUpdateView(u({}), false).action).toBe(false);
    expect(deviceUpdateView(u({ behind: false, current: '0.5.0' }), true)).toEqual({ tone: 'dim', action: false });
    expect(deviceUpdateView(undefined, true)).toEqual({ tone: 'dim', action: false });
  });

  test('the desktop app keeps its own, a manual one says how, and the result shows', () => {
    expect(deviceUpdateView(u({ mode: 'app' }), true).words).toContain('desktop app');
    expect(deviceUpdateView(u({ mode: 'manual', why: 'Run conclave daemon install --start.' }), true)).toMatchObject({ tone: 'warn', action: false });
    expect(deviceUpdateView(u({ state: 'sent', message: 'Sent 0.5.0.' }), true)).toEqual({ words: 'Sent 0.5.0.', tone: 'dim', action: false });
    expect(deviceUpdateView(u({ state: 'failed', message: 'The update signature does not match the file.' }), true)).toMatchObject({ tone: 'fault', action: true });
    expect(deviceUpdateView(u({ state: 'done', behind: false, current: '0.5.0', message: 'Updated to 0.5.0.' }), true)).toEqual({ words: 'Updated to 0.5.0.', tone: 'ok', action: false });
  });
});

test('no em or en dashes in the update words', () => {
  for (const f of ['src/lib/updates.ts', 'src/components/UpdateBanners.tsx', 'src/features/settings/updates.tsx', 'src/features/devices/DaemonUpdate.tsx', 'src/mock/updates.ts']) {
    const text = readFileSync(join(import.meta.dir, '..', f), 'utf8');
    expect({ f, dash: /[–—]/.test(text) }).toEqual({ f, dash: false });
  }
});
