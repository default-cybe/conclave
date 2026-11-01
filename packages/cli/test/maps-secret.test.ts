/**
 * `conclave secret google-maps --value ...` stores the Maps key where
 * Settings > Maps does, then tests each Google Maps API against the fake
 * Google, and never prints the key.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaps } from '@conclave/core/engine/create.ts';
import { attachMaps } from '@conclave/core/maps/index.ts';
import { OWNER, startHub, type TestHub } from '../../server/test/helpers';
import { FAKE_KEY, startFakeGoogle, type FakeGoogle } from '../../core/test/maps/fakes';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
let hub: TestHub;
let google: FakeGoogle;
let home: string;

beforeAll(() => {
  google = startFakeGoogle();
  process.env.CONCLAVE_MAPS_GOOGLE_URL = google.url;
  hub = startHub();
  attachMaps(hub.engine, createMaps(hub.engine, hub.engine.config, hub.engine.repos, () => 'Europe/Berlin', 'test'));
  home = mkdtempSync(join(tmpdir(), 'conclave-maps-cli-'));
});

afterAll(async () => {
  await hub.stop();
  google.stop();
  delete process.env.CONCLAVE_MAPS_GOOGLE_URL;
  rmSync(home, { recursive: true, force: true });
});

describe('conclave secret google-maps', () => {
  test('saves the key on the hub and tests every Maps API', async () => {
    const { CONCLAVE_HUB: _h, CONCLAVE_TOKEN: _t, ...env } = process.env;
    const proc = Bun.spawn([process.execPath, ENTRY, 'secret', 'google-maps', '--value', FAKE_KEY, '--hub', hub.url, '--token', OWNER], { env: { ...env, CONCLAVE_HOME: home, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(hub.engine.config.storedKey('google-maps')).toBe(FAKE_KEY);
    expect(stdout).toContain('Saved the google-maps key on the hub (AIza…)');
    for (const name of ['Geocoding API', 'Places API (New)', 'Routes API', 'Time Zone API', 'Maps Static API']) expect(stdout).toMatch(new RegExp(`✓ ${name.replace(/[()]/g, '\\$&')}: Works\\.`));
    expect(stdout).not.toContain(FAKE_KEY);
  });
});
