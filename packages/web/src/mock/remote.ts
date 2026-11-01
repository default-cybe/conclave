/**
 * Mock routes for remote access (Settings, Remote access; the onboarding hub
 * step; the Devices pairing dialog). The busy hub runs a quick tunnel; a
 * first-run hub (?fresh=1) starts on the same network only, and its first
 * tunnel downloads cloudflared before it starts. Pairing codes and hub info
 * carry the best address, as the real hub does.
 */
import type { HubAddress, RemoteMode, RemoteStatus } from '@conclave/core/types';
import type { CloudflareZoneDto, RemoteSettingsInput, StableTunnelInput } from '@conclave/core/client';
import type { MockCtx } from './index';

const LAN: HubAddress = { url: 'http://192.168.1.20:7717', kind: 'lan', label: 'Wi-Fi 192.168.1.20' };
const WORDS = ['quiet-river-lamp', 'amber-field-notes', 'cedar-moon-relay', 'north-pine-signal', 'slate-harbor-tide'];
const ZONES: CloudflareZoneDto[] = [
  { id: 'z_kai', name: 'kaivalya.dev', accountId: 'acc_1', accountName: 'Kai' },
  { id: 'z_lab', name: 'homelab.network', accountId: 'acc_1', accountName: 'Kai' },
];

export function registerRemote(ctx: MockCtx) {
  const { on, emit, sleep } = ctx;
  let n = 0;
  const quickUrl = () => `https://${WORDS[n % WORDS.length]}.trycloudflare.com`;

  // ?remote=error: the quick tunnel cannot reach Cloudflare (to see the error state)
  const broken = typeof location !== 'undefined' && new URLSearchParams(location.search).get('remote') === 'error';
  let mode: RemoteMode = ctx.FRESH ? 'off' : 'quick';
  let state: RemoteStatus['state'] = ctx.FRESH ? 'off' : broken ? 'error' : 'on';
  let since = Date.now() - (ctx.FRESH ? 0 : 3 * 3_600_000);
  let url: string | undefined = ctx.FRESH || broken ? undefined : quickUrl();
  let previousUrl: string | undefined;
  let detail: string | undefined = broken ? 'Trying again in 30 seconds.' : undefined;
  let error: string | undefined = broken ? 'cloudflared could not reach Cloudflare (dial tcp: lookup api.trycloudflare.com: no such host). Check that the hub has internet access and working DNS.' : undefined;
  let lan = true;
  let own: string | undefined;
  let token = false;
  let stable: { hostname: string; zone: string } | undefined;
  let installed = !ctx.FRESH;
  let gen = 0;

  const addresses = (): HubAddress[] => {
    const out: HubAddress[] = [];
    if (state === 'on' && url && (mode === 'quick' || mode === 'stable')) out.push({ url, kind: mode, label: mode === 'stable' ? 'Cloudflare tunnel, your domain' : 'Cloudflare quick tunnel' });
    if (own && mode !== 'off') out.push({ url: own, kind: 'own', label: /\.ts\.net$/.test(own) ? 'Tailscale' : 'Your address' });
    if (lan) out.push(LAN);
    return out;
  };
  const status = (): RemoteStatus => ({
    mode,
    state,
    url: mode === 'quick' || mode === 'stable' ? (state === 'on' ? url : undefined) : mode === 'off' ? undefined : own,
    addresses: addresses(),
    previousUrl,
    since,
    detail,
    error,
    lan: { on: lan, listening: lan },
    stable,
    cloudflareToken: token,
    cloudflared: installed ? { path: '/home/kai/.conclave/bin/cloudflared', version: '2026.9.0', managed: true, verified: true } : undefined,
  });
  const setState = (s: RemoteStatus['state'], d?: string, e?: string) => {
    if (s !== state) since = Date.now();
    state = s;
    detail = d;
    error = e;
    emit({ type: 'remote.updated', remote: status() });
  };

  /** Start a tunnel: download cloudflared the first time, then ask for an address. */
  const start = async (kind: 'quick' | 'stable', switching = false) => {
    const mine = ++gen;
    const step = (s: RemoteStatus['state'], d: string) => {
      if (mine !== gen) return;
      if (switching) {
        detail = d;
        emit({ type: 'remote.updated', remote: status() });
      } else setState(s, d);
    };
    if (!installed) {
      for (const done of [4, 13, 22, 31, 38]) {
        step('installing', `Downloading cloudflared, ${done} of 38 MB`);
        await sleep(450);
      }
      installed = true;
    }
    step('starting', kind === 'quick' ? 'Asking Cloudflare for an address' : `Connecting ${stable?.hostname ?? 'the address'} to Cloudflare`);
    await sleep(1600);
    if (mine !== gen) return;
    const old = url;
    if (kind === 'quick') {
      n++;
      url = quickUrl();
    } else url = `https://${stable!.hostname}`;
    previousUrl = old && old !== url ? old : previousUrl;
    setState('on');
  };

  on('GET', '/api/remote', () => status());

  on('PUT', '/api/remote', async ({ body }) => {
    const input = (body ?? {}) as RemoteSettingsInput;
    await sleep(120);
    if (input.lan !== undefined) lan = input.lan;
    if (input.url === null) own = undefined;
    else if (typeof input.url === 'string') {
      const u = input.url.trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s/]+/.test(u)) ctx.fail(400, 'The hub cannot use that address. Use the form https://hub.example.com, with no ? or # part.');
      own = u;
    }
    const m = input.mode;
    if (m === 'stable' && !stable) ctx.fail(409, 'Set up the stable address first: paste a Cloudflare API token and pick a domain.');
    if (m === 'custom' && !own) ctx.fail(400, 'Type the address first, for example https://hub.example.com.');
    if (m === 'tailscale' && !own) own = 'https://madx.tail4e2a.ts.net';
    if (m && m !== mode) {
      const was = mode;
      mode = m;
      if (m === 'quick' || m === 'stable') void start(m, (was === 'quick' || was === 'stable') && state === 'on');
      else {
        gen++;
        if ((was === 'quick' || was === 'stable') && url) previousUrl = url;
        url = undefined;
        setState(m === 'off' ? 'off' : 'on');
      }
    } else emit({ type: 'remote.updated', remote: status() });
    return status();
  });

  on('POST', '/api/remote/restart', () => {
    if (mode !== 'quick' && mode !== 'stable') ctx.fail(409, 'Remote access is not using a Cloudflare tunnel. Pick Quick or Stable first.');
    void start(mode as 'quick' | 'stable', state === 'on');
    return status();
  });

  on('POST', '/api/remote/cloudflare', async ({ body }) => {
    await sleep(700);
    const t = String(body?.token ?? '').trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) ctx.fail(400, 'That does not look like a Cloudflare API token. Copy it again from My Profile, API Tokens.');
    if (/bad|wrong/i.test(t)) ctx.fail(400, 'Cloudflare refused this token. Make one with Account, Cloudflare Tunnel, Edit and Zone, DNS, Edit, then paste it again.');
    token = true;
    emit({ type: 'remote.updated', remote: status() });
    return { zones: ZONES };
  });

  on('GET', '/api/remote/cloudflare/zones', () => {
    if (!token) ctx.fail(409, 'No Cloudflare token is saved. Paste one first.');
    return { zones: ZONES };
  });

  on('POST', '/api/remote/stable', async ({ body }) => {
    const input = (body ?? {}) as StableTunnelInput;
    const zone = ZONES.find((z) => z.id === input.zoneId);
    if (!zone) ctx.fail(400, 'zoneId is required');
    const name = (input.name || 'conclave').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) ctx.fail(400, 'Use letters, digits and dashes for the name, for example conclave or hub-home.');
    await sleep(1200);
    stable = { hostname: `${name}.${zone!.name}`, zone: zone!.name };
    const was = mode;
    mode = 'stable';
    void start('stable', (was === 'quick' || was === 'stable') && state === 'on');
    return status();
  });

  on('DELETE', '/api/remote/stable', async () => {
    await sleep(600);
    const wasStable = mode === 'stable';
    stable = undefined;
    token = false;
    if (wasStable) {
      gen++;
      mode = 'off';
      url = undefined;
      setState('off');
    } else emit({ type: 'remote.updated', remote: status() });
    return status();
  });

  on('GET', '/api/remote/tailscale', async () => {
    await sleep(500);
    return { installed: true, running: true, dnsName: 'madx.tail4e2a.ts.net', url: 'https://madx.tail4e2a.ts.net', command: 'tailscale serve --bg 7717' };
  });

  // pairing codes and hub info carry the best address; the older handlers below do the rest
  // (?inner=1 marks the request this module makes to them, so it passes through)
  on('POST', '/api/pairing', async ({ body, query }) => {
    if (query.get('inner')) return ctx.pass;
    const info = await (await ctx.request('/api/pairing?inner=1', { method: 'POST', body: JSON.stringify(body ?? {}) })).json();
    const list = addresses().map((a) => a.url);
    if (!list.length) return info;
    const alts = list
      .slice(1)
      .map((a) => `&alt=${encodeURIComponent(a)}`)
      .join('');
    return { ...info, url: list[0], addresses: list, deepLink: `conclave://pair?url=${encodeURIComponent(list[0])}&code=${info.code}${alts}` };
  });
  on('GET', '/api/info', async ({ query }) => {
    if (query.get('inner')) return ctx.pass;
    const info = await (await ctx.request('/api/info?inner=1')).json();
    return { ...info, publicUrl: addresses()[0]?.url ?? info.publicUrl };
  });
}
