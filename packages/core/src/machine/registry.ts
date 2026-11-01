import type { Device, MachineInfo } from '../types';
import type { DeviceHub } from '../engine/api';
import type { Repos } from '../storage/repos';
import type { EventBus } from '../util/bus';
import type { Machine } from './types';
import { OWNER_ID, isMember } from '../people/context';
import { guardMachine } from '../people/guard';

export interface DeviceRegistryOptions {
  /** The hub's own machine, exposed as device "local". */
  local: Machine;
  repos: Repos;
  bus: EventBus;
  /** Display name for the hub device. Defaults to the local machine's name. The owner's name (renameHub) wins. */
  localName?: string;
}

/** Where the owner's name for the hub device is kept (the kv table, so it survives restarts and is in backups). */
const HUB_NAME_KEY = 'devices.hubName';

/**
 * Every Machine the engine can run tools on: "local" (the hub) plus one
 * RemoteMachine per connected daemon. Paired devices live in the devices
 * table; this adds the online flag and emits device.updated on changes.
 */
export class DeviceRegistry implements DeviceHub {
  private readonly local: Machine;
  private readonly repos: Repos;
  private readonly bus: EventBus;
  private localName: string;
  private readonly createdAt = Date.now();
  private localInfo: MachineInfo | undefined;
  private remotes = new Map<string, Machine>();

  constructor(opts: DeviceRegistryOptions) {
    // the machine guard (people/guard.ts): the hub is the owner's alone, a paired device its account's
    this.local = guardMachine(opts.local, OWNER_ID, 'hub');
    this.repos = opts.repos;
    this.bus = opts.bus;
    this.localName = opts.localName ?? opts.local.name;
    try {
      this.localName = this.repos.kv.get<string | null>(HUB_NAME_KEY, null) || this.localName;
    } catch {
      /* an old database without the kv table: the host name */
    }
    // cache the hub's info for list(); failures just leave it empty
    Promise.resolve()
      .then(() => this.local.info())
      .then((info) => (this.localInfo = info))
      .catch(() => {});
  }

  get(id: string): Machine | undefined {
    if (id === 'local' || id === '' || id === this.local.id) return this.local;
    return this.remotes.get(id);
  }

  /**
   * The hub first, then paired devices (online first, then by name). With an
   * account, only its devices; a member sees the hub by name only, since its
   * folders and shell are the owner's.
   */
  list(accountId?: string): Device[] {
    const member = isMember(accountId);
    const hub: Device = {
      id: 'local',
      name: this.localName,
      online: true,
      lastSeenAt: Date.now(),
      ...(member ? {} : { info: this.localInfo }),
      roots: [],
      createdAt: this.createdAt,
    };
    const rows = this.repos.devices.list(accountId).map((d) => ({ ...d, online: this.remotes.has(d.id) }));
    rows.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return [hub, ...rows];
  }

  /** One device with online state, or undefined. */
  device(id: string): Device | undefined {
    return this.list().find((d) => d.id === id);
  }

  attach(device: Device, machine: Machine): void {
    if (device.id === 'local') throw new Error('"local" is reserved for the hub');
    // whose the device is, read at call time: a device removed and paired again by someone else is judged as it is now
    this.remotes.set(device.id, guardMachine(machine, () => this.repos.devices.accountOf(device.id), 'device'));
    try {
      this.repos.devices.seen(device.id, device.info);
    } catch {
      /* device row may be gone; still usable for this connection */
    }
    this.bus.emit({ type: 'device.updated', device: this.snapshot(device, true) });
  }

  detach(deviceId: string): void {
    if (!this.remotes.delete(deviceId)) return;
    try {
      this.repos.devices.seen(deviceId);
    } catch {
      /* ignore */
    }
    const row = this.repos.devices.get(deviceId);
    if (row) this.bus.emit({ type: 'device.updated', device: { ...row, online: false } });
  }

  isOnline(id: string): boolean {
    return id === 'local' || this.remotes.has(id);
  }

  renameHub(name: string): Device {
    this.repos.kv.set(HUB_NAME_KEY, name);
    this.localName = name;
    const hub = this.list()[0];
    this.bus.emit({ type: 'device.updated', device: hub });
    return hub;
  }

  /** Ids of connected daemons. */
  onlineIds(): string[] {
    return [...this.remotes.keys()];
  }

  private snapshot(device: Device, online: boolean): Device {
    const row = this.repos.devices.get(device.id);
    return { ...device, ...(row ?? {}), info: device.info ?? row?.info, online };
  }
}
