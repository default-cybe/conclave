/**
 * Fake Google and Microsoft endpoints in one in-process server, for tests
 * and the real run: Google's token and revoke endpoints with PKCE checks,
 * Gmail (search, metadata, raw, drafts, send, profile), Google Calendar
 * (calendar list, expanded events, free/busy, insert, patch, delete), and
 * Microsoft's device code flow and Graph mail. No real Google or Microsoft
 * address is ever called.
 */
import { createHash } from 'node:crypto';
import type { PimEndpoints } from '../../src/pim/service';

export interface FakeCloud {
  url: string;
  endpoints: PimEndpoints;
  google: {
    clientId: string;
    clientSecret: string;
    /** codes the "browser" got: code -> PKCE challenge, redirect, scopes */
    codes: Map<string, { challenge: string; redirect: string; scope: string }>;
    refresh: Map<string, string>;
    revoked: string[];
    access: Set<string>;
    messages: Array<{ id: string; threadId: string; labelIds: string[]; raw: string; internalDate: number }>;
    /** Message ids the search still lists but whose fetch answers this status (404: deleted between the two). */
    failFetch: Map<string, number>;
    drafts: Array<{ raw: string; threadId?: string }>;
    sent: Array<{ raw: string }>;
    events: Map<string, Array<Record<string, any>>>;
    busy: Map<string, Array<{ start: string; end: string }>>;
  };
  microsoft: {
    clientId: string;
    pendingPolls: number;
    refresh: Map<string, string>;
    access: Set<string>;
    messages: Array<Record<string, any>>;
    drafts: Array<Record<string, any>>;
    sent: string[];
  };
  requests: Array<{ method: string; path: string; auth?: string; body?: string }>;
  /** What the browser does at Google's consent screen: approve and get the code for this auth URL. */
  approveGoogle(authUrl: string): { code: string; state: string; redirect: string };
  stop(): void;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const idToken = (email: string) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email, sub: '1' }))}.sig`;

export function startFakeCloud(opts: { googleEmail?: string; msEmail?: string } = {}): FakeCloud {
  const googleEmail = opts.googleEmail ?? 'owner@gmail.com';
  const msEmail = opts.msEmail ?? 'owner@outlook.com';
  const requests: FakeCloud['requests'] = [];
  let n = 0;
  const g: FakeCloud['google'] = {
    clientId: 'test-desktop.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-test-desktop-secret',
    codes: new Map(),
    refresh: new Map(),
    revoked: [],
    access: new Set(),
    messages: [],
    failFetch: new Map(),
    drafts: [],
    sent: [],
    events: new Map([['primary', []]]),
    busy: new Map(),
  };
  const ms: FakeCloud['microsoft'] = { clientId: 'ms-public-client', pendingPolls: 1, refresh: new Map(), access: new Set(), messages: [], drafts: [], sent: [] };
  /** The scopes the last device code asked for: the token grants them. */
  let msScope = '';

  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const bearer = (req: Request, set: Set<string>) => {
    const t = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    return set.has(t);
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const body = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
      requests.push({ method: req.method, path: p + url.search, auth: req.headers.get('authorization') ?? undefined, ...(body ? { body } : {}) });
      const form = new URLSearchParams(body);

      // ----- Google OAuth
      if (p === '/google/token') {
        const grant = form.get('grant_type');
        if (form.get('client_id') !== g.clientId && !String(form.get('client_id')).endsWith('.apps.googleusercontent.com')) return json({ error: 'invalid_client' }, 401);
        if (grant === 'authorization_code') {
          const c = g.codes.get(form.get('code') ?? '');
          if (!c) return json({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
          if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verifier does not match' }, 400);
          if (form.get('redirect_uri') !== c.redirect) return json({ error: 'redirect_uri_mismatch' }, 400);
          g.codes.delete(form.get('code')!);
          const access = `ya29.access-${++n}`;
          const refresh = `1//refresh-${n}`;
          g.access.add(access);
          g.refresh.set(refresh, c.scope);
          return json({ access_token: access, refresh_token: refresh, expires_in: 3599, scope: c.scope, token_type: 'Bearer', id_token: idToken(googleEmail) });
        }
        if (grant === 'refresh_token') {
          const scope = g.refresh.get(form.get('refresh_token') ?? '');
          if (!scope || g.revoked.includes(form.get('refresh_token')!)) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
          const access = `ya29.access-${++n}`;
          g.access.add(access);
          return json({ access_token: access, expires_in: 3599, scope, token_type: 'Bearer' });
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }
      if (p === '/google/revoke') {
        g.revoked.push(form.get('token') ?? '');
        return json({});
      }

      // ----- Gmail
      if (p.startsWith('/gmail/')) {
        if (!bearer(req, g.access)) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
        const rest = p.slice('/gmail'.length);
        if (rest === '/profile') return json({ emailAddress: googleEmail, messagesTotal: g.messages.length });
        if (rest === '/messages' && req.method === 'GET') {
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          const words = q.split(/\s+/).filter((w) => w && !w.includes(':'));
          const from = /from:(\S+)/.exec(q)?.[1];
          const unread = q.includes('is:unread');
          const list = g.messages
            .filter((m) => (!from || m.raw.toLowerCase().includes(`from:`) && m.raw.toLowerCase().split('\n').find((l) => l.startsWith('from:'))!.includes(from)) && (!unread || m.labelIds.includes('UNREAD')) && words.every((w) => m.raw.toLowerCase().includes(w)))
            .slice(0, Number(url.searchParams.get('maxResults') ?? 10));
          return json({ messages: list.map((m) => ({ id: m.id, threadId: m.threadId })) });
        }
        const mm = /^\/messages\/([^/]+)$/.exec(rest);
        if (mm && req.method === 'GET') {
          const fail = g.failFetch.get(decodeURIComponent(mm[1]));
          if (fail) return json({ error: { code: fail, message: fail === 404 ? 'Requested entity was not found.' : 'Backend Error' } }, fail);
          const m = g.messages.find((x) => x.id === decodeURIComponent(mm[1]));
          if (!m) return json({ error: { message: 'Not Found' } }, 404);
          if (url.searchParams.get('format') === 'raw') return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: String(m.internalDate), raw: Buffer.from(m.raw).toString('base64url') });
          const head = m.raw.split(/\r?\n\r?\n/)[0].split(/\r?\n/);
          const headers = head.map((l) => ({ name: l.slice(0, l.indexOf(':')), value: l.slice(l.indexOf(':') + 1).trim() }));
          return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: String(m.internalDate), snippet: m.raw.split(/\r?\n\r?\n/)[1]?.slice(0, 80).replace(/'/g, '&#39;'), payload: { headers } });
        }
        if (rest === '/drafts' && req.method === 'POST') {
          const b = JSON.parse(body) as { message: { raw: string; threadId?: string } };
          g.drafts.push({ raw: Buffer.from(b.message.raw, 'base64url').toString('utf8'), ...(b.message.threadId ? { threadId: b.message.threadId } : {}) });
          return json({ id: `r-${g.drafts.length}`, message: { id: `d-${g.drafts.length}` } });
        }
        if (rest === '/messages/send' && req.method === 'POST') {
          const b = JSON.parse(body) as { raw: string };
          g.sent.push({ raw: Buffer.from(b.raw, 'base64url').toString('utf8') });
          return json({ id: `s-${g.sent.length}` });
        }
        return json({ error: { message: 'no route' } }, 404);
      }

      // ----- Google Calendar
      if (p.startsWith('/gcal/')) {
        if (!bearer(req, g.access)) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
        const rest = p.slice('/gcal'.length);
        if (rest === '/users/me/calendarList') return json({ items: [...g.events.keys()].map((id) => ({ id, summary: id === 'primary' ? googleEmail : id, accessRole: 'owner', primary: id === 'primary', backgroundColor: '#9fe1e7' })) });
        if (rest === '/freeBusy') {
          const b = JSON.parse(body) as { items: Array<{ id: string }> };
          const calendars: Record<string, unknown> = {};
          for (const { id } of b.items) calendars[id] = g.busy.has(id) ? { busy: g.busy.get(id) } : { errors: [{ domain: 'global', reason: 'notFound' }] };
          return json({ calendars });
        }
        const em = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(rest);
        if (em) {
          const cal = decodeURIComponent(em[1]);
          const list = g.events.get(cal) ?? [];
          if (req.method === 'GET' && em[2]) {
            const one = list.find((e) => e.id === decodeURIComponent(em[2]));
            return one ? json({ ...one, etag: `"etag-${one.id}"` }) : json({ error: { message: 'Not Found' } }, 404);
          }
          if (req.method === 'GET') {
            const a = Date.parse(url.searchParams.get('timeMin')!);
            const b = Date.parse(url.searchParams.get('timeMax')!);
            return json({ items: list.filter((e) => Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00Z`) < b && Date.parse(e.end.dateTime ?? `${e.end.date}T00:00:00Z`) > a) });
          }
          if (req.method === 'POST') {
            const e = { ...(JSON.parse(body) as Record<string, any>), id: `gev${++n}`, status: 'confirmed', sendUpdates: url.searchParams.get('sendUpdates') };
            list.push(e);
            g.events.set(cal, list);
            return json(e);
          }
          const i = list.findIndex((e) => e.id === decodeURIComponent(em[2] ?? ''));
          if (i === -1) return json({ error: { message: 'Not Found' } }, 404);
          if (req.method === 'PATCH') {
            list[i] = { ...list[i], ...(JSON.parse(body) as Record<string, any>) };
            return json(list[i]);
          }
          if (req.method === 'DELETE') {
            list.splice(i, 1);
            return new Response(null, { status: 204 });
          }
        }
        return json({ error: { message: 'no route' } }, 404);
      }

      // ----- Microsoft identity
      if (p === '/ms/devicecode') {
        if (form.get('client_id') !== ms.clientId) return json({ error: 'unauthorized_client', error_description: 'AADSTS700016: Application not found' }, 400);
        msScope = form.get('scope') ?? '';
        return json({ device_code: 'dev-code-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1, message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-EFGH.' });
      }
      if (p === '/ms/token') {
        const grant = form.get('grant_type');
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (ms.pendingPolls > 0) {
            ms.pendingPolls--;
            return json({ error: 'authorization_pending' }, 400);
          }
          const access = `ms-access-${++n}`;
          const refresh = `ms-refresh-${n}`;
          ms.access.add(access);
          ms.refresh.set(refresh, msScope);
          return json({ access_token: access, refresh_token: refresh, expires_in: 3600, scope: msScope, id_token: idToken(msEmail) });
        }
        if (grant === 'refresh_token') {
          const scope = ms.refresh.get(form.get('refresh_token') ?? '');
          if (!scope) return json({ error: 'invalid_grant', error_description: 'AADSTS70000: refresh token is invalid' }, 400);
          ms.refresh.delete(form.get('refresh_token')!);
          const access = `ms-access-${++n}`;
          const refresh = `ms-refresh-${n}`;
          ms.access.add(access);
          ms.refresh.set(refresh, scope);
          return json({ access_token: access, refresh_token: refresh, expires_in: 3600, scope });
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      }

      // ----- Microsoft Graph
      if (p.startsWith('/graph/')) {
        if (!bearer(req, ms.access)) return json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } }, 401);
        const rest = p.slice('/graph'.length);
        if (rest === '/me') return json({ mail: msEmail, userPrincipalName: msEmail });
        if (rest === '/me/mailFolders/inbox') return json({ totalItemCount: ms.messages.length });
        if (rest === '/me/mailFolders/inbox/messages' || rest === '/me/messages') {
          if (req.method === 'POST') {
            const d = { ...(JSON.parse(body) as Record<string, any>), id: `msd-${++n}` };
            ms.drafts.push(d);
            return json(d, 201);
          }
          const search = (url.searchParams.get('$search') ?? '').replace(/"/g, '').toLowerCase();
          const filter = url.searchParams.get('$filter') ?? '';
          let list = ms.messages;
          if (search) list = list.filter((m) => search.split(' ').every((w) => (w.startsWith('from:') ? m.from.emailAddress.address.toLowerCase().includes(w.slice(5)) : `${m.subject} ${m.body.content}`.toLowerCase().includes(w))));
          if (filter.includes('isRead eq false')) list = list.filter((m) => !m.isRead);
          return json({ value: list.slice(0, Number(url.searchParams.get('$top') ?? 10)).map(({ body: _b, ...m }) => m) });
        }
        const mm = /^\/me\/messages\/([^/]+)(\/[a-zA-Z]+)?$/.exec(rest);
        if (mm) {
          const id = decodeURIComponent(mm[1]);
          const action = mm[2];
          if (action === '/send' && req.method === 'POST') {
            ms.sent.push(id);
            return new Response(null, { status: 202 });
          }
          const m = ms.messages.find((x) => x.id === id);
          if (!m) return json({ error: { message: 'not found' } }, 404);
          if (action === '/attachments') return json({ value: m.attachments ?? [] });
          if (action === '/createReply' && req.method === 'POST') {
            const b = JSON.parse(body) as { comment: string; message?: Record<string, unknown> };
            const d = { id: `msd-${++n}`, replyTo: id, comment: b.comment, ...(b.message ?? {}) };
            ms.drafts.push(d);
            return json(d, 201);
          }
          const text = req.headers.get('prefer')?.includes('text');
          // Graph turns HTML into text when asked to
          return json({ ...m, body: text ? { contentType: 'text', content: String(m.body.content).replace(/<[^>]+>/g, '') } : m.body });
        }
        return json({ error: { message: 'no route' } }, 404);
      }
      return new Response('not found', { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    endpoints: {
      googleAuth: `${url}/google/auth`,
      googleToken: `${url}/google/token`,
      googleRevoke: `${url}/google/revoke`,
      microsoft: `${url}/ms`,
      gmail: `${url}/gmail`,
      graph: `${url}/graph`,
      gcal: `${url}/gcal`,
    },
    google: g,
    microsoft: ms,
    requests,
    approveGoogle(authUrl) {
      const u = new URL(authUrl);
      const code = `4/code-${++n}`;
      g.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')!, scope: u.searchParams.get('scope')! });
      return { code, state: u.searchParams.get('state')!, redirect: u.searchParams.get('redirect_uri')! };
    },
    stop: () => server.stop(true),
  };
}
