import type { ServerWebSocket } from 'bun';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { EngineEventEnvelope } from '@conclave/core/types.ts';
import { parseFrame } from '@conclave/core/machine/protocol.ts';
import { eventVisibleTo } from '@conclave/core/people/events.ts';
import { sharedChatEventView, sharedEventSession } from '@conclave/core/people/shared-chats.ts';

export interface ClientSocketData {
  kind: 'client';
  /** "owner" or a paired client id. */
  clientId: string;
  /** Whose socket (docs/design/ACCOUNTS.md 4): it gets that account's events and the hub wide ones only. Missing: the owner's. */
  accountId?: string;
  /** Session ids whose live deltas this socket wants. null means all. */
  filter: Set<string> | null;
  /**
   * Presence, for apps that report it (?active=0 on connect, then
   * {type:'presence', active}). True: in the foreground; each presence frame
   * with active:true counts as use, so apps send one on input or as a
   * heartbeat. False: in the background; the hub stops holding notifications
   * for this client at once. Unset for clients that never report presence:
   * every frame counts as use, as before.
   */
  active?: boolean;
  /** The Map is open: send map.delta events ({type:'map', on}). Off by default. */
  map?: boolean;
}

/** Drop high-volume deltas for a socket once this much is queued, close it past the hard cap. */
const SOFT_BUFFER = 4 * 1024 * 1024;
const HARD_BUFFER = 32 * 1024 * 1024;

function isLive(e: EngineEventEnvelope): e is Extract<EngineEventEnvelope, { type: 'message.delta' | 'tool.progress' }> {
  return e.type === 'message.delta' || e.type === 'tool.progress';
}

/**
 * /api/ws fan-out. Every bus event goes to the sockets of its account as JSON
 * (the bus stamps each event with its account, people/events.ts). Clients can
 * catch up after a reconnect with {type:'since', seq} and can limit live
 * deltas to the sessions they show with {type:'subscribe', sessions}.
 * Apps say whether they are in the foreground with {type:'presence', active},
 * which decides whether notifications are held while someone is looking.
 */
export class ClientHub {
  private sockets = new Set<ServerWebSocket<ClientSocketData>>();
  private readonly off: () => void;
  private readonly offConfig: () => void;
  private ownerToken: string | undefined;

  constructor(private readonly engine: EngineApi) {
    this.off = engine.bus.on((e) => this.broadcast(e));
    // a socket opened with the old hub token must not outlive it
    this.ownerToken = engine.config.get().server.token;
    this.offConfig = engine.config.onChange(() => {
      const token = engine.config.get().server.token;
      if (token === this.ownerToken) return;
      this.ownerToken = token;
      this.disconnect('owner', 'the hub token changed');
    });
  }

  get count(): number {
    return this.sockets.size;
  }

  /** Sockets that show the Map. */
  get mapWatchers(): number {
    return this.mapCount;
  }
  private mapCount = 0;

  /**
   * A paired app's first socket opened or its last one closed (not the hub
   * token's). Revoking an app closes its sockets without this: the revoke
   * says so itself.
   */
  onPresence?: (clientId: string, online: boolean) => void;

  /** The app has a socket open now. */
  connected(clientId: string): boolean {
    for (const ws of this.sockets) if (ws.data.clientId === clientId) return true;
    return false;
  }

  private presence(clientId: string, online: boolean): void {
    if (clientId === 'owner' || !this.onPresence) return;
    try {
      this.onPresence(clientId, online);
    } catch {
      /* presence is a convenience */
    }
  }

  open(ws: ServerWebSocket<ClientSocketData>): void {
    const was = this.connected(ws.data.clientId);
    this.sockets.add(ws);
    if (ws.data.active === undefined) this.touch(ws);
    ws.send(JSON.stringify({ type: 'hello', seq: this.engine.bus.currentSeq, version: this.engine.version }));
    if (!was) this.presence(ws.data.clientId, true);
  }

  message(ws: ServerWebSocket<ClientSocketData>, raw: string | Buffer): void {
    const msg = parseFrame(raw);
    if (msg?.type === 'presence') {
      ws.data.active = msg.active !== false;
      if (ws.data.active) this.touch(ws);
      else this.release(ws);
      return;
    }
    // apps that report presence say when they are in use; pings are not use
    if (ws.data.active === undefined) this.touch(ws);
    if (!msg) return;
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      case 'since': {
        const seq = Number(msg.seq);
        const events = Number.isFinite(seq) ? this.engine.bus.since(seq) : null;
        if (!events) {
          ws.send(JSON.stringify({ type: 'resync', seq: this.engine.bus.currentSeq }));
          return;
        }
        // the replay is filtered the same way as the live stream
        for (const e of events) this.replayTo(ws, e);
        return;
      }
      case 'map': {
        const on = msg.on === true;
        if (on !== !!ws.data.map) this.mapCount += on ? 1 : -1;
        ws.data.map = on;
        return;
      }
      case 'subscribe': {
        const s = msg.sessions;
        ws.data.filter = Array.isArray(s) ? new Set(s.filter((x): x is string => typeof x === 'string')) : null;
        return;
      }
      default:
        return;
    }
  }

  close(ws: ServerWebSocket<ClientSocketData>): void {
    const had = this.sockets.has(ws);
    if (had && ws.data.map) this.mapCount--;
    this.sockets.delete(ws);
    if (ws.data.active !== undefined) this.release(ws);
    if (had && !this.connected(ws.data.clientId)) this.presence(ws.data.clientId, false);
  }

  /** Close every socket of an account (a person removed, a password reset). */
  disconnectAccount(accountId: string, reason: string): void {
    for (const ws of this.sockets) {
      if ((ws.data.accountId ?? 'owner') !== accountId) continue;
      if (ws.data.map) this.mapCount--;
      this.sockets.delete(ws);
      ws.close(4001, reason);
    }
  }

  /** Close every socket of a client whose token stopped working (revoked, or the hub token changed). */
  disconnect(clientId: string, reason: string): void {
    for (const ws of this.sockets) {
      if (ws.data.clientId !== clientId) continue;
      if (ws.data.map) this.mapCount--;
      this.sockets.delete(ws);
      ws.close(4001, reason);
    }
  }

  /** The event as this socket's account may get it: its own, or a shared chat's shaped by sharedChatEventView. */
  private frameFor(ws: ServerWebSocket<ClientSocketData>, e: EngineEventEnvelope): string | undefined {
    const account = ws.data.accountId ?? 'owner';
    if (eventVisibleTo(e.account, account)) return JSON.stringify(e);
    // a shared chat: only the doc's allow list, shaped per viewer, membership read per event so removal stops the stream
    if (!sharedEventSession(e)) return undefined;
    const shaped = sharedChatEventView(this.engine.repos.db, e, account);
    return shaped ? JSON.stringify(shaped) : undefined;
  }

  /** One replayed event, under the same rules as the live stream. */
  private replayTo(ws: ServerWebSocket<ClientSocketData>, e: EngineEventEnvelope): void {
    const frame = this.frameFor(ws, e);
    if (frame) ws.send(frame);
  }

  broadcast(e: EngineEventEnvelope): void {
    if (!this.sockets.size) return;
    // map deltas go only to sockets that show the Map, and like deltas they are the first thing a slow socket skips
    const map = e.type === 'map.delta';
    if (map && !this.mapCount) return;
    const live = isLive(e) || map;
    for (const ws of this.sockets) {
      // another account's event never reaches this socket, apart from a shared chat's allowed events
      const frame = this.frameFor(ws, e);
      if (!frame) continue;
      if (map ? !ws.data.map : live && ws.data.filter && !ws.data.filter.has((e as { sessionId: string }).sessionId)) continue;
      const buffered = ws.getBufferedAmount();
      if (buffered > HARD_BUFFER) {
        // too far behind; it will reconnect and replay with since
        ws.close(1013, 'too slow');
        if (ws.data.map) this.mapCount--;
        this.sockets.delete(ws);
        continue;
      }
      if (live && buffered > SOFT_BUFFER) continue;
      ws.send(frame);
    }
  }

  private touch(ws: ServerWebSocket<ClientSocketData>): void {
    try {
      this.engine.notifier.touch(ws.data.clientId, ws.data.accountId ?? 'owner');
    } catch {
      /* notifier not ready */
    }
  }

  /** This socket left the foreground or closed: stop holding, unless the same client is still in the foreground elsewhere. */
  private release(ws: ServerWebSocket<ClientSocketData>): void {
    const { clientId } = ws.data;
    for (const other of this.sockets) if (other !== ws && other.data.clientId === clientId && other.data.active === true) return;
    try {
      this.engine.notifier.release(clientId);
    } catch {
      /* notifier not ready */
    }
  }

  dispose(): void {
    this.off();
    this.offConfig();
    for (const ws of this.sockets) ws.close(1001, 'server shutting down');
    this.sockets.clear();
  }
}
