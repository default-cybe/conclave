import { describe, expect, test } from 'bun:test';
import { CARD_TOKEN_CAP, cardTokens, platformCard, subagentNote, toolGroups, type PlatformFacts } from '../../src/platform/card';
import { builtinTools } from '../../src/tools';
import { mcpServersOf, surfaceOf } from '../../src/platform/facts';

/** The assistant on a busy hub: every built-in tool, the browser, MCP servers, devices and accounts. */
function busy(over: Partial<PlatformFacts> = {}): PlatformFacts {
  return {
    hub: { name: 'madx', version: '0.4.14', where: 'Linux x64 in an LXC container (CT 100)' },
    surface: 'assistant',
    agent: 'assistant',
    tools: [...builtinTools().map((t) => t.name), 'browser_navigate', 'browser_snapshot', 'browser_click', 'mcp__github__search_code', 'mcp__basic-memory__read_note'],
    mcpServers: ['basic-memory', 'github'],
    devices: [
      { name: 'madx', online: true, hub: true },
      { name: 'MadX Arch', online: true },
      { name: 'macbook', online: false },
    ],
    browser: 'ready',
    browserEngine: 'CloakBrowser',
    accounts: ['Claude plan neu@example.org', 'Claude plan personal@example.org', 'Anthropic API key', 'Z.ai Coding Plan key'],
    engines: ['Claude Code', 'Codex'],
    defaultModel: 'anthropic/claude-sonnet-5-5',
    ...over,
  };
}

describe('the platform card', () => {
  test('says what Conclave is, the modes, where things are and what the agent cannot do, with the hub line', () => {
    const { card } = platformCard(busy());
    expect(card).toStartWith('# Conclave\n');
    expect(card).toContain("the owner's self-hosted agent hub");
    expect(card).toContain('This hub: madx, Conclave 0.4.14, on Linux x64 in an LXC container (CT 100).');
    for (const word of ['Chat is a plain conversation', 'Assistant runs on the hub', 'Code works in a folder', 'Delegate sends a job', 'Task runs a subagent', 'Workflow runs a script']) expect(card).toContain(word);
    for (const page of ['Settings > Models', 'Refusal fallback', 'Settings > Browser', 'GitHub', 'Inbox', 'Usage', 'Routines', 'Extensions', 'Friends', 'Import']) expect(card).toContain(page);
    expect(card).toContain('You cannot change settings, keys, sign-ins or device pairing');
    expect(card).toContain('"can you do X"');
    expect(card).toContain('call ConclaveHelp first');
    // the house wording: no em dashes
    expect(card).not.toContain('—');
  });

  test('without ConclaveHelp it does not send the agent to a tool it lacks', () => {
    const { card } = platformCard(busy({ tools: ['Read', 'Bash'] }));
    expect(card).not.toContain('ConclaveHelp');
    expect(card).toContain('say what you are unsure of');
  });

  test('the live block lists tools by group, MCP servers, devices, the browser and the models', () => {
    const { live } = platformCard(busy());
    expect(live).toStartWith('# Conclave right now\n');
    expect(live).toContain('This is an Assistant session with the assistant agent.');
    expect(live).toContain('Tools: files, shell, web, browser, memory and past chats');
    expect(live).toContain('Delegate, Task, Workflow, ScheduleRoutine');
    expect(live).toContain('- MCP servers: basic-memory, github.');
    expect(live).toContain('- Devices online: madx (the hub), MadX Arch. Offline: macbook.');
    expect(live).toContain('- Browser: ready on the hub (CloakBrowser).');
    expect(live).toContain('default anthropic/claude-sonnet-5-5; accounts Claude plan neu@example.org');
    expect(live).toContain('engines Claude Code, Codex');
    expect(live).not.toContain('Not in this session');
  });

  test('a chat hears what it lacks and where Delegate sends it', () => {
    const { live } = platformCard(
      busy({ surface: 'chat', agent: 'chat', tools: ['WebSearch', 'WebFetch', 'MemorySearch', 'MemorySave', 'SessionSearch', 'Delegate', 'ConclaveHelp'], mcpServers: [], browser: 'none' }),
    );
    expect(live).toContain('This is a Chat with the chat agent. Tools: web, memory and past chats, Delegate, ConclaveHelp.');
    expect(live).toContain('Not in this session: files and the shell, workflows, the browser, routines, watches, subagents.');
    expect(live).toContain('Delegate hands those to Code (files and the shell, workflows) or the Assistant (the browser, routines, watches).');
    expect(live).toContain('MCP servers: none connected.');
    expect(live).not.toContain('Browser:');
  });

  test('live state shows: a device offline, a new MCP server, the browser missing', () => {
    const before = platformCard(busy()).live;
    const offline = platformCard(busy({ devices: [{ name: 'madx', online: true, hub: true }, { name: 'MadX Arch', online: false }, { name: 'macbook', online: false }] })).live;
    expect(offline).toContain('Devices online: madx (the hub). Offline: MadX Arch, macbook.');
    const mcp = platformCard(busy({ mcpServers: ['basic-memory', 'github', 'proxmox'] })).live;
    expect(mcp).toContain('MCP servers: basic-memory, github, proxmox.');
    const missing = platformCard(busy({ browser: 'missing', browserEngine: undefined })).live;
    expect(missing).toContain('no browser is installed on the hub yet; the owner adds one in Settings > Browser.');
    for (const changed of [offline, mcp, missing]) expect(changed).not.toBe(before);
  });

  test('the same facts give the same bytes, with no clock in them', () => {
    const a = platformCard(busy());
    const b = platformCard(structuredClone(busy()));
    expect(b).toEqual(a);
    const text = `${a.card}\n${a.live}`;
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
  });

  test(`card and live block stay under ${CARD_TOKEN_CAP} tokens on a busy hub`, () => {
    const big = busy({
      devices: [{ name: 'madx', online: true, hub: true }, ...['arch-desktop', 'MadX Arch', 'pve', 'kali-vm', 'studio', 'nas', 'pi', 'laptop'].map((name) => ({ name, online: true })), ...['macbook', 'old-pc'].map((name) => ({ name, online: false }))],
      mcpServers: ['basic-memory', 'github', 'proxmox', 'notion', 'gmail', 'serena', 'semgrep', 'zotero', 'radare2', 'tailscale'],
      accounts: ['Claude plan neu@example.org', 'Claude plan personal@example.org', 'ChatGPT plan me@example.org', 'Gemini plan me@example.org', 'Anthropic API key', 'OpenAI API key', 'Z.ai Coding Plan key', 'OpenRouter key'],
    });
    const c = platformCard(big);
    const tokens = cardTokens(c);
    console.log(`platform card: ${tokens} tokens (card ${Math.ceil(c.card.length / 4)}, live ${Math.ceil(c.live.length / 4)})`);
    expect(tokens).toBeLessThan(CARD_TOKEN_CAP);
    expect(tokens).toBeGreaterThan(400);
    expect(c.live).toContain('and 2 more');
  });

  test('a member sees their own devices, not the hub owner\'s settings or accounts', () => {
    const c = platformCard(busy({ member: true, accounts: [], engines: [] }));
    expect(c.card).toContain('The hub, its browser and its accounts are the owner\'s.');
    expect(c.card).not.toContain('Settings > Models');
    expect(c.live).not.toContain('Models:');
  });

  test('subagents get two lines', () => {
    const note = subagentNote({ hub: { name: 'madx', version: '0.4.14' }, tools: ['Read', 'ConclaveHelp'] }, 'subagent');
    expect(note.split('\n')).toHaveLength(2);
    expect(note).toContain('You are a subagent: do the brief and report back');
    expect(note).toContain('ConclaveHelp searches the Conclave docs.');
    const untrusted = subagentNote({ hub: { name: 'madx', version: '0.4.14' }, tools: [] }, 'untrusted');
    expect(untrusted.split('\n')).toHaveLength(2);
    expect(untrusted).not.toContain('ConclaveHelp');
  });

  test('tool groups, surfaces and MCP servers', () => {
    expect(toolGroups([])).toBe('none');
    expect(toolGroups(['Read', 'Grep', 'Bash', 'Task'])).toBe('files, shell, Task');
    expect(toolGroups(['mcp__a__x', 'mcp__a__y'])).toBe('2 MCP tools');
    expect(toolGroups(['ToolSearch', 'mcp__a__x'])).toBe('MCP tools through ToolSearch');
    expect(surfaceOf({ kind: 'chat', agent: 'chat' })).toBe('chat');
    expect(surfaceOf({ agent: 'assistant' })).toBe('assistant');
    expect(surfaceOf({ agent: 'coder' })).toBe('code');
    expect(mcpServersOf(['Read', 'mcp__github__a', 'mcp__basic-memory__b', 'mcp__github__c', 'mcp__plugin_x_y__z'])).toEqual(['basic-memory', 'github', 'plugin_x_y']);
  });
});
