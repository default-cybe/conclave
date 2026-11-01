import { expect, test } from 'bun:test';
import { ConclaveClient } from '../../src/client';
import type { EngineEventEnvelope } from '../../src/types';

/** A socket the test drives: it opens at once and takes frames from `frames`. */
class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  frame(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

test('a resync calls onResync; config.updated stays a config change', async () => {
  const events: EngineEventEnvelope[] = [];
  let resyncs = 0;
  const client = new ConclaveClient({ baseUrl: 'http://hub.test', token: 't' });
  const stop = client.connect((e) => events.push(e), { onResync: () => resyncs++, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
  await Bun.sleep(0);
  const ws = FakeSocket.last!;
  ws.frame({ type: 'hello', seq: 3 });
  ws.frame({ type: 'resync', seq: 40 });
  expect(resyncs).toBe(1);
  expect(events).toEqual([]);
  ws.frame({ type: 'config.updated', seq: 41, ts: 1 });
  expect(events.map((e) => e.type)).toEqual(['config.updated']);
  expect(resyncs).toBe(1);
  stop();
});

test('a hub that restarted (hello seq below ours) means a resync, and the seq starts again from its count', async () => {
  let resyncs = 0;
  const client = new ConclaveClient({ baseUrl: 'http://hub.test', token: 't' });
  const stop = client.connect(() => {}, { onResync: () => resyncs++, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
  await Bun.sleep(0);
  const first = FakeSocket.last!;
  first.frame({ type: 'hello', seq: 10 });
  first.frame({ type: 'config.updated', seq: 5000, ts: 1 });
  expect(resyncs).toBe(0);
  // the hub restarts: the socket drops, the client reconnects and the new hello counts from 2
  first.readyState = 3;
  first.onclose?.();
  await Bun.sleep(600);
  const second = FakeSocket.last!;
  expect(second).not.toBe(first);
  expect(second.sent).toContain(JSON.stringify({ type: 'since', seq: 5000 }));
  second.frame({ type: 'hello', seq: 2 });
  expect(resyncs).toBe(1);
  // the next reconnect asks from the new count, not 5000
  second.readyState = 3;
  second.onclose?.();
  await Bun.sleep(1100);
  expect(FakeSocket.last!.sent).toContain(JSON.stringify({ type: 'since', seq: 2 }));
  stop();
});
