/**
 * Signing the hub in to an MCP server with OAuth (McpServerConfig.auth
 * "oauth"). The SDK does the protocol: protected resource metadata (RFC
 * 9728), authorization server metadata (RFC 8414), dynamic client
 * registration, PKCE S256, the code exchange and refresh. This file is the
 * OAuthClientProvider it asks for storage, plus the Connect flow.
 *
 * Where things live:
 * - Client registration, tokens and discovery: one hub secret,
 *   `mcp.<server>.oauth`, sealed with AES-256-GCM under browser-logins.key
 *   (browser/logins.ts), so a copy of secrets.json alone holds no usable token.
 * - The PKCE verifier and the state: memory only, 15 minutes. The state is
 *   what lets the public callback route accept a code.
 *
 * Refreshes are single-flight per refresh token: a second caller holding
 * the same refresh token gets the first answer instead of posting the token
 * again. Notion revokes the whole connection when an old refresh token is
 * used twice.
 *
 * The stored record names the server URL it was made for: after the URL
 * changes the hub holds no tokens for the server, so a token never reaches
 * another host. Every request (discovery, registration, token, redirects)
 * goes to https on a public address only; the server's metadata cannot send
 * the hub to its own network or a cloud metadata service.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ConfigStore } from '../config';
import { LOGINS_KEY_FILE, open, seal, sealKey } from '../browser/logins';
import { markHubPrivate } from '../machine/private';
import { isLocalName, isPrivateAddress } from '../people/net';
import { guardHost } from '../tools/webfetch';
import { logger } from '../util/log';

const log = logger('mcp-oauth');

export const MCP_OAUTH_CALLBACK = '/api/mcp/oauth/callback';
const FLOW_TTL = 15 * 60_000;
/** How long a refresh answer is handed to callers that still hold the old refresh token. */
const REFRESH_REUSE_MS = 60_000;

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  redirectUrl?: string;
  /** The server URL the record was made for; under another URL it is not used. */
  serverUrl?: string;
}

export interface McpOAuthOptions {
  now?: () => number;
  fetch?: typeof fetch;
  /** Origins allowed over plain http or on a private address: tests' localhost fixtures only. Empty by default. */
  allowOrigins?: string[];
}

interface Pending {
  server: string;
  serverUrl: string;
  redirectUrl: string;
  verifier?: string;
  expiresAt: number;
}

export class McpOAuthError extends Error {}

/** What the owner may see about a failure: our own messages, or an OAuth error code. Never a response body. */
export function oauthFailure(err: unknown): string {
  if (err instanceof McpOAuthError) return err.message;
  const code = (err as { errorCode?: unknown }).errorCode;
  if (typeof code === 'string' && /^[a-z_]{1,40}$/.test(code)) return `the server answered ${code}`;
  return 'the server gave an answer the hub could not use';
}

export function oauthSecretName(server: string): string {
  return `mcp.${server}.oauth`;
}

export class McpOAuth {
  private pending = new Map<string, Pending>();
  private refreshes = new Map<string, Promise<{ status: number; headers: [string, string][]; body: string }>>();
  /** Bumped by disconnect: a refresh or registration still under way from before cannot write back. */
  private gens = new Map<string, number>();
  private keyFile: string;

  constructor(
    private config: ConfigStore,
    private opts: McpOAuthOptions = {},
  ) {
    this.keyFile = join(config.paths.home, LOGINS_KEY_FILE);
    // this may make the key before the login vault does: sessions never read it either way
    markHubPrivate(this.keyFile);
  }

  private gen(server: string): number {
    return this.gens.get(server) ?? 0;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The stored record; with serverUrl, nothing unless it was made for that URL. */
  read(server: string, serverUrl?: string): Stored {
    const sealed = this.config.secretValue(oauthSecretName(server));
    const key = sealed ? sealKey(this.keyFile, false) : undefined;
    const plain = key && sealed ? open(key, oauthSecretName(server), sealed) : undefined;
    if (!plain) return {};
    try {
      const s = JSON.parse(plain) as Stored;
      return serverUrl !== undefined && s.serverUrl !== serverUrl ? {} : s;
    } catch {
      return {};
    }
  }

  private write(server: string, next: Stored): void {
    const name = oauthSecretName(server);
    if (!next.client && !next.tokens && !next.discovery) return this.config.setSecret('values', name, undefined);
    this.config.setSecret('values', name, seal(sealKey(this.keyFile, true)!, name, JSON.stringify(next)));
  }

  private patch(server: string, serverUrl: string, fn: (s: Stored) => Stored): void {
    this.write(server, { ...fn(this.read(server, serverUrl)), serverUrl });
  }

  /** Signed in: the hub holds tokens for this server at this URL. */
  hasTokens(server: string, serverUrl: string): boolean {
    return !!this.read(server, serverUrl).tokens?.access_token;
  }

  /** Refuse anything but https on a public address, unless the origin is allowed (tests). */
  private async guard(raw: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new McpOAuthError('The server gave a sign-in address that does not parse.');
    }
    if (this.opts.allowOrigins?.includes(u.origin)) return;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const refuse = (why: string) => {
      log.warn(`refused ${u.protocol}//${host}: ${why}`);
      return new McpOAuthError(`Refused a sign-in address on ${host}: ${why}.`);
    };
    if (u.protocol !== 'https:') throw refuse('only https is allowed');
    if (isLocalName(host) || (isIP(host) && isPrivateAddress(host))) throw refuse('it is on a private network');
    const g = await guardHost(u);
    if ('error' in g) throw refuse('it is a cloud metadata address');
    if (g.address && isPrivateAddress(g.address)) throw refuse('it is on a private network');
  }

  /** fetch with every hop guarded, redirects followed here so each one is checked too. */
  private async guardedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const base = this.opts.fetch ?? fetch;
    let target = String(url);
    let req = init;
    for (let hop = 0; hop < 5; hop++) {
      await this.guard(target);
      const res = await base(target, { ...req, redirect: 'manual' });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) {
        // status only: a body can carry tokens or the server's own words
        if (res.status >= 400 && res.status !== 401) log.warn(`${new URL(target).host} answered HTTP ${res.status}`);
        return res;
      }
      const next = new URL(loc, target);
      if (next.origin !== new URL(target).origin) {
        const headers = new Headers(req?.headers);
        headers.delete('authorization');
        req = { ...req, headers };
      }
      if (res.status !== 307 && res.status !== 308) req = { ...req, method: 'GET', body: undefined };
      target = next.href;
    }
    throw new McpOAuthError('The server redirected too many times.');
  }

  /**
   * The fetch the transport and auth() use for this server: every address
   * guarded, and token requests with grant_type=refresh_token run once per
   * refresh token.
   */
  fetchFor(): FetchLike {
    return async (url, init) => {
      const body = init?.body;
      const params = body instanceof URLSearchParams ? body : typeof body === 'string' ? new URLSearchParams(body) : undefined;
      const rt = init?.method === 'POST' && params?.get('grant_type') === 'refresh_token' ? params.get('refresh_token') : null;
      if (!rt) return this.guardedFetch(url, init);
      let p = this.refreshes.get(rt);
      if (!p) {
        p = this.guardedFetch(url, init).then(async (r) => ({ status: r.status, headers: [...r.headers.entries()], body: await r.text() }));
        this.refreshes.set(rt, p);
        const drop = () => setTimeout(() => this.refreshes.delete(rt), REFRESH_REUSE_MS).unref?.();
        p.then(drop, () => this.refreshes.delete(rt));
      }
      const r = await p;
      return new Response(r.body, { status: r.status, headers: r.headers });
    };
  }

  /** The provider a transport uses: stored tokens, refresh on 401, and no browser (a needed sign-in surfaces as needs-auth). */
  provider(server: string, serverUrl: string): OAuthClientProvider {
    return this.makeProvider(server, serverUrl, {});
  }

  private makeProvider(server: string, serverUrl: string, flow: { state?: string; pending?: Pending; fresh?: boolean; onRedirect?: (u: URL) => void }): OAuthClientProvider {
    const self = this;
    const gen = this.gen(server);
    const read = () => self.read(server, serverUrl);
    // a disconnect since this provider was made wins over anything it still saves
    const save = (fn: (s: Stored) => Stored) => {
      if (self.gen(server) === gen) self.patch(server, serverUrl, fn);
    };
    const redirectUrl = () => flow.pending?.redirectUrl ?? read().redirectUrl;
    return {
      get redirectUrl() {
        return redirectUrl();
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'Conclave',
          redirect_uris: [redirectUrl() ?? 'http://127.0.0.1/'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      state: () => flow.state ?? randomBytes(16).toString('base64url'),
      clientInformation: () => {
        const s = read();
        // a registration made for another callback address cannot finish here
        if (flow.pending && s.redirectUrl && s.redirectUrl !== flow.pending.redirectUrl) return undefined;
        return s.client;
      },
      saveClientInformation: (client) => save((s) => ({ ...s, client, ...(flow.pending ? { redirectUrl: flow.pending.redirectUrl } : {}) })),
      // a Connect starts from no tokens, so the old ones keep working until the new ones arrive
      tokens: () => (flow.fresh ? undefined : read().tokens),
      saveTokens: (tokens) => save((s) => ({ ...s, tokens })),
      redirectToAuthorization: (url) => flow.onRedirect?.(url),
      saveCodeVerifier: (v) => {
        if (flow.pending) flow.pending.verifier = v;
      },
      codeVerifier: () => {
        if (!flow.pending?.verifier) throw new McpOAuthError('No sign-in is under way for this server.');
        return flow.pending.verifier;
      },
      saveDiscoveryState: (discovery) => save((s) => ({ ...s, discovery })),
      discoveryState: () => read().discovery,
      invalidateCredentials: (scope) =>
        save((s) => {
          if (scope === 'all') return {};
          if (scope === 'client') return { ...s, client: undefined };
          if (scope === 'tokens') return { ...s, tokens: undefined };
          if (scope === 'discovery') return { ...s, discovery: undefined };
          return s;
        }),
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt < now) this.pending.delete(k);
  }

  /** Start a sign-in: discovery and registration run now; returns the address to open. */
  async start(server: string, serverUrl: string, redirectUrl: string): Promise<{ authorizeUrl: string }> {
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    const pending: Pending = { server, serverUrl, redirectUrl, expiresAt: this.now() + FLOW_TTL };
    let authorizeUrl: URL | undefined;
    const p = this.makeProvider(server, serverUrl, { state, pending, fresh: true, onRedirect: (u) => (authorizeUrl = u) });
    let r: Awaited<ReturnType<typeof auth>>;
    try {
      r = await auth(p, { serverUrl, fetchFn: this.fetchFor() });
    } catch (err) {
      throw new McpOAuthError(`The sign-in could not start: ${oauthFailure(err)}.`);
    }
    if (r !== 'REDIRECT' || !authorizeUrl) throw new McpOAuthError('The server did not ask for a sign-in.');
    // the owner's browser opens it: never a javascript: or data: address
    if ((authorizeUrl as URL).protocol !== 'https:' && !this.opts.allowOrigins?.includes((authorizeUrl as URL).origin)) throw new McpOAuthError('The server gave a sign-in page that is not https.');
    this.pending.set(state, pending);
    return { authorizeUrl: authorizeUrl.toString() };
  }

  /** The server a pending sign-in with this state belongs to. */
  serverOf(state: string): string | undefined {
    const p = this.pending.get(state);
    return p && p.expiresAt >= this.now() ? p.server : undefined;
  }

  /** Finish a sign-in from the callback. Each state works once. */
  async finish(state: string, code: string | undefined, error?: string): Promise<{ server: string }> {
    const p = this.pending.get(state);
    if (!p) throw new McpOAuthError('This sign-in is unknown or already finished. Press Connect again in Conclave.');
    this.pending.delete(state);
    if (p.expiresAt < this.now()) throw new McpOAuthError('The sign-in took too long. Press Connect again.');
    if (error) throw new McpOAuthError(error === 'access_denied' ? 'You cancelled the sign-in.' : /^[a-z_]{1,40}$/.test(error) ? `The server answered ${error}.` : 'The server refused the sign-in.');
    if (!code) throw new McpOAuthError('The sign-in came back without a code.');
    const provider = this.makeProvider(p.server, p.serverUrl, { pending: p, fresh: true });
    let r: Awaited<ReturnType<typeof auth>>;
    try {
      r = await auth(provider, { serverUrl: p.serverUrl, authorizationCode: code, fetchFn: this.fetchFor() });
    } catch (err) {
      throw new McpOAuthError(`The sign-in could not finish: ${oauthFailure(err)}.`);
    }
    if (r !== 'AUTHORIZED') throw new McpOAuthError('The server did not accept the sign-in.');
    return { server: p.server };
  }

  /** Forget the tokens, the registration and any sign-in under way. */
  disconnect(server: string): void {
    this.gens.set(server, this.gen(server) + 1);
    for (const [k, p] of this.pending) if (p.server === server) this.pending.delete(k);
    this.write(server, {});
  }
}
