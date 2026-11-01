/**
 * Sign ins kept on this browser (lib/people.ts, docs/design/ACCOUNTS.md 10):
 * the current one first, one entry per person per hub, a newer token
 * replacing the older, and the label each shows.
 *
 *   bun test packages/web/test/people.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Connection } from '../src/lib/api';

const g = globalThis as { localStorage?: unknown; indexedDB?: unknown };
const store = new Map<string, string>();
const before = g.localStorage;

beforeAll(() => {
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
});
afterAll(() => {
  g.localStorage = before;
});

const hub = 'https://hub.example.com';
const owner: Connection = { baseUrl: hub, token: 'cnc_owner', hubName: 'madx', account: { id: 'owner', name: 'owner', role: 'owner' } };
const alice: Connection = { baseUrl: hub, token: 'cnc_alice', hubName: 'madx', account: { id: 'acc_a', name: 'alice', role: 'member' }, clientId: 'cli_a' };

describe('kept sign ins', () => {
  test('one per person, the current one first, a new token replacing the old', async () => {
    const { saveConnection } = await import('../src/lib/api');
    const { accountLabel, isCurrent, rememberAccount, savedAccounts } = await import('../src/lib/people');
    saveConnection(owner);
    rememberAccount(owner);
    rememberAccount(alice);
    expect(savedAccounts().map((c) => c.account?.name)).toEqual(['owner', 'alice']);
    rememberAccount({ ...alice, token: 'cnc_alice2' });
    expect(savedAccounts().map((c) => c.token)).toEqual(['cnc_owner', 'cnc_alice2']);
    saveConnection({ ...alice, token: 'cnc_alice2' });
    expect(savedAccounts()[0].account?.name).toBe('alice');
    expect(isCurrent(alice)).toBe(true);
    expect(isCurrent(owner)).toBe(false);
    // a sign in from before display names shows the sign-in name with a capital, one with a display name shows that
    expect(accountLabel(alice)).toBe('Alice');
    expect(accountLabel({ ...alice, account: { ...alice.account!, displayName: 'Alice Mbeki' } })).toBe('Alice Mbeki');
    // the owner who gave no name is still "owner" in the list
    expect(accountLabel(owner)).toBe('owner');
    // a sign in from before accounts shows the hub
    expect(accountLabel({ baseUrl: hub, token: 'x', hubName: 'madx' })).toBe('madx');
    expect(accountLabel({ baseUrl: hub, token: 'x' })).toBe('hub.example.com');
  });
});

describe('the forced Connect screen', () => {
  test('?connect goes once signed in, so a reload opens the app and not Connect again', async () => {
    // found in a real run: sign out, sign in again, reload: the Connect screen came back
    const { withoutConnectParam } = await import('../src/lib/api');
    expect(withoutConnectParam('/', '?connect=1', '')).toBe('/');
    expect(withoutConnectParam('/settings', '?connect=1&tab=a', '#x')).toBe('/settings?tab=a#x');
    expect(withoutConnectParam('/', '', '')).toBeUndefined();
    expect(withoutConnectParam('/', '?tab=a', '')).toBeUndefined();
  });
});

describe("the hub's keys a person can be given (Settings, People)", () => {
  test('only providers the hub has a key or a signed in plan for; harnesses and switched off ones never', async () => {
    const { hubKeyProviders } = await import('../src/lib/providers');
    const g = (provider: string, configured: boolean, p: { enabled?: boolean; type?: string; name?: string } = {}) => ({ provider, name: p.name ?? provider, type: p.type ?? 'openai', configured, enabled: p.enabled ?? true });
    // found in a real run: a hub with an Anthropic key only offered OpenAI, Gemini, Z.ai and OpenRouter too
    const groups = [
      g('anthropic', true, { type: 'anthropic' }),
      g('openai', false),
      g('google', false, { type: 'gemini' }),
      g('zai', false, { type: 'anthropic', name: 'Z.ai Coding Plan' }),
      g('openrouter', false),
      g('ollama', true, { enabled: false, name: 'Ollama' }),
      g('cliproxy', true, { enabled: false, name: 'CLIProxyAPI' }),
      g('claude-code', true, { type: 'acp', name: 'Claude Code' }),
    ];
    expect(hubKeyProviders(groups)).toEqual([{ id: 'anthropic', name: 'Anthropic' }]);
    // subscriptions set up turn CLIProxyAPI on
    expect(hubKeyProviders(groups.map((x) => (x.provider === 'cliproxy' ? { ...x, enabled: true } : x))).map((p) => p.name)).toEqual(['Anthropic', 'CLIProxyAPI']);
  });
});

describe("the owner's name (setup step 1, Home, the account menu)", () => {
  // found in a real setup: no step asked for a name, so Home said "Good evening." and the menu said "owner"
  const owner = (name: string) => ({ name, role: 'owner' as const });

  test('the owner account starts as "owner", which is no name', async () => {
    const { personName } = await import('../src/lib/people');
    expect(personName(owner('owner'))).toBeUndefined();
    expect(personName(owner('Owner'))).toBeUndefined();
    expect(personName(owner('Kai'))).toBe('Kai');
    // a member who signs in as owner2 is called that, with a capital like Home's greeting
    expect(personName({ name: 'owner2', role: 'member' })).toBe('Owner2');
    expect(personName(undefined)).toBeUndefined();
  });

  test('Home greets by the name saved in setup, and by none when there is none', async () => {
    const { greetingName } = await import('../src/lib/people');
    const { greeting } = await import('../src/features/conversation/units');
    const evening = new Date(2026, 9, 21, 20);
    // setup saved Kai to the account; the hub copies it to ui.name
    expect(greeting(greetingName(owner('Kai'), 'Kai'), evening)).toBe('Good evening, Kai.');
    // a hub that has not copied it yet still greets by the account
    expect(greetingName(owner('kai'), undefined)).toBe('Kai');
    expect(greeting(greetingName(owner('owner'), undefined), evening)).toBe('Good evening.');
    // a name set only in Settings, Appearance, and one cleared there
    expect(greetingName(owner('owner'), 'Kai Ahir')).toBe('Kai Ahir');
    expect(greetingName(owner('kai'), '')).toBeUndefined();
    // a member is greeted by their own name, never the owner's
    expect(greetingName({ name: 'riley', role: 'member' }, 'Kai')).toBe('Riley');
  });

  test('a name the account cannot take says why', async () => {
    const { nameProblem } = await import('../src/lib/people');
    expect(nameProblem('Kai')).toBeUndefined();
    expect(nameProblem('  ')).toBeUndefined();
    expect(nameProblem('kai.ahir')).toBeUndefined();
    expect(nameProblem('Kai Ahir')).toBe('One word, with no spaces.');
    expect(nameProblem('-kai')).toContain('starting with a letter or digit');
    expect(nameProblem('k'.repeat(41))).toBe('At most 40 characters.');
    for (const n of ['Kai Ahir', '-kai', 'k'.repeat(41)]) expect(nameProblem(n)).not.toMatch(/[\u2014\u2013]/);
  });
});

describe('display names (Your account, People, setup step 1, the account menu, Home)', () => {
  test('shown as typed, with spaces; a sign-in name only gets a capital', async () => {
    const { greetingName, personName } = await import('../src/lib/people');
    expect(personName({ name: 'kai', displayName: 'Kai Ahir', role: 'owner' })).toBe('Kai Ahir');
    expect(personName({ name: 'owner', displayName: 'Kai Ahir', role: 'owner' })).toBe('Kai Ahir');
    expect(personName({ name: 'riley', displayName: 'riley', role: 'member' })).toBe('Riley');
    expect(personName({ name: 'riley', displayName: 'riley k', role: 'member' })).toBe('riley k');
    // a member is greeted by their own display name, never by the owner's greeting
    expect(greetingName({ name: 'dee', displayName: 'Dee Okafor', role: 'member' }, 'Kai Ahir')).toBe('Dee Okafor');
    // the owner by ui.name, which the hub sets from the display name, else the display name
    expect(greetingName({ name: 'owner', displayName: 'Kai Ahir', role: 'owner' }, 'Kai Ahir')).toBe('Kai Ahir');
    expect(greetingName({ name: 'owner', displayName: 'Kai Ahir', role: 'owner' }, undefined)).toBe('Kai Ahir');
  });

  test('what a display name may be: the hub checks the same', async () => {
    const { displayNameProblem, tidyDisplayName, DISPLAY_NAME_MAX } = await import('../src/lib/people');
    for (const ok of ['Kai Ahir', "Zoë O'Brien-Smith (ZO)", 'Ana María', 'J.R.R. Tolkien', '', '   ', 'x'.repeat(DISPLAY_NAME_MAX)]) expect(displayNameProblem(ok)).toBeUndefined();
    expect(displayNameProblem('x'.repeat(DISPLAY_NAME_MAX + 1))).toBe('A display name has at most 60 characters.');
    for (const bad of ['<b>Kai</b>', 'Kai 🎉', '...']) expect(displayNameProblem(bad)).toBe('Use letters, digits, spaces and common punctuation in a display name.');
    expect(tidyDisplayName('  Kai \t  Ahir ')).toBe('Kai Ahir');
    for (const bad of ['x'.repeat(DISPLAY_NAME_MAX + 1), 'Kai 🎉']) expect(displayNameProblem(bad)).not.toMatch(/[\u2014\u2013]/);
  });

  test('a new name shows on the kept sign in too', async () => {
    const { saveConnection } = await import('../src/lib/api');
    const { accountLabel, refreshAccount, savedAccounts } = await import('../src/lib/people');
    saveConnection(alice);
    refreshAccount({ id: 'acc_a', name: 'alice', displayName: 'Alice Mbeki', role: 'member' });
    expect(accountLabel(savedAccounts()[0])).toBe('Alice Mbeki');
    expect(savedAccounts().filter((c) => c.account?.id === 'acc_a')).toHaveLength(1);
    // someone else's: nothing changes
    refreshAccount({ id: 'owner', name: 'kai', displayName: 'Kai Ahir', role: 'owner' });
    expect(savedAccounts().find((c) => c.account?.id === 'owner')?.account?.displayName).toBeUndefined();
  });
});
