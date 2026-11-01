/** What `tailscale status --json` says about this machine, for the Tailscale option. */
import { existsSync } from 'node:fs';
import type { TailscaleInfo } from '@conclave/core/client/index.ts';

const MAC_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export type StatusReader = () => Promise<string | undefined>;

/** Run `tailscale status --json` with a short timeout. Undefined when Tailscale is not installed. */
export const readTailscaleStatus: StatusReader = async () => {
  const bin = Bun.which('tailscale') ?? (process.platform === 'darwin' && existsSync(MAC_CLI) ? MAC_CLI : null);
  if (!bin) return undefined;
  const proc = Bun.spawn([bin, 'status', '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => proc.kill(), 4_000);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out || '{}';
  } catch {
    return '{}';
  } finally {
    clearTimeout(timer);
  }
};

/** Pure: turn the JSON (or its absence) into TailscaleInfo. */
export function parseTailscale(json: string | undefined, port: number): TailscaleInfo {
  const command = `tailscale serve --bg ${port}`;
  if (json === undefined) return { installed: false, running: false, command };
  let data: { BackendState?: string; Self?: { DNSName?: string } } = {};
  try {
    data = JSON.parse(json);
  } catch {
    /* not running or old CLI */
  }
  const running = data.BackendState === 'Running';
  const dnsName = data.Self?.DNSName?.replace(/\.$/, '') || undefined;
  return { installed: true, running, dnsName, url: running && dnsName ? `https://${dnsName}` : undefined, command };
}

export async function tailscaleInfo(port: number, read: StatusReader = readTailscaleStatus): Promise<TailscaleInfo> {
  return parseTailscale(await read().catch(() => undefined), port);
}
