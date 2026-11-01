import type { ServerWebSocket } from 'bun';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { DaemonSelf, Device, MachineInfo } from '@conclave/core/types.ts';
import { RemoteMachine } from '@conclave/core/machine/remote.ts';
import { HEARTBEAT_MS, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, parseFrame, type DaemonMessage, type HubMessage } from '@conclave/core/machine/protocol.ts';
import { logger } from '@conclave/core/util/log.ts';

const log = logger('daemon-ws');
/** Connects and disconnects, with the device's name and daemon, for the hub's log files. */
const dlog = logger('device');

export interface DaemonSocketData {
  kind: 'daemon';
  deviceId: string;
  /** The address it connected from, as the hub sees a browser's (http.ts clientIp). */
  ip?: string;
  conn?: DaemonConn;
}

interface DaemonConn {
  ws: ServerWebSocket<DaemonSocketData>;
  deviceId: string;
  machine?: RemoteMachine;
  lastHeard: number;
  lastSeenWrite: number;
  helloTimer?: ReturnType<typeof setTimeout>;
  /** When its hello was accepted, and its name then. */
  onlineAt?: number;
  name?: string;
  ip?: string;
}

/** A daemon must say hello this soon after connecting. */
const HELLO_TIMEOUT_MS = 15_000;

/**
 * /api/daemon connections. The socket is authenticated at upgrade time; the
 * device becomes usable after its hello, when a RemoteMachine is attached to
 * the engine's device hub. A second connection for the same device replaces
 * the first.
 */
export class DaemonHub {
  private conns = new Map<string, DaemonConn>();
  private sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly engine: EngineApi,
    private readonly opts: { heartbeatMs?: number; rpcTimeoutMs?: number; /** The hub's addresses, best first (remote access). */ addresses?: () => string[] } = {},
  ) {
    const hb = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.sweeper = setInterval(() => this.sweep(hb), hb);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** Connected device ids. */
  online(): string[] {
    return [...this.conns.keys()];
  }

  /**
   * The one connected device whose daemon comes from this address: the
   * computer a browser at that address most likely runs on. Undefined when
   * none or several do (two computers behind one router).
   */
  deviceAt(ip: string): string | undefined {
    const hits = [...this.conns.values()].filter((c) => c.machine && c.ip === ip);
    return hits.length === 1 ? hits[0].deviceId : undefined;
  }

  open(ws: ServerWebSocket<DaemonSocketData>): void {
    const conn: DaemonConn = { ws, deviceId: ws.data.deviceId, lastHeard: Date.now(), lastSeenWrite: 0, ...(ws.data.ip ? { ip: ws.data.ip } : {}) };
    conn.helloTimer = setTimeout(() => {
      if (!conn.machine) ws.close(4003, 'no hello');
    }, HELLO_TIMEOUT_MS);
    ws.data.conn = conn;
  }

  message(ws: ServerWebSocket<DaemonSocketData>, raw: string | Buffer): void {
    const conn = ws.data.conn;
    if (!conn) return;
    conn.lastHeard = Date.now();
    const msg = parseFrame(raw) as DaemonMessage | undefined;
    if (!msg) return;
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', ts: msg.ts });
      this.markSeen(conn);
      return;
    }
    if (msg.type === 'pong') return;
    if (!conn.machine) {
      if (msg.type === 'hello') this.hello(conn, msg);
      return;
    }
    conn.machine.handleMessage(msg);
  }

  close(ws: ServerWebSocket<DaemonSocketData>, code?: number, reason?: string): void {
    const conn = ws.data.conn;
    if (!conn) return;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.machine?.dispose('device disconnected');
    if (this.conns.get(conn.deviceId) === conn) {
      this.conns.delete(conn.deviceId);
      try {
        this.engine.devices.detach(conn.deviceId);
      } catch (err) {
        log.warn(`detach ${conn.deviceId} failed`, err);
      }
      dlog.info('device disconnected', {
        deviceId: conn.deviceId,
        ...(conn.name ? { name: conn.name } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(reason ? { reason: reason.slice(0, 120) } : {}),
        ...(conn.onlineAt ? { onlineMs: Date.now() - conn.onlineAt } : {}),
      });
    }
  }

  /** Tell every connected daemon the hub's addresses, best first. A daemon on an address that is not listed moves. */
  sendAddresses(urls: string[]): void {
    if (!urls.length) return;
    for (const conn of this.conns.values()) send(conn.ws, { type: 'addresses', urls });
  }

  /** Drop a device's connection (device deleted or token revoked). */
  disconnect(deviceId: string, reason = 'disconnected by hub'): void {
    const conn = this.conns.get(deviceId);
    if (!conn) return;
    try {
      conn.ws.close(4001, reason);
    } catch {
      /* already closed */
    }
  }

  private hello(conn: DaemonConn, msg: Extract<DaemonMessage, { type: 'hello' }>): void {
    const { ws, deviceId } = conn;
    // daemons one version behind keep working; the hub calls only the RPCs they know
    if (typeof msg.version !== 'number' || msg.version < MIN_PROTOCOL_VERSION || msg.version > PROTOCOL_VERSION) {
      dlog.warn('device refused', { deviceId, protocol: msg.version, why: 'protocol version' });
      send(ws, { type: 'error', message: `protocol version ${msg.version} not supported (hub speaks ${MIN_PROTOCOL_VERSION} to ${PROTOCOL_VERSION})` });
      ws.close(4002, 'protocol version mismatch');
      return;
    }
    const row = this.engine.repos.devices.get(deviceId);
    if (!row) {
      dlog.warn('device refused', { deviceId, why: 'not registered' });
      send(ws, { type: 'error', message: 'device not registered' });
      ws.close(4001, 'device not registered');
      return;
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    const info = sanitizeInfo(msg.info);
    const machine = new RemoteMachine({
      id: deviceId,
      name: row.name,
      info,
      send: (m: HubMessage) => {
        // Bun returns 0 when the frame was dropped (socket closed), -1 when queued
        if (send(ws, m) === 0) throw new Error('socket closed');
      },
      rpcTimeoutMs: this.opts.rpcTimeoutMs,
      protocol: msg.version,
    });
    conn.machine = machine;
    const old = this.conns.get(deviceId);
    this.conns.set(deviceId, conn);
    if (old && old !== conn) {
      old.machine?.dispose('replaced by a new connection');
      try {
        old.ws.close(4000, 'replaced by a new connection');
      } catch {
        /* ignore */
      }
    }
    const device: Device = { ...row, online: true, info, lastSeenAt: Date.now() };
    this.engine.devices.attach(device, machine);
    conn.lastSeenWrite = Date.now();
    send(ws, { type: 'welcome', version: PROTOCOL_VERSION, hubVersion: this.engine.version, deviceId, name: row.name });
    const urls = this.opts.addresses?.() ?? [];
    if (urls.length) send(ws, { type: 'addresses', urls });
    conn.onlineAt = Date.now();
    conn.name = row.name;
    dlog.info('device connected', {
      deviceId,
      name: row.name,
      hostname: info.hostname,
      platform: info.platform,
      arch: info.arch,
      protocol: msg.version,
      ...(info.daemon ? { daemon: `${info.daemon.impl} ${info.daemon.version}` } : {}),
      ...(old && old !== conn ? { replaced: true } : {}),
    });
  }

  private markSeen(conn: DaemonConn): void {
    const now = Date.now();
    if (now - conn.lastSeenWrite < 60_000) return;
    conn.lastSeenWrite = now;
    try {
      this.engine.repos.devices.seen(conn.deviceId);
    } catch {
      /* ignore */
    }
  }

  private sweep(heartbeatMs: number): void {
    const cutoff = Date.now() - heartbeatMs * 3;
    for (const conn of this.conns.values()) {
      if (conn.lastHeard < cutoff) {
        log.warn('device silent, closing', { deviceId: conn.deviceId, ...(conn.name ? { name: conn.name } : {}), silentMs: Date.now() - conn.lastHeard });
        try {
          conn.ws.close(4008, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
      } else {
        // hub pings too, so a half-open socket shows up on both ends
        send(conn.ws, { type: 'ping', ts: Date.now() });
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const conn of this.conns.values()) {
      try {
        conn.ws.close(1001, 'hub shutting down');
      } catch {
        /* ignore */
      }
    }
  }
}

function send(ws: ServerWebSocket<DaemonSocketData>, msg: HubMessage): number {
  try {
    return ws.send(JSON.stringify(msg));
  } catch {
    return 0;
  }
}

/** Keep only expected fields with sane types so a daemon cannot stuff the db. */
function sanitizeInfo(raw: unknown): MachineInfo {
  const i = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '');
  const clis: Record<string, string> = {};
  if (i.clis && typeof i.clis === 'object') {
    for (const [k, v] of Object.entries(i.clis as Record<string, unknown>).slice(0, 64)) clis[k.slice(0, 64)] = str(v, 128);
  }
  const caps = Array.isArray(i.capabilities) ? i.capabilities.filter((x) => typeof x === 'string').slice(0, 64).map((x) => (x as string).slice(0, 64)) : [];
  // which daemon this is (the Rust one says), shown on the Devices page
  const d = (i.daemon && typeof i.daemon === 'object' ? i.daemon : {}) as Record<string, unknown>;
  const daemon = typeof d.impl === 'string' && typeof d.version === 'string' ? { daemon: { impl: str(d.impl, 32), version: str(d.version, 64), ...daemonUpdate(d, str) } } : {};
  return {
    hostname: str(i.hostname, 255),
    platform: str(i.platform, 32),
    arch: str(i.arch, 32),
    home: str(i.home, 1024),
    shell: str(i.shell, 1024),
    clis,
    capabilities: caps,
    ...daemon,
  };
}

/** How a daemon updates and its last update (protocol 4), kept to known values. */
function daemonUpdate(d: Record<string, unknown>, str: (v: unknown, max?: number) => string): Partial<DaemonSelf> {
  const out: Partial<DaemonSelf> = {};
  if (d.update === 'self' || d.update === 'app' || d.update === 'manual') out.update = d.update;
  if (typeof d.updateWhy === 'string') out.updateWhy = str(d.updateWhy, 300);
  const l = (d.lastUpdate && typeof d.lastUpdate === 'object' ? d.lastUpdate : undefined) as Record<string, unknown> | undefined;
  if (l && typeof l.to === 'string' && typeof l.ok === 'boolean') {
    out.lastUpdate = { from: str(l.from, 64), to: str(l.to, 64), ok: l.ok, at: typeof l.at === 'number' ? l.at : 0, ...(typeof l.message === 'string' ? { message: str(l.message, 300) } : {}) };
  }
  return out;
}
