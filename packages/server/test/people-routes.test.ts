/**
 * People and sign in (routes-people.ts, docs/design/ACCOUNTS.md 4): the
 * owner adds people with a password or an invite link, sets their access
 * to the hub's keys, resets a password (their apps sign out) and removes
 * them (their rows go). Login takes a sign-in name or email once there is
 * more than one person; a hub with one keeps the old login.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { RateLimiter } from '../src/auth';
import { hashPassword } from '../src/password';
import { startHub, type TestHub } from './helpers';

const PW = 'a long enough password';
let hub: TestHub;

beforeAll(() => {
  hub = startHub();
  // the hub has keys for Anthropic and OpenAI only; Gemini, Z.ai and OpenRouter have none
  const providers = hub.engine.config.get().providers;
  hub.engine.config.update({ providers: { ...providers, anthropic: { ...providers.anthropic, apiKey: 'sk-ant-hub-test' }, openai: { ...providers.openai, apiKey: 'sk-hub-openai-test' } } });
});
afterAll(() => hub.stop());
// the login limit (10 a minute from one address) is tested in identity-login.test.ts
beforeEach(() => {
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
});

const asJson = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => undefined)) as any });

describe('one person', () => {
  test('health says so, and the login is the old one', async () => {
    expect((await asJson(await hub.api('/api/health', { token: null }))).body.people).toBe(false);
    await hub.api('/api/auth/password', { method: 'PUT', json: { password: PW } });
    const r = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { password: PW, name: 'laptop' } }));
    expect(r.status).toBe(200);
    expect(r.body.account).toEqual({ id: 'owner', name: 'owner', role: 'owner' });
    const wrong = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { password: 'nope nope nope', name: 'laptop' } }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('Wrong password, or no password is set on this hub.');
  });
});

describe('the owner adds people', () => {
  let alice: { id: string; token: string };

  test('with a password: they sign in with their name, and see only what is theirs', async () => {
    const made = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'alice', email: 'alice@example.com', password: PW, providers: { anthropic: { monthlyUsd: 20 } } } }));
    expect(made.status).toBe(200);
    expect(made.body.person).toMatchObject({ name: 'alice', role: 'member', passwordSet: true, providers: { anthropic: { monthlyUsd: 20 } } });
    expect(made.body.invite).toBeUndefined();
    expect((await asJson(await hub.api('/api/health', { token: null }))).body.people).toBe(true);

    // the owner's password does not open alice's account, nor alice's the owner's
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: 'a wrong password here' } })).status).toBe(400);
    const missing = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'nobody', password: PW } }));
    expect(missing.body.error).toBe('Wrong name or password.');
    const login = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'Alice', password: PW, name: 'phone' } }));
    expect(login.status).toBe(200);
    expect(login.body.account).toEqual({ id: made.body.person.id, name: 'alice', displayName: 'alice', role: 'member' });
    alice = { id: made.body.person.id, token: login.body.token };

    const me = await asJson(await hub.api('/api/me', { token: alice.token }));
    expect(me.body).toMatchObject({ id: alice.id, name: 'alice', role: 'member', people: true, hubMachine: false, email: 'alice@example.com' });
    const anthropic = me.body.providers.find((p: any) => p.provider === 'anthropic');
    expect(anthropic).toMatchObject({ source: 'hub', hubAllowed: true, ownKey: false, monthlyUsd: 20, spentUsd: 0 });

    // a member's session is theirs; the owner's list does not show it
    const s = await asJson(await hub.api('/api/sessions', { method: 'POST', token: alice.token, json: { title: 'alice chat' } }));
    expect(s.body.accountId).toBe(alice.id);
    expect(((await asJson(await hub.api('/api/sessions'))).body as any[]).some((x) => x.id === s.body.id)).toBe(false);
    expect(((await asJson(await hub.api('/api/sessions', { token: alice.token }))).body as any[]).map((x) => x.id)).toEqual([s.body.id]);
    expect((await hub.api(`/api/sessions/${s.body.id}`)).status).toBe(404);
  });

  test('each account keeps its own side by side layout', async () => {
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { splitView: ['s_a', 's_b', 's_a'] } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me', { token: alice.token }))).body.preferences.splitView).toEqual(['s_a', 's_b']);
    // the owner's layout is the owner's
    expect((await asJson(await hub.api('/api/me'))).body.preferences.splitView).toBeUndefined();
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { splitView: ['1', '2', '3', '4', '5'] } })).status).toBe(400);
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { splitView: [7] } })).status).toBe(400);
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { splitView: null } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me', { token: alice.token }))).body.preferences.splitView).toBeUndefined();
  });

  test('a member changes their own name, defaults and password, and nothing of anyone else', async () => {
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { name: 'alice2', defaultModel: 'anthropic/claude-sonnet-5-5' } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me', { token: alice.token }))).body).toMatchObject({ name: 'alice2', preferences: { defaultModel: 'anthropic/claude-sonnet-5-5' } });
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { name: 'owner' } })).status).toBe(409);
    expect((await hub.api('/api/me', { method: 'PATCH', token: alice.token, json: { name: 'bad name!' } })).status).toBe(400);
    expect((await hub.api('/api/auth/password', { method: 'PUT', token: alice.token, json: { password: 'another long password' } })).status).toBe(200);
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice2', password: 'another long password' } })).status).toBe(200);
    // the owner's password stays the owner's
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'owner', password: PW } })).status).toBe(200);
    // members do not manage people
    expect((await hub.api('/api/people', { token: alice.token })).status).toBe(403);
    expect((await hub.api('/api/people', { method: 'POST', token: alice.token, json: { name: 'mallory', password: PW } })).status).toBe(403);
  });

  test('names are checked', async () => {
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'ALICE2', password: PW } })).status).toBe(409);
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'two words', password: PW } })).status).toBe(400);
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'carol', password: 'short' } })).status).toBe(400);
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'carol', password: PW, providers: { nowhere: {} } } })).status).toBe(400);
  });

  test('with an invite link: good once, then a password signs them in', async () => {
    const made = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'bob' } }));
    expect(made.body.person.passwordSet).toBe(false);
    const invite = made.body.invite;
    expect(invite.url).toContain(`/invite/${invite.secret}`);
    const client = new ConclaveClient({ baseUrl: hub.url });
    expect(await client.invite(invite.secret)).toMatchObject({ name: 'bob' });
    const res = await client.acceptInvite(invite.secret, 'bobs long password', 'laptop', 'web');
    expect(res.account).toEqual({ id: made.body.person.id, name: 'bob', displayName: 'bob', role: 'member' });
    expect((await hub.api('/api/me', { token: res.token })).status).toBe(200);
    // good once
    expect((await hub.api(`/api/invite/${invite.secret}`, { token: null })).status).toBe(404);
    expect((await hub.api(`/api/invite/${invite.secret}`, { method: 'POST', token: null, json: { password: 'bobs long password' } })).status).toBe(404);
  });

  test('an invite answered twice at the same moment signs in once', async () => {
    const made = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'dora' } }));
    const secret = made.body.invite.secret as string;
    // the same link from two places (a leaked link and the person), both before either finished
    const answers = await Promise.all(
      ['first long password', 'second long password'].map((password) => hub.api(`/api/invite/${secret}`, { method: 'POST', token: null, json: { password, name: 'x' } }).then(asJson)),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 404]);
    const won = answers.find((a) => a.status === 200)!;
    // only one app was made, and the password is the winner's
    const apps = hub.engine.repos.db.query('SELECT COUNT(*) AS n FROM clients WHERE account_id = ?').get(made.body.person.id) as { n: number };
    expect(apps.n).toBe(1);
    const tried = await Promise.all(['first long password', 'second long password'].map((password) => hub.api('/api/login', { method: 'POST', token: null, json: { account: 'dora', password } })));
    expect(tried.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await hub.api('/api/me', { token: won.body.token })).status).toBe(200);
    // a bad password does not use the link up
    const again = await asJson(await hub.api(`/api/people/${made.body.person.id}/invite`, { method: 'POST' }));
    expect((await hub.api(`/api/invite/${again.body.secret}`, { method: 'POST', token: null, json: { password: 'short' } })).status).toBe(400);
    expect((await hub.api(`/api/invite/${again.body.secret}`, { token: null })).status).toBe(200);
  });

  test('a reset password signs the person out everywhere', async () => {
    const before = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'bob', password: 'bobs long password' } }));
    expect((await hub.api('/api/me', { token: before.body.token })).status).toBe(200);
    const bob = before.body.account.id;
    expect((await hub.api(`/api/people/${bob}/password`, { method: 'POST', json: { password: 'a new password for bob' } })).status).toBe(200);
    expect((await hub.api('/api/me', { token: before.body.token })).status).toBe(401);
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'bob', password: 'a new password for bob' } })).status).toBe(200);
  });

  test('provider access and budgets are set by the owner', async () => {
    const r = await asJson(await hub.api(`/api/people/${alice.id}`, { method: 'PATCH', json: { providers: { anthropic: { monthlyUsd: 5 }, openai: { monthlyUsd: null } } } }));
    expect(r.status).toBe(200);
    expect(r.body.providers).toEqual({ anthropic: { monthlyUsd: 5 }, openai: { monthlyUsd: null } });
    expect((await hub.api(`/api/people/${alice.id}`, { method: 'PATCH', json: { providers: { anthropic: { monthlyUsd: -1 } } } })).status).toBe(400);
    expect((await hub.api('/api/people/owner', { method: 'PATCH', json: { providers: {} } })).status).toBe(400);
  });

  test("access only where the hub has a key or a signed in plan; a harness has none to share", async () => {
    const add = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'gina', password: PW, providers: { google: {} } } }));
    expect(add.status).toBe(400);
    expect(add.body.error).toBe('The hub has no key for google. Add one in Settings, Providers first.');
    expect(hub.engine.people.list().some((p) => p.name === 'gina')).toBe(false);
    for (const id of ['zai', 'openrouter', 'cliproxy']) {
      const r = await asJson(await hub.api(`/api/people/${alice.id}`, { method: 'PATCH', json: { providers: { anthropic: { monthlyUsd: 5 }, [id]: { monthlyUsd: 1 } } } }));
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('The hub has no key for');
    }
    const harness = await asJson(await hub.api(`/api/people/${alice.id}`, { method: 'PATCH', json: { providers: { 'claude-code': {} } } }));
    expect(harness.status).toBe(400);
    expect(harness.body.error).toBe("Claude Code runs on each person's own device with their own sign in. There is no hub key to share.");
    // what she had stays
    expect(hub.engine.people.get(alice.id)!.settings.providers).toEqual({ anthropic: { monthlyUsd: 5 }, openai: { monthlyUsd: null } });
    // subscriptions set up: CLIProxyAPI is on, on this machine, and can be shared
    const providers = hub.engine.config.get().providers;
    hub.engine.config.update({ providers: { ...providers, cliproxy: { ...providers.cliproxy, enabled: true } } });
    const plan = await asJson(await hub.api(`/api/people/${alice.id}`, { method: 'PATCH', json: { providers: { anthropic: { monthlyUsd: 5 }, openai: { monthlyUsd: null }, cliproxy: { monthlyUsd: null } } } }));
    expect(plan.status).toBe(200);
    expect(Object.keys(plan.body.providers)).toEqual(['anthropic', 'openai', 'cliproxy']);
    // turning a grant off needs no key
    expect((await hub.api(`/api/people/${alice.id}`, { method: 'PATCH', json: { providers: { anthropic: { monthlyUsd: 5 }, openai: { monthlyUsd: null }, google: null } } })).status).toBe(200);
  });

  test('a workspace on the hub machine is a device of theirs', async () => {
    const w = await asJson(await hub.api(`/api/people/${alice.id}/workspace`, { method: 'POST' }));
    expect(w.status).toBe(200);
    expect(w.body.commands.linux.join('\n')).toContain(`daemon pair ${w.body.addresses[0]} ${w.body.code}`);
    expect(w.body.commands.linux.join('\n')).toContain('useradd');
    const reg = await asJson(await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: w.body.code, name: 'alice on the hub' } }));
    expect(reg.status).toBe(200);
    expect(hub.engine.repos.devices.accountOf(reg.body.deviceId)).toBe(alice.id);
    expect(((await asJson(await hub.api('/api/devices', { token: alice.token }))).body as any[]).map((d) => d.id)).toContain(reg.body.deviceId);
    expect(((await asJson(await hub.api('/api/devices'))).body as any[]).map((d) => d.id)).not.toContain(reg.body.deviceId);
    expect((await hub.api('/api/people/owner/workspace', { method: 'POST' })).status).toBe(400);
  });

  test('logs are the owner’s; an app’s own lines say whose app sent them', async () => {
    expect((await hub.api('/api/logs', { token: alice.token })).status).toBe(403);
    expect((await hub.api('/api/logs/export', { token: alice.token })).status).toBe(403);
    const sent = await asJson(await hub.api('/api/logs/client', { method: 'POST', token: alice.token, json: { app: 'web', events: [{ event: 'page.opened', level: 'info' }] } }));
    expect(sent.body).toMatchObject({ accepted: 1 });
    const tail = await asJson(await hub.api('/api/logs/tail?component=client&lines=50'));
    const mine = (tail.body.lines as any[]).filter((l) => l.msg === 'page.opened');
    expect(mine.length).toBe(1);
    expect(mine[0].client.account).toBe(alice.id);
  });

  test('removing a person signs them out and deletes what was theirs', async () => {
    const s = await asJson(await hub.api('/api/sessions', { method: 'POST', token: alice.token, json: { title: 'goes away' } }));
    expect(s.status).toBe(200);
    expect((await hub.api('/api/people/owner', { method: 'DELETE' })).status).toBe(400);
    expect((await hub.api(`/api/people/${alice.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await hub.api('/api/me', { token: alice.token })).status).toBe(401);
    expect(hub.engine.repos.sessions.get(s.body.id)).toBeUndefined();
    expect(hub.engine.repos.devices.list(alice.id)).toEqual([]);
    expect(hub.engine.people.get(alice.id)).toBeUndefined();
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice2', password: 'another long password' } })).status).toBe(400);
  });
});

describe("the owner's name", () => {
  test('setup saves it to the owner account, and apps that greet by ui.name get it too', async () => {
    // found in a real setup: the name was never asked, so Home greeted nobody and the account menu said "owner"
    const config = async () => (await asJson(await hub.api('/api/config'))).body.config.ui;
    expect((await config()).name).toBeUndefined();
    // "owner" is no name: other changes leave the greeting alone
    expect((await hub.api('/api/me', { method: 'PATCH', json: { email: 'kai@example.com' } })).status).toBe(200);
    expect((await config()).name).toBeUndefined();
    expect((await hub.api('/api/me', { method: 'PATCH', json: { name: 'Kai' } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me'))).body).toMatchObject({ id: 'owner', name: 'Kai', role: 'owner' });
    // the Android app's Home reads ui.name (HubRepository.ownerName)
    expect((await config()).name).toBe('Kai');
    // People renames the owner the same way
    expect((await hub.api('/api/people/owner', { method: 'PATCH', json: { name: 'Kaivalya' } })).status).toBe(200);
    expect((await config()).name).toBe('Kaivalya');
    // a name that cannot sign in is refused and changes nothing
    expect((await hub.api('/api/me', { method: 'PATCH', json: { name: 'Kai Ahir' } })).status).toBe(400);
    expect((await config()).name).toBe('Kaivalya');
    // setup run again with the same name: a greeting set apart in Appearance stays, an unset one is filled
    await hub.api('/api/config', { method: 'PATCH', json: { ui: { name: 'Kai A.' } } });
    expect((await hub.api('/api/me', { method: 'PATCH', json: { name: 'Kaivalya' } })).status).toBe(200);
    expect((await config()).name).toBe('Kai A.');
    hub.engine.config.replace({ ...hub.engine.config.getUser(), ui: { theme: 'system' } });
    expect((await hub.api('/api/me', { method: 'PATCH', json: { name: 'Kaivalya' } })).status).toBe(200);
    expect((await config()).name).toBe('Kaivalya');
    // a member's name is theirs alone, and their apps greet them by it, not by the owner's
    const cy = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'cy', password: PW } }));
    expect((await hub.api(`/api/people/${cy.body.person.id}`, { method: 'PATCH', json: { name: 'cyrus' } })).status).toBe(200);
    expect((await config()).name).toBe('Kaivalya');
    const login = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'cyrus', password: PW, name: 'Pixel' } }));
    expect((await asJson(await hub.api('/api/config', { token: login.body.token }))).body.config.ui.name).toBe('Cyrus');
  });
});

describe('display names', () => {
  test('a name with spaces to show, apart from the one to sign in with; a member never sees the owner’s', async () => {
    const ui = async (token?: string) => (await asJson(await hub.api('/api/config', token ? { token } : {}))).body.config.ui;
    // the owner: Kai Ahir to show, Kaivalya to sign in
    expect((await hub.api('/api/me', { method: 'PATCH', json: { displayName: '  Kai   Ahir ' } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me'))).body).toMatchObject({ id: 'owner', name: 'Kaivalya', displayName: 'Kai Ahir', role: 'owner' });
    // the name apps greet by, Android's Home included
    expect((await ui()).name).toBe('Kai Ahir');
    // a display name does not sign in; the sign-in name still does
    expect((await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'Kai Ahir', password: PW } })).status).toBe(400);
    const own = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'Kaivalya', password: PW, name: 'laptop' } }));
    expect(own.body.account).toEqual({ id: 'owner', name: 'Kaivalya', displayName: 'Kai Ahir', role: 'owner' });
    // checked; a bad one changes nothing
    const long = await asJson(await hub.api('/api/me', { method: 'PATCH', json: { displayName: 'x'.repeat(61) } }));
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('A display name has at most 60 characters.');
    expect((await hub.api('/api/me', { method: 'PATCH', json: { displayName: '<script>' } })).status).toBe(400);
    expect((await hub.api('/api/me', { method: 'PATCH', json: { displayName: 42 } })).status).toBe(400);
    expect((await asJson(await hub.api('/api/me'))).body.displayName).toBe('Kai Ahir');
    // a new sign-in name leaves a display name set apart as it is
    expect((await hub.api('/api/me', { method: 'PATCH', json: { name: 'kai' } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me'))).body).toMatchObject({ name: 'kai', displayName: 'Kai Ahir' });
    expect((await ui()).name).toBe('Kai Ahir');

    // the owner gives a member one when adding them, or later on People
    const dee = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'dee', displayName: 'Dee Okafor', password: PW } }));
    expect(dee.body.person).toMatchObject({ name: 'dee', displayName: 'Dee Okafor', role: 'member' });
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'eve', displayName: 'Eve 🎉', password: PW } })).status).toBe(400);
    expect(hub.engine.people.byName('eve')).toBeUndefined();
    const login = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'dee', password: PW, name: 'Pixel' } }));
    expect(login.body.account).toEqual({ id: dee.body.person.id, name: 'dee', displayName: 'Dee Okafor', role: 'member' });
    const t = login.body.token as string;
    // a member sees their own, in /api/me and as the name their apps greet by, and never the owner's
    const me = await asJson(await hub.api('/api/me', { token: t }));
    expect(me.body).toMatchObject({ name: 'dee', displayName: 'Dee Okafor' });
    expect((await ui(t)).name).toBe('Dee Okafor');
    const config = await asJson(await hub.api('/api/config', { token: t }));
    for (const body of [me.body, config.body]) expect(JSON.stringify(body)).not.toContain('Kai Ahir');
    // their own change is theirs alone
    expect((await hub.api('/api/me', { method: 'PATCH', token: t, json: { displayName: "Dee O'Kafor-Lee (DO)" } })).status).toBe(200);
    expect((await ui(t)).name).toBe("Dee O'Kafor-Lee (DO)");
    expect((await ui()).name).toBe('Kai Ahir');
    // cleared, the apps call them by their sign-in name
    expect((await hub.api('/api/me', { method: 'PATCH', token: t, json: { displayName: null } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me', { token: t }))).body.displayName).toBeUndefined();
    expect((await ui(t)).name).toBe('Dee');
    // People sets it too, and it is not the owner's greeting
    const set = await asJson(await hub.api(`/api/people/${dee.body.person.id}`, { method: 'PATCH', json: { displayName: 'Dee Okafor' } }));
    expect(set.body).toMatchObject({ name: 'dee', displayName: 'Dee Okafor' });
    expect((await ui()).name).toBe('Kai Ahir');
    // an invite says who it is for
    const fern = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'fern', displayName: 'Fern Ng' } }));
    expect((await asJson(await hub.api(`/api/invite/${fern.body.invite.secret}`, { token: null }))).body).toMatchObject({ name: 'fern', displayName: 'Fern Ng' });

    // the owner clears theirs: Home greets by the sign-in name
    expect((await hub.api('/api/me', { method: 'PATCH', json: { displayName: '' } })).status).toBe(200);
    expect((await asJson(await hub.api('/api/me'))).body.displayName).toBeUndefined();
    expect((await ui()).name).toBe('Kai');
  });
});

describe('emails sign in', () => {
  const login = (account: string, password = PW) => hub.api('/api/login', { method: 'POST', token: null, json: { account, password, name: 'phone' } });
  const WRONG = 'Wrong name or password.';
  const TAKEN = 'Another person already has that email.';
  /** The hashes the logins in run checked. */
  const checked = async (run: () => Promise<unknown>): Promise<string[]> => {
    const spy = spyOn(Bun.password, 'verify');
    try {
      await run();
      return spy.mock.calls.map((c) => String(c[1]));
    } finally {
      spy.mockRestore();
    }
  };
  /** An argon2 hash's algorithm and cost, without its salt and digest. */
  const cost = (h: string) => h.split('$').slice(0, 4).join('$');

  test('an email signs in like a sign-in name, case and spaces aside; an unknown one gets the same no', async () => {
    const gus = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'gus', email: 'Gus@Example.com', password: PW } }));
    expect(gus.status).toBe(200);
    for (const account of ['gus@example.com', '  GUS@EXAMPLE.COM ', 'Gus@Example.com', 'GUS']) {
      const r = await asJson(await login(account));
      expect(r.status).toBe(200);
      expect(r.body.account).toMatchObject({ id: gus.body.person.id, name: 'gus' });
    }
    // the owner's email too (set in "the owner's name")
    expect((await asJson(await login('KAI@example.com'))).body.account).toMatchObject({ id: 'owner', role: 'owner' });
    // a wrong password and an email nobody has: one answer, each after one check of a hash that costs the same
    const replies: Array<{ status: number; body: any }> = [];
    const hashes = await checked(async () => {
      replies.push(await asJson(await login('gus@example.com', 'a wrong password here')));
      replies.push(await asJson(await login('nobody@example.com')));
    });
    for (const r of replies) {
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(WRONG);
    }
    expect(hashes.length).toBe(2);
    expect(hashes[1]).not.toBe(hashes[0]);
    expect(cost(hashes[1])).toBe(cost(hashes[0]));
  });

  test('one email per person: a new or changed one that someone else has is a 409', async () => {
    const taken = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'gus2', email: ' gus@EXAMPLE.com ', password: PW } }));
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe(TAKEN);
    expect(hub.engine.people.byName('gus2')).toBeUndefined();

    const hal = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'hal', email: 'hal@example.com', password: PW } }));
    expect(hal.status).toBe(200);
    // on People
    const onPeople = await asJson(await hub.api(`/api/people/${hal.body.person.id}`, { method: 'PATCH', json: { email: 'Kai@Example.com' } }));
    expect(onPeople.status).toBe(409);
    expect(onPeople.body.error).toBe(TAKEN);
    // in their own Your account
    const t = (await asJson(await login('hal@example.com'))).body.token as string;
    const own = await asJson(await hub.api('/api/me', { method: 'PATCH', token: t, json: { email: 'gus@example.com', displayName: 'Hal' } }));
    expect(own.status).toBe(409);
    expect(own.body.error).toBe(TAKEN);
    expect(hub.engine.people.get(hal.body.person.id)).toMatchObject({ email: 'hal@example.com', displayName: 'hal' });
    // their own again, in other case, is theirs to keep
    expect((await hub.api('/api/me', { method: 'PATCH', token: t, json: { email: 'HAL@example.com' } })).status).toBe(200);
    expect((await asJson(await login('hal@EXAMPLE.com'))).body.account).toMatchObject({ id: hal.body.person.id });
    // an email let go no longer signs in, and is free for someone else
    expect((await hub.api('/api/me', { method: 'PATCH', token: t, json: { email: null } })).status).toBe(200);
    expect((await asJson(await login('hal@example.com'))).body.error).toBe(WRONG);
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'ida', email: 'hal@example.com', password: PW } })).status).toBe(200);
  });

  test('an email two old accounts share signs in neither, with the same answer in the same time', async () => {
    // rows from before emails were one person's: they stay as they are
    const hash = await hashPassword(PW);
    const add = hub.engine.repos.db.query(
      "INSERT INTO hub_accounts (id, name, name_key, display_name, email, email_key, role, password_hash, password_set_at, settings, created_at, updated_at) VALUES (?,?,?,?,?,?,'member',?,1,'{}',1,1)",
    );
    add.run('acc_twin_a', 'twina', 'twina', 'twina', 'twins@example.com', 'twins@example.com', hash);
    add.run('acc_twin_b', 'twinb', 'twinb', 'twinb', 'Twins@Example.com', 'twins@example.com', hash);
    const replies: Array<{ status: number; body: any }> = [];
    const hashes = await checked(async () => {
      replies.push(await asJson(await login('twins@example.com')));
    });
    expect(replies[0].status).toBe(400);
    expect(replies[0].body.error).toBe(WRONG);
    // one check, of the stand-in, which costs what theirs does
    expect(hashes.length).toBe(1);
    expect(hashes[0]).not.toBe(hash);
    expect(cost(hashes[0])).toBe(cost(hash));
    // their sign-in names still work
    expect((await login('twina')).status).toBe(200);
    // the rest of an old row changes, with the shared email sent along
    const keep = await asJson(await hub.api('/api/people/acc_twin_a', { method: 'PATCH', json: { displayName: 'Twin A', email: 'TWINS@example.com' } }));
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ displayName: 'Twin A', email: 'TWINS@example.com' });
    // once one moves to an email of its own, each signs in by theirs
    expect((await hub.api('/api/people/acc_twin_b', { method: 'PATCH', json: { email: 'b@example.com' } })).status).toBe(200);
    expect((await asJson(await login('twins@example.com'))).body.account).toMatchObject({ id: 'acc_twin_a' });
    expect((await asJson(await login('B@example.com'))).body.account).toMatchObject({ id: 'acc_twin_b' });
  });
});
