/**
 * The "/" menu of a session composer (features/chat/slash.ts): what Code
 * and Chat mode offer, skills only when the agent can load them, custom
 * commands from the hub and plugins, fuzzy search that keeps the sections,
 * and what a pick does.
 *
 *   bun test packages/web/test/slash-menu.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { agentHasSkills, builtinCommands, filterSlash, findSlash, menuList, pickAction, sectionsOf, SHEET_TITLES, slashItems, slashMode, TOP_COMMANDS } from '../src/features/chat/slash';
import { contextShares } from '../src/features/chat/sheets/ContextSheet';

const skills = [
  { name: 'changelog', description: 'Keep the changelog', source: 'user' as const },
  { name: 'release-notes', description: 'Write release notes from the git log', source: 'user' as const },
  { name: 'superpowers:brainstorming', description: 'Explore an idea before code', source: 'plugin' as const, plugin: 'superpowers' },
  { name: 'compact', description: 'A skill that clashes with a built-in', source: 'user' as const },
];
const commands = [
  { name: 'deploy', description: 'Deploy to staging', argumentHint: '<env>', source: 'user' as const },
  { name: 'standup', description: 'Write my standup', source: 'plugin' as const, plugin: 'team' },
  { name: 'release-notes', description: 'A command with a skill name', source: 'user' as const },
];

const names = (list: Array<{ name: string }>) => list.map((x) => x.name);

describe('per mode', () => {
  test('Code mode has the Claude Code commands, and the settings ones open sheets', () => {
    const code = names(builtinCommands('code'));
    for (const n of ['help', 'clear', 'compact', 'context', 'cost', 'model', 'agents', 'mcp', 'hooks', 'permissions', 'memory', 'resume', 'review', 'init', 'export', 'status', 'skills']) expect(code).toContain(n);
    const sheets = builtinCommands('code').filter((b) => b.sheet).map((b) => b.name);
    expect(sheets.sort()).toEqual(['agents', 'context', 'cost', 'help', 'hooks', 'mcp', 'memory', 'model', 'permissions', 'resume', 'skills', 'status']);
    expect(SHEET_TITLES.mcp).toBe('Connectors');
    expect(code).toEqual([...code].sort());
  });

  test('Chat mode keeps a smaller set without the coding commands', () => {
    const chat = names(builtinCommands('chat'));
    for (const n of ['help', 'model', 'clear', 'compact', 'export', 'memory', 'resume', 'cost', 'status']) expect(chat).toContain(n);
    for (const n of ['mcp', 'hooks', 'permissions', 'agents', 'skills', 'init', 'review', 'device', 'cwd', 'context', 'jury', 'debate']) expect(chat).not.toContain(n);
    expect(chat.length).toBeLessThan(builtinCommands('code').length);
  });

  test('the mode follows the session: Chat mode or a chat gets the small set', () => {
    expect(slashMode({ mode: 'agent' })).toBe('code');
    expect(slashMode({ mode: 'plan' })).toBe('code');
    expect(slashMode({ mode: 'chat' })).toBe('chat');
    expect(slashMode({ mode: 'agent', kind: 'chat' })).toBe('chat');
  });
});

describe('sections', () => {
  test('Commands, then Skills, then Custom; a built-in wins over a command, a command over a skill, as on the hub', () => {
    const items = slashItems({ mode: 'code', skills, commands });
    expect(sectionsOf(items).map((g) => g.label)).toEqual(['Commands', 'Skills', 'Custom']);
    const sk = items.filter((i) => i.section === 'skills');
    expect(names(sk)).toEqual(['changelog', 'superpowers:brainstorming']);
    expect(sk[1].source).toBe('superpowers');
    expect(sk[0].source).toBeUndefined();
    expect(names(items.filter((i) => i.section === 'custom'))).toEqual(['deploy', 'release-notes', 'standup']);
    expect(items.filter((i) => i.name === 'compact')).toHaveLength(1);
  });

  test('no skills in Chat mode, or for an agent without the Skill tool', () => {
    expect(slashItems({ mode: 'chat', skills, commands }).some((i) => i.section === 'skills')).toBe(false);
    expect(slashItems({ mode: 'code', skills, commands, agent: { tools: ['Read', 'Grep'] } }).some((i) => i.section === 'skills')).toBe(false);
    expect(slashItems({ mode: 'code', skills, commands, agent: { tools: ['Read', 'Skill'] } }).some((i) => i.section === 'skills')).toBe(true);
    expect(agentHasSkills({ disallowedTools: ['Skill'] })).toBe(false);
    expect(agentHasSkills(undefined)).toBe(true);
  });
});

describe('search', () => {
  const items = slashItems({ mode: 'code', skills, commands });
  test('fuzzy, best first in each section, sections in order', () => {
    const hits = filterSlash(items, 'chang');
    expect(hits[0].section).toBe('skills');
    expect(hits[0].name).toBe('changelog');
    expect(filterSlash(items, 'rel').at(-1)?.name).toBe('release-notes');
    expect(names(filterSlash(items, 'cont'))[0]).toBe('context');
    const mixed = filterSlash(items, 's');
    const order = mixed.map((i) => i.section);
    expect(order).toEqual([...order].sort((a, b) => ['commands', 'skills', 'custom'].indexOf(a) - ['commands', 'skills', 'custom'].indexOf(b)));
    expect(filterSlash(items, 'zzzz')).toEqual([]);
    expect(filterSlash(items, '')).toBe(items);
  });

  test('a typed name or alias finds its item', () => {
    expect(findSlash(items, 'MCP')?.sheet).toBe('mcp');
    expect(findSlash(items, 'agent')?.name).toBe('agents');
    expect(findSlash(items, 'superpowers:brainstorming')?.section).toBe('skills');
    expect(findSlash(items, 'nope')).toBeUndefined();
  });
});

describe('a bare "/"', () => {
  const items = slashItems({ mode: 'code', skills, commands });
  test('lists the top commands, a row for the rest, then every skill and custom command', () => {
    const shown = menuList(items, '');
    const cmds = shown.filter((i) => i.section === 'commands');
    expect(names(cmds.filter((i) => !i.more))).toEqual(TOP_COMMANDS);
    const more = cmds.at(-1)!;
    expect(more.more).toBe(builtinCommands('code').length - TOP_COMMANDS.length);
    expect(more.description).toBe('/agents, /hooks, /skills, /memory');
    expect(pickAction(more)).toBe('more');
    expect(shown.filter((i) => i.section === 'skills')).toHaveLength(2);
    // skills sit within the first rows a 440px menu shows
    expect(shown.findIndex((i) => i.section === 'skills')).toBeLessThan(12);
  });
  test('all lists every command; typing searches all of them', () => {
    expect(menuList(items, '', true)).toBe(items);
    expect(names(menuList(items, 'hook'))[0]).toBe('hooks');
  });
});

describe('a pick', () => {
  const items = slashItems({ mode: 'code', skills, commands });
  const by = (n: string) => findSlash(items, n)!;
  test('settings open their sheet, skills and commands that need an argument wait for it, the rest run', () => {
    expect(pickAction(by('mcp'))).toBe('sheet');
    expect(pickAction(by('context'))).toBe('sheet');
    expect(pickAction(by('model'))).toBe('sheet');
    expect(pickAction(by('changelog'))).toBe('fill');
    expect(pickAction(by('cwd'))).toBe('fill');
    expect(pickAction(by('deploy'))).toBe('fill');
    expect(pickAction(by('standup'))).toBe('run');
    expect(pickAction(by('compact'))).toBe('run');
    expect(pickAction(by('clear'))).toBe('run');
  });
});

describe('/context bar', () => {
  test('each part is its share of the window, capped at 100', () => {
    const s = contextShares({ window: 200_000, parts: { system: 10_000, tools: 20_000, messages: 50_000, toolOutput: 400_000 } });
    expect(s).toEqual({ system: 5, tools: 10, messages: 25, toolOutput: 100 });
  });
});
