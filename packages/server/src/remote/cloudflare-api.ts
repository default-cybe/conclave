/**
 * The few Cloudflare API calls stable mode needs: list zones, make (or find)
 * a named tunnel, point its ingress at the hub, put a CNAME on the zone, and
 * remove both again. The token needs Account, Cloudflare Tunnel, Edit and
 * Zone, DNS, Edit.
 */
const API = 'https://api.cloudflare.com/client/v4';
/** The comment on the DNS record stable mode makes, so it can tell its own record from the owner's. */
const CNAME_COMMENT = 'Conclave hub';

export interface CfZone {
  id: string;
  name: string;
  accountId: string;
  accountName?: string;
}

export interface CfTunnel {
  id: string;
  name: string;
}

export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

/** A hostname label: lowercase letters, digits and dashes, 1 to 63 long, no dash at either end. */
export function validLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new CloudflareError(502, `Could not reach the Cloudflare API (${(err as Error).message}). Check the hub's internet connection.`);
    }
    let data: Envelope<T> | undefined;
    try {
      data = (await res.json()) as Envelope<T>;
    } catch {
      data = undefined;
    }
    if (res.status === 401 || res.status === 403 || data?.errors?.some((e) => e.code === 10000 || e.code === 9109 || e.code === 6003)) {
      throw new CloudflareError(401, 'Cloudflare refused this token. Make one with Account, Cloudflare Tunnel, Edit and Zone, DNS, Edit, then paste it again.');
    }
    if (!res.ok || !data?.success) {
      const msg = data?.errors?.map((e) => e.message).join('; ') || res.statusText || `HTTP ${res.status}`;
      throw new CloudflareError(res.status >= 400 && res.status < 600 ? res.status : 502, `Cloudflare said: ${msg}.`);
    }
    return data.result;
  }

  /** Active zones the token can see. */
  async zones(): Promise<CfZone[]> {
    const rows = await this.call<Array<{ id: string; name: string; status?: string; account?: { id: string; name?: string } }>>('GET', '/zones?per_page=50');
    return rows
      .filter((z) => z.account?.id && (!z.status || z.status === 'active'))
      .map((z) => ({ id: z.id, name: z.name, accountId: z.account!.id, accountName: z.account!.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async zone(zoneId: string): Promise<CfZone> {
    const z = await this.call<{ id: string; name: string; account?: { id: string; name?: string } }>('GET', `/zones/${encodeURIComponent(zoneId)}`);
    if (!z.account?.id) throw new CloudflareError(400, 'Cloudflare did not say which account owns this zone.');
    return { id: z.id, name: z.name, accountId: z.account.id, accountName: z.account.name };
  }

  /** A named tunnel with this name, or a new one. Its ingress is managed by the API (config_src cloudflare). */
  async ensureTunnel(accountId: string, name: string): Promise<CfTunnel> {
    const a = encodeURIComponent(accountId);
    const found = await this.call<Array<{ id: string; name: string }>>('GET', `/accounts/${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`);
    const hit = found.find((t) => t.name === name);
    if (hit) return { id: hit.id, name: hit.name };
    const made = await this.call<{ id: string; name: string }>('POST', `/accounts/${a}/cfd_tunnel`, { name, config_src: 'cloudflare' });
    return { id: made.id, name: made.name };
  }

  /** The token `cloudflared tunnel run` uses. */
  tunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.call<string>('GET', `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`);
  }

  /** Send hostname to the hub on 127.0.0.1:port, everything else to a 404. */
  async routeTunnel(accountId: string, tunnelId: string, hostname: string, port: number): Promise<void> {
    await this.call('PUT', `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
      config: { ingress: [{ hostname, service: `http://127.0.0.1:${port}` }, { service: 'http_status:404' }] },
    });
  }

  /**
   * Point hostname at the tunnel with a proxied CNAME. Replaces only a record
   * that already points at this tunnel or that Conclave made (its comment);
   * anything else on that name, such as another tunnel of the owner's, stays
   * and the call says to pick another name.
   */
  async upsertCname(zoneId: string, hostname: string, tunnelId: string): Promise<string> {
    const z = encodeURIComponent(zoneId);
    const target = `${tunnelId}.cfargotunnel.com`;
    const existing = await this.call<Array<{ id: string; type: string; content: string; comment?: string | null }>>('GET', `/zones/${z}/dns_records?name=${encodeURIComponent(hostname)}`);
    const record = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1, comment: CNAME_COMMENT };
    const ours = (r: { type: string; content: string; comment?: string | null }) => r.type === 'CNAME' && (r.content === target || r.comment === CNAME_COMMENT);
    const mine = existing.find(ours);
    const other = existing.find((r) => !ours(r));
    if (other) throw new CloudflareError(409, `${hostname} already has a DNS record that points somewhere else. Pick another name, or remove that record first.`);
    if (mine) {
      const r = await this.call<{ id: string }>('PUT', `/zones/${z}/dns_records/${encodeURIComponent(mine.id)}`, record);
      return r.id;
    }
    const r = await this.call<{ id: string }>('POST', `/zones/${z}/dns_records`, record);
    return r.id;
  }

  async deleteDns(zoneId: string, recordId: string): Promise<void> {
    await this.call('DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    const base = `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
    // a tunnel with live connections cannot be deleted; drop them first
    await this.call('DELETE', `${base}/connections`).catch(() => undefined);
    await this.call('DELETE', base);
  }
}
