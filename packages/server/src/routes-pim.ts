/**
 * Calendar and mail (docs/DESIGN.md, Calendar and mail): accounts, the OAuth
 * sign-ins, and the proposals the owner approves. Every route is behind the
 * bearer token except the Google callback, which a browser reaches straight
 * from Google (or from the relay page on the project site): its state names
 * a sign-in the owner started in the last 15 minutes, and nothing else is
 * accepted there.
 */
import type { Context, Hono } from 'hono';
import { pimFor, pimServices, PimError, type PimService } from '@conclave/core/pim/index.ts';
import { isMember } from '@conclave/core/people/context.ts';
import { checkPublicHost, checkPublicUrl } from '@conclave/core/people/net.ts';
import { OAuthError } from '@conclave/core/mail/oauth.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, readJson, requestOrigin } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf } from './scope';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The page a browser lands on after Google. Plain, no scripts, nothing from the query echoed but the result. */
function callbackPage(ok: boolean, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conclave</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f6f3;color:#1d1c1a}main{max-width:28rem;padding:24px}h1{font-size:20px;margin:0 0 8px}@media(prefers-color-scheme:dark){body{background:#151413;color:#ecebe8}}</style></head><body><main><h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1><p>${esc(text)}</p><p>You can close this tab.</p></main></body></html>`;
}

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

export function registerPimRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  // each account its own calendars, mail and proposals (docs/design/ACCOUNTS.md 2)
  const svc = (c: Context<HonoEnv>): PimService => {
    const s = pimFor(ctx.engine, accountOf(c));
    if (!s) throw new HttpError(501, 'This hub has no calendar and mail service.');
    return s;
  };
  /** A member's servers are never on the hub's network: the hub would reach them for the member. */
  const publicOnly = async (c: Context<HonoEnv>, check: () => Promise<void>): Promise<void> => {
    if (!isMember(accountOf(c))) return;
    try {
      await check();
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  };
  /** Turn the service's errors into answers with the right status. */
  const run = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PimError) throw new HttpError(err.status, err.message);
      if (err instanceof OAuthError) throw badRequest(err.message);
      throw err;
    }
  };

  app.get('/api/pim', (c) => c.json(svc(c).settings()));

  app.post('/api/pim/accounts/caldav', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    await publicOnly(c, () => checkPublicUrl(String(b.serverUrl ?? '')));
    const a = await run(() => svc(c).addCaldav({ serverUrl: String(b.serverUrl ?? ''), username: String(b.username ?? ''), password: String(b.password ?? ''), ...(typeof b.label === 'string' ? { label: b.label } : {}), ...(typeof b.preset === 'string' ? { preset: b.preset as never } : {}) }));
    audit(c, 'pim.account.add', `${a.label} (CalDAV)`);
    return c.json(a);
  });

  app.post('/api/pim/accounts/imap', async (c) => {
    const b = await readJson<Record<string, any>>(c);
    await publicOnly(c, async () => {
      await checkPublicHost(String(b.host ?? ''));
      if (b.smtp && typeof b.smtp === 'object' && typeof b.smtp.host === 'string') await checkPublicHost(b.smtp.host);
    });
    const a = await run(() =>
      svc(c).addImap({
        host: String(b.host ?? ''),
        username: String(b.username ?? ''),
        password: String(b.password ?? ''),
        ...(b.port ? { port: Number(b.port) } : {}),
        ...(['tls', 'starttls', 'none'].includes(b.security) ? { security: b.security as 'tls' | 'starttls' | 'none' } : {}),
        ...(typeof b.address === 'string' ? { address: b.address } : {}),
        ...(typeof b.label === 'string' ? { label: b.label } : {}),
        ...(typeof b.preset === 'string' ? { preset: b.preset } : {}),
        ...(typeof b.draftsFolder === 'string' ? { draftsFolder: b.draftsFolder } : {}),
        ...(b.smtp && typeof b.smtp === 'object' ? { smtp: b.smtp } : {}),
        ...(typeof b.send === 'boolean' ? { send: b.send } : {}),
      }),
    );
    audit(c, 'pim.account.add', `${a.label} (IMAP)`);
    return c.json(a);
  });

  app.patch('/api/pim/accounts/:id', async (c) => {
    const b = await readJson<Record<string, any>>(c);
    const a = await run(() =>
      svc(c).updateAccount(c.req.param('id'), {
        ...(typeof b.label === 'string' ? { label: b.label } : {}),
        ...(bool(b.drafts) !== undefined ? { drafts: b.drafts } : {}),
        ...(bool(b.send) !== undefined ? { send: b.send } : {}),
        ...(bool(b.autoDraft) !== undefined ? { autoDraft: b.autoDraft } : {}),
        ...(typeof b.signature === 'string' ? { signature: b.signature } : {}),
        ...(typeof b.password === 'string' ? { password: b.password } : {}),
        ...(Array.isArray(b.calendars) ? { calendars: b.calendars.filter((x: unknown) => x && typeof x === 'object' && typeof (x as { remoteId?: unknown }).remoteId === 'string') } : {}),
      }),
    );
    if (bool(b.send) !== undefined) audit(c, 'pim.account.send', `${a.label}: ${b.send ? 'on' : 'off'}`);
    return c.json(a);
  });

  app.post('/api/pim/accounts/:id/test', async (c) => c.json(await run(() => svc(c).test(c.req.param('id')))));

  app.delete('/api/pim/accounts/:id', async (c) => {
    const label = await run(() => svc(c).account(c.req.param('id')).label);
    const out = await run(() => svc(c).removeAccount(c.req.param('id')));
    audit(c, 'pim.account.remove', `${label}${out.revoked ? ', revoked' : ''}`);
    return c.json(out);
  });

  // ----- OAuth ------------------------------------------------------------------

  app.put('/api/pim/oauth/clients', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
    await run(() => svc(c).oauth.setHubClients({ googleWebClientId: s('googleWebClientId'), googleWebSecret: s('googleWebSecret'), googleDesktopClientId: s('googleDesktopClientId'), googleDesktopSecret: s('googleDesktopSecret'), microsoftClientId: s('microsoftClientId') }));
    audit(c, 'pim.oauth.clients', Object.keys(b).filter((k) => !/secret/i.test(k)).join(', ') || 'secrets');
    return c.json(svc(c).settings());
  });

  const wants = (b: Record<string, unknown>) => ({ mail: bool(b.mail), drafts: bool(b.drafts), send: bool(b.send), calendar: bool(b.calendar), calendarWrite: bool(b.calendarWrite) });

  /**
   * Where a relayed Google sign-in comes back to (docs/design/OAUTH-APPS.md,
   * The relay): the hub origin the page names, when it is one of this hub's
   * own addresses or the origin of this request; without one, where this
   * request came in. The relay page sends the code wherever the state says,
   * so a stranger's host never goes in.
   */
  const relayOrigin = (c: Context<HonoEnv>, asked: unknown): string => {
    const here = requestOrigin(c.req.raw);
    if (asked === undefined || asked === '') return here;
    if (typeof asked !== 'string' || !URL.canParse(asked)) throw badRequest('origin must be the address of this hub that the page uses.');
    const own = new Set<string>([here, ...ctx.remote.knownOrigins()]);
    for (const u of [ctx.engine.config.get().server.publicUrl, c.req.header('origin')]) if (u && URL.canParse(u)) own.add(new URL(u).origin);
    const want = new URL(asked);
    if (!own.has(want.origin)) throw badRequest(`Google can only send the sign-in back to this hub's own address, and ${want.host || want.protocol} is not one.`);
    return asked;
  };

  app.post('/api/pim/oauth/google/start', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    const client = (typeof b.client === 'string' ? b.client : 'desktop') as never;
    const returnTo = client === 'relay' ? relayOrigin(c, b.origin) : undefined;
    return c.json(await run(() => svc(c).oauth.startGoogle({ client, wants: wants(b), ...(returnTo ? { returnTo } : {}), ...(typeof b.redirectUri === 'string' ? { redirectUri: b.redirectUri } : {}), ...(typeof b.accountId === 'string' ? { accountId: b.accountId } : {}), ...(typeof b.loginHint === 'string' ? { loginHint: b.loginHint } : {}) })));
  });

  /** The desktop app or the phone hands the code (or a refresh token it got) to the hub. */
  app.post('/api/pim/oauth/google/finish', async (c) => {
    const b = await readJson<Record<string, any>>(c);
    const flow = await run(() => svc(c).oauth.finishGoogle({ state: String(b.state ?? ''), ...(typeof b.code === 'string' ? { code: b.code } : {}), ...(typeof b.error === 'string' ? { error: b.error } : {}), ...(b.tokens && typeof b.tokens.refreshToken === 'string' ? { tokens: b.tokens } : {}) }));
    if (flow.state === 'done') audit(c, 'pim.account.signin', 'Google');
    return c.json(flow);
  });

  // public: a browser comes here from Google with ?code&state (or ?error&state)
  app.get('/api/pim/oauth/google/callback', async (c: Context<HonoEnv>) => {
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code');
    const error = c.req.query('error');
    // the sign-in is in the service of the account that started it
    const s = pimServices(ctx.engine).find((x) => x.service.oauth.ownsState(state))?.service;
    if (!s || !state) return c.html(callbackPage(false, 'This address only finishes a sign-in started in Conclave.'), 400);
    try {
      const flow = await s.oauth.finishGoogle({ state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      if (flow.state !== 'done') return c.html(callbackPage(false, flow.error ?? 'Google did not finish the sign-in.'), 400);
      const acc = flow.accountId ? s.accounts().find((a) => a.id === flow.accountId) : undefined;
      return c.html(callbackPage(true, `${acc?.label ?? 'Your Google account'} is connected to Conclave. Settings shows it now.`));
    } catch (err) {
      return c.html(callbackPage(false, (err as Error).message), 400);
    }
  });

  app.post('/api/pim/oauth/microsoft/start', async (c) => {
    const b = await readJson<Record<string, unknown>>(c);
    return c.json(await run(() => svc(c).oauth.startMicrosoft({ wants: wants(b), ...(typeof b.accountId === 'string' ? { accountId: b.accountId } : {}) })));
  });

  app.get('/api/pim/oauth/flows/:id', (c) => {
    const f = svc(c).oauth.flow(c.req.param('id'));
    if (!f) throw new HttpError(404, 'That sign-in is unknown or too old.');
    return c.json(f);
  });

  app.delete('/api/pim/oauth/flows/:id', (c) => {
    svc(c).oauth.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- proposals -------------------------------------------------------------

  app.get('/api/proposals', (c) => {
    const status = c.req.query('status') || 'pending';
    if (!['pending', 'applied', 'declined', 'failed', 'all'].includes(status)) throw badRequest('status must be pending, applied, declined, failed or all');
    return c.json(svc(c).proposals({ status: status as never, limit: Math.min(200, Number(c.req.query('limit') ?? 50) || 50) }));
  });

  app.post('/api/proposals/:id/approve', async (c) => {
    const p = await run(() => svc(c).approve(c.req.param('id')));
    audit(c, 'proposal.approve', `${p.summary}: ${p.status}`, p.sessionId ? { sessionId: p.sessionId } : undefined);
    return c.json(p);
  });

  app.post('/api/proposals/:id/decline', async (c) => {
    const b = await readJson<{ note?: unknown }>(c);
    const p = await run(() => svc(c).decline(c.req.param('id'), typeof b.note === 'string' ? b.note : undefined));
    audit(c, 'proposal.decline', p.summary, p.sessionId ? { sessionId: p.sessionId } : undefined);
    return c.json(p);
  });
}
