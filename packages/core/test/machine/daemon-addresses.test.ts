import { afterEach, describe, expect, test } from 'bun:test';
import { hubUrls, isLoopbackUrl, isQuickTunnelUrl, runDaemon, type DaemonHandle } from '../../src/machine/daemon';
import { FakeMachine, waitFor } from './fake-machine';

/** A WebSocket the test drives: it records where the daemon dials and lets the test speak as the hub. */
class FakeSocket {
  static all: FakeSocket[] = [];
  /** Hosts that refuse connections. */
  static down = new Set<string>();
  readyState = 0;
  sent: any[] = [];
  closedWith?: number;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    setTimeout(() => {
      if (FakeSocket.down.has(new URL(url).host)) {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.({ code: 1006, reason: '' });
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 1);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  /** The hub says something. */
  hub(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = code;
    setTimeout(() => this.onclose?.({ code, reason }), 1);
  }
}

const hostOf = (s: FakeSocket) => new URL(s.url).host;
let daemon: DaemonHandle | undefined;

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  FakeSocket.all = [];
  FakeSocket.down.clear();
});

async function online(sock: FakeSocket) {
  await waitFor(() => sock.sent.some((m) => m.type === 'hello'), 1000, 'hello');
  sock.hub({ type: 'welcome', version: 1, deviceId: 'dev1', name: 'pc' });
}

describe('daemon and the hub addresses', () => {
  test('moves to the new address when the hub drops the one in use, and saves the list', async () => {
    const saved: string[][] = [];
    daemon = runDaemon({
      hubUrl: 'https://old-words.trycloudflare.com',
      fallbackUrls: ['http://192.168.1.20:7717'],
      deviceId: 'dev1',
      token: 't',
      machine: new FakeMachine('pc', 'pc'),
      maxBackoffMs: 20,
      onAddresses: (urls) => saved.push(urls),
      WebSocketImpl: FakeSocket,
    });
    await waitFor(() => FakeSocket.all.length === 1, 500, 'first dial');
    const first = FakeSocket.all[0];
    expect(first.url).toBe('wss://old-words.trycloudflare.com/api/daemon?deviceId=dev1');
    await online(first);
    await waitFor(() => daemon!.state === 'online', 500, 'online');

    first.hub({ type: 'addresses', urls: ['https://new-words.trycloudflare.com', 'http://192.168.1.20:7717'] });
    expect(saved).toEqual([['https://new-words.trycloudflare.com', 'http://192.168.1.20:7717']]);
    await waitFor(() => FakeSocket.all.length === 2, 500, 'dial to the new address');
    expect(first.closedWith).toBe(1000);
    expect(hostOf(FakeSocket.all[1])).toBe('new-words.trycloudflare.com');
  });

  test('a quick tunnel address the hub dropped is never tried again', async () => {
    daemon = runDaemon({ hubUrl: 'https://old-words.trycloudflare.com', deviceId: 'dev1', token: 't', machine: new FakeMachine('pc', 'pc'), maxBackoffMs: 10, WebSocketImpl: FakeSocket });
    await waitFor(() => FakeSocket.all.length === 1, 500, 'first dial');
    await online(FakeSocket.all[0]);
    FakeSocket.down.add('new-words.trycloudflare.com');
    FakeSocket.down.add('192.168.1.20:7717');
    FakeSocket.all[0].hub({ type: 'addresses', urls: ['https://new-words.trycloudflare.com', 'http://192.168.1.20:7717'] });
    await waitFor(() => FakeSocket.all.length >= 5, 1500, 'several dials');
    const hosts = FakeSocket.all.slice(1).map(hostOf);
    expect(hosts).toContain('192.168.1.20:7717');
    expect(hosts).not.toContain('old-words.trycloudflare.com');
  });

  test('stays on an address that is still listed, such as the same network', async () => {
    daemon = runDaemon({ hubUrl: 'http://192.168.1.20:7717', deviceId: 'dev1', token: 't', machine: new FakeMachine('pc', 'pc'), maxBackoffMs: 20, WebSocketImpl: FakeSocket });
    await waitFor(() => FakeSocket.all.length === 1, 500, 'dial');
    const sock = FakeSocket.all[0];
    await online(sock);
    sock.hub({ type: 'addresses', urls: ['https://a-b.trycloudflare.com', 'http://192.168.1.20:7717'] });
    await Bun.sleep(30);
    expect(FakeSocket.all).toHaveLength(1);
    expect(sock.closedWith).toBeUndefined();
  });

  test('when the address in use stops answering it tries the others in turn', async () => {
    daemon = runDaemon({
      hubUrl: 'https://gone-words.trycloudflare.com',
      fallbackUrls: ['http://192.168.1.20:7717'],
      deviceId: 'dev1',
      token: 't',
      machine: new FakeMachine('pc', 'pc'),
      maxBackoffMs: 10,
      WebSocketImpl: FakeSocket,
    });
    FakeSocket.down.add('gone-words.trycloudflare.com');
    await waitFor(() => FakeSocket.all.length >= 2, 1000, 'second dial');
    expect(hostOf(FakeSocket.all[0])).toBe('gone-words.trycloudflare.com');
    expect(hostOf(FakeSocket.all[1])).toBe('192.168.1.20:7717');
  });

  test('a daemon on the hub machine keeps its loopback address', async () => {
    daemon = runDaemon({ hubUrl: 'http://127.0.0.1:7717', deviceId: 'dev1', token: 't', machine: new FakeMachine('pc', 'pc'), maxBackoffMs: 20, WebSocketImpl: FakeSocket });
    await waitFor(() => FakeSocket.all.length === 1, 500, 'dial');
    const sock = FakeSocket.all[0];
    await online(sock);
    sock.hub({ type: 'addresses', urls: ['https://a-b.trycloudflare.com'] });
    await Bun.sleep(30);
    expect(FakeSocket.all).toHaveLength(1);
  });

  test('hubUrls and isLoopbackUrl', () => {
    expect(hubUrls(['https://a.example/', 'https://a.example', 'nope', 3, 'ws://b:1'])).toEqual(['https://a.example', 'ws://b:1']);
    expect(isLoopbackUrl('http://localhost:7717')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:7717/')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.2:7717')).toBe(false);
    expect(isLoopbackUrl('https://localhost.evil.example')).toBe(false);
    expect(isQuickTunnelUrl('https://sea-river-cloud.trycloudflare.com')).toBe(true);
    expect(isQuickTunnelUrl('https://hub.example.com')).toBe(false);
    expect(isQuickTunnelUrl('https://trycloudflare.com.evil.example')).toBe(false);
  });
});
