/**
 * REST routes. One handler per method in client/index.ts, same paths, query
 * and body shapes. Handlers stay thin: validate, call the engine, return JSON.
 */
import type { Context, Hono } from 'hono';
import QRCode from 'qrcode';
import type { ApprovalResponse, MemoryKind, MemoryScope, RoutineRun, Session, Task } from '@conclave/core/types.ts';
import type {
  AppDto,
  CreateSessionInput,
  GatewayKeyDto,
  HubInfo,
  PairingInfo,
  PairResult,
  SecondOpinionInput,
  SendInput,
  SessionPatch,
} from '@conclave/core/client/index.ts';
import type { SessionFilter } from '@conclave/core/storage/repos.ts';
import type { RoutineInput } from '@conclave/core/scheduler/types.ts';
import type { AgentDef } from '@conclave/core/extensions/types.ts';
import type { MemoryInput } from '@conclave/core/memory/types.ts';
import { deepMerge } from '@conclave/core/config/index.ts';
import { browserConfigProblems } from '@conclave/core/browser/engine.ts';
import { buildBundle } from '@conclave/core/session/share.ts';
import { INLINE_TYPES } from '@conclave/core/files/share.ts';
import { MAX_ATTACHMENTS, TOO_MANY_FILES } from '@conclave/core/attachments/limits.ts';
import type { ShareOptions } from '@conclave/core/client/share.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, PUBLIC_BODY_MAX, auditFor, badRequest, clientIp, isDirectLocal, notFound, optBool, qBool, qNum, readBody, readJson, requestOrigin, requireString } from './http';
import { ACTION_DECISIONS, verifyActionWith, type ActionDecision } from './actions';
import { safeEqual, sha256, type ClientRow } from './auth';
import { NONCE } from './identity';
import { checkLogin, clearPassword, passwordStatus, setPassword } from './password';
import { OWNER_ID, isMember } from '@conclave/core/people/context.ts';
import type { AccountRef } from '@conclave/core/client/people.ts';
import { accountRoutines } from '@conclave/core/people/scoped.ts';
import { checkAgentAllowed, accountOf, memberConfig, ownerOnly as adminOnly } from './scope';
import { esc, htmlPage } from './static';
import { registerExtensionRoutes } from './routes-extensions';
import { registerMemoryRoutes } from './routes-memory';
import { registerBackupRoutes } from './routes-backup';
import { registerCatalogRoutes } from './routes-catalog';
import { registerRoutineSuggestionRoutes } from './routes-suggestions';
import { registerAssistantRoutes } from './routes-assistant';
import { registerMapsRoutes } from './routes-maps';
import { registerWebSearchRoutes } from './routes-websearch';
import { registerPimRoutes } from './routes-pim';
import { registerWatchRoutes } from './routes-watches';
import { registerBrowserRoutes } from './routes-browser';
import { registerPreviewRoutes } from './routes-preview';
import { patchSession, registerProjectRoutes } from './routes-projects';
import { registerGithubRoutes } from './routes-github';
import { registerImportRoutes } from './routes-import';
import { registerWorkflowRoutes } from './routes-workflows';
import { appDevices, registerDaemonRoutes, registerDevice, removeDevice } from './routes-daemon';
import { importOffersOf } from '@conclave/core/import/registry.ts';
import { probeModel, probeModels, providerPatchProblem, removedProviders } from './provider-probe';

const PAIRING_TTL_MS = 10 * 60_000;
const ok = { ok: true as const };

const MEMORY_KINDS: MemoryKind[] = ['profile', 'fact', 'episode', 'procedure', 'inspiration'];
const MEMORY_SCOPES: MemoryScope[] = ['global', 'project', 'agent'];

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw badRequest(`${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function stringArray(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${name} must be an array of strings`);
  return v as string[];
}

/** ?thinking, ?toolOutput, ?attachments and ?code for the export and bundle routes (1 or 0, true or false). */
function shareOptions(c: Context): ShareOptions {
  const out: ShareOptions = {};
  for (const k of ['thinking', 'toolOutput', 'attachments', 'code'] as const) {
    const v = qBool(c.req.query(k));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Public URL for pairing: config.server.publicUrl, else where this request came in. */
export function publicUrl(ctx: ServerContext, req: Request): string {
  return (ctx.engine.config.get().server.publicUrl || requestOrigin(req)).replace(/\/+$/, '');
}

/**
 * Every address of the hub, best first (remote access: tunnel, own URL, the
 * same network), or where this request came in when there is none.
 */
export function hubAddresses(ctx: ServerContext, req: Request): string[] {
  const list = ctx.remote.addresses().map((a) => a.url);
  const first = list[0] ?? publicUrl(ctx, req);
  return [first, ...list.filter((u) => u !== first)];
}

/**
 * conclave://pair?url=...&code=...&fp=...&alt=... for QR codes. fp is the
 * hub's key fingerprint: an app checks the hub at url against it before it
 * sends the code. Each alt is another address, so an app can fall back to the
 * same network when a tunnel address goes away.
 */
export function pairDeepLink(addresses: string[], code: string, fingerprint: string): string {
  const alts = addresses.slice(1).map((a) => `&alt=${encodeURIComponent(a)}`).join('');
  return `conclave://pair?url=${encodeURIComponent(addresses[0])}&code=${encodeURIComponent(code)}&fp=${fingerprint}${alts}`;
}

/**
 * A pairing code for an account: the app or device paired with it is that
 * account's (docs/design/ACCOUNTS.md 4). With `again`, a code of that kind the
 * account made and has not used comes back with the addresses the hub has
 * now, so a QR shown before remote access was set gets the new address. A
 * used or expired one gets a new code.
 */
export async function createPairing(ctx: ServerContext, req: Request, kind: 'client' | 'device', accountId: string = OWNER_ID, again?: string): Promise<PairingInfo & { refreshed?: boolean }> {
  const codes = ctx.engine.repos.devices;
  const live = again ? codes.peekCode(again) : undefined;
  const same = live?.kind === kind && live.accountId === accountId;
  const code = same ? again!.trim().toUpperCase() : codes.createPairingCode(kind, PAIRING_TTL_MS, accountId);
  const expiresAt = (same ? live : codes.peekCode(code))?.expiresAt ?? Date.now() + PAIRING_TTL_MS;
  const addresses = hubAddresses(ctx, req);
  const url = addresses[0];
  const fingerprint = ctx.identity.fingerprint;
  const deepLink = pairDeepLink(addresses, code, fingerprint);
  const qrSvg = await QRCode.toString(deepLink, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { code, url, deepLink, qrSvg, expiresAt, addresses, fingerprint, ...(same ? { refreshed: true } : {}) };
}

/** An app as GET /api/clients and app.updated show it: the stored row, and whether it is connected now. */
export function appDto(ctx: ServerContext, row: ClientRow): AppDto {
  return { ...row, online: ctx.clients.connected(row.id) };
}

/**
 * Sign an app out: its token stops working, its socket closes, its account
 * hears app.updated, and a computer it shared (the desktop app's daemon)
 * goes with it. The caller checked who may do it.
 */
export function revokeApp(ctx: ServerContext, c: Context<HonoEnv>, id: string): void {
  const audit = auditFor(ctx.engine);
  if (!ctx.auth.clients.revoke(id)) throw notFound('unknown client');
  ctx.clients.disconnect(id, 'this app was revoked');
  announceApp(ctx, id);
  audit(c, 'client.revoke', id);
  const device = appDevices(ctx).deviceOf(id);
  appDevices(ctx).forgetClient(id);
  if (device && ctx.engine.repos.devices.get(device)) {
    removeDevice(ctx, device, 'its app was revoked');
    audit(c, 'device.delete', `${device}, shared by the revoked app`, { device });
  }
}

/** Tell the app's account (its other devices, setup's Devices step) that an app paired, went or connected. */
export function announceApp(ctx: ServerContext, id: string): void {
  const row = ctx.auth.clients.get(id);
  if (!row) return;
  try {
    ctx.engine.bus.emit({ type: 'app.updated', app: appDto(ctx, row) });
  } catch {
    /* an event must not break the request */
  }
}

/** engine.info() and the hub's key fingerprint, for Settings to show. */
export function hubInfo(ctx: ServerContext): HubInfo {
  return { ...ctx.engine.info(), fingerprint: ctx.identity.fingerprint };
}

function rateLimit(ctx: ServerContext, c: Context, limiter = ctx.pairLimiter): void {
  const ip = clientIp(c);
  if (!limiter.hit(ip)) {
    const wait = limiter.retryAfterSec(ip);
    throw Object.assign(new HttpError(429, `Too many attempts from this address. Try again in ${wait} seconds.`), { retryAfter: wait });
  }
}

/** Pairing and password attempts: 10 a minute, and an address with 10 wrong codes or passwords in 10 minutes waits, longer each time. */
function pairGate(ctx: ServerContext, c: Context): void {
  rateLimit(ctx, c);
  const ip = clientIp(c);
  const wait = isDirectLocal(c) ? 0 : ctx.pairGuard.blocked(ip);
  if (wait) throw Object.assign(new HttpError(429, `Too many wrong pairing codes or passwords from this address. Try again in ${wait} seconds.`), { retryAfter: wait });
}

/** A name and platform for a new client, from a pairing or login body. */
function clientLabel(body: { name?: unknown; platform?: unknown }): { name: string; platform?: string } {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'client';
  return { name, platform: typeof body.platform === 'string' ? body.platform : undefined };
}

export function registerRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;

  /** Session id from the path; 404 when unknown. */
  const sid = (c: Context): string => {
    const id = c.req.param('id') ?? '';
    if (!engine.getSession(id)) throw notFound(`unknown session ${id}`);
    return id;
  };

  const audit = auditFor(engine);

  // ----- hub -----------------------------------------------------------------

  // people: more than one account, so the login screen asks for a name (docs/design/ACCOUNTS.md 4)
  app.get('/api/health', (c) => c.json({ ok: true, version: engine.version, uptimeMs: Date.now() - engine.startedAt, people: engine.people.count() > 1 }));
  app.get('/api/info', (c) => c.json(hubInfo(ctx)));

  app.post('/api/pairing', async (c) => {
    const body = await readJson<{ kind?: string; code?: unknown }>(c);
    const kind = oneOf(body.kind ?? 'client', ['client', 'device'] as const, 'kind')!;
    if (body.code !== undefined && typeof body.code !== 'string') throw badRequest('code must be a pairing code');
    const { refreshed, ...info } = await createPairing(ctx, c.req.raw, kind, accountOf(c), body.code as string | undefined);
    // the same code with new addresses is not a new code
    if (!refreshed) audit(c, 'pairing.create', kind);
    return c.json(info);
  });

  /** A wrong guess: count it against the address. The same wrong value again is not a new guess. Returns the block it started, in seconds. */
  const guessFailed = (c: Context<HonoEnv>, mark: string): number => (isDirectLocal(c) ? 0 : ctx.pairGuard.fail(clientIp(c), Date.now(), mark));

  /** A wrong code: audit it, and count it against the address. */
  const pairFailed = (c: Context<HonoEnv>, kind: 'client' | 'device', code: string): never => {
    audit(c, 'pair.failed', `wrong or expired ${kind} code`);
    const block = guessFailed(c, code.trim().toUpperCase());
    if (block) audit(c, 'pair.blocked', `${clientIp(c)} for ${block}s after repeated wrong codes`);
    throw new HttpError(400, 'That pairing code is wrong or has expired. Make a new one on the Devices page, or with conclave pair on the hub.');
  };

  /** A new client token for an account, and what an app keeps with it: the hub, its addresses, its key and who signed in. */
  const clientReply = (c: Context<HonoEnv>, label: { name: string; platform?: string }, action: 'pair.client' | 'login.client', accountId: string) => {
    const { id, token } = ctx.auth.clients.create({ ...label, accountId });
    const account = engine.people.get(accountId);
    try {
      engine.repos.audit.add({ actor: `ip:${clientIp(c)}`, action, detail: `${label.name} (${label.platform ?? 'unknown'}) as ${id}${account ? ` for ${account.name}` : ''}`, accountId });
    } catch {
      /* auditing must not break the request */
    }
    const ref: AccountRef | undefined = account ? { id: account.id, name: account.name, ...(account.displayName ? { displayName: account.displayName } : {}), role: account.role } : undefined;
    const reply: PairResult & { account?: AccountRef } = { token, clientId: id, hub: hubInfo(ctx), addresses: hubAddresses(ctx, c.req.raw), identity: ctx.identity.identity(), ...(ref ? { account: ref } : {}) };
    // the page that showed the code (setup's Devices step, Devices) sees the phone at once
    announceApp(ctx, id);
    return c.json(reply);
  };

  app.post('/api/pair', async (c) => {
    pairGate(ctx, c);
    const body = await readJson<{ code?: unknown; name?: unknown; platform?: unknown }>(c);
    const code = requireString(body.code, 'code');
    const hit = engine.repos.devices.consumeCode(code);
    if (hit?.kind !== 'client' || !engine.people.get(hit.accountId)) pairFailed(c, 'client', code);
    return clientReply(c, clientLabel(body), 'pair.client', hit!.accountId);
  });

  // ----- hub identity and password login, docs/design/HUB-LOGIN-AND-IDENTITY.md -----

  /** The hub signs the app's nonce with its key (no auth). Apps check it before they send a token. */
  app.get('/api/identity', (c) => {
    const nonce = c.req.query('nonce') ?? '';
    if (!NONCE.test(nonce)) throw badRequest('nonce must be 16 to 128 base64url characters');
    return c.json(ctx.identity.prove(nonce), 200, { 'cache-control': 'no-store' });
  });

  /**
   * The backup to a pairing code (docs/design/ACCOUNTS.md 4). `account` names
   * whose password it is, by sign-in name or email; left out, it is the
   * owner's, as on a hub before accounts. A wrong name and a wrong password are one answer in the same
   * time, and count like a wrong code.
   */
  app.post('/api/login', async (c) => {
    pairGate(ctx, c);
    const body = await readJson<{ password?: unknown; name?: unknown; platform?: unknown; account?: unknown }>(c);
    const password = requireString(body.password, 'password');
    if (body.account !== undefined && body.account !== null && typeof body.account !== 'string') throw badRequest('account must be a name or email');
    const account = await checkLogin(engine.people, (body.account as string | undefined) ?? undefined, password);
    if (!account) {
      audit(c, 'login.failed', `wrong name or password${typeof body.account === 'string' && body.account ? '' : ' (no name)'}`);
      const block = guessFailed(c, `password:${sha256(`${body.account ?? ''}\u0000${password}`).slice(0, 16)}`);
      if (block) audit(c, 'login.blocked', `${clientIp(c)} for ${block}s after repeated wrong passwords`);
      throw new HttpError(400, engine.people.count() > 1 ? 'Wrong name or password.' : 'Wrong password, or no password is set on this hub.');
    }
    return clientReply(c, clientLabel(body), 'login.client', account.id);
  });

  /** Each person's own password. The owner's may be changed only with the hub token, as before accounts; a member changes theirs from a signed in app. */
  const passwordGate = (c: Context<HonoEnv>): string => {
    const who = c.get('auth');
    if (who.role === 'owner' && who.kind !== 'owner') throw new HttpError(403, 'Only the owner token can see or change the hub password.');
    return who.accountId;
  };
  app.get('/api/auth/password', (c) => {
    const acct = passwordGate(c);
    return c.json(passwordStatus(engine.people, acct));
  });
  app.put('/api/auth/password', async (c) => {
    const acct = passwordGate(c);
    const body = await readJson<{ password?: unknown }>(c);
    const status = await setPassword(engine.people, acct, body.password);
    audit(c, 'password.set', acct === OWNER_ID ? 'apps can log in with the hub password' : 'a password for this account');
    return c.json(status);
  });
  app.delete('/api/auth/password', (c) => {
    const acct = passwordGate(c);
    const had = passwordStatus(engine.people, acct).set;
    const status = clearPassword(engine.people, acct);
    if (had) audit(c, 'password.clear', 'logging in with a password is off');
    return c.json(status);
  });

  app.post('/api/daemon/register', async (c) => {
    pairGate(ctx, c);
    const body = await readJson<{ code?: unknown; name?: unknown }>(c);
    const code = requireString(body.code, 'code');
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'device';
    const hit = engine.repos.devices.consumeCode(code);
    if (hit?.kind !== 'device' || !engine.people.get(hit.accountId)) pairFailed(c, 'device', code);
    // a code the desktop app asked for gives its own computer the same device again (routes-daemon.ts); the device is the code's account's
    const { deviceId, token, again } = registerDevice(ctx, code, name, hit!.accountId);
    // a computer paired for the first time: once it is online, the hub offers to import its chats (import/offers.ts)
    if (!again) importOffersOf(engine)?.paired(deviceId, hit!.accountId);
    const row = engine.repos.devices.get(deviceId);
    if (row) engine.bus.emit({ type: 'device.updated', device: { ...row, online: false } });
    audit(c, 'pair.device', `${name} as ${deviceId}${again ? ', paired again from its app' : ''}`, { device: deviceId, accountId: hit!.accountId });
    return c.json({ deviceId, token, addresses: hubAddresses(ctx, c.req.raw) });
  });

  // the daemon inside the desktop app: a device code for an app that is already paired, and a daemon removing itself
  registerDaemonRoutes(app, ctx, audit, (ttlMs, req, accountId) => {
    const code = engine.repos.devices.createPairingCode('device', ttlMs, accountId);
    return { code, expiresAt: Date.now() + ttlMs, addresses: hubAddresses(ctx, req) };
  });

  // paired apps (phones, the desktop app, browsers, the CLI): list and revoke, each account its own
  app.get('/api/clients', (c) => c.json(ctx.auth.clients.list(accountOf(c)).map((r) => appDto(ctx, r))));
  app.delete('/api/clients/:id', (c) => {
    // each account signs out its own apps (route-policy.ts checks the id is theirs), from any of them or with the hub token:
    // Settings, Your account lists them with Sign out, and a signed out browser's own token stops working too
    revokeApp(ctx, c, c.req.param('id'));
    return c.json(ok);
  });

  // ----- sessions ------------------------------------------------------------

  app.get('/api/sessions', (c) => {
    const q = c.req.query();
    const filter: SessionFilter = {
      agent: q.agent || undefined,
      taskId: q.taskId || undefined,
      archived: qBool(q.archived),
      search: q.search || undefined,
      device: q.device || undefined,
      limit: qNum(q.limit),
      offset: qNum(q.offset),
      // one account's sessions only (docs/design/ACCOUNTS.md)
      accountId: accountOf(c),
      routineId: q.routineId || undefined,
      tag: q.tag || undefined,
      pinned: qBool(q.pinned),
      status: (q.status || undefined) as Session['status'] | undefined,
      kind: oneOf(q.kind || undefined, ['agent', 'chat'] as const, 'kind'),
    };
    if (q.parentId === 'none') filter.parentId = null;
    else if (q.parentId) filter.parentId = q.parentId;
    return c.json(engine.listSessions(filter));
  });

  app.post('/api/sessions', async (c) => {
    const input = await readJson<CreateSessionInput>(c);
    if (input.agent) checkAgentAllowed(engine, c, input.agent);
    // the account is the caller's, never the body's; a member's code session on the hub is refused before it starts
    return c.json(await engine.createSession(input, accountOf(c), { byPerson: true }));
  });

  app.get('/api/sessions/:id', (c) => {
    const s = engine.getSession(c.req.param('id'));
    if (!s) throw notFound(`unknown session ${c.req.param('id')}`);
    return c.json(s);
  });

  app.patch('/api/sessions/:id', async (c) => {
    const id = sid(c);
    // a new device goes through the same folder resolution as a move (routes-projects.ts)
    const res = await patchSession(ctx, id, await readJson<SessionPatch>(c));
    if (res.status === 409) return c.json({ error: res.result.line, ...res.result }, 409);
    return c.json(res.session);
  });

  // Move to main list: delegated work becomes a normal session of its kind; parentId stays (core engine/delegate.ts)
  app.post('/api/sessions/:id/main-list', (c) => c.json(engine.moveToMainList(sid(c))));

  // the owner opened it: no longer unread (core session/unread.ts)
  app.post('/api/sessions/:id/seen', (c) => c.json(engine.markSeen(sid(c))));

  // move, location, projects, device folders (folders across devices)
  registerProjectRoutes(app, ctx, audit);
  // repo sessions on GitHub: the connection, repositories, push, pull requests, clean up
  registerGithubRoutes(app, ctx);

  app.delete('/api/sessions/:id', async (c) => {
    const id = sid(c);
    await engine.deleteSession(id);
    return c.json(ok);
  });

  app.post('/api/sessions/:id/fork', async (c) => {
    const id = sid(c);
    const { fromSeq } = await readJson<{ fromSeq?: unknown }>(c);
    if (fromSeq !== undefined && fromSeq !== null && typeof fromSeq !== 'number') throw badRequest('fromSeq must be a number');
    return c.json(engine.forkSession(id, (fromSeq as number | null) ?? undefined));
  });

  app.get('/api/sessions/:id/messages', (c) => {
    const id = sid(c);
    return c.json(engine.getMessages(id, qNum(c.req.query('afterSeq'))));
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const id = sid(c);
    const input = await readJson<SendInput>(c);
    if (typeof input.text !== 'string') throw badRequest('text is required');
    if (input.attachments !== undefined && !Array.isArray(input.attachments)) throw badRequest('attachments must be an array');
    // the apps refuse more before sending; the hub says the same (core attachments/limits.ts)
    if (input.attachments && input.attachments.length > MAX_ATTACHMENTS) throw badRequest(TOO_MANY_FILES);
    if (input.pendingId !== undefined && typeof input.pendingId !== 'string') throw badRequest('pendingId must be a string');
    return c.json(await engine.send(id, input));
  });

  // messages sent while the session is busy, until each joins the transcript (session.queue keeps apps current)
  app.get('/api/sessions/:id/queue', (c) => c.json(engine.queue(sid(c))));

  app.delete('/api/sessions/:id/queue/:pendingId', (c) => {
    engine.unqueue(sid(c), c.req.param('pendingId'));
    return c.json(ok);
  });

  // /btw: a side question, answered apart from the transcript
  app.post('/api/sessions/:id/btw', async (c) => {
    const id = sid(c);
    const { text } = await readJson<{ text?: unknown }>(c);
    if (typeof text !== 'string' || !text.trim()) throw badRequest('text is required');
    return c.json(await engine.btw(id, text));
  });

  // a message Stop held: it runs now (or after the running turn)
  app.post('/api/sessions/:id/queue/:pendingId/send', (c) => {
    engine.sendQueued(sid(c), c.req.param('pendingId'));
    return c.json(ok);
  });

  app.post('/api/sessions/:id/abort', (c) => {
    engine.abort(sid(c));
    return c.json(ok);
  });

  // Pause: the call in progress finishes, then the session waits for Resume (kept across restarts)
  app.post('/api/sessions/:id/pause', (c) => c.json(engine.pauseSession(sid(c))));
  app.post('/api/sessions/:id/resume', async (c) => c.json(await engine.resumeSession(sid(c))));

  app.post('/api/sessions/:id/rewind', async (c) => {
    const id = sid(c);
    const body = await readJson<{ seq?: unknown; restoreFiles?: unknown }>(c);
    if (typeof body.seq !== 'number') throw badRequest('seq is required');
    return c.json(await engine.rewind(id, body.seq, body.restoreFiles === true));
  });

  app.post('/api/sessions/:id/second-opinion', async (c) => {
    const id = sid(c);
    await engine.secondOpinion(id, await readJson<SecondOpinionInput>(c));
    return c.json(ok);
  });

  // a switch: { model, brief? } (brief: a short handover, docs/DESIGN.md 44)
  app.post('/api/sessions/:id/handoff', async (c) => {
    const id = sid(c);
    const { model, brief } = await readJson<{ model?: unknown; brief?: unknown }>(c);
    const b = optBool(brief, 'brief');
    return c.json(await engine.handoff(id, requireString(model, 'model'), b ? { brief: true } : {}));
  });

  // "Try the next model" on a refused reply: { messageId? } (session/refusal-fallback.ts). The turn runs again on the
  // next model of the owner's Refusal fallback list; the answer is { model, label } of the model it tries.
  app.post('/api/sessions/:id/next-model', async (c) => {
    const id = sid(c);
    const { messageId } = await readJson<{ messageId?: unknown }>(c);
    if (messageId !== undefined && typeof messageId !== 'string') throw badRequest('messageId must be a string');
    return c.json(await engine.tryNextModel(id, messageId));
  });

  app.post('/api/sessions/:id/retry-provider', async (c) => {
    const id = sid(c);
    const { messageId, model } = await readJson<{ messageId?: unknown; model?: unknown }>(c);
    return c.json(await engine.retryProvider(id, requireString(messageId, 'messageId'), requireString(model, 'model')));
  });

  app.get('/api/sessions/:id/switch-estimate', (c) => {
    const id = sid(c);
    return c.json(engine.switchEstimate(id, requireString(c.req.query('model'), 'model')));
  });

  app.post('/api/sessions/:id/compact', async (c) => {
    const id = sid(c);
    // optional { instructions }: what the summary must keep
    const body = await readJson<{ instructions?: unknown }>(c);
    const instructions = typeof body.instructions === 'string' ? body.instructions.slice(0, 4_000) : undefined;
    const compacted = await engine.compact(id, instructions);
    return c.json({ ok: true, compacted });
  });

  app.get('/api/sessions/:id/context', async (c) => c.json(await engine.contextUsage(sid(c))));

  app.post('/api/sessions/:id/command', async (c) => {
    const id = sid(c);
    const { line } = await readJson<{ line?: unknown }>(c);
    const res = await engine.command(id, requireString(line, 'line'));
    return c.json({ ok: true, output: res?.output });
  });

  app.get('/api/sessions/:id/todos', (c) => c.json(engine.todos(sid(c))));
  app.get('/api/sessions/:id/checkpoints', (c) => c.json(engine.checkpoints(sid(c))));

  app.post('/api/sessions/:id/checkpoints/:checkpointId/restore', async (c) => {
    const id = sid(c);
    const cp = engine.repos.checkpoints.get(c.req.param('checkpointId'));
    if (!cp || cp.sessionId !== id) throw notFound('unknown checkpoint');
    await engine.restoreCheckpoint(id, cp.id);
    return c.json(ok);
  });

  app.get('/api/sessions/:id/diff', async (c) => c.json(await engine.diff(sid(c))));

  // sanitized by default (core session/share.ts); ?raw=1 is the stored rows, for the owner's backups only
  app.get('/api/sessions/:id/export', (c) => {
    const id = sid(c);
    const format = oneOf(c.req.query('format') ?? 'md', ['md', 'json'] as const, 'format')!;
    const raw = qBool(c.req.query('raw')) === true;
    if (raw && (c.get('auth')?.kind !== 'owner' || engine.sessionAccount(id) !== OWNER_ID)) throw new HttpError(403, 'Only the owner token can export the raw transcript. Leave out raw for a shareable copy.');
    if (raw) audit(c, 'session.export.raw', id, { sessionId: id });
    return c.json(engine.exportSession(id, format, { ...shareOptions(c), raw }));
  });

  // a file a ShareFile call shared (core files/share.ts): found by its tool call in this session and checked again; no path comes from the request
  app.get('/api/sessions/:id/files/:toolUseId', async (c) => {
    const id = sid(c);
    const toolUseId = c.req.param('toolUseId');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId)) throw notFound(`unknown session ${id}`);
    const f = await engine.sharedFile(id, toolUseId);
    const inline = qBool(c.req.query('inline')) === true && INLINE_TYPES.has(f.mediaType);
    const ascii = f.name.replace(/[^A-Za-z0-9._ -]/g, '_');
    audit(c, 'session.file.download', `${f.name} (${f.size} bytes)`, { sessionId: id });
    return new Response(f.bytes as unknown as BodyInit, {
      headers: {
        'content-type': f.mediaType,
        'content-length': String(f.bytes.byteLength),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'x-content-type-options': 'nosniff',
        // an SVG or HTML file a model wrote never runs as the hub's page
        'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        'cache-control': 'private, no-store',
      },
    });
  });

  // the session and its subagents, sanitized and signed with the hub key, for another Conclave
  app.get('/api/sessions/:id/bundle', (c) => {
    const id = sid(c);
    return c.json(buildBundle(engine, id, { ...shareOptions(c), signer: ctx.identity.bundleSigner() }));
  });

  app.get('/api/search', (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) return c.json([]);
    return c.json(engine.search(q, accountOf(c)));
  });

  // ----- approvals and questions --------------------------------------------

  app.get('/api/approvals', (c) => c.json(engine.pendingApprovals(accountOf(c))));

  // signed one-tap action from a notification (no bearer token)
  const act = async (c: Context<HonoEnv>) => {
    const id = c.req.param('id') ?? '';
    // "d" is the name links sent before this hub version used
    let decision = c.req.query('decision') ?? c.req.query('d');
    let sig = c.req.query('sig');
    if ((!decision || !sig) && c.req.method === 'POST') {
      const type = c.req.header('content-type') ?? '';
      if (type.includes('json')) {
        const b = await readJson<{ decision?: string; sig?: string }>(c);
        decision ??= b.decision;
        sig ??= b.sig;
      } else if (type.includes('form')) {
        // a form posts decision and sig urlencoded; read only up to the cap of a request with no token
        const f = new URLSearchParams(await readBody(c, PUBLIC_BODY_MAX));
        decision ??= f.get('decision') ?? undefined;
        sig ??= f.get('sig') ?? undefined;
      }
    }
    if (!decision || !ACTION_DECISIONS.includes(decision as ActionDecision)) throw badRequest(`decision must be one of ${ACTION_DECISIONS.join(', ')}`);
    if (!verifyActionWith(ctx.actionSecret, id, decision, sig)) throw new HttpError(403, 'This approval link is not valid. Open Conclave and answer the approval there.');
    const wantsHtml = (c.req.header('accept') ?? '').includes('text/html');
    if (c.req.method === 'GET') {
      // a GET (link preview, browser) never acts; it shows a button that POSTs
      return htmlPage(
        'Approve action',
        `<p>Approval <code>${esc(id)}</code>: <b>${esc(decision)}</b></p><form method="post" action="?decision=${encodeURIComponent(decision)}&amp;sig=${encodeURIComponent(sig!)}"><button type="submit">Confirm ${esc(decision)}</button></form>`,
      );
    }
    const pending = engine.pendingApprovals().find((a) => a.id === id);
    const response: ApprovalResponse =
      decision === 'deny'
        ? { decision: 'deny', message: 'Denied from notification' }
        : { decision: 'allow', scope: decision === 'allow' ? 'once' : (decision as 'session' | 'always'), rule: decision === 'always' ? pending?.suggestedRule : undefined };
    const resolved = engine.resolveApproval(id, response);
    if (!resolved) {
      if (wantsHtml) return htmlPage('Already handled', '<p>This approval is no longer pending.</p>', 404);
      throw notFound('This approval is not pending any more. It was answered or it expired; open Conclave to see the session.');
    }
    try {
      engine.repos.audit.add({ actor: 'notification', action: 'approval.act', detail: `${id} ${decision}`, sessionId: pending?.sessionId });
    } catch {
      /* ignore */
    }
    if (wantsHtml) return htmlPage('Done', `<p>Approval ${esc(decision === 'deny' ? 'denied' : 'allowed')}.</p>`);
    return c.json(ok);
  };
  app.post('/api/approvals/:id/act', act);
  app.get('/api/approvals/:id/act', act);

  app.post('/api/approvals/:id', async (c) => {
    const body = await readJson<ApprovalResponse>(c);
    if (body.decision !== 'allow' && body.decision !== 'deny') throw badRequest('decision must be allow or deny');
    if (!engine.resolveApproval(c.req.param('id'), body)) throw notFound('approval is not pending');
    return c.json(ok);
  });

  app.get('/api/questions', (c) => c.json(engine.pendingQuestions(accountOf(c))));

  app.post('/api/questions/:id', async (c) => {
    const { answers } = await readJson<{ answers?: unknown }>(c);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw badRequest('answers must be an object');
    if (!engine.answerQuestion(c.req.param('id'), answers as Record<string, string>)) throw notFound('question is not pending');
    return c.json(ok);
  });

  // ----- models, agents, extensions -----------------------------------------

  // a member sees which providers they can use: their own keys and the hub keys the owner allows
  app.get('/api/models', async (c) => c.json(await engine.listModels(accountOf(c))));
  // Refresh models: each account and harness is asked for its own model list again (owner only: it starts harnesses)
  app.post('/api/models/refresh', async (c) => c.json(await engine.refreshModels(accountOf(c))));

  app.post('/api/providers/:provider/test', async (c) => {
    const id = c.req.param('provider');
    if (!engine.config.get().providers[id]) throw notFound(`unknown provider ${id}`);
    return c.json(await engine.testProvider(id));
  });

  // Settings > Providers > Custom provider: { type, baseUrl, apiKey } probed as typed, nothing saved (provider-probe.ts)
  app.post('/api/providers/probe', async (c) => c.json(await probeModels(await readJson(c))));
  app.post('/api/providers/probe-model', async (c) => c.json(await probeModel(await readJson(c))));

  app.get('/api/agents', (c) => c.json(engine.agentsFor(accountOf(c))));

  app.put('/api/agents/:name', async (c) => {
    const name = c.req.param('name');
    const body = await readJson<Partial<AgentDef> & { scope?: string }>(c);
    const scope = oneOf(body.scope ?? 'user', ['user', 'project'] as const, 'scope')!;
    const { scope: _scope, ...rest } = body;
    const existing = engine.extensions.agent(name);
    const def: AgentDef = {
      ...(existing ?? {}),
      ...rest,
      name,
      description: rest.description ?? existing?.description ?? '',
      prompt: rest.prompt ?? existing?.prompt ?? '',
      source: scope,
    } as AgentDef;
    const saved = await engine.extensions.saveAgent(def, scope);
    audit(c, 'agent.save', name);
    return c.json(saved);
  });

  app.delete('/api/agents/:name', async (c) => {
    if (!(await engine.extensions.deleteAgent(c.req.param('name')))) throw notFound('unknown agent');
    audit(c, 'agent.delete', c.req.param('name'));
    return c.json(ok);
  });

  // a member sees the skills and commands that ship and plugin ones, never the owner's own
  app.get('/api/skills', (c) => c.json(engine.extensions.skills().filter((s) => !isMember(accountOf(c)) || s.source === 'builtin' || s.source === 'plugin')));
  app.get('/api/commands', (c) => c.json(engine.extensions.commands().filter((s) => !isMember(accountOf(c)) || s.source === 'builtin' || s.source === 'plugin')));
  app.get('/api/mcp', (c) => c.json(engine.mcpStatus()));
  app.get('/api/plugins', (c) => c.json(engine.extensions.plugins()));

  app.post('/api/plugins', async (c) => {
    const { source } = await readJson<{ source?: unknown }>(c);
    const p = await engine.extensions.installPlugin(requireString(source, 'source'));
    audit(c, 'plugin.install', String(source));
    return c.json(p);
  });

  app.delete('/api/plugins/:name', async (c) => {
    if (!(await engine.extensions.removePlugin(c.req.param('name')))) throw notFound('unknown plugin');
    audit(c, 'plugin.remove', c.req.param('name'));
    return c.json(ok);
  });

  app.patch('/api/plugins/:name', async (c) => {
    const { enabled, hooks } = await readJson<{ enabled?: unknown; hooks?: unknown }>(c);
    if (enabled !== undefined && typeof enabled !== 'boolean') throw badRequest('enabled must be a boolean');
    if (hooks !== undefined && typeof hooks !== 'boolean') throw badRequest('hooks must be a boolean');
    if (enabled === undefined && hooks === undefined) throw badRequest('send enabled or hooks');
    const name = c.req.param('name');
    if (!engine.extensions.plugins().some((p) => p.name === name)) throw notFound('unknown plugin');
    if (typeof enabled === 'boolean') await engine.extensions.setPluginEnabled(name, enabled);
    if (typeof hooks === 'boolean') {
      // hooks off keeps the plugin's skills, agents and commands (ponytail or caveman without a node process per prompt)
      if (!engine.extensions.setPluginHooks) throw badRequest('this hub cannot switch plugin hooks');
      await engine.extensions.setPluginHooks(name, hooks);
      audit(c, 'plugin.hooks', `${name} ${hooks ? 'on' : 'off'}`);
    }
    return c.json(ok);
  });

  app.get('/api/marketplace', async (c) => c.json(await engine.extensions.marketplaces()));

  app.post('/api/marketplace', async (c) => {
    const { source } = await readJson<{ source?: unknown }>(c);
    await engine.extensions.addMarketplace(requireString(source, 'source'));
    return c.json(ok);
  });

  app.post('/api/reload', async (c) => {
    await engine.reload();
    return c.json(ok);
  });

  // tools, hooks, trust, plugin detail, marketplace search, MCP admin, sync-clis, agent defaults
  registerExtensionRoutes(app, ctx, audit);

  // ----- tasks ---------------------------------------------------------------

  const taskExists = (id: string) => {
    if (!engine.repos.tasks.get(id)) throw notFound(`unknown task ${id}`);
  };

  app.get('/api/tasks', (c) => {
    const q = c.req.query();
    return c.json(engine.listTasks({ status: q.status || undefined, agent: q.agent || undefined, project: q.project || undefined, accountId: accountOf(c) }));
  });

  app.post('/api/tasks', async (c) => {
    const body = await readJson<Partial<Task>>(c);
    requireString(body.title, 'title');
    return c.json(engine.createTask(body as Partial<Task> & { title: string }, accountOf(c)));
  });

  app.patch('/api/tasks/:id', async (c) => {
    taskExists(c.req.param('id'));
    return c.json(engine.updateTask(c.req.param('id'), await readJson<Partial<Task>>(c)));
  });

  app.delete('/api/tasks/:id', (c) => {
    taskExists(c.req.param('id'));
    engine.deleteTask(c.req.param('id'));
    return c.json(ok);
  });

  app.post('/api/tasks/:id/start', async (c) => {
    taskExists(c.req.param('id'));
    const body = await readJson<{ agent?: string; model?: string; device?: string; cwd?: string }>(c);
    return c.json(await engine.startTask(c.req.param('id'), body));
  });

  // ----- routines ------------------------------------------------------------

  // suggestions first, so "suggestions" never reads as a routine id
  registerRoutineSuggestionRoutes(app, ctx, audit);
  // goals, assistant settings, Today, routine template upgrades
  registerAssistantRoutes(app, ctx, audit);
  // places, directions, map images and leave-by times (Settings > Maps)
  registerMapsRoutes(app, ctx, audit);
  // the engine WebSearch uses and its keys (Settings > Web search)
  registerWebSearchRoutes(app, ctx, audit);
  registerPimRoutes(app, ctx, audit);
  // watches: the Routines page rows, a watch's items and runs, item photos (routes-watches.ts)
  registerWatchRoutes(app, ctx);
  // Settings > Browser: profiles, the sites signed in to, the sign-in view (routes-browser.ts)
  registerBrowserRoutes(app, ctx, audit);
  // a Code session's Preview pane (routes-preview.ts)
  registerPreviewRoutes(app, ctx, audit);

  const routineExists = (id: string) => {
    const r = engine.routines.get(id);
    if (!r) throw notFound(`unknown routine ${id}`);
    return r;
  };

  app.get('/api/routines', (c) => c.json(engine.routines.list(accountOf(c))));
  app.get('/api/routines/templates', (c) => c.json(engine.routines.templates()));

  app.get('/api/routines/preview', (c) => {
    const schedule = c.req.query('schedule');
    if (!schedule) return c.json({ next: [], error: 'schedule is required' });
    try {
      return c.json({ next: engine.routines.preview(schedule, c.req.query('timezone') || undefined, 5) });
    } catch (err) {
      return c.json({ next: [], error: (err as Error).message });
    }
  });

  app.post('/api/routines', async (c) => {
    const body = await readJson<RoutineInput>(c);
    requireString(body.name, 'name');
    requireString(body.schedule, 'schedule');
    requireString(body.prompt, 'prompt');
    if (body.agent) checkAgentAllowed(engine, c, body.agent);
    let r;
    try {
      r = engine.routines.create(body, accountOf(c));
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    audit(c, 'routine.create', r.name);
    return c.json(r);
  });

  app.patch('/api/routines/:id', async (c) => {
    routineExists(c.req.param('id'));
    const body = await readJson<Partial<RoutineInput>>(c);
    if (body.agent) checkAgentAllowed(engine, c, body.agent);
    try {
      return c.json(engine.routines.update(c.req.param('id'), body));
    } catch (err) {
      // a schedule, rule list or limit the hub cannot use
      throw badRequest((err as Error).message);
    }
  });

  /**
   * Start a run and answer once it has its session, not when it ends: runs
   * take minutes, and a proxy or tunnel in front of the hub gives up long
   * before that. The run goes on; its updates arrive as routine.run events.
   */
  const startRun = (id: string, trigger: RoutineRun['trigger'], extra?: string) =>
    new Promise<RoutineRun>((resolve, reject) => {
      engine.routines.runNow(id, trigger, extra, { onStart: resolve }).then(resolve, reject);
    });

  app.delete('/api/routines/:id', (c) => {
    routineExists(c.req.param('id'));
    engine.routines.remove(c.req.param('id'));
    audit(c, 'routine.delete', c.req.param('id'));
    return c.json(ok);
  });

  app.post('/api/routines/:id/run', async (c) => {
    routineExists(c.req.param('id'));
    return c.json(await startRun(c.req.param('id'), 'manual'));
  });

  app.get('/api/routines/:id/runs', (c) => {
    routineExists(c.req.param('id'));
    return c.json(engine.routines.runs(c.req.param('id'), qNum(c.req.query('limit'))));
  });

  // webhook: the routine's own secret instead of a bearer token
  app.post('/api/routines/:id/trigger', async (c) => {
    const ip = clientIp(c);
    const id = c.req.param('id');
    const routine = engine.routines.get(id);
    const secret = c.req.header('x-conclave-secret') ?? c.req.query('secret');
    if (!routine || !routine.webhookSecret || !safeEqual(secret, routine.webhookSecret)) {
      if (!ctx.webhookLimiter.hit(ip)) throw new HttpError(429, 'too many failed attempts');
      throw new HttpError(401, 'invalid routine or secret');
    }
    if (!routine.enabled) throw new HttpError(409, 'routine is disabled');
    const text = (await c.req.text()).slice(0, 64 * 1024).trim();
    return c.json(await startRun(id, 'webhook', text || undefined));
  });

  // ----- memory --------------------------------------------------------------

  app.get('/api/memory', (c) => {
    const q = c.req.query();
    return c.json(
      engine.memoryFor(accountOf(c)).list({
        scope: oneOf(q.scope, MEMORY_SCOPES, 'scope'),
        scopeKey: q.scopeKey || undefined,
        kind: oneOf(q.kind, MEMORY_KINDS, 'kind'),
        limit: qNum(q.limit),
        offset: qNum(q.offset),
      }),
    );
  });

  app.get('/api/memory/search', async (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) return c.json([]);
    return c.json(await engine.memoryFor(accountOf(c)).search(q, { limit: qNum(c.req.query('limit')) ?? 20 }));
  });

  // connections, file import, export and /api/memory/stats
  registerMemoryRoutes(app, ctx, audit);

  app.post('/api/memory', async (c) => {
    const body = await readJson<MemoryInput>(c);
    requireString(body.content, 'content');
    oneOf(body.kind, MEMORY_KINDS, 'kind');
    oneOf(body.scope, MEMORY_SCOPES, 'scope');
    stringArray(body.tags, 'tags');
    return c.json(await engine.memoryFor(accountOf(c)).save(body));
  });

  app.patch('/api/memory/:id', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    oneOf(body.kind, MEMORY_KINDS, 'kind');
    oneOf(body.scope, MEMORY_SCOPES, 'scope');
    stringArray(body.tags, 'tags');
    const updated = await engine.memoryFor(accountOf(c)).update(c.req.param('id'), body);
    if (!updated) throw notFound('unknown memory');
    return c.json(updated);
  });

  app.delete('/api/memory/:id', async (c) => {
    if (!(await engine.memoryFor(accountOf(c)).remove(c.req.param('id')))) throw notFound('unknown memory');
    return c.json(ok);
  });

  // ----- usage ---------------------------------------------------------------

  app.get('/api/usage', (c) => {
    const q = c.req.query();
    return c.json(engine.usageSummary({ from: qNum(q.from), to: qNum(q.to), tzOffset: qNum(q.tzOffset), accountId: accountOf(c) }));
  });
  // SQLite reads a negative LIMIT as no limit at all
  app.get('/api/usage/recent', (c) => c.json(engine.usageRecent(Math.max(0, Math.min(1000, qNum(c.req.query('limit')) ?? 100)), accountOf(c))));
  // the hub's limits: a member sees those of the hub keys they may use
  app.get('/api/limits', (c) => {
    const acct = accountOf(c);
    if (!isMember(acct)) return c.json(engine.limits());
    return c.json(engine.limits().filter((l) => engine.access.source(acct, l.provider) === 'hub'));
  });
  app.post('/api/limits/refresh', async (c) => {
    // each signed in plan's usage too (accounts), for at most 8 seconds
    await Promise.race([ctx.cliproxy.refreshUsage({ force: true }).catch(() => undefined), Bun.sleep(8_000)]);
    ctx.cliproxy.accountService.publish();
    return c.json(await engine.refreshLimits());
  });

  // ----- devices -------------------------------------------------------------

  const deviceMachine = (id: string) => {
    if (engine.devices.get(id)) return;
    if (engine.repos.devices.get(id)) throw new HttpError(409, `device ${id} is offline`);
    throw notFound(`unknown device ${id}`);
  };

  app.get('/api/devices', (c) => c.json(engine.devices.list(accountOf(c))));

  // the computer this app runs on, when the hub can tell: a daemon from the same address, or the hub's own computer
  // for a browser on it (Code starts there by default). A member never gets the hub's computer.
  app.get('/api/devices/here', (c) => {
    const acct = accountOf(c);
    const mine = new Set(engine.devices.list(acct).map((d) => d.id));
    const ip = clientIp(c);
    const at = ctx.daemons.deviceAt(ip);
    const device = at && mine.has(at) ? at : !isMember(acct) && isDirectLocal(c) ? 'local' : undefined;
    return c.json(device ? { device } : {});
  });

  app.patch('/api/devices/:id', async (c) => {
    const id = c.req.param('id');
    if (id === 'local') {
      // the hub's own device: the owner may name it, since every app shows it ("Hub madx online"); nothing else about it is set here
      if (c.get('auth')?.kind !== 'owner') throw new HttpError(403, 'Only the owner token can rename the hub.');
      adminOnly(c);
      const body = await readJson<{ name?: unknown; roots?: unknown }>(c);
      if (body.roots !== undefined) throw badRequest('the hub device has no roots to set');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 64) throw badRequest('name must be 1 to 64 characters');
      const device = engine.devices.renameHub(name);
      audit(c, 'device.update', 'local', { device: 'local' });
      return c.json(device);
    }
    if (!engine.repos.devices.get(id)) throw notFound(`unknown device ${id}`);
    const body = await readJson<{ name?: unknown; roots?: unknown }>(c);
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw badRequest('name must be a non-empty string');
    const roots = stringArray(body.roots, 'roots');
    engine.repos.devices.update(id, { name: (body.name as string | undefined)?.trim(), roots });
    const device = engine.devices.list().find((d) => d.id === id)!;
    engine.bus.emit({ type: 'device.updated', device });
    audit(c, 'device.update', id, { device: id });
    return c.json(device);
  });

  app.delete('/api/devices/:id', (c) => {
    const id = c.req.param('id');
    if (id === 'local') throw badRequest('the hub device cannot be removed');
    if (!engine.repos.devices.get(id)) throw notFound(`unknown device ${id}`);
    removeDevice(ctx, id, 'device removed');
    audit(c, 'device.delete', id, { device: id });
    return c.json(ok);
  });

  app.get('/api/devices/:device/files', async (c) => {
    const device = c.req.param('device');
    deviceMachine(device);
    return c.json(await engine.browse(device, c.req.query('path') ?? ''));
  });

  app.get('/api/devices/:device/file', async (c) => {
    const device = c.req.param('device');
    deviceMachine(device);
    return c.json(await engine.readDeviceFile(device, requireString(c.req.query('path'), 'path')));
  });

  // chat import: scan, estimate, batches, uploads, sync, retention, and the two older routes (routes-import.ts)
  registerImportRoutes(app, ctx, audit);

  // workflows: the library, runs, worktree actions, findings (routes-workflows.ts)
  registerWorkflowRoutes(app, ctx, audit);

  // ----- gateway keys --------------------------------------------------------

  app.get('/api/gateway/keys', (c) => c.json(engine.repos.gatewayKeys.list() satisfies GatewayKeyDto[]));

  app.post('/api/gateway/keys', async (c) => {
    const body = await readJson<{ name?: unknown; device?: unknown; agent?: unknown }>(c);
    const created = ctx.auth.createGatewayKey({
      name: requireString(body.name, 'name'),
      device: typeof body.device === 'string' ? body.device : undefined,
      agent: typeof body.agent === 'string' ? body.agent : undefined,
    });
    audit(c, 'gateway.key.create', `${created.name} (${created.prefix})`);
    return c.json(created satisfies GatewayKeyDto & { key: string });
  });

  app.delete('/api/gateway/keys/:id', (c) => {
    const id = c.req.param('id');
    if (!engine.repos.gatewayKeys.list().some((k) => k.id === id)) throw notFound('unknown gateway key');
    engine.repos.gatewayKeys.revoke(id);
    audit(c, 'gateway.key.revoke', id);
    return c.json(ok);
  });

  // ----- config, secrets, notifications -------------------------------------

  app.get('/api/config', (c) => {
    // a member sees the parts of the hub's config they use, and their own secret names
    if (isMember(accountOf(c))) return c.json(memberConfig(engine, accountOf(c)));
    const owner = c.get('auth')?.kind === 'owner';
    const config = structuredClone(engine.config.get()) as unknown as Record<string, any>;
    const user = structuredClone(engine.config.getUser()) as unknown as Record<string, any>;
    // only the owner sees the owner token; paired clients get everything else
    if (!owner) {
      if (config.server) delete config.server.token;
      if (user.server) delete user.server.token;
    }
    // keyed: providers with a key from anywhere (stored, config or the hub's environment)
    const keyed = Object.keys(engine.config.get().providers).filter((id) => engine.config.hasProviderKey(id));
    return c.json({ config, user, secrets: { ...engine.config.secretNames(), keyed } });
  });

  app.patch('/api/config', async (c) => {
    const patch = await readJson<Record<string, any>>(c);
    if (patch.server && typeof patch.server === 'object' && 'token' in patch.server) {
      const t = patch.server.token;
      if (c.get('auth')?.kind !== 'owner') throw new HttpError(403, 'only the owner can change the server token');
      if (typeof t !== 'string' || t.length < 16) throw badRequest('server.token must be a string of at least 16 characters');
    }
    // a bad browser engine or pin is refused here, not at the next launch
    if (patch.browser !== undefined) {
      const bad = browserConfigProblems(deepMerge(structuredClone(engine.config.get().browser), patch.browser));
      if (bad.length) throw badRequest(bad.join(' '));
    }
    const badProvider = providerPatchProblem(patch.providers, engine.config.get().providers, (s) => engine.config.expand(s));
    if (badProvider) throw badRequest(badProvider);
    const removed = removedProviders(patch.providers);
    if (removed.length) {
      // deepMerge keeps a null: remove the entries from the user config the way routes-browser writeBrowser does
      const user = deepMerge(structuredClone(engine.config.getUser()) as Record<string, any>, patch);
      for (const id of removed) delete user.providers?.[id];
      engine.config.replace(user);
    } else engine.config.update(patch);
    engine.bus.emit({ type: 'config.updated' });
    audit(c, 'config.update', Object.keys(patch).join(','));
    return c.json(ok);
  });

  app.put('/api/secrets', async (c) => {
    const body = await readJson<{ kind?: unknown; key?: unknown; value?: unknown }>(c);
    const kind = oneOf(body.kind, ['providers', 'values'] as const, 'kind');
    if (!kind) throw badRequest('kind is required');
    const key = requireString(body.key, 'key');
    if (body.value !== null && body.value !== undefined && typeof body.value !== 'string') throw badRequest('value must be a string or null');
    const acct = accountOf(c);
    if (isMember(acct)) {
      // a member's own provider keys, in their own secrets file; the hub's secrets are the owner's
      if (kind !== 'providers' || !engine.config.get().providers[key]) throw new HttpError(403, 'You can save keys for the providers on this hub. Ask the owner for anything else.');
      engine.accountSecrets.set(acct, 'providers', key, (body.value as string | null) ?? undefined);
      audit(c, 'secret.set', `${kind}.${key}${body.value ? '' : ' (removed)'} (own key)`);
      return c.json(ok);
    }
    engine.config.setSecret(kind, key, (body.value as string | null) ?? undefined);
    engine.bus.emit({ type: 'config.updated' });
    audit(c, 'secret.set', `${kind}.${key}${body.value ? '' : ' (removed)'}`);
    return c.json(ok);
  });

  app.get('/api/notify/channels', (c) => c.json(engine.notifier.channels()));

  // { channel?: 'webpush', endpoint?: string }: with an endpoint only that browser gets the test
  app.post('/api/notify/test', async (c) => {
    const body = await readJson<{ channel?: unknown; endpoint?: unknown }>(c);
    const id = body.channel === undefined ? 'webpush' : requireString(body.channel, 'channel');
    if (!engine.notifier.channels().some((ch) => ch.id === id)) throw notFound(`There is no notification channel called ${id}. Use webpush.`);
    if (body.endpoint !== undefined && typeof body.endpoint !== 'string') throw badRequest('endpoint must be a string');
    await engine.notifier.test(id, { ...(body.endpoint ? { endpoint: body.endpoint as string } : {}), accountId: accountOf(c) });
    return c.json(ok);
  });

  app.get('/api/notify/vapid', (c) => c.json({ publicKey: engine.notifier.vapidPublicKey() }));

  app.post('/api/notify/subscribe', async (c) => {
    const body = await readJson<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; device?: unknown }>(c);
    const endpoint = requireString(body.endpoint, 'endpoint');
    if (!/^https:\/\//.test(endpoint)) throw badRequest('endpoint must be an https URL');
    const p256dh = requireString(body.keys?.p256dh, 'keys.p256dh');
    const authKey = requireString(body.keys?.auth, 'keys.auth');
    engine.notifier.addPushSubscription({ endpoint, keys: { p256dh, auth: authKey } }, typeof body.device === 'string' ? body.device : undefined, accountOf(c));
    return c.json(ok);
  });

  app.post('/api/notify/unsubscribe', async (c) => {
    const body = await readJson<{ endpoint?: unknown }>(c);
    engine.notifier.removePushSubscription(requireString(body.endpoint, 'endpoint'), accountOf(c));
    return c.json(ok);
  });

  app.get('/api/notify/devices', (c) => c.json(engine.notifier.devices(accountOf(c))));

  app.delete('/api/notify/devices/:id', (c) => {
    const id = c.req.param('id');
    if (!engine.notifier.removeDevice(id, accountOf(c))) throw notFound('That device no longer gets notifications. Reload the list.');
    audit(c, 'notify.device.remove', id);
    return c.json(ok);
  });

  app.get('/api/audit', (c) => {
    const q = c.req.query();
    // each account reads its own entries; the hub's own (no account) are the owner's
    return c.json(engine.listAudit({ sessionId: q.sessionId || undefined, limit: qNum(q.limit), accountId: accountOf(c) }));
  });

  // GET /api/backup and POST /api/restore
  registerBackupRoutes(app, ctx, audit);

  // Discover catalog and the agentic-tools task import (routes-catalog.ts)
  registerCatalogRoutes(app, ctx, audit);
}
