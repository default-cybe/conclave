/**
 * Mock routes for OAuth on /mcp: the consent page's request
 * (GET /api/oauth/requests/:id, POST the answer) and Settings > Connected
 * apps (GET /api/oauth/apps, DELETE /api/oauth/apps/:id).
 *
 * Requests to try: /oauth/consent?request=oar_demo (claude.ai),
 * oar_chatgpt, oar_lookalike (a "Claude" on another host), oar_local
 * (Claude Code on this computer). Any other id has expired.
 */
import type { ConnectedAppDto, OAuthConsentDto, OAuthScope } from '@conclave/core/client';
import type { MockCtx } from './index';

const MIN = 60_000;
const DAY = 86_400_000;

const WORDS: Record<OAuthScope, string> = {
  'memory:read': "Read your memory: your profile, facts, goals, tasks and today's plan",
  'memory:write': 'Save new memories and forget old ones',
  'chats:read': 'Search your past chats',
};
const ALL: OAuthScope[] = ['memory:read', 'memory:write', 'chats:read'];
const scopes = (list: OAuthScope[]) => list.map((id) => ({ id, label: WORDS[id] }));

type Demo = Omit<OAuthConsentDto, 'id' | 'consent' | 'expiresAt'> & { state: string };

const DEMOS: Record<string, Demo> = {
  oar_demo: {
    app: { name: 'Claude', host: 'claude.ai', kind: 'dcr', loopback: false },
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    scopes: scopes(ALL),
    state: 'c2f1',
  },
  oar_chatgpt: {
    app: { name: 'ChatGPT', host: 'chatgpt.com', identity: 'chatgpt.com', kind: 'cimd', loopback: false },
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scopes: scopes(['memory:read', 'chats:read']),
    state: '9ab0',
  },
  oar_lookalike: {
    app: {
      name: 'Claude',
      host: 'claude-ai.connect-app.net',
      kind: 'dcr',
      loopback: false,
      warning: 'This app calls itself Claude, but Claude does not send you back to claude-ai.connect-app.net. Deny unless you set this app up yourself.',
    },
    redirectUri: 'https://claude-ai.connect-app.net/oauth/callback',
    scopes: scopes(ALL),
    state: '77d3',
  },
  oar_local: {
    app: {
      name: 'Claude Code',
      host: 'localhost',
      identity: 'claude.ai',
      kind: 'cimd',
      loopback: true,
      warning: 'This app finishes signing in on your own computer. Any program there can use this name. Allow it only if you started this sign in yourself just now, for example from Claude Code.',
    },
    redirectUri: 'http://localhost:51734/callback',
    scopes: scopes(['memory:read', 'memory:write']),
    state: '41e8',
  },
};

export function registerOAuth(ctx: MockCtx) {
  const { on, fail, sleep } = ctx;
  const opened = Date.now();
  const consent = new Map<string, string>();
  const decided = new Set<string>();
  let n = 0;

  const apps = new Map<string, ConnectedAppDto>();
  if (!ctx.FRESH) {
    const now = Date.now();
    for (const a of [
      { id: 'oac_claude', name: 'Claude', host: 'claude.ai', kind: 'dcr' as const, scopes: scopes(ALL), createdAt: now - 12 * DAY, lastUsedAt: now - 4 * MIN },
      { id: 'oac_chatgpt', name: 'ChatGPT', host: 'chatgpt.com', identity: 'chatgpt.com', kind: 'cimd' as const, scopes: scopes(['memory:read', 'chats:read']), createdAt: now - 3 * DAY, lastUsedAt: now - 2 * 3_600_000 },
      { id: 'oac_cc', name: 'Claude Code', host: 'localhost', identity: 'claude.ai', kind: 'cimd' as const, scopes: scopes(['memory:read', 'memory:write']), createdAt: now - 40 * DAY, lastUsedAt: now - 26 * 3_600_000 },
    ])
      apps.set(a.id, a);
  }

  on('GET', '/api/oauth/requests/:id', async ({ params }) => {
    await sleep(120);
    const id = params[0];
    const demo = DEMOS[id];
    if (!demo || decided.has(id)) fail(404, 'This sign in request expired or was already answered. Start again from the app.');
    const value = `mock-consent-${++n}`;
    consent.set(id, value);
    const { state: _s, ...rest } = demo;
    return { id, ...rest, expiresAt: opened + 10 * MIN, consent: value } satisfies OAuthConsentDto;
  });

  on('POST', '/api/oauth/requests/:id', async ({ params, body }) => {
    await sleep(350);
    const id = params[0];
    const demo = DEMOS[id];
    if (!demo || decided.has(id)) fail(404, 'This sign in request expired or was already answered. Start again from the app.');
    if (body?.consent !== consent.get(id)) fail(403, 'This consent page is out of date. Reload it and choose again.');
    const picked: string[] | undefined = Array.isArray(body?.scopes) ? body.scopes : undefined;
    if (body?.decision === 'allow' && picked && !picked.length) fail(400, 'Pick at least one thing to allow, or press Deny.');
    decided.add(id);
    const u = new URL(demo.redirectUri);
    if (body?.decision === 'allow') {
      u.searchParams.set('code', 'cac_mock');
      apps.set(`oac_${id}`, {
        id: `oac_${id}`,
        name: demo.app.name,
        host: demo.app.host,
        ...(demo.app.identity ? { identity: demo.app.identity } : {}),
        kind: demo.app.kind,
        scopes: demo.scopes.filter((s) => !picked || picked.includes(s.id)),
        createdAt: Date.now(),
      });
    } else u.searchParams.set('error', 'access_denied');
    u.searchParams.set('state', demo.state);
    u.searchParams.set('iss', location.origin);
    return { redirect: u.toString() };
  });

  on('GET', '/api/oauth/apps', async () => {
    await sleep(150);
    return [...apps.values()].sort((a, b) => b.createdAt - a.createdAt);
  });

  on('DELETE', '/api/oauth/apps/:id', async ({ params }) => {
    await sleep(250);
    if (!apps.delete(params[0])) fail(404, 'That app is not connected any more. Reload the list.');
    return { ok: true };
  });
}
