/**
 * Phones and pairing codes, from the owner's first real setup:
 *
 * - The Android app paired from setup step 8 and was connected, but the step
 *   kept "Waiting for the phone": a phone pairs as an app (POST /api/pair),
 *   and the step looked for it among the hub's devices only.
 * - Then phones were mixed into Devices as if they were devices; the owner
 *   found that wrong: a phone or a browser only talks to the hub and runs no
 *   work. Devices and the device pickers list computers only; the apps are
 *   in Settings, Your account, Signed in (signed-in.test.tsx).
 * - A QR made before remote access was set kept only the LAN address: the
 *   panel now asks for the same code again when the hub's addresses change.
 *
 *   bun test packages/web/test/pairing-phones.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AppDto } from '@conclave/core/client';
import type { Device, RemoteStatus } from '@conclave/core/types';
import { connectClient } from '../src/lib/api';
import { applyEvent, loadAll, useHub } from '../src/store/store';
import { isPhoneApp, phoneApps, signedIn } from '../src/lib/apps';
import { pairingStale } from '../src/lib/remote';

const hubDevice: Device = { id: 'local', name: 'homelab', online: true, roots: [], createdAt: 1, info: { hostname: 'homelab', platform: 'linux', arch: 'x64', home: '/root', shell: '/bin/bash', clis: {}, capabilities: [] } };
const mac: Device = { ...hubDevice, id: 'dev_mac', name: 'MacBook', createdAt: 2, info: { ...hubDevice.info!, hostname: 'MacBook', platform: 'darwin' } };
const pixel: AppDto = { id: 'cli_pixel', name: 'Pixel 8', platform: 'android', createdAt: 2, lastSeenAt: 3, revoked: false, accountId: 'owner', online: true };
const laptop: AppDto = { id: 'cli_laptop', name: 'Firefox on Linux', platform: 'web', createdAt: 2, revoked: false, accountId: 'owner' };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  const body = path === '/api/devices' ? [hubDevice, mac] : path === '/api/clients' ? [pixel, laptop, { ...laptop, id: 'cli_old', platform: 'ios', revoked: true }] : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('a phone paired with a code', () => {
  test('the hub lists it as an app; Devices lists the computers only', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    await loadAll();
    const st = useHub.getState();
    // what Devices, the device pickers and setup count as devices: the computers that run the device agent
    expect(Object.keys(st.devices).sort()).toEqual(['dev_mac', 'local']);
    // what setup's Devices step and the pairing panel read for the phone
    expect(phoneApps(st.apps).map((a) => a.name)).toEqual(['Pixel 8']);
    // what Settings, Your account lists as Signed in: phones and browsers, not the revoked one
    expect(signedIn(st.apps).map((a) => a.id)).toEqual(['cli_pixel', 'cli_laptop']);
  });

  test('the iPhone web app pairing while the step is open shows up from app.updated, and goes when revoked', () => {
    const iphone: AppDto = { id: 'cli_iphone', name: 'Safari on iOS', platform: 'ios', createdAt: 5, revoked: false, accountId: 'owner', online: false };
    applyEvent({ type: 'app.updated', app: iphone, seq: 1, ts: 5 });
    expect(phoneApps(useHub.getState().apps).map((a) => a.name)).toEqual(['Pixel 8', 'Safari on iOS']);
    expect(Object.keys(useHub.getState().devices)).not.toContain('cli_iphone');
    applyEvent({ type: 'app.updated', app: { ...iphone, revoked: true }, seq: 2, ts: 6 });
    expect(phoneApps(useHub.getState().apps).map((a) => a.name)).toEqual(['Pixel 8']);
  });

  test('only android and ios apps that still work are phones', () => {
    expect(isPhoneApp(pixel)).toBe(true);
    expect(isPhoneApp({ ...pixel, revoked: true })).toBe(false);
    expect(isPhoneApp(laptop)).toBe(false);
    expect(isPhoneApp({ ...laptop, platform: 'desktop' })).toBe(false);
    expect(isPhoneApp({ ...laptop, platform: undefined })).toBe(false);
  });
});

describe('a pairing code shown while the hub address changes', () => {
  const remote = (...urls: string[]): Pick<RemoteStatus, 'addresses'> => ({ addresses: urls.map((url) => ({ url, kind: url.startsWith('https') ? 'own' : 'lan', label: url })) });
  const lan = 'http://192.168.1.50:7717';

  test('a code that has only the LAN address is stale once the owner adds their URL', () => {
    const shown = { url: lan, addresses: [lan] };
    expect(pairingStale(shown, remote(lan))).toBe(false);
    expect(pairingStale(shown, remote('https://hub.example.com', lan))).toBe(true);
    // the refreshed code carries both, own URL first
    expect(pairingStale({ url: 'https://hub.example.com', addresses: ['https://hub.example.com', lan] }, remote('https://hub.example.com', lan))).toBe(false);
  });

  test('a tunnel that moved, or one that went away, also makes it stale', () => {
    const shown = { url: 'https://a-b-c.trycloudflare.com', addresses: ['https://a-b-c.trycloudflare.com', lan] };
    expect(pairingStale(shown, remote('https://d-e-f.trycloudflare.com', lan))).toBe(true);
    expect(pairingStale(shown, remote(lan))).toBe(true);
  });

  test('with nothing known, or no addresses but this computer, there is nothing newer', () => {
    expect(pairingStale({ url: 'http://127.0.0.1:7717', addresses: ['http://127.0.0.1:7717'] }, undefined)).toBe(false);
    expect(pairingStale({ url: 'http://127.0.0.1:7717', addresses: ['http://127.0.0.1:7717'] }, remote())).toBe(false);
    // a hub too old to list addresses in the code
    expect(pairingStale({ url: lan }, remote(lan))).toBe(false);
  });
});
