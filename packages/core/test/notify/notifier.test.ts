import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { ConfigStore } from '../../src/config';
import { NotifierService, endpointId, privatePushHost, validPushKeys } from '../../src/notify/notifier';
import { approvalActionUrl, deepLink, pushPayload } from '../../src/notify/channels';
import type { Notice } from '../../src/types';

interface Sent {
  endpoint: string;
  payload: Record<string, any>;
  options: Record<string, any>;
}

let home: string;
let db: Db;
let config: ConfigStore;
let bus: EventBus;
let notices: Notice[];
let repos: Repos;
let sent: Sent[];
/** Endpoints the fake push service answers with this status. */
let failWith: Record<string, number>;

const lib = {
  generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
  sendNotification: async (sub: { endpoint: string }, payload: string, options: Record<string, unknown>) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
    const status = failWith[sub.endpoint];
    if (status === -1) throw new Error('Network down');
    if (status === -2) throw new Error('Public key is not valid for specified curve');
    if (status) throw Object.assign(new Error(status === 410 ? 'Gone' : 'Server error'), { statusCode: status });
    return {};
  },
};

beforeEach(() => {
  sent = [];
  failWith = {};
  home = mkdtempSync(join(tmpdir(), 'conclave-notify-'));
  config = new ConfigStore(home);
  config.update({
    server: { ...config.get().server, publicUrl: 'https://hub.example.ts.net/' },
    notifications: { ...config.get().notifications, idleSeconds: 60 },
  });
  db = openDb(':memory:');
  repos = new Repos(db);
  bus = new EventBus();
  notices = [];
  bus.on((e) => {
    if (e.type === 'notice') notices.push(e.notice);
  });
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function mk(extra: Partial<ConstructorParameters<typeof NotifierService>[0]> = {}) {
  return new NotifierService({ db, repos, bus, config, signAction: (id, d) => `sig-${id}-${d}`, webPush: lib, ...extra });
}

/** Keys like a browser sends: a P-256 public key and a 16 byte secret. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const KEYS = browserKeys();

function subscribe(n: NotifierService, endpoint: string, device?: string) {
  n.addPushSubscription({ endpoint, keys: KEYS }, device);
}

describe('Web Push', () => {
  test('payload carries the deep link and signed Allow and Deny links the server accepts', async () => {
    const n = mk();
    subscribe(n, 'https://push.example/phone', 'Safari on iOS');
    const notice = await n.send({ title: 'Approval needed', body: 'Run: git push', level: 'warning', sessionId: 'ses_1', link: '/s/ses_1', approvalId: 'apv_1' });
    expect(notice.id).toMatch(/^ntc_/);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({
      id: notice.id,
      title: 'Approval needed',
      body: 'Run: git push',
      level: 'warning',
      link: '/s/ses_1',
      url: 'https://hub.example.ts.net/s/ses_1',
      approvalId: 'apv_1',
      approveUrl: 'https://hub.example.ts.net/api/approvals/apv_1/act?decision=allow&sig=sig-apv_1-allow',
      denyUrl: 'https://hub.example.ts.net/api/approvals/apv_1/act?decision=deny&sig=sig-apv_1-deny',
      sessionId: 'ses_1',
      tag: 'approval-apv_1',
    });
    expect(sent[0].options.urgency).toBe('high');
    expect(sent[0].options.vapidDetails).toEqual({ subject: 'https://hub.example.ts.net/', publicKey: 'PUB', privateKey: 'PRIV' });
  });

  test('without a public URL the signed links are paths the service worker sends to its own hub', async () => {
    config.update({ server: { ...config.get().server, publicUrl: '' } });
    const n = mk();
    subscribe(n, 'https://push.example/a');
    await n.send({ title: 'Approval needed', body: 'b', level: 'warning', approvalId: 'apv_2', sessionId: 's2' });
    expect(sent[0].payload.approveUrl).toBe('/api/approvals/apv_2/act?decision=allow&sig=sig-apv_2-allow');
    expect(sent[0].payload.denyUrl).toBe('/api/approvals/apv_2/act?decision=deny&sig=sig-apv_2-deny');
    expect(sent[0].payload.url).toBeUndefined();
    expect(sent[0].payload.link).toBe('/s/s2');
  });

  test('notices of one job share a tag so the device replaces instead of stacking', () => {
    const base: Notice = { id: 'n', title: 'Workflow w', body: 'Finished', level: 'success', createdAt: 0, sessionId: 's1' };
    expect(pushPayload({ ...base, thread: 'workflow-r1' }, undefined).tag).toBe('thread-workflow-r1');
    expect(pushPayload({ ...base, id: 'm', thread: 'workflow-r1' }, undefined).tag).toBe('thread-workflow-r1');
    expect(pushPayload(base, undefined).tag).toBe('session-s1');
    expect(pushPayload({ ...base, thread: 't', approvalId: 'a1' }, undefined).tag).toBe('approval-a1');
  });

  test('a long body is cut so the push fits, also in wide scripts', () => {
    const notice: Notice = { id: 'n', title: 'Routine: digest', body: '\u65e5\u672c\u8a9e'.repeat(900), level: 'info', createdAt: 0, sessionId: 's1' };
    const payload = pushPayload(notice, 'https://hub.example', (id, d) => `${id}${d}`);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(3000);
    expect(String(payload.body)).toEndWith('...');
    expect(String(payload.body).length).toBeGreaterThan(100);
    const short = pushPayload({ ...notice, body: 'Done' }, undefined);
    expect(short.body).toBe('Done');
  });

  test('VAPID keys are generated once and kept', () => {
    const n = mk();
    expect(n.vapidPublicKey()).toBe('PUB');
    expect(repos.kv.get<unknown>('vapid', null)).toEqual({ publicKey: 'PUB', privateKey: 'PRIV' });
    expect(mk({ webPush: { ...lib, generateVAPIDKeys: () => ({ publicKey: 'OTHER', privateKey: 'X' }) } }).vapidPublicKey()).toBe('PUB');
  });

  test('subscriptions the browser ended (410) are dropped', async () => {
    const n = mk();
    subscribe(n, 'https://push.example/ok', 'Chrome on macOS');
    subscribe(n, 'https://push.example/gone');
    failWith['https://push.example/gone'] = 410;
    await n.send({ title: 'T', body: 'B', level: 'error', sessionId: 's1' });
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example/gone', 'https://push.example/ok']);
    expect(n.devices().map((d) => d.name)).toEqual(['Chrome on macOS']);
  });

  test('devices are listed by a short id and can be removed', () => {
    const n = mk();
    subscribe(n, 'https://push.example/one', 'Firefox on Linux');
    subscribe(n, 'https://push.example/two', 'Safari on iOS');
    const list = n.devices();
    expect(list).toEqual([
      { id: endpointId('https://push.example/one'), name: 'Firefox on Linux', kind: 'webpush', createdAt: expect.any(Number) },
      { id: endpointId('https://push.example/two'), name: 'Safari on iOS', kind: 'webpush', createdAt: expect.any(Number) },
    ]);
    expect(list[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list)).not.toContain('push.example');
    expect(n.removeDevice(list[0].id)).toBe(true);
    expect(n.removeDevice(list[0].id)).toBe(false);
    n.removePushSubscription('https://push.example/two');
    expect(n.devices()).toEqual([]);
    expect(n.channels()).toEqual([{ id: 'webpush', enabled: false }]);
  });

  test('a subscription without keys or https is refused with what to do', () => {
    const n = mk();
    expect(() => n.addPushSubscription({ endpoint: 'http://push.example/x', keys: KEYS })).toThrow(/turn Notify this device on again/);
    // keys that cannot encrypt a push: refused now, not when the first push fails
    expect(() => n.addPushSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } })).toThrow(/turn Notify this device on again/);
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
    expect(validPushKeys({ p256dh: offCurve, auth: KEYS.auth })).toBe(false);
    expect(validPushKeys(KEYS)).toBe(true);
    expect(n.devices()).toEqual([]);
  });

  test('the hub never posts to a push address on this machine or a private network', () => {
    const n = mk();
    for (const endpoint of ['https://127.0.0.1:9/x', 'https://localhost/x', 'https://10.0.0.4/x', 'https://192.168.1.20/x', 'https://[::1]/x', 'https://router.lan/x', 'https://100.101.102.103/x']) {
      expect(() => n.addPushSubscription({ endpoint, keys: KEYS })).toThrow(/private network/);
    }
    expect(privatePushHost('fcm.googleapis.com')).toBe(false);
    expect(privatePushHost('8.8.8.8')).toBe(false);
    expect(n.devices()).toEqual([]);
  });

  test('the hub keeps the newest 50 browsers', () => {
    let now = 1;
    const n = mk({ now: () => now++ });
    for (let i = 0; i < 52; i++) subscribe(n, `https://push.example/b${i}`, `Browser ${i}`);
    const names = n.devices().map((d) => d.name);
    expect(names).toHaveLength(50);
    expect(names[0]).toBe('Browser 2');
    expect(names.at(-1)).toBe('Browser 51');
  });
});

describe('test()', () => {
  test('with an endpoint only that browser gets the test', async () => {
    const n = mk();
    subscribe(n, 'https://push.example/laptop');
    subscribe(n, 'https://push.example/phone');
    await n.test('webpush', { endpoint: 'https://push.example/phone' });
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/phone']);
    expect(sent[0].payload).toMatchObject({ title: 'Conclave test', body: 'Notifications reach this device.', link: '/settings/notifications' });
    expect(notices).toEqual([]);
  });

  test('errors say what to do next', async () => {
    const n = mk();
    await expect(n.test('webpush')).rejects.toThrow('No browser is set up for notifications yet. Turn on Notify this device in Settings, then send a test.');
    await expect(n.test('webpush', { endpoint: 'https://push.example/nope' })).rejects.toMatchObject({ status: 409 });
    await expect(n.test('telegram')).rejects.toMatchObject({ status: 404, message: 'There is no notification channel called telegram. Use webpush.' });

    subscribe(n, 'https://push.example/gone');
    failWith['https://push.example/gone'] = 410;
    await expect(n.test('webpush', { endpoint: 'https://push.example/gone' })).rejects.toThrow('Turn Notify this device off and on again.');

    subscribe(n, 'https://push.example/down');
    failWith['https://push.example/down'] = 500;
    await expect(n.test('webpush', { endpoint: 'https://push.example/down' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('(500 Server error). Turn Notify this device off and on again.') });

    subscribe(n, 'https://push.example/offline');
    failWith['https://push.example/offline'] = -1;
    await expect(n.test('webpush', { endpoint: 'https://push.example/offline' })).rejects.toThrow(/could not reach the browser's push service \(Network down\)\. Check that the hub can reach the internet/);

    // a failure that is not the network does not blame the internet
    subscribe(n, 'https://push.example/badkey');
    failWith['https://push.example/badkey'] = -2;
    await expect(n.test('webpush', { endpoint: 'https://push.example/badkey' })).rejects.toThrow('The hub could not send the notification (Public key is not valid for specified curve). Turn Notify this device off and on again.');
  });

  test('send never throws, even when every push fails', async () => {
    const n = mk();
    subscribe(n, 'https://push.example/down');
    failWith['https://push.example/down'] = 500;
    await expect(n.send({ title: 'x', body: 'y', level: 'error' })).resolves.toMatchObject({ title: 'x', alert: true });
  });
});

describe('held while someone is using Conclave', () => {
  test('notices still reach open apps; devices get only errors, approvals and forced sends', async () => {
    const n = mk();
    subscribe(n, 'https://push.example/phone');
    n.touch('web-1');
    await n.send({ title: 'info', body: 'b', level: 'info' });
    expect(sent).toHaveLength(0);
    await n.send({ title: 'err', body: 'b', level: 'error' });
    await n.send({ title: 'approval', body: 'b', level: 'info', approvalId: 'a1' });
    await n.send({ title: 'forced', body: 'b', level: 'info' }, { force: true });
    expect(sent.map((s) => s.payload.title)).toEqual(['err', 'approval', 'forced']);
    expect(notices.map((x) => [x.title, x.alert])).toEqual([
      ['info', undefined],
      ['err', true],
      ['approval', true],
      ['forced', true],
    ]);
  });

  test('stale touches do not count, and idleSeconds 0 never holds', async () => {
    let now = 1_000_000;
    const n = mk({ now: () => now });
    n.touch('web-1');
    now += 61_000;
    expect((await n.send({ title: 'later', body: 'b', level: 'info' })).alert).toBe(true);

    n.touch('web-1');
    config.update({ notifications: { ...config.get().notifications, idleSeconds: 0 } });
    expect((await n.send({ title: 'now', body: 'b', level: 'info' })).alert).toBe(true);
  });

  test('a client that leaves the foreground stops the hold at once', async () => {
    let now = 1_000_000;
    const n = mk({ now: () => now });
    n.touch('web-1');
    n.touch('phone-1');
    now += 5_000;
    n.release('web-1');
    expect((await n.send({ title: 'still held', body: 'b', level: 'info' })).alert).toBeUndefined();
    n.release('phone-1');
    expect((await n.send({ title: 'away', body: 'b', level: 'info' })).alert).toBe(true);
    n.release('never-seen');
  });

  test('a caller cannot set alert itself', async () => {
    const n = mk();
    n.touch('web-1');
    const notice = await n.send({ title: 'sneaky', body: 'b', level: 'info', alert: true } as never);
    expect(notice.alert).toBeUndefined();
  });
});

describe('cleanup from before notifications moved into the app', () => {
  test('UnifiedPush endpoints left in the database are removed on start', () => {
    repos.kv.set('unifiedpush.endpoints', [{ endpoint: 'https://ntfy.sh/upXYZ', createdAt: 1 }]);
    mk();
    expect(repos.kv.get<unknown>('unifiedpush.endpoints', null)).toBeNull();
    expect(mk().channels()).toEqual([{ id: 'webpush', enabled: false }]);
  });
});

describe('links', () => {
  test('deep links resolve against the public URL', () => {
    const base: Notice = { id: 'n', title: 't', body: '', level: 'info', createdAt: 0 };
    expect(deepLink({ ...base, sessionId: 's1' }, 'https://hub.example/')).toBe('https://hub.example/s/s1');
    expect(deepLink({ ...base, link: 'routines/r1' }, 'https://hub.example')).toBe('https://hub.example/routines/r1');
    expect(deepLink(base, undefined)).toBeUndefined();
    expect(approvalActionUrl('https://hub.example/', 'a b', 'deny', () => 'x/y')).toBe('https://hub.example/api/approvals/a%20b/act?decision=deny&sig=x%2Fy');
  });
});
