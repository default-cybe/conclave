/**
 * `conclave remote`: how phones and paired computers reach the hub. The same
 * choices as Settings, Remote access in the web app.
 */
import type { RemoteStatus } from '@conclave/core/types.ts';
import type { ConclaveClient } from '@conclave/core/client/index.ts';
import { out as p } from '../ansi';
import { str, type ParsedArgs } from '../args';
import { loginLink } from '../hub';
import { CliError, getClient, print } from './shared';

const MODE_WORDS: Record<RemoteStatus['mode'], string> = {
  off: 'Local only',
  quick: 'Quick tunnel (Cloudflare, no account)',
  stable: 'Stable address (your Cloudflare domain)',
  tailscale: 'Tailscale',
  custom: 'Your own URL',
};

export function describeRemote(s: RemoteStatus): string[] {
  const lines: string[] = [];
  const state =
    s.state === 'on' ? p.green('on') : s.state === 'error' ? p.red('not working') : s.state === 'off' ? p.dim('off') : p.yellow(s.state === 'installing' ? 'installing' : 'starting');
  lines.push(`${p.bold('Remote access')}  ${MODE_WORDS[s.mode]}, ${state}`);
  if (s.url) lines.push(`  Address  ${p.bold(s.url)}`);
  if (s.detail) lines.push(`  ${p.dim(s.detail)}`);
  if (s.error) lines.push(`  ${p.red(s.error)}`);
  const lan = s.addresses.filter((a) => a.kind === 'lan');
  if (lan.length) for (const a of lan) lines.push(`  Same network  ${a.url}`);
  else if (s.lan.fixedHost) lines.push(p.dim(`  Listening on ${s.lan.fixedHost} (set by --host or server.host)`));
  else if (!s.lan.on) lines.push(p.dim('  Same network: off. Only this computer and the remote address are answered.'));
  if (s.previousUrl && s.previousUrl !== s.url) lines.push(p.dim(`  Was ${s.previousUrl}. Devices that were away need to scan a new code.`));
  return lines;
}

/** Wait until a tunnel is on or failed, printing what it does. */
async function settle(client: ConclaveClient, first: RemoteStatus, ms = 60_000): Promise<RemoteStatus> {
  let s = first;
  let shown = '';
  const end = Date.now() + ms;
  while ((s.state === 'starting' || s.state === 'installing') && Date.now() < end) {
    const line = s.detail ?? s.state;
    if (line !== shown) {
      process.stderr.write(p.dim(`  ${line}\n`));
      shown = line;
    }
    await Bun.sleep(500);
    s = await client.remote();
  }
  return s;
}

const USAGE = [
  'conclave remote                 show how devices reach the hub',
  'conclave remote quick           a Cloudflare tunnel the hub runs itself, no account',
  'conclave remote new             quick tunnel: get a new address',
  'conclave remote url <URL>       your own address (a reverse proxy or a domain)',
  'conclave remote tailscale [URL] the hub on your tailnet (tailscale serve)',
  'conclave remote stable --cf-token T --zone example.com [--name conclave]',
  'conclave remote off             no outside address',
  'conclave remote lan on|off      devices on the same network',
].join('\n       ');

export async function remoteCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1];
  const value = args._[2];
  const { client, target } = await getClient(args);
  let s: RemoteStatus;
  switch (sub) {
    case undefined:
    case 'status':
      s = await client.remote();
      break;
    case 'quick':
    case 'on':
      s = await settle(client, await client.setRemote({ mode: 'quick' }));
      break;
    case 'new':
    case 'restart':
      s = await client.restartRemote();
      await Bun.sleep(300);
      s = await settle(client, await client.remote());
      break;
    case 'off':
      s = await client.setRemote({ mode: 'off' });
      break;
    case 'url':
    case 'custom':
      if (!value) throw new CliError(`Give the address: conclave remote url https://hub.example.com`);
      s = await client.setRemote({ mode: 'custom', url: value });
      break;
    case 'tailscale':
      if (!value) {
        const ts = await client.tailscaleInfo();
        if (!ts.url) throw new CliError(ts.installed ? `Tailscale is not connected on the hub. Run \`sudo tailscale up\` and \`${ts.command}\` there, then try again.` : 'Tailscale is not installed on the hub. Install it, or use `conclave remote quick`.');
        print(p.dim(`Found ${ts.url}. If it does not answer, run \`${ts.command}\` on the hub.`));
      }
      s = await client.setRemote({ mode: 'tailscale', ...(value ? { url: value } : {}) });
      break;
    case 'stable': {
      const token = str(args, 'cf-token');
      const zoneName = str(args, 'zone');
      if (token) await client.cloudflareToken(token);
      const { zones } = await client.cloudflareZones().catch(() => ({ zones: [] }));
      if (!zones.length) throw new CliError('Paste a Cloudflare API token first: conclave remote stable --cf-token <token> --zone example.com. It needs Account, Cloudflare Tunnel, Edit and Zone, DNS, Edit.');
      const zone = zoneName ? zones.find((z) => z.name === zoneName) : zones.length === 1 ? zones[0] : undefined;
      if (!zone) throw new CliError(`Pick a domain with --zone: ${zones.map((z) => z.name).join(', ')}`);
      s = await settle(client, await client.setupStableTunnel({ zoneId: zone.id, name: str(args, 'name') }));
      break;
    }
    case 'lan':
      if (value !== 'on' && value !== 'off') throw new CliError('Use conclave remote lan on, or conclave remote lan off.');
      s = await client.setRemote({ lan: value === 'on' });
      break;
    default:
      throw new CliError(`Unknown remote command "${sub}". Try:\n       ${USAGE}`);
  }
  for (const line of describeRemote(s)) print(line);
  // on the hub itself, with its own token: the link that signs a browser in over the outside address
  const out = s.addresses.find((a) => a.kind !== 'lan') ?? s.addresses[0];
  if (target.local && target.token && out && s.state !== 'error') print(`  Login  ${loginLink(out.url, target.token)}`);
  if (s.state === 'on' && (s.mode === 'quick' || s.mode === 'stable') && sub && sub !== 'status') {
    print('');
    print(p.dim('Pair a phone with: conclave pair-phone'));
  }
  if (sub === undefined && s.mode === 'off' && !s.addresses.length) {
    print('');
    print(`Phones cannot reach this hub yet. ${p.bold('conclave remote quick')} gives it an https address with no account.`);
  }
  return s.state === 'error' ? 1 : 0;
}
