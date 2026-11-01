/**
 * Accounts (docs/design/ACCOUNTS.md): who you are, and People for the owner.
 *
 *   GET   /api/me                       who this token is, what they may use
 *   PATCH /api/me                       their sign-in name, display name, email and defaults
 *   GET   /api/people                   (owner) everyone on the hub, with this month's spend
 *   POST  /api/people                   (owner) add a person: a password now, or an invite link
 *   GET   /api/people/:id               (owner)
 *   PATCH /api/people/:id               (owner) name, email, provider access and budgets
 *   DELETE /api/people/:id              (owner) remove them and everything that is theirs
 *   POST  /api/people/:id/password      (owner) set a new password; their apps sign out
 *   POST  /api/people/:id/invite        (owner) a new invite link
 *   POST  /api/people/:id/workspace     (owner) a device code for their workspace on the hub machine
 *   GET   /api/people/:id/clients       (owner) the apps they are signed in with
 *   DELETE /api/people/:id/clients/:client (owner) sign one of them out
 *   GET   /api/invite/:secret           (no token) who an invite is for
 *   POST  /api/invite/:secret           (no token) set a password and sign in
 */
import type { Context, Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import type { PairResult } from '@conclave/core/client/index.ts';
import type { Contact } from '@conclave/core/client/contacts.ts';
import { shownName, SPLIT_MAX, type AccountRef, type InviteDto, type InviteInfo, type MeDto, type MePatch, type PersonCreated, type PersonDto, type PersonInput, type PersonPatch, type ProviderGrantsDto, type WorkspaceCode } from '@conclave/core/client/people.ts';
import { isMember } from '@conclave/core/people/context.ts';
import { PeopleError, accountKey, type HubAccount, type ProviderGrants } from '@conclave/core/people/store.ts';
import { MEMBER_ALLOW_KEY } from '@conclave/core/engine/permissions-view.ts';
import { forgetAssistant } from '@conclave/core/assistant/registry.ts';
import { forgetPim } from '@conclave/core/pim/registry.ts';
import type { ConclaveConfig } from '@conclave/core/config/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, auditFor, badRequest, clientIp, isDirectLocal, notFound, readJson } from './http';
import { accountOf, ownerOnly } from './scope';
import { checkNewPassword, hashPassword } from './password';
import { appDto, hubAddresses, hubInfo, revokeApp } from './routes';
import { removeDevice } from './routes-daemon';

const INVITE_TTL_MS = 7 * 24 * 3_600_000;
/** A device code for a workspace lives an hour: the owner runs the commands on the hub machine. */
const WORKSPACE_TTL_MS = 60 * 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function peopleError(err: unknown): never {
  if (err instanceof PeopleError) throw new HttpError(err.status, err.message);
  throw err;
}

/**
 * Provider grants from a request: known provider ids the hub has a key (or a
 * signed in plan) for, a budget of 0 or more USD, or null for no cap.
 */
function grantsOf(ctx: ServerContext, raw: unknown): ProviderGrants {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('providers must be an object of provider ids');
  const known = ctx.engine.config.get().providers;
  const out: ProviderGrants = {};
  for (const [id, g] of Object.entries(raw as Record<string, unknown>)) {
    if (!known[id]) throw badRequest(`There is no provider ${id} on this hub.`);
    if (g === null || g === false) continue;
    // a grant the hub cannot pay with would only fail at the member's first call
    const no = ctx.engine.access.grantRefusal(id);
    if (no) throw badRequest(no);
    const m = g && typeof g === 'object' ? (g as { monthlyUsd?: unknown }).monthlyUsd : undefined;
    if (m !== undefined && m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > 1_000_000)) throw badRequest('A monthly budget is a number of US dollars, 0 or more.');
    out[id] = { monthlyUsd: typeof m === 'number' ? Math.round(m * 100) / 100 : null };
  }
  return out;
}

function ref(a: HubAccount): AccountRef {
  return { id: a.id, name: a.name, ...(a.displayName ? { displayName: a.displayName } : {}), role: a.role };
}

export function registerPeopleRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;
  const audit = auditFor(engine);
  const people = engine.people;

  const person = (a: HubAccount): PersonDto => {
    const access = engine.access.list(a.id);
    const grants = (a.settings.providers ?? {}) as ProviderGrantsDto;
    return {
      ...ref(a),
      ...(a.email ? { email: a.email } : {}),
      passwordSet: a.passwordSet,
      ...(a.inviteExpiresAt ? { inviteExpiresAt: a.inviteExpiresAt } : {}),
      createdAt: a.createdAt,
      devices: engine.repos.devices.list(a.id).length,
      apps: ctx.auth.clients.list(a.id).filter((x) => !x.revoked).length,
      providers: a.role === 'owner' ? {} : grants,
      spend: access
        .filter((p) => a.role === 'owner' || grants[p.provider] || p.spentUsd > 0)
        .map((p) => ({ provider: p.provider, name: p.name, ...(p.monthlyUsd !== undefined ? { monthlyUsd: p.monthlyUsd } : {}), spentUsd: Math.round(p.spentUsd * 10_000) / 10_000 })),
      // only how many: which plans, and whose, stay theirs
      ...(a.role === 'member' && ctx.memberPlans.count(a.id) ? { ownPlans: ctx.memberPlans.count(a.id) } : {}),
      ...(a.role === 'member' && a.settings.webSearch ? { webSearch: true } : {}),
      ...(a.role === 'member' ? (({ limitBytes, usedBytes }) => ({ diskLimitGb: limitBytes / 1024 ** 3, diskUsedBytes: usedBytes }))(engine.diskUse(a.id)) : {}),
    };
  };

  const requirePerson = (id: string): HubAccount => {
    const a = people.get(id);
    if (!a) throw notFound('There is nobody with that id on this hub.');
    return a;
  };

  /** A new invite for someone: the link is shown once; the hub keeps its SHA-256. */
  const invite = (c: Context<HonoEnv>, a: HubAccount): InviteDto => {
    const secret = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + INVITE_TTL_MS;
    people.setInvite(a.id, sha(secret), expiresAt);
    const base = hubAddresses(ctx, c.req.raw)[0].replace(/\/+$/, '');
    return { url: `${base}/invite/${secret}`, secret, expiresAt };
  };

  /**
   * The owner's display name is also the name apps greet them by (config
   * ui.name): Android and the web read it there, so a name given in setup,
   * Your account or People shows on Home everywhere, also in apps older
   * than display names. Never a member's: theirs comes with their own
   * config (scope.ts memberConfig).
   */
  const greetAs = (a: HubAccount, before: HubAccount, asked: boolean): void => {
    if (!asked || a.role !== 'owner') return;
    // "owner" is what the account is called until the owner gives a name: no name (shownName)
    const now = shownName(a);
    const was = shownName(before);
    const ui = (engine.config.get().ui as { name?: unknown } | undefined)?.name;
    let next: string;
    if (now) {
      // a new name, or the same one on a hub that greets by none yet; a greeting set apart in Appearance stays until the name changes
      if (now === was ? typeof ui === 'string' : ui === now) return;
      next = now;
    } else {
      // the display name was cleared: a greeting that was it goes too
      if (!was || ui !== was) return;
      next = '';
    }
    engine.config.update({ ui: { name: next } } as Partial<ConclaveConfig>);
    engine.bus.emit({ type: 'config.updated' });
  };

  /** Every app and device of a person stops working now. */
  const signOutEverywhere = (accountId: string, reason: string): void => {
    for (const id of ctx.auth.clients.revokeAccount(accountId)) ctx.clients.disconnect(id, reason);
    ctx.clients.disconnectAccount(accountId, reason);
  };

  // ----- you ------------------------------------------------------------------

  app.get('/api/contacts', (c) => {
    const caller = accountOf(c);
    const contacts: Contact[] = people.list().filter((a) => a.id !== caller).map((a) => ({
      party: `account:${a.id}`,
      name: shownName(a) ?? (a.role === 'owner' ? 'Hub owner' : 'Member'),
    }));
    // A member has no remote friends or hub identity. Do not expose the owner's friend cards.
    if (!isMember(caller)) for (const f of ctx.peer.list()) if (f.status === 'active') contacts.push({ party: `friend:${f.id}`, name: f.name });
    return c.json(contacts);
  });

  app.get('/api/me', (c) => {
    const who = c.get('auth');
    const a = people.get(who.accountId);
    if (!a) throw notFound('This account is gone.');
    const me: MeDto = {
      ...ref(a),
      ...(a.email ? { email: a.email } : {}),
      people: people.count() > 1,
      hubMachine: a.role === 'owner',
      passwordSet: a.passwordSet,
      providers: engine.access.list(a.id),
      preferences: {
        ...(a.settings.defaultModel ? { defaultModel: a.settings.defaultModel } : {}),
        ...(a.settings.smallModel ? { smallModel: a.settings.smallModel } : {}),
        ...(a.settings.defaultAgent ? { defaultAgent: a.settings.defaultAgent } : {}),
        ...(a.settings.importWatch ? { importWatch: true } : {}),
        ...(a.settings.splitView?.length ? { splitView: a.settings.splitView } : {}),
      },
      ...(isMember(a.id) ? { allow: engine.repos.kv.get<string[]>(accountKey(a.id, MEMBER_ALLOW_KEY), []), disk: engine.diskUse(a.id) } : {}),
    };
    return c.json(me);
  });

  app.patch('/api/me', async (c) => {
    const acct = accountOf(c);
    const body = await readJson<MePatch>(c);
    const a = requirePerson(acct);
    const settings = { ...a.settings };
    for (const k of ['defaultModel', 'smallModel', 'defaultAgent'] as const) {
      const v = body[k];
      if (v === undefined) continue;
      if (v !== null && (typeof v !== 'string' || v.length > 200)) throw badRequest(`${k} must be a model or agent name`);
      if (v) settings[k] = v;
      else delete settings[k];
    }
    if (body.importWatch !== undefined) {
      if (typeof body.importWatch !== 'boolean') throw badRequest('importWatch must be true or false');
      settings.importWatch = body.importWatch;
    }
    if (body.splitView !== undefined) {
      const ids = body.splitView ?? [];
      if (!Array.isArray(ids) || ids.length > SPLIT_MAX || ids.some((x) => typeof x !== 'string' || !x || x.length > 100)) throw badRequest(`splitView must be at most ${SPLIT_MAX} session ids`);
      if (ids.length) settings.splitView = [...new Set(ids)];
      else delete settings.splitView;
    }
    if (body.allow !== undefined) {
      // the owner's rules are the hub's config (permissions.allow)
      if (!isMember(acct)) throw badRequest('Your rules are in Settings, Permissions.');
      if (!Array.isArray(body.allow) || body.allow.length > 200 || body.allow.some((r) => typeof r !== 'string' || !r.trim() || r.length > 500)) throw badRequest('allow must be at most 200 rules of text');
      engine.repos.kv.set(accountKey(acct, MEMBER_ALLOW_KEY), [...new Set(body.allow.map((r) => r.trim()))]);
    }
    if (body.usageFallback !== undefined || body.refusalFallback !== undefined) {
      // the owner's lists are the hub's (models.limitFallback, models.refusalFallback in /api/config)
      if (!isMember(acct)) throw badRequest('Your fallback lists are in Settings, Models.');
      try {
        const { usageFallback: usage, refusalFallback: refusal } = engine.checkMemberFallbacks(acct, body);
        if (usage) settings.usageFallback = usage;
        else if (usage === null) delete settings.usageFallback;
        if (refusal) settings.refusalFallback = refusal;
        else if (refusal === null) delete settings.refusalFallback;
      } catch (err) {
        peopleError(err);
      }
    }
    try {
      const named = body.name !== undefined || body.displayName !== undefined;
      greetAs(people.update(acct, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.displayName !== undefined ? { displayName: body.displayName } : {}), ...(body.email !== undefined ? { email: body.email } : {}), settings }), a, named);
    } catch (err) {
      peopleError(err);
    }
    audit(c, 'account.update', 'own name, display name, email, defaults or layout');
    return c.json({ ok: true });
  });

  // ----- people (owner) -----------------------------------------------------

  app.get('/api/people', (c) => {
    ownerOnly(c);
    return c.json(people.list().map(person));
  });

  app.get('/api/people/:id', (c) => {
    ownerOnly(c);
    return c.json(person(requirePerson(c.req.param('id'))));
  });

  app.post('/api/people', async (c) => {
    ownerOnly(c);
    const body = await readJson<PersonInput>(c);
    const providers = grantsOf(ctx, body.providers);
    const password = body.password !== undefined && body.password !== null && body.password !== '' ? checkNewPassword(body.password) : undefined;
    let a: HubAccount;
    try {
      a = people.create({ name: body.name, displayName: body.displayName, email: body.email, settings: { providers } });
    } catch (err) {
      peopleError(err);
    }
    if (password) people.setPasswordHash(a.id, await hashPassword(password));
    const out: PersonCreated = { person: person(people.get(a.id)!) };
    if (!password || body.invite) out.invite = invite(c, a);
    out.person = person(people.get(a.id)!);
    audit(c, 'people.add', `${a.name}${password ? ' with a password' : ''}${out.invite ? ', invite link made' : ''}`);
    engine.bus.emit({ type: 'config.updated' });
    return c.json(out);
  });

  app.patch('/api/people/:id', async (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    const body = await readJson<PersonPatch>(c);
    const settings = { ...a.settings };
    if (body.providers !== undefined) {
      if (a.role === 'owner') throw badRequest('The owner always uses the hub\'s keys.');
      settings.providers = grantsOf(ctx, body.providers);
    }
    if (body.diskLimitGb !== undefined) {
      if (a.role === 'owner') throw badRequest('The owner has no disk cap.');
      const g = body.diskLimitGb;
      if (g !== null && (typeof g !== 'number' || !Number.isFinite(g) || g < 1 || g > 1000)) throw badRequest('A disk cap is 1 to 1000 GB.');
      if (g === null) delete settings.diskLimitGb;
      else settings.diskLimitGb = g;
    }
    if (body.webSearch !== undefined) {
      if (a.role === 'owner') throw badRequest('The owner always uses the hub\'s web search.');
      if (typeof body.webSearch !== 'boolean') throw badRequest('webSearch must be true or false.');
      if (body.webSearch) settings.webSearch = true;
      else delete settings.webSearch;
    }
    try {
      const named = body.name !== undefined || body.displayName !== undefined;
      greetAs(people.update(a.id, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.displayName !== undefined ? { displayName: body.displayName } : {}), ...(body.email !== undefined ? { email: body.email } : {}), settings }), a, named);
    } catch (err) {
      peopleError(err);
    }
    audit(c, 'people.update', `${a.name}: ${Object.keys(body).join(', ')}`);
    return c.json(person(people.get(a.id)!));
  });

  app.delete('/api/people/:id', async (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    if (a.role === 'owner') throw badRequest('The owner cannot be removed.');
    // their work stops, their apps and devices go, then every row of theirs
    signOutEverywhere(a.id, 'this account was removed');
    for (const d of engine.repos.devices.list(a.id)) removeDevice(ctx, d.id, 'its account was removed');
    await engine.forgetAccount(a.id);
    forgetAssistant(engine, a.id);
    forgetPim(engine, a.id);
    // their own CLIProxyAPI stops, and its folder and keys go
    await ctx.memberPlans.remove(a.id);
    try {
      people.remove(a.id);
    } catch (err) {
      peopleError(err);
    }
    engine.accountSecrets.remove(a.id);
    audit(c, 'people.remove', a.name);
    engine.bus.emit({ type: 'config.updated' });
    return c.json({ ok: true });
  });

  app.post('/api/people/:id/password', async (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    if (a.role === 'owner') throw badRequest('Set your own password in Settings, Account.');
    const body = await readJson<{ password?: unknown }>(c);
    const password = checkNewPassword(body.password);
    people.setPasswordHash(a.id, await hashPassword(password));
    people.setInvite(a.id, undefined);
    // a reset signs them out everywhere: an app that had the old password's token stops working
    signOutEverywhere(a.id, 'the password was reset');
    audit(c, 'people.password', `${a.name}: reset by the owner, apps signed out`);
    return c.json(person(people.get(a.id)!));
  });

  app.post('/api/people/:id/invite', (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    if (a.role === 'owner') throw badRequest('The owner signs in with the hub token or a pairing code.');
    const inv = invite(c, a);
    audit(c, 'people.invite', a.name);
    return c.json(inv);
  });

  // the apps a person is signed in with (phones, browsers, the desktop app): the owner sees and ends them
  app.get('/api/people/:id/clients', (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    return c.json(ctx.auth.clients.list(a.id).map((r) => appDto(ctx, r)));
  });

  app.delete('/api/people/:id/clients/:client', (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    const row = ctx.auth.clients.get(c.req.param('client'));
    // an app of someone else answers as an unknown one
    if (!row || row.accountId !== a.id || row.revoked) throw notFound('unknown client');
    revokeApp(ctx, c, row.id);
    return c.json({ ok: true });
  });

  app.post('/api/people/:id/workspace', (c) => {
    ownerOnly(c);
    const a = requirePerson(c.req.param('id'));
    if (!isMember(a.id)) throw badRequest('The owner works on the hub itself.');
    const code = engine.repos.devices.createPairingCode('device', WORKSPACE_TTL_MS, a.id);
    const addresses = hubAddresses(ctx, c.req.raw);
    const user = `conclave-${a.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'member'}`;
    const hub = addresses[0];
    const out: WorkspaceCode = {
      code,
      expiresAt: Date.now() + WORKSPACE_TTL_MS,
      addresses,
      commands: {
        // its own OS user: the daemon runs with that user's rights, so it cannot read the owner's files
        linux: [
          `sudo useradd --create-home --shell /bin/bash ${user}`,
          `sudo -iu ${user} sh -c 'curl -fsSL https://raw.githubusercontent.com/default-cybe/conclave/main/scripts/install.sh | sh'`,
          `sudo -iu ${user} /home/${user}/.local/bin/conclave daemon pair ${hub} ${code}`,
          `sudo loginctl enable-linger ${user}`,
          `sudo -iu ${user} env XDG_RUNTIME_DIR=/run/user/$(id -u ${user}) /home/${user}/.local/bin/conclave daemon install --start`,
        ],
        // or a container of its own: the daemon sees only its volume (host network, so it reaches a hub on this machine)
        docker: [
          `docker run -d --name ${user} --restart unless-stopped --network host -v ${user}:/data ghcr.io/default-cybe/conclave:latest sh -c 'test -f /data/device.json || bun packages/cli/src/index.ts daemon pair ${hub} ${code}; exec bun packages/cli/src/index.ts daemon run'`,
        ],
      },
    };
    audit(c, 'people.workspace', `device code for ${a.name}`);
    return c.json(out);
  });

  // ----- invites (no token: the secret is the check) -----------------------

  const byInvite = (c: Context<HonoEnv>): HubAccount => {
    const secret = c.req.param('secret') ?? '';
    const a = /^[A-Za-z0-9_-]{20,64}$/.test(secret) ? people.byInvite(sha(secret)) : undefined;
    if (!a) {
      // a wrong invite counts like a wrong pairing code
      if (!isDirectLocal(c)) ctx.pairGuard.fail(clientIp(c), Date.now(), `invite:${sha(secret).slice(0, 16)}`);
      throw notFound('This invite link is not valid any more. Ask the owner of the hub for a new one.');
    }
    return a;
  };

  app.get('/api/invite/:secret', (c) => {
    const wait = isDirectLocal(c) ? 0 : ctx.pairGuard.blocked(clientIp(c));
    if (wait) throw Object.assign(new HttpError(429, `Too many wrong codes from this address. Try again in ${wait} seconds.`), { retryAfter: wait });
    const a = byInvite(c);
    const info: InviteInfo = { name: a.name, ...(a.displayName ? { displayName: a.displayName } : {}), hub: hubInfo(ctx).name, expiresAt: a.inviteExpiresAt ?? 0 };
    return c.json(info);
  });

  app.post('/api/invite/:secret', async (c) => {
    const wait = isDirectLocal(c) ? 0 : ctx.pairGuard.blocked(clientIp(c));
    if (wait) throw Object.assign(new HttpError(429, `Too many wrong codes from this address. Try again in ${wait} seconds.`), { retryAfter: wait });
    if (!ctx.pairLimiter.hit(clientIp(c))) throw new HttpError(429, 'Too many attempts from this address. Try again in a minute.');
    byInvite(c);
    const body = await readJson<{ password?: unknown; name?: unknown; platform?: unknown }>(c);
    const password = checkNewPassword(body.password);
    // good once: claimed before the slow hash below, so a second answer to the same link, sent at the same moment, finds it used
    const a = people.claimInvite(sha(c.req.param('secret') ?? ''));
    if (!a) throw notFound('This invite link is not valid any more. Ask the owner of the hub for a new one.');
    people.setPasswordHash(a.id, await hashPassword(password));
    const label = { name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'client', platform: typeof body.platform === 'string' ? body.platform : undefined };
    const { id, token } = ctx.auth.clients.create({ ...label, accountId: a.id });
    try {
      engine.repos.audit.add({ actor: `ip:${clientIp(c)}`, action: 'invite.accept', detail: `${a.name} set a password and signed in as ${id}`, accountId: a.id });
    } catch {
      /* auditing must not break the request */
    }
    const reply: PairResult & { account: AccountRef } = { token, clientId: id, hub: hubInfo(ctx), addresses: hubAddresses(ctx, c.req.raw), identity: ctx.identity.identity(), account: ref(people.get(a.id)!) };
    return c.json(reply);
  });
}
