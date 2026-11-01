/**
 * Accounts, the pieces (docs/design/ACCOUNTS.md): the migration (every old
 * row is the owner's, the old password moves, safe to run again), the
 * people store, removing an account, event stamps, the machine guard and
 * the public address check.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { ACCOUNT_TABLES, CHILD_TABLES, HUB_TABLES } from '../../src/people/tables';
import { OLD_PASSWORD_KEY, migratePeople } from '../../src/people/migrate';
import { DISPLAY_NAME_MAX, NAME_RE, PeopleError, PeopleStore, accountKey, checkDisplayName, purgeAccount } from '../../src/people/store';
import { shownName } from '../../src/client/people';
import { OWNER_ID, currentAccount, runAs } from '../../src/people/context';
import { accountKv } from '../../src/people/scoped';
import { eventAccount, eventVisibleTo } from '../../src/people/events';
import { HUB_REFUSED, MachineRefused, RefusedMachine, guardMachine } from '../../src/people/guard';
import { PRIVATE_LOOKUP_FAILED, PRIVATE_REFUSED, checkPublicUrl, isPrivateAddress } from '../../src/people/net';
import type { Session } from '../../src/types';

const columns = (db: ReturnType<typeof openDb>, t: string) => (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
const tables = (db: ReturnType<typeof openDb>) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);

function session(id: string, accountId?: string): Session {
  const now = Date.now();
  return {
    id,
    ...(accountId ? { accountId } : {}),
    title: id,
    agent: 'assistant',
    model: 'x/y',
    mode: 'agent',
    permissionMode: 'default',
    cwd: '/',
    device: 'local',
    status: 'idle',
    tags: [],
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  } as Session;
}

describe('the migration', () => {
  test('makes every old row the owner’s, moves the old password, and is safe to run again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-people-migrate-'));
    try {
      const file = join(dir, 'conclave.db');
      // a hub from before accounts: the tables without account_id, and the password in kv
      let db = openDb(file);
      const repos = new Repos(db);
      repos.sessions.insert(session('ses_old'));
      repos.kv.set('memory.extract.ses_old', 3);
      // This membership table did not exist before accounts; its composite key cannot drop account_id.
      db.exec('DROP TABLE chat_participants');
      db.query("INSERT INTO memories (id, scope, kind, content, created_at, updated_at) VALUES ('mem_old', 'global', 'fact', 'old fact', 1, 1)").run();
      for (const t of ACCOUNT_TABLES) {
        if (!tables(db).includes(t) || !columns(db, t).includes('account_id')) continue;
        db.exec(`DROP INDEX IF EXISTS ${t}_account`);
        db.exec(`ALTER TABLE ${t} DROP COLUMN account_id`);
      }
      db.exec('DROP TABLE hub_accounts');
      db.query('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(OLD_PASSWORD_KEY, JSON.stringify({ hash: '$argon2id$old', setAt: 42 }), 1);
      expect(columns(db, 'sessions')).not.toContain('account_id');
      db.close();

      // opened again: migrated
      db = openDb(file);
      for (const t of ACCOUNT_TABLES) if (tables(db).includes(t)) expect(columns(db, t)).toContain('account_id');
      expect(db.query("SELECT account_id FROM sessions WHERE id = 'ses_old'").get()).toEqual({ account_id: OWNER_ID });
      expect(db.query("SELECT account_id FROM memories WHERE id = 'mem_old'").get()).toEqual({ account_id: OWNER_ID });
      const people = new PeopleStore(db);
      expect(people.list().map((a) => a.id)).toEqual([OWNER_ID]);
      expect(people.passwordHash(OWNER_ID)).toBe('$argon2id$old');
      expect(people.owner().passwordSetAt).toBe(42);
      expect(db.query('SELECT 1 FROM kv WHERE key = ?').get(OLD_PASSWORD_KEY)).toBeNull();

      // again, and again by hand: nothing changes
      const snapshot = () => JSON.stringify([db.query('SELECT * FROM hub_accounts').all(), db.query('SELECT id, account_id FROM sessions').all(), columns(db, 'sessions')]);
      const before = snapshot();
      migratePeople(db);
      migratePeople(db);
      expect(snapshot()).toBe(before);
      db.close();
      db = openDb(file);
      expect(snapshot()).toBe(before);
      // and a later password is not overwritten by a stray old key
      new PeopleStore(db).setPasswordHash(OWNER_ID, '$argon2id$new');
      db.query('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(OLD_PASSWORD_KEY, JSON.stringify({ hash: '$argon2id$stale' }), 1);
      migratePeople(db);
      expect(new PeopleStore(db).passwordHash(OWNER_ID)).toBe('$argon2id$new');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('display names: an account from before them starts with its name, the default owner with none, and once only', () => {
    const db = openDb(':memory:');
    // hub_accounts as it was before display names, with the owner still "owner", a renamed owner, and a member
    db.exec('DROP TABLE hub_accounts');
    db.exec(`CREATE TABLE hub_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, email TEXT, role TEXT NOT NULL, password_hash TEXT, password_set_at INTEGER, invite_hash TEXT, invite_expires_at INTEGER, settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    const add = db.query('INSERT INTO hub_accounts (id, name, name_key, role, settings, created_at, updated_at) VALUES (?,?,?,?,?,1,1)');
    add.run(OWNER_ID, 'owner', 'owner', 'owner', '{}');
    add.run('acc_riley', 'riley', 'riley', 'member', '{"providers":{}}');
    add.run('acc_dee', 'Dee.O', 'dee.o', 'member', '{}');
    migratePeople(db);
    expect(columns(db, 'hub_accounts')).toContain('display_name');
    const shown = () => db.query('SELECT id, display_name FROM hub_accounts ORDER BY id').all();
    expect(shown()).toEqual([
      { id: 'acc_dee', display_name: 'Dee.O' },
      { id: 'acc_riley', display_name: 'riley' },
      { id: OWNER_ID, display_name: null },
    ]);
    // settings and the rest stay
    expect(new PeopleStore(db).get('acc_riley')).toMatchObject({ name: 'riley', displayName: 'riley', settings: { providers: {} } });
    // a display name cleared or set apart later is never filled in again
    db.query("UPDATE hub_accounts SET display_name = NULL WHERE id = 'acc_riley'").run();
    db.query("UPDATE hub_accounts SET display_name = 'Dee Okafor' WHERE id = 'acc_dee'").run();
    const before = JSON.stringify(db.query('SELECT * FROM hub_accounts ORDER BY id').all());
    migratePeople(db);
    migratePeople(db);
    expect(JSON.stringify(db.query('SELECT * FROM hub_accounts ORDER BY id').all())).toBe(before);

    // an owner who had given a name when display names came starts with it
    const db2 = openDb(':memory:');
    db2.exec('ALTER TABLE hub_accounts DROP COLUMN display_name');
    db2.query("UPDATE hub_accounts SET name = 'kai', name_key = 'kai' WHERE id = ?").run(OWNER_ID);
    migratePeople(db2);
    expect(new PeopleStore(db2).owner().displayName).toBe('kai');
    expect(shownName(new PeopleStore(db2).owner())).toBe('Kai');
  });

  test('email keys: filled once from the emails there were; two rows that share one stay, and it signs in neither', () => {
    const db = openDb(':memory:');
    // hub_accounts as it was before email keys, with two members who share an email in different case
    db.exec('DROP INDEX IF EXISTS hub_accounts_email');
    db.exec('ALTER TABLE hub_accounts DROP COLUMN email_key');
    const add = db.query("INSERT INTO hub_accounts (id, name, name_key, display_name, email, role, settings, created_at, updated_at) VALUES (?,?,?,?,?,'member','{}',1,1)");
    add.run('acc_sol', 'sol', 'sol', 'sol', 'Sol@Example.com');
    add.run('acc_twin_a', 'twina', 'twina', 'twina', 'twins@example.com');
    add.run('acc_twin_b', 'twinb', 'twinb', 'twinb', 'TWINS@example.com');
    add.run('acc_none', 'none', 'none', 'none', null);
    migratePeople(db);
    expect(columns(db, 'hub_accounts')).toContain('email_key');
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'hub_accounts_email'").get()).toBeTruthy();
    expect(db.query('SELECT id, email, email_key FROM hub_accounts ORDER BY id').all()).toEqual([
      { id: 'acc_none', email: null, email_key: null },
      { id: 'acc_sol', email: 'Sol@Example.com', email_key: 'sol@example.com' },
      { id: 'acc_twin_a', email: 'twins@example.com', email_key: 'twins@example.com' },
      { id: 'acc_twin_b', email: 'TWINS@example.com', email_key: 'twins@example.com' },
      { id: OWNER_ID, email: null, email_key: null },
    ]);
    const people = new PeopleStore(db);
    expect(people.bySignIn('sol@example.com')?.id).toBe('acc_sol');
    expect(people.bySignIn('twins@example.com')).toBeUndefined();
    expect(people.bySignIn('twina')?.id).toBe('acc_twin_a');
    // the rest of a row that shares one still changes, with the email sent along
    expect(people.update('acc_twin_a', { displayName: 'Twin A', email: 'Twins@Example.com' })).toMatchObject({ displayName: 'Twin A', email: 'Twins@Example.com' });
    // again: nothing changes
    const before = JSON.stringify(db.query('SELECT * FROM hub_accounts ORDER BY id').all());
    migratePeople(db);
    expect(JSON.stringify(db.query('SELECT * FROM hub_accounts ORDER BY id').all())).toBe(before);
  });

  test('every table is classed once: an account’s, a child of one, or the hub’s', () => {
    const lists = [...ACCOUNT_TABLES, ...Object.keys(CHILD_TABLES), ...HUB_TABLES];
    expect(lists.length).toBe(new Set(lists).size);
    for (const parent of Object.values(CHILD_TABLES)) expect([...ACCOUNT_TABLES, ...Object.keys(CHILD_TABLES)]).toContain(parent);
  });
});

describe('the people store', () => {
  test('names, roles, passwords and invites', () => {
    const people = new PeopleStore(openDb(':memory:'));
    expect(people.owner()).toMatchObject({ id: OWNER_ID, name: 'owner', role: 'owner', passwordSet: false });
    const a = people.create({ name: 'Alice', email: 'a@example.com' });
    expect(a.id).toMatch(/^acc_/);
    expect(a.role).toBe('member');
    expect(people.byName('ALICE')?.id).toBe(a.id);
    expect(() => people.create({ name: 'alice' })).toThrow(PeopleError);
    expect(() => people.create({ name: 'owner' })).toThrow(PeopleError);
    expect(() => people.create({ name: 'two words' })).toThrow(PeopleError);
    expect(() => people.create({ name: 'x', role: 'owner' })).toThrow(PeopleError);
    expect(NAME_RE.test('bob.smith-2')).toBe(true);
    people.setPasswordHash(a.id, 'h');
    expect(people.get(a.id)?.passwordSet).toBe(true);
    people.setInvite(a.id, 'sha', Date.now() + 1000);
    expect(people.byInvite('sha')?.id).toBe(a.id);
    people.setInvite(a.id, 'old', Date.now() - 1);
    expect(people.byInvite('old')).toBeUndefined();
    expect(people.count()).toBe(2);
    expect(() => people.remove(OWNER_ID)).toThrow(PeopleError);
  });

  test('emails: one person each, case aside, and a login finds the account by one', () => {
    const people = new PeopleStore(openDb(':memory:'));
    const a = people.create({ name: 'alice', displayName: 'Alice Moss', email: ' Alice@Example.com ' });
    expect(a.email).toBe('Alice@Example.com');
    for (const s of ['alice@example.com', '  ALICE@EXAMPLE.COM ', 'Alice', ' alice ']) expect(people.bySignIn(s)?.id).toBe(a.id);
    expect(people.bySignIn('nobody@example.com')).toBeUndefined();
    expect(people.bySignIn('Alice Moss')).toBeUndefined();
    expect(people.bySignIn('')).toBeUndefined();

    const refused = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof PeopleError ? `${e.status} ${e.message}` : String(e);
      }
      return 'no error';
    };
    expect(refused(() => people.create({ name: 'bob', email: 'alice@EXAMPLE.com' }))).toBe('409 Another person already has that email.');
    expect(people.byName('bob')).toBeUndefined();
    const b = people.create({ name: 'bob', email: 'bob@example.com' });
    expect(refused(() => people.update(b.id, { email: ' ALICE@example.com' }))).toBe('409 Another person already has that email.');
    expect(refused(() => people.update(OWNER_ID, { email: 'Bob@Example.com' }))).toBe('409 Another person already has that email.');
    expect(people.get(b.id)?.email).toBe('bob@example.com');
    // one's own in other case is fine, and still signs in
    expect(people.update(b.id, { email: 'BOB@example.com' }).email).toBe('BOB@example.com');
    expect(people.bySignIn('bob@example.com')?.id).toBe(b.id);
    // cleared: it no longer signs in, and is free for someone else
    people.update(b.id, { email: null });
    expect(people.bySignIn('bob@example.com')).toBeUndefined();
    expect(people.update(OWNER_ID, { email: 'bob@example.com' }).email).toBe('bob@example.com');
    expect(people.bySignIn('BOB@example.com')?.id).toBe(OWNER_ID);
  });

  test('display names: spaces and punctuation, apart from the sign-in name', () => {
    const people = new PeopleStore(openDb(':memory:'));
    // the owner's default account has none
    expect(people.owner().displayName).toBeUndefined();
    expect(shownName(people.owner())).toBeUndefined();
    // a member starts with their sign-in name, unless one is given
    expect(people.create({ name: 'riley' }).displayName).toBe('riley');
    const dee = people.create({ name: 'dee', displayName: '  Dee   Okafor ' });
    expect(dee.displayName).toBe('Dee Okafor');
    for (const ok of ["Zoë O'Brien-Smith (ZO)", 'Kai Ahir', 'Ana María', 'राहुल शर्मा', 'J.R.R. Tolkien', 'x'.repeat(DISPLAY_NAME_MAX)]) expect(checkDisplayName(ok)).toBe(ok);
    for (const bad of ['x'.repeat(DISPLAY_NAME_MAX + 1), '<b>Kai</b>', 'Kai 🎉', '...', 'a\u0000b', 42]) expect(() => checkDisplayName(bad)).toThrow(PeopleError);
    // nothing but spaces is none, like empty
    for (const none of ['', '   ', null, undefined]) expect(checkDisplayName(none)).toBeUndefined();
    expect(checkDisplayName('Kai\t\n Ahir')).toBe('Kai Ahir');
    // the sign-in name stays one word, and a display name never signs in
    expect(() => people.update(dee.id, { name: 'Dee Okafor' })).toThrow(PeopleError);
    expect(people.byName('Dee Okafor')).toBeUndefined();
    // a display name set apart stays when the sign-in name changes; one that was the sign-in name follows it
    expect(people.update(dee.id, { name: 'deeo' }).displayName).toBe('Dee Okafor');
    const riley = people.byName('riley')!;
    expect(people.update(riley.id, { name: 'riley.k' }).displayName).toBe('riley.k');
    expect(people.update(OWNER_ID, { name: 'kai' }).displayName).toBe('kai');
    // null clears it; the greeting then uses the sign-in name
    expect(people.update(OWNER_ID, { displayName: 'Kai Ahir' }).displayName).toBe('Kai Ahir');
    expect(people.update(OWNER_ID, { displayName: null }).displayName).toBeUndefined();
    expect(shownName(people.owner())).toBe('Kai');
  });

  test('shownName: as typed when set apart, a capital when it is the sign-in name, none for the default owner', () => {
    expect(shownName({ name: 'kai', displayName: 'kai ahir', role: 'owner' })).toBe('kai ahir');
    expect(shownName({ name: 'riley', displayName: 'riley', role: 'member' })).toBe('Riley');
    expect(shownName({ name: 'riley', role: 'member' })).toBe('Riley');
    expect(shownName({ name: 'owner', role: 'owner' })).toBeUndefined();
    expect(shownName({ name: 'Owner', displayName: 'Owner', role: 'owner' })).toBeUndefined();
    expect(shownName({ name: 'owner', displayName: 'Kai Ahir', role: 'owner' })).toBe('Kai Ahir');
    expect(shownName({ name: 'owner', role: 'member' })).toBe('Owner');
    expect(shownName(undefined)).toBeUndefined();
  });

  test('removing a person deletes every row of theirs and nothing of anyone else', () => {
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const people = new PeopleStore(db);
    const a = people.create({ name: 'alice' });
    repos.sessions.insert(session('ses_a', a.id));
    repos.sessions.insert(session('ses_o'));
    for (const [id, sid] of [['m1', 'ses_a'], ['m2', 'ses_o']]) {
      repos.messages.insert({ id, sessionId: sid, seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: `zebra ${sid}` }], createdAt: 1 } as never);
    }
    db.query("INSERT INTO memories (id, scope, kind, content, created_at, updated_at, account_id) VALUES ('mem_a', 'global', 'fact', 'a fact', 1, 1, ?)").run(a.id);
    db.query("INSERT INTO memories (id, scope, kind, content, created_at, updated_at) VALUES ('mem_o', 'global', 'fact', 'o fact', 1, 1)").run();
    repos.kv.set(accountKey(a.id, 'assistant.prefs'), { x: 1 });
    repos.kv.set(accountKey(OWNER_ID, 'assistant.prefs'), { x: 2 });
    expect(accountKey(OWNER_ID, 'k')).toBe('k');

    people.remove(a.id);
    expect(people.get(a.id)).toBeUndefined();
    expect(repos.sessions.get('ses_a')).toBeUndefined();
    expect(repos.sessions.get('ses_o')).toBeDefined();
    expect(repos.messages.list('ses_a')).toEqual([]);
    expect(repos.messages.list('ses_o').length).toBe(1);
    expect(repos.messages.search('zebra', 10, OWNER_ID).map((h) => h.sessionId)).toEqual(['ses_o']);
    expect(db.query('SELECT id FROM memories').all()).toEqual([{ id: 'mem_o' }]);
    expect(repos.kv.get(accountKey(a.id, 'assistant.prefs'), null)).toBeNull();
    expect(repos.kv.get<unknown>('assistant.prefs', null)).toEqual({ x: 2 });
    // safe on an id with nothing left
    purgeAccount(db, a.id);
  });

  test('an account\'s kv lists only its own keys, named as it set them', () => {
    const repos = new Repos(openDb(':memory:'));
    const member = accountKv(repos.kv, 'acc_a');
    member.set('maps.usage.2026-10-20', 1);
    repos.kv.set('maps.usage.2026-10-21', 2);
    repos.kv.set('maps.usageX', 3);
    expect(member.keys('maps.usage.')).toEqual(['maps.usage.2026-10-20']);
    expect(accountKv(repos.kv, OWNER_ID).keys('maps.usage.')).toEqual(['maps.usage.2026-10-21']);
  });
});

describe('events', () => {
  const lookup = { session: (id: string) => ({ ses_a: 'acc_a', ses_o: OWNER_ID })[id] };

  test('each event is stamped with its account, and goes to that account only', () => {
    expect(eventAccount({ type: 'message.delta', sessionId: 'ses_a' } as never, lookup)).toBe('acc_a');
    expect(eventAccount({ type: 'session.updated', session: { id: 'ses_o' } } as never, lookup)).toBe(OWNER_ID);
    expect(eventAccount({ type: 'approval.requested', approval: { sessionId: 'ses_a' } } as never, lookup)).toBe('acc_a');
    expect(eventAccount({ type: 'memory.updated', entry: { accountId: 'acc_a' } } as never, lookup)).toBe('acc_a');
    expect(eventAccount({ type: 'device.updated', device: { id: 'd', accountId: 'acc_a' } } as never, lookup)).toBe('acc_a');
    expect(eventAccount({ type: 'config.updated' } as never, lookup)).toBe('*');
    expect(eventAccount({ type: 'limit.updated' } as never, lookup)).toBe(OWNER_ID);
    // what cannot be placed is the owner's
    expect(eventVisibleTo(undefined, OWNER_ID)).toBe(true);
    expect(eventVisibleTo(undefined, 'acc_a')).toBe(false);
    expect(eventVisibleTo('*', 'acc_a')).toBe(true);
    expect(eventVisibleTo('acc_a', 'acc_b')).toBe(false);
  });
});

describe('the machine guard', () => {
  const hub = {
    id: 'local',
    name: 'hub',
    info: async () => ({ os: 'linux' }),
    exec: async () => ({ code: 0, stdout: 'ran', stderr: '' }),
    resolve: (p: string) => p,
  };

  test('the hub refuses a member, a device refuses everyone but its account, background work passes', async () => {
    const guarded = guardMachine(hub as never, OWNER_ID, 'hub') as typeof hub;
    expect(await guarded.exec()).toMatchObject({ stdout: 'ran' });
    expect(await runAs(OWNER_ID, () => guarded.exec())).toMatchObject({ stdout: 'ran' });
    await expect(runAs('acc_a', () => guarded.exec())).rejects.toThrow(HUB_REFUSED);
    await expect(runAs('acc_a', () => guarded.exec())).rejects.toBeInstanceOf(MachineRefused);
    // a pure path helper is not a use of the machine
    expect(runAs('acc_a', () => guarded.resolve('/x'))).toBe('/x');

    const device = guardMachine({ ...hub, id: 'dev_a' } as never, 'acc_a', 'device') as typeof hub;
    expect(await runAs('acc_a', () => device.exec())).toMatchObject({ stdout: 'ran' });
    await expect(runAs('acc_b', () => device.exec())).rejects.toBeInstanceOf(MachineRefused);
    await expect(runAs(OWNER_ID, () => device.exec())).rejects.toBeInstanceOf(MachineRefused);

    await expect((new RefusedMachine('local', HUB_REFUSED) as unknown as { exec(): Promise<unknown> }).exec()).rejects.toThrow(HUB_REFUSED);
    expect(currentAccount()).toBeUndefined();
    expect(await runAs('acc_a', async () => currentAccount())).toBe('acc_a');
  });
});

describe('public addresses', () => {
  test('private, loopback and link-local addresses are refused', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '100.64.0.1', '0.0.0.0', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
    await expect(checkPublicUrl('http://localhost:8000/mcp')).rejects.toThrow(PRIVATE_REFUSED);
    await expect(checkPublicUrl('http://notes.example/mcp', async () => ['10.0.0.5'])).rejects.toThrow(PRIVATE_REFUSED);
    await expect(checkPublicUrl('https://notes.example/mcp', async () => ['93.184.216.34'])).resolves.toBeUndefined();
    await expect(checkPublicUrl('file:///etc/passwd')).rejects.toThrow();
  });

  test('a lookup that fails or finds nothing is refused (fail closed)', async () => {
    await expect(checkPublicUrl('https://notes.example/mcp', async () => Promise.reject(new Error('SERVFAIL')))).rejects.toThrow(PRIVATE_LOOKUP_FAILED);
    await expect(checkPublicUrl('https://notes.example/mcp', async () => [])).rejects.toThrow(PRIVATE_LOOKUP_FAILED);
  });
});
