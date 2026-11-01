/**
 * A member's own plans (docs/design/ACCOUNTS.md 12): their `cliproxy` calls
 * go to their own CLIProxyAPI for a model it lists, to the hub's only while
 * the owner allows it, and the owner's calls never reach a member's plan.
 * The server's MemberPlans is faked here; both sides are paths on the
 * harness's mock server, so each request says which side took it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MemberPlanEntry, MemberPlans } from '../../src/people/plans';
import { startTestEngine, type TestEngine } from '../engine/harness';

let t: TestEngine;
let entry: MemberPlanEntry | undefined;
const listeners = new Set<(id: string) => void>();
let aliceId = '';
let bobId = '';
/** Requests to her own side to answer 529, and what to do when one does. */
let failOwn = 0;
let onFailOwn: (() => void) | undefined;

const plans: MemberPlans = {
  entry: (id) => (id === aliceId ? entry : undefined),
  count: (id) => (id === aliceId && entry ? 1 : 0),
  onChange: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const changed = () => {
  for (const fn of listeners) fn(aliceId);
};

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]], extraProviders: { cliproxy: ['claude-hub-5', 'claude-shared-5'] },
    route: (_body, _text, provider) => {
      if (provider !== 'alice-own' || failOwn <= 0) return undefined;
      failOwn--;
      onFailOwn?.();
      return 529;
    },
  });
  t.engine.access.setPlans(plans);
  // the hub's CLIProxyAPI is on, as once the owner set up subscriptions
  t.engine.config.setRuntime({ providers: { cliproxy: { enabled: true, modelOverrides: { 'claude-hub-5': { inputPrice: 1000, outputPrice: 1000 } } } } } as never, 'cliproxy');
  aliceId = t.engine.people.create({ name: 'alice' }).id;
  bobId = t.engine.people.create({ name: 'bob', settings: { providers: { cliproxy: {} } } }).id;
  const base = t.engine.config.get().providers.mock.baseUrl;
  entry = { config: { type: 'anthropic', baseUrl: `${base}/p/alice-own`, models: ['claude-own-5', 'claude-shared-5'] }, apiKey: 'cpk-alice' } as MemberPlanEntry;
  changed();
});

afterAll(async () => {
  t.engine.access.setPlans(undefined);
  await t?.close();
});

/** Run one turn on a model as an account: the side that took it (undefined when nothing was sent), every side asked, the session's messages and who paid its usage rows. */
async function sideOf(accountId: string, model: string): Promise<{ side?: string; sides: string[]; text: string; paidBy: string[]; rows: Array<{ paid_by: string; purpose: string }> }> {
  const before = t.requestProviders.length;
  const s = await t.engine.createSession({ agent: 'coder', model } as never, accountId);
  await t.run(s.id, 'hello');
  const rows = t.engine.repos.db.query("SELECT paid_by, purpose FROM usage WHERE session_id = ? AND provider = 'cliproxy'").all(s.id) as Array<{ paid_by: string; purpose: string }>;
  const sides = t.requestProviders.slice(before);
  return { side: sides[0], sides, text: JSON.stringify(t.engine.getMessages(s.id)), paidBy: rows.map((r) => r.paid_by), rows };
}

/** Give alice the owner's cliproxy grant, or take it back. */
function grant(on: boolean): void {
  t.engine.people.update(aliceId, { settings: { providers: on ? { cliproxy: {} } : {} } });
  changed();
}

describe("a member's own plans", () => {
  test('her model goes to her own CLIProxyAPI, a model both list too, and she pays for it herself', async () => {
    expect((await sideOf(aliceId, 'cliproxy/claude-own-5')).side).toBe('alice-own');
    expect((await sideOf(aliceId, 'cliproxy/claude-shared-5')).side).toBe('alice-own');
    const rows = t.engine.repos.db.query("SELECT paid_by FROM usage WHERE account_id = ? AND provider = 'cliproxy'").all(aliceId) as Array<{ paid_by: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.paid_by === 'own')).toBe(true);
    expect(t.engine.access.info(aliceId, 'cliproxy')).toMatchObject({ source: 'own', ownPlans: 1, ownKey: false, hubAllowed: false });
  });

  test("without the owner's grant, the hub's plans stay closed to her", async () => {
    const r = await sideOf(aliceId, 'cliproxy/claude-hub-5');
    expect(r.side).toBeUndefined();
    expect(r.text).toContain("can't use");
  });

  test("with the grant, a member without plans uses the hub's", async () => {
    expect((await sideOf(bobId, 'cliproxy/claude-hub-5')).side).toBe('cliproxy');
    expect((await sideOf(bobId, 'cliproxy/claude-shared-5')).side).toBe('cliproxy');
  });

  test("with the hub's CLIProxyAPI off (the default), a grant on it answers none, as her calls find", async () => {
    t.engine.config.setRuntime({ providers: { cliproxy: { enabled: false } } } as never, 'cliproxy');
    try {
      expect(t.engine.access.hubHas('cliproxy')).toBe(false);
      expect(t.engine.access.source(bobId, 'cliproxy')).toBe('none');
      expect(() => t.engine.access.check(bobId, 'cliproxy', 'claude-hub-5')).toThrow("can't use");
      // her own plan still answers for its models
      expect(t.engine.access.source(aliceId, 'cliproxy', 'claude-own-5')).toBe('own');
    } finally {
      t.engine.config.setRuntime({ providers: { cliproxy: { enabled: true, modelOverrides: { 'claude-hub-5': { inputPrice: 1000, outputPrice: 1000 } } } } } as never, 'cliproxy');
    }
    expect(t.engine.access.source(bobId, 'cliproxy')).toBe('hub');
  });

  test("the owner's calls never reach a member's plan", async () => {
    expect((await sideOf('owner', 'cliproxy/claude-shared-5')).side).toBe('cliproxy');
    expect(t.engine.access.info('owner', 'cliproxy').ownPlans).toBeUndefined();
  });

  test('when her CLIProxyAPI stops, her calls stop too, and start again with it', async () => {
    const keep = entry;
    entry = undefined;
    changed();
    try {
      expect((await sideOf(aliceId, 'cliproxy/claude-own-5')).side).toBeUndefined();
    } finally {
      entry = keep;
      changed();
    }
    expect((await sideOf(aliceId, 'cliproxy/claude-own-5')).side).toBe('alice-own');
  });
});

describe("a member with her own plan and the owner's grant", () => {
  beforeAll(() => grant(true));
  afterAll(() => grant(false));

  test("a model only the hub lists goes to the hub's and counts on her budget; her plan's model stays hers", async () => {
    const spent = t.engine.access.spent(aliceId, 'cliproxy');
    const hub = await sideOf(aliceId, 'cliproxy/claude-hub-5');
    expect(hub.side).toBe('cliproxy');
    expect(hub.paidBy.length).toBeGreaterThan(0);
    expect(hub.paidBy.every((p) => p === 'hub')).toBe(true);
    expect(t.engine.access.spent(aliceId, 'cliproxy')).toBeGreaterThan(spent);
    const own = await sideOf(aliceId, 'cliproxy/claude-own-5');
    expect(own.side).toBe('alice-own');
    // her session's title may go to the hub's (paid 'hub'); the turn itself is hers
    expect(own.rows.filter((r) => r.purpose === 'turn').map((r) => r.paid_by)).toEqual(['own']);
  });

  test('taking the grant back refuses her next hub-only call', async () => {
    grant(false);
    try {
      const r = await sideOf(aliceId, 'cliproxy/claude-hub-5');
      expect(r.side).toBeUndefined();
      expect(r.text).toContain("can't use");
    } finally {
      grant(true);
    }
  });

  test('her plan signed out between a failed attempt and its retry: the retry is refused, never paid as hers on the hub', async () => {
    const keep = entry;
    failOwn = 1;
    onFailOwn = () => {
      entry = undefined;
      changed();
    };
    try {
      const r = await sideOf(aliceId, 'cliproxy/claude-own-5');
      expect(r.sides).toEqual(['alice-own']);
      // the turn has no row: nothing on the hub was called for it (its title went to the hub, paid by the hub)
      expect(r.rows.filter((x) => x.purpose === 'turn')).toEqual([]);
      expect(r.paidBy).not.toContain('own');
      expect(r.text).toContain('Your plans changed during this call');
    } finally {
      failOwn = 0;
      onFailOwn = undefined;
      entry = keep;
      changed();
    }
  }, 15_000);
});
