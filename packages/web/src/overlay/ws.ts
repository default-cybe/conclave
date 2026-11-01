/**
 * The overlay's own WebSocket client (docs/design/MEETING-MODE.md 2.3): the
 * app's ConclaveClient is too big for this window. It speaks the hub's
 * /api/ws protocol (server/src/ws/clients.ts): hello, since, subscribe,
 * resync and ping. After a reconnect it subscribes again and asks for the
 * events it missed with since; when the hub cannot replay them (resync, or
 * a hub that restarted) onResync refetches the meeting.
 */
export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsOptions {
  /** The hub's address, http(s)://host[:port]. */
  baseUrl: string;
  token: string;
  /** Sessions whose live deltas this socket wants. */
  sessions: () => string[];
  onEvent: (e: { type: string; seq?: number } & Record<string, unknown>) => void;
  onStatus?: (s: WsStatus) => void;
  onResync?: () => void;
  WebSocketImpl?: typeof WebSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** Backoff after a drop: 0.5, 1, 2, 4, 8 s, then every 8 s. */
export function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

const PING_MS = 25_000;

export interface WsHandle {
  close(): void;
  /** Send the subscribe frame again (the meeting's session became known). */
  resubscribe(): void;
}

export function connectWs(o: WsOptions): WsHandle {
  const WS = o.WebSocketImpl ?? WebSocket;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let ws: WebSocket | undefined;
  let lastSeq = 0;
  let attempt = 0;
  let closed = false;
  let retry: unknown;
  let ping: unknown;
  const send = (data: unknown) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
  };
  const subscribe = () => send({ type: 'subscribe', sessions: o.sessions() });
  // one timer at a time, re-armed after each ping: no interval runs while the socket is down
  const armPing = () => {
    ping = setTimer(() => {
      send({ type: 'ping' });
      armPing();
    }, PING_MS);
  };
  const open = () => {
    if (closed) return;
    o.onStatus?.('connecting');
    const s = new WS(`${o.baseUrl.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(o.token)}`);
    ws = s;
    s.onopen = () => {
      attempt = 0;
      o.onStatus?.('open');
      subscribe();
      if (lastSeq) send({ type: 'since', seq: lastSeq });
      armPing();
    };
    s.onmessage = (m: MessageEvent) => {
      let data: { type?: string; seq?: number } & Record<string, unknown>;
      try {
        data = JSON.parse(typeof m.data === 'string' ? m.data : '');
      } catch {
        return;
      }
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'hello') {
        // a hub that restarted counts from 0 again: what we missed will never come
        if (lastSeq && typeof data.seq === 'number' && data.seq < lastSeq) {
          lastSeq = data.seq;
          o.onResync?.();
        } else if (!lastSeq && typeof data.seq === 'number') lastSeq = data.seq;
        return;
      }
      if (data.type === 'resync') {
        if (typeof data.seq === 'number') lastSeq = data.seq;
        o.onResync?.();
        return;
      }
      if (data.type === 'pong') return;
      if (typeof data.seq === 'number' && data.seq > lastSeq) lastSeq = data.seq;
      o.onEvent(data as { type: string });
    };
    s.onclose = () => {
      if (ws !== s) return;
      clearTimer(ping);
      o.onStatus?.('closed');
      if (closed) return;
      retry = setTimer(open, backoff(attempt++));
    };
    s.onerror = () => s.close();
  };
  open();
  return {
    close() {
      closed = true;
      clearTimer(retry);
      clearTimer(ping);
      const s = ws;
      ws = undefined;
      if (!s) return;
      s.onclose = null;
      s.onmessage = null;
      if (s.readyState === 0) s.onopen = () => s.close();
      else s.close();
      o.onStatus?.('closed');
    },
    resubscribe: subscribe,
  };
}
