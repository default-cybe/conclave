/**
 * Calendar and mail, maps and watches with several people on one hub
 * (docs/design/ACCOUNTS.md): each account has its own calendar accounts,
 * proposals and secrets, while the hub's own OAuth clients stay hub wide;
 * leave-by reads the calendars of the account the work runs for; a member's
 * CalDAV server is never on the hub's network; members get no maps and no
 * watches.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { pimFor } from '../../src/pim/registry';
import { calendarPortOf } from '../../src/maps/registry';
import { OWNER_ID, runAs } from '../../src/people/context';
import type { PimService } from '../../src/pim/service';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

type Host = { secret(n: string): string | undefined; setSecret(n: string, v: string | undefined): void };
const hostOf = (s: PimService) => (s as unknown as { h: Host }).h;

describe('calendar and mail per account', () => {
  test('accounts, proposals and secrets are each account’s; the hub’s OAuth clients are shared', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice' });
    const own = pimFor(engine, OWNER_ID)!;
    const mine = pimFor(engine, alice.id)!;
    expect(mine).not.toBe(own);
    expect(pimFor(engine, alice.id)).toBe(mine);

    const p = own.store.addProposal({ kind: 'event', payload: { dto: { kind: 'event', action: 'create', summary: 'owner dentist' } } });
    const q = mine.store.addProposal({ kind: 'event', payload: { dto: { kind: 'event', action: 'create', summary: 'alice gym' } } });
    expect(own.proposals({ status: 'pending' }).map((x) => x.id)).toEqual([p.id]);
    expect(mine.proposals({ status: 'pending' }).map((x) => x.id)).toEqual([q.id]);
    expect(mine.store.proposal(p.id)).toBeUndefined();
    expect(mine.store.claim(p.id)).toBe(false);
    expect(own.store.proposal(p.id)?.status).toBe('pending');

    mine.store.saveAccount({ id: 'acct_a1', kind: 'caldav', label: 'Alice calendar', createdAt: 1, updatedAt: 1 });
    expect(mine.accounts().map((a) => a.id)).toEqual(['acct_a1']);
    expect(own.accounts()).toEqual([]);

    // a member's app passwords go to their own secrets file, never the hub's
    hostOf(mine).setSecret('pim.acct_a1.password', 'alice-app-password');
    expect(engine.accountSecrets.value(alice.id, 'pim.acct_a1.password')).toBe('alice-app-password');
    expect(engine.config.secretValue('pim.acct_a1.password')).toBeUndefined();
    expect(hostOf(own).secret('pim.acct_a1.password')).toBeUndefined();
    // the hub's Google app is the owner's to set, and every account signs in with it
    own.oauth.setHubClients({ googleWebClientId: 'hub-web-client', googleWebSecret: 'hub-web-secret' });
    expect(mine.oauth.hubClients().google?.webClientId).toBe('hub-web-client');
    expect(hostOf(mine).secret('pim.oauth.google.web')).toBe('hub-web-secret');
    hostOf(mine).setSecret('pim.oauth.google.web', 'member-override');
    expect(hostOf(own).secret('pim.oauth.google.web')).toBe('hub-web-secret');

    // a member's CalDAV server is never on the hub's network
    await expect(mine.addCaldav({ serverUrl: 'http://127.0.0.1:9/dav', username: 'a', password: 'pw' })).rejects.toThrow("hub's own network");
  }, 30_000);

  test('leave-by reads the calendars of the account the work runs for', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice' });
    const ev = (title: string) => ({ events: [{ id: title, title, start: 1, end: 2, allDay: false, status: 'confirmed' }], errors: [] });
    (pimFor(engine, OWNER_ID) as unknown as { events: unknown }).events = async () => ev('owner meeting');
    (pimFor(engine, alice.id) as unknown as { events: unknown }).events = async () => ev('alice yoga');
    const port = calendarPortOf(engine);
    expect((await port.eventsBetween(0, 10)).map((e) => e.title)).toEqual(['owner meeting']);
    expect((await runAs(alice.id, () => port.eventsBetween(0, 10))).map((e) => e.title)).toEqual(['alice yoga']);
  }, 30_000);
});

describe('maps and watches are each account’s', () => {
  test('a member’s session gets the maps tools (on their own key, people-keys.test.ts), and a member can make a watch of their own', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice' });
    const agent = engine.extensions.agent('assistant')!;
    const ownS = await engine.createSession({ agent: 'assistant' } as never, OWNER_ID);
    const memberS = await engine.createSession({ agent: 'assistant' } as never, alice.id);
    const names = (id: string) => engine.toolsFor(engine.requireSession(id), agent, 'agent', 0).map((x) => x.name);
    const ownerTools = names(ownS.id);
    const memberTools = names(memberS.id);
    // members get every tool now (MEMBER_DENY is empty); maps calls use the member's own key, never the owner's
    for (const n of ['PlaceSearch', 'Directions']) {
      expect(ownerTools).toContain(n);
      expect(memberTools).toContain(n);
    }
    // a member's watch browses in their own browser (browser/manager.ts), so it is allowed, and it is theirs
    const w = engine.routines.create({ name: 'cars', schedule: '0 7 * * *', prompt: 'look', watch: { url: 'https://example.com' } } as never, alice.id);
    expect(w.accountId).toBe(alice.id);
    const r = engine.routines.create({ name: 'brief', schedule: '0 7 * * *', prompt: 'brief me' }, alice.id);
    expect(engine.routines.update(r.id, { watch: { url: 'https://example.com' } } as never).watch?.url).toBe('https://example.com/');
  }, 30_000);
});
