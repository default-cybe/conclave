/**
 * Mock routes for updates (docs/DESIGN.md, Updates): the demo hub runs 0.1.0
 * as a service of its user and 0.2.0 is out; Update now walks through the
 * steps and ends where a real hub would restart. Devices: every paired
 * device's daemon is on the hub's version.
 */
import type { DeviceUpdateDto, UpdateJobDto, UpdateStatusDto } from '@conclave/core/client';
import type { MockCtx } from './index';

export function registerUpdates(ctx: MockCtx) {
  const { on, fail, db, FRESH } = ctx;
  const current = '0.1.0';
  let checkedAt = Date.now() - 5 * 3_600_000;
  let auto = true;
  let window: 'idle' | 'night' = 'idle';
  let job: UpdateJobDto | undefined;
  const latest = FRESH ? undefined : { version: '0.2.0', notes: 'Updates from the app: Settings, About on the hub, the desktop app and the Android app.\nDevices update their daemons from the Devices page.', pubDate: new Date(Date.now() - 86_400_000).toISOString(), signed: true };

  const status = (): UpdateStatusDto => ({
    current,
    ...(latest ? { latest } : {}),
    available: !!latest,
    checkedAt,
    checking: false,
    install: { kind: 'systemd-user', canUpdate: true, dir: '/home/sam/.local/share/conclave' },
    keyMissing: false,
    auto: { on: auto, window, hours: '03:00 to 05:00' },
    ...(job ? { job: { ...job } } : {}),
  });

  on('GET', '/api/update', () => status());
  on('POST', '/api/update/check', () => {
    checkedAt = Date.now();
    return status();
  });
  on('POST', '/api/update/apply', ({ body }: { body?: { version?: string } }) => {
    if (!latest || body?.version !== latest.version) fail(409, 'That is not the newest release.');
    const j: UpdateJobDto = { id: 'job1', version: latest!.version, from: current, phase: 'downloading', startedAt: Date.now(), by: 'owner', done: 0, total: 60_000_000 };
    job = j;
    const steps: Array<Partial<UpdateJobDto>> = [{ done: 30_000_000 }, { done: 60_000_000 }, { phase: 'checking' }, { phase: 'installing' }, { phase: 'restarting' }, { phase: 'verifying' }];
    steps.forEach((s, i) => setTimeout(() => job === j && Object.assign(j, s), (i + 1) * 900));
    setTimeout(() => job === j && Object.assign(j, { phase: 'failed', message: 'The demo hub cannot restart itself. A real one would be on 0.2.0 now.', finishedAt: Date.now() }), (steps.length + 1) * 900);
    return status();
  });
  on('PUT', '/api/update/settings', ({ body }: { body?: { auto?: boolean; window?: 'idle' | 'night' } }) => {
    if (body?.auto !== undefined) auto = body.auto === true;
    if (body?.window) window = body.window;
    return status();
  });
  on('GET', '/api/devices/updates', () => ({
    hubVersion: current,
    devices: [...db.devices.values()]
      .filter((d) => d.id !== 'local')
      .map((d): DeviceUpdateDto => ({ deviceId: d.id, current: d.info?.daemon?.version ?? current, target: current, mode: 'self', behind: false })),
  }));
  on('POST', '/api/devices/:id/update', () => fail(409, 'This device already runs 0.1.0.'));
}
