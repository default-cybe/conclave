/**
 * Settings over the app (lib/settingsRoute.ts, features/settings/nav.ts,
 * docs/design/SPEC.md 5.3): /settings/... stays the address, the page under it
 * is the last place outside Settings, and closing goes back there however
 * many sections were opened; a deep link closes to Home. The index's
 * groups and search, and the phone's More list.
 */
import { describe, expect, test } from 'bun:test';
import { isSettingsPath, settingsMove, startTrail, type Move, type SettingsTrail } from '../src/lib/settingsRoute';
import { groupSections, searchSections, settingsRedirect, SETTINGS_GROUPS } from '../src/features/settings/nav';
import { MORE_PAGES, OWNER_PAGES, PHONE_PAGES } from '../src/components/nav';

const walk = (start: SettingsTrail, moves: Move[]) => moves.reduce(settingsMove, start);
const push = (path: string, search = ''): Move => ({ kind: 'push', path, search });
const replace = (path: string, search = ''): Move => ({ kind: 'replace', path, search });
const pop = (path: string, search = ''): Move => ({ kind: 'pop', path, search });

describe('the page under Settings', () => {
  test('what is a Settings address', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/providers')).toBe(true);
    expect(isSettingsPath('/settings/friends/frd_a')).toBe(true);
    expect(isSettingsPath('/settingsx')).toBe(false);
    expect(isSettingsPath('/s/abc')).toBe(false);
  });

  test('opened from a session: the session stays under it, and closing goes back one step', () => {
    const t = walk(startTrail('/s/s_auth', '?x=1'), [push('/settings'), replace('/settings/account'), replace('/settings/providers'), replace('/settings/about')]);
    expect(t).toEqual({ outside: { path: '/s/s_auth', search: '?x=1' }, depth: 1 });
  });

  test('a link inside Settings that adds an entry is taken back too', () => {
    const t = walk(startTrail('/workflows', ''), [push('/settings/about'), push('/settings/defaults')]);
    expect(t.depth).toBe(2);
    expect(t.outside.path).toBe('/workflows');
    // Back inside Settings takes one off
    expect(settingsMove(t, pop('/settings/about')).depth).toBe(1);
  });

  test('a deep link has Home under it and closes in place', () => {
    const t = walk(startTrail('/settings/remote', ''), [replace('/settings/friends')]);
    expect(t).toEqual({ outside: { path: '/', search: '' }, depth: 0 });
  });

  test('leaving Settings any way makes the new place the one under it', () => {
    const t = walk(startTrail('/s/a', ''), [push('/settings/about'), pop('/s/a'), push('/memory'), push('/settings')]);
    expect(t).toEqual({ outside: { path: '/memory', search: '' }, depth: 1 });
    // a link out of Settings to another page
    expect(settingsMove(t, push('/extensions/mcp')).outside.path).toBe('/extensions/mcp');
  });
});

describe('where an address under /settings goes', () => {
  const known = ['account', 'providers', 'friends', 'about'];
  test('bare /settings opens the first section on a computer, the index on a phone', () => {
    expect(settingsRedirect(undefined, undefined, known, false)).toBe('/settings/account');
    expect(settingsRedirect(undefined, undefined, known, true)).toBeUndefined();
  });
  test('an unknown section, a moved one, and an item of a section without items', () => {
    expect(settingsRedirect('nope', undefined, known, false)).toBe('/settings/account');
    expect(settingsRedirect('nope', undefined, known, true)).toBe('/settings');
    expect(settingsRedirect('mcp', undefined, known, false, '?add=1')).toBe('/extensions/mcp?add=1');
    expect(settingsRedirect('about', 'x', known, false)).toBe('/settings/about');
    expect(settingsRedirect('friends', 'frd_a', known, false)).toBeUndefined();
    expect(settingsRedirect('providers', undefined, known, false)).toBeUndefined();
  });
});

describe("the index's groups and search", () => {
  const sections = [
    { id: 'account', label: 'Your account', desc: 'Your name and password.' },
    { id: 'providers', label: 'Providers', desc: 'Keys and plans the hub signs in with.' },
    { id: 'remote', label: 'Remote access', desc: 'How your phone reaches this hub.' },
    { id: 'about', label: 'About', desc: 'This hub and this client.' },
    { id: 'newthing', label: 'New thing', desc: 'A section no group names.' },
  ];

  test('quiet groups in order, empty ones left out, a new section under the first', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(['Settings', 'Models', 'Customize', 'Platform']);
    const g = groupSections(sections);
    expect(g.map((x) => x.label)).toEqual(['Settings', 'Models', 'Platform']);
    expect(g[0].items.map((x) => x.id)).toEqual(['account', 'newthing']);
    expect(g[2].items.map((x) => x.id)).toEqual(['remote', 'about']);
  });

  test('search matches names, lines and the words people use', () => {
    expect(searchSections(sections, '').length).toBe(5);
    expect(searchSections(sections, 'remote').map((x) => x.id)).toEqual(['remote']);
    expect(searchSections(sections, 'tailscale').map((x) => x.id)).toEqual(['remote']);
    expect(searchSections(sections, 'update').map((x) => x.id)).toEqual(['about']);
    expect(searchSections(sections, 'KEYS hub').map((x) => x.id)).toEqual(['providers']);
    expect(searchSections(sections, 'nothing like this')).toEqual([]);
  });
});

describe('the pages', () => {
  test("a phone's Settings reaches every page: the Inbox on its index, the rest in More", () => {
    const labels = PHONE_PAGES.map((p) => p.label);
    expect(labels[0]).toBe('Inbox');
    for (const l of ['All conversations', 'Workflows', 'Routines', 'Memory', 'Extensions', 'Tasks', 'Goals', 'Agents', 'Usage', 'Devices', 'Map']) expect(labels).toContain(l);
  });
  test("the sidebar's More menu has the pages without a row, and a member does not get the owner's", () => {
    const labels = MORE_PAGES.map((p) => p.label);
    expect(labels).toEqual(['Tasks', 'Goals', 'Agents', 'Usage', 'Devices', 'Map', 'Today', 'Friends', 'Remote access']);
    expect(MORE_PAGES.filter((p) => !OWNER_PAGES.has(p.to)).map((p) => p.label)).not.toContain('Friends');
  });
});
