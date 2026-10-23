/**
 * Local CLI state under ~/.conclave: client.json (paired hub), device.json
 * (daemon credentials), history, hub.log. Secrets files are written 0600.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { conclaveHome } from '@conclave/core/config/paths.ts';

export interface ClientFile {
  hub: string;
  token: string;
  clientId?: string;
  name?: string;
  savedAt: number;
  /** Every address of the hub, best first. Tried in turn when `hub` stops answering (a quick tunnel that changed). */
  addresses?: string[];
  /** The hub's public key from pairing (PairResult.identity). The hub proves it before the token is sent. */
  hubKey?: string;
  /** Its fingerprint, to show. */
  fingerprint?: string;
  /** Who the token signs in as on a hub with several people (docs/design/ACCOUNTS.md). */
  account?: { id: string; name: string; role: 'owner' | 'member' };
}

export interface DeviceFile {
  hub: string;
  deviceId: string;
  token: string;
  name: string;
  savedAt: number;
  /** Every address of the hub, best first, as the hub last sent them. The daemon tries them when `hub` stops answering. */
  addresses?: string[];
}

export function cliPaths(home = conclaveHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    client: join(home, 'client.json'),
    device: join(home, 'device.json'),
    history: join(home, 'history'),
    logs: join(home, 'logs'),
    hubLog: join(home, 'logs', 'hub.log'),
    daemonLog: join(home, 'logs', 'daemon.log'),
    web: join(home, 'web'),
  };
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writePrivateJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

export function readClientFile(home?: string): ClientFile | undefined {
  const f = readJson<ClientFile>(cliPaths(home).client);
  return f && typeof f.hub === 'string' && typeof f.token === 'string' ? f : undefined;
}

export function readDeviceFile(home?: string): DeviceFile | undefined {
  const f = readJson<DeviceFile>(cliPaths(home).device);
  return f && typeof f.hub === 'string' && typeof f.deviceId === 'string' ? f : undefined;
}

/** Normalize a hub URL: add http:// when missing, drop trailing slashes and a trailing /api. */
export function normalizeHubUrl(url: string): string {
  let u = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(u) || /^[^/]+:\d+/.test(u);
    u = (local ? 'http://' : 'https://') + u;
  }
  u = u.replace(/^ws(s?):\/\//i, 'http$1://');
  return u.replace(/\/+$/, '').replace(/\/api$/, '');
}
