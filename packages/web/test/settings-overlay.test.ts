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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODE_PAGES, MORE_ADVANCED, MORE_PAGES, NAV, OWNER_PAGES, PHONE_ADVANCED, PHONE_MORE, PHONE_PAGES, sidePages } from '../src/components/nav';
import { meetingsDefault, NEW_ACCOUNT_MODES } from '@conclave/core/client';

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
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(['You', 'AI connections', 'Assistant', 'Tools and apps', 'Hub and people', 'Data', 'Advanced']);
    const g = groupSections(sections);
    expect(g.map((x) => x.label)).toEqual(['You', 'AI connections', 'Hub and people']);
    expect(g[0].items.map((x) => x.id)).toEqual(['account', 'newthing']);
    expect(g[2].items.map((x) => x.id)).toEqual(['remote', 'about']);
  });

  test("the report's tree: all 30 section ids once each, every one a real section, and only Advanced folded", () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.ids);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    const src = readFileSync(join(import.meta.dir, '../src/features/settings/SettingsPage.tsx'), 'utf8');
    for (const id of ids) expect(src).toContain(`id: '${id}',`);
    expect(SETTINGS_GROUPS.filter((g) => g.folded).map((g) => g.label)).toEqual(['Advanced']);
    expect(SETTINGS_GROUPS.find((g) => g.label === 'Advanced')!.ids).toEqual(['accounts', 'refusal', 'usage', 'security', 'gateway', 'secrets', 'logs']);
    expect(groupSections([{ id: 'logs' }]).map((g) => [g.label, g.folded])).toEqual([['Advanced', true]]);
    // usage keeps its id and address; its name says what it does
    expect(src).toContain("label: 'Limit fallback'");
  });

  test('the old group names and the new ones still find their sections', () => {
    const all = [...sections, { id: 'refusal', label: 'Refusal fallback', desc: '' }, { id: 'gateway', label: 'Gateway keys', desc: '' }, { id: 'logs', label: 'Logs', desc: '' }];
    expect(searchSections(all, 'models').map((x) => x.id)).toEqual(['providers', 'refusal']);
    expect(searchSections(all, 'customize').map((x) => x.id)).toEqual(['gateway']);
    expect(searchSections(all, 'platform').map((x) => x.id)).toEqual(['remote', 'about', 'logs']);
    expect(searchSections(all, 'advanced').map((x) => x.id)).toEqual(['refusal', 'gateway', 'logs']);
  });

  test('the computer index folds Advanced until clicked, a search runs or one of its sections is open; the phone index shows it on a tap', () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/settings/SettingsPage.tsx'), 'utf8');
    expect(src).toContain('!g.folded || !!q || (advanced ?? g.items.some((x) => x.id === current?.id))');
    expect(src).toContain('aria-expanded={open(g)}');
    // a search shows every match, so the header is plain text then, not a toggle that does nothing
    expect(src).toContain('{g.folded && !q ? (');
    expect(src).toContain("g.folded && !advanced\n          ? [{ label: 'Show advanced settings'");
  });

  test('search matches names, lines and the words people use', () => {
    expect(searchSections(sections, '').length).toBe(5);
    expect(searchSections(sections, 'remote').map((x) => x.id)).toEqual(['remote']);
    expect(searchSections(sections, 'tailscale').map((x) => x.id)).toEqual(['remote']);
    expect(searchSections(sections, 'update').map((x) => x.id)).toEqual(['about']);
    expect(searchSections(sections, 'KEYS hub').map((x) => x.id)).toEqual(['providers']);
    expect(searchSections(sections, 'nothing like this')).toEqual([]);
  });

  test('Import & export opens the Data group, and search finds it', () => {
    expect(SETTINGS_GROUPS.find((g) => g.label === 'Data')!.ids).toEqual(['data', 'audit']);
    const all = [...sections, { id: 'reflect', label: 'Reflect', desc: 'Your own report.' }, { id: 'data', label: 'Import & export', desc: 'Bring in chats. Export your memory.' }, { id: 'subscriptions', label: 'Subscriptions', desc: 'Plans you pay for.' }];
    expect(groupSections(all).find((g) => g.label === 'Data')!.items.map((x) => x.id)).toEqual(['data']);
    expect(searchSections(all, 'export').map((x) => x.id)).toEqual(['data']);
    expect(searchSections(all, 'claude').map((x) => x.id)).toContain('data');
    expect(searchSections(all, 'conversations.json').map((x) => x.id)).toEqual(['data']);
  });
});

describe('the sidebar rows per mode', () => {
  test('Inbox always, Meetings only when on, Today, Tasks, Goals and Routines only in Assistant', () => {
    expect(sidePages('chat', false)).toEqual(['/approvals']);
    expect(sidePages('code', true)).toEqual(['/approvals', '/meetings']);
    expect(sidePages('assistant', false)).toEqual(['/approvals', '/today', '/tasks', '/goals', '/routines']);
    expect(sidePages('assistant', true)).toEqual(['/approvals', '/meetings', '/today', '/tasks', '/goals', '/routines']);
    for (const m of ['chat', 'assistant', 'code', 'security', 'canvas'] as const) for (const p of ['/workflows', '/memory', '/extensions']) expect(sidePages(m, true)).not.toContain(p);
    for (const m of ['chat', 'code', 'security', 'canvas'] as const) for (const p of ['/today', '/tasks', '/goals', '/routines']) expect(sidePages(m, true)).not.toContain(p);
  });
  test('every mode row has an icon row in the sidebar, and the phone drawer draws the same rows', () => {
    const side = readFileSync(join(import.meta.dir, '../src/components/Sidebar.tsx'), 'utf8');
    for (const to of MODE_PAGES.assistant ?? []) expect(side).toContain(`'${to}': { to: '${to}'`);
    const phone = readFileSync(join(import.meta.dir, '../src/components/PhoneFrame.tsx'), 'utf8');
    expect(phone).toContain('(MODE_PAGES[mode] ?? []).map(');
  });
  test('Routines, Tasks and Goals keep their G keys and Search entries in every mode; Today is in Search', () => {
    expect(NAV.find((n) => n.to === '/routines')?.key).toBe('r');
    expect(NAV.find((n) => n.to === '/tasks')?.key).toBe('t');
    expect(NAV.find((n) => n.to === '/goals')?.key).toBe('o');
    const palette = readFileSync(join(import.meta.dir, '../src/components/CommandPalette.tsx'), 'utf8');
    expect(palette).toContain("go('/today')");
    expect(palette).toContain("go('/sessions/split')");
  });
});

describe("a phone's drawer", () => {
  test('its More row opens the page list, which reaches Workflows, Memory, Extensions and Usage; the Assistant rows are not in it', () => {
    const src = readFileSync(join(import.meta.dir, '../src/components/PhoneFrame.tsx'), 'utf8');
    expect(src).toContain('label="More" to={PHONE_MORE}');
    expect(PHONE_MORE).toBe('/settings/more');
    const to = PHONE_PAGES.map((p) => p.to);
    for (const p of ['/workflows', '/memory', '/extensions', '/usage']) expect(to).toContain(p);
    for (const p of ['/today', '/tasks', '/goals', '/routines']) expect(to).not.toContain(p);
  });
});

describe('the Meetings default', () => {
  test('off for a fresh hub, on when the account already has meetings, else what was chosen', () => {
    expect(NEW_ACCOUNT_MODES.meetings).toBe(false);
    expect(meetingsDefault(undefined, () => false)).toBe(false);
    expect(meetingsDefault(undefined, () => true)).toBe(true);
    expect(meetingsDefault(false, () => true)).toBe(false);
    expect(meetingsDefault(true, () => false)).toBe(true);
  });
});

describe('the pages', () => {
  test("a phone's Settings reaches every page the drawer has no row for: the Inbox on its index, the rest in More, Agents and Map under Advanced", () => {
    const labels = PHONE_PAGES.map((p) => p.label);
    expect(labels[0]).toBe('Inbox');
    for (const l of ['All conversations', 'Workflows', 'Memory', 'Extensions', 'Usage', 'Devices']) expect(labels).toContain(l);
    expect(PHONE_ADVANCED.map((p) => p.label)).toEqual(['Agents', 'Map']);
    const src = readFileSync(join(import.meta.dir, '../src/features/settings/SettingsPage.tsx'), 'utf8');
    expect(src).toContain("{ label: 'Advanced', rows: PHONE_ADVANCED }");
  });
  test("the sidebar's More menu has the pages without a row, then Agents, Map and Side by side under Advanced", () => {
    expect(MORE_PAGES.map((p) => p.label)).toEqual(['Workflows', 'Memory', 'Extensions', 'Usage', 'Devices']);
    expect(MORE_ADVANCED.map((p) => p.label)).toEqual(['Agents', 'Map', 'Side by side']);
    expect(MORE_ADVANCED.find((p) => p.label === 'Side by side')?.to).toBe('/sessions/split');
    expect(MORE_PAGES.filter((p) => !OWNER_PAGES.has(p.to)).map((p) => p.label)).not.toContain('Extensions');
  });
  test('no page is lost: every page with a G key is a sidebar row, in More, or in its Advanced fold', () => {
    const reach = new Set([...MORE_PAGES, ...MORE_ADVANCED].map((p) => p.to).concat(sidePages('assistant', true)));
    for (const n of NAV.filter((x) => !['/', '/chat', '/sessions'].includes(x.to))) expect(reach.has(n.to)).toBe(true);
  });
});
