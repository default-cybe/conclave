/**
 * Platform awareness (platform/card.ts, docs/DESIGN.md 51) on the real
 * engine with the scripted model: the card goes to primary sessions, two
 * lines to subagents, the live block follows devices, MCP servers and the
 * browser, the prompt holds byte for byte while nothing changes, and the
 * switches turn it off.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type RequestBody, type TestEngine } from './harness';
import { HomeMachine } from '../projects/machines';
import { cleanup, tempDir } from '../extensions/_helpers';
import { CARD_TOKEN_CAP } from '../../src/platform/card';
import { estimateTokens } from '../../src/util/text';
import type { Device } from '../../src/types';

const SERVER = join(import.meta.dir, 'fixtures', 'mcp-catalog-server.ts');

let t: TestEngine | undefined;
const homes: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  cleanup(...homes.splice(0));
});

/** The system prompt of a request, its blocks joined. */
function systemOf(body: string): string {
  return ((JSON.parse(body) as RequestBody).system as Array<{ text: string }>).map((b) => b.text).join('\n\n');
}

/** The system blocks without their cache markers. */
function blocksOf(body: string): string {
  return JSON.stringify(((JSON.parse(body) as RequestBody).system as Array<{ text: string }>).map((b) => b.text));
}

function attach(t: TestEngine, id: string, name: string): void {
  const home = tempDir('conclave-card-dev-');
  homes.push(home);
  const m = new HomeMachine(id, name, home);
  t.engine.repos.devices.insert({ id, name, tokenHash: 'test', roots: [] });
  t.engine.devices.attach({ ...t.engine.repos.devices.get(id)!, online: true, info: m.infoNow() } as Device, m);
}

describe('the platform card in requests', () => {
  test('a primary session gets the card and the live block; its subagent gets two lines', async () => {
    t = await startTestEngine({
      script: [[{ tool: 'Task', input: { subagent_type: 'explore', description: 'Look around', prompt: 'SUB-BRIEF: list the files.' } }], [{ text: 'Done.' }]],
      route: (body) => (firstUserText(body).includes('SUB-BRIEF') ? [{ text: 'Two files.' }] : undefined),
    });
    const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder' });
    await t.run(s.id, 'what is in this folder?');

    const parent = t.requests.find((r) => !firstUserText(JSON.parse(r)).includes('SUB-BRIEF'))!;
    const child = t.requests.find((r) => firstUserText(JSON.parse(r)).includes('SUB-BRIEF'))!;
    const sys = systemOf(parent);
    const hub = t.engine.info().name;
    expect(sys).toContain(`# Conclave\nYou run in Conclave, the owner's self-hosted agent hub`);
    expect(sys).toContain(`This hub: ${hub}, Conclave test`);
    expect(sys).toContain('# Conclave right now\n- This is a Code session with the coder agent.');
    expect(sys).toContain('ConclaveHelp');
    expect(sys).toContain(`- Devices online: ${hub} (the hub).`);
    // the card follows the role, the live block is the last block
    const blocks = (JSON.parse(parent) as RequestBody).system as Array<{ text: string }>;
    expect(blocks.findIndex((b) => b.text.startsWith('# Conclave\n'))).toBe(blocks.findIndex((b) => b.text.startsWith('# Your role: coder')) + 1);
    expect(blocks[blocks.length - 1].text).toStartWith('# Conclave right now');
    const card = blocks.filter((b) => b.text.startsWith('# Conclave')).map((b) => b.text).join('\n\n');
    expect(estimateTokens(card)).toBeLessThan(CARD_TOKEN_CAP);

    const sub = systemOf(child);
    expect(sub).toContain('You are a subagent: do the brief and report back');
    expect(sub).not.toContain('# Conclave right now');
    expect(sub).not.toContain('Where things are in the app');
  }, 30_000);

  test('the live block follows devices, MCP servers and the browser, and holds byte for byte while nothing changes', async () => {
    t = await startTestEngine({
      script: [[{ text: 'one' }]],
      overrides: { mcpServers: { gh: { command: 'bun', args: [SERVER] } } } as never,
    });
    const browser = (t.engine as unknown as { browser: { available: () => Promise<{ ok: boolean }> } }).browser;
    browser.available = async () => ({ ok: true });
    const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'assistant' });

    await t.run(s.id, 'first');
    await t.run(s.id, 'second');
    expect(t.requests).toHaveLength(2);
    // nothing changed between the turns: the same bytes
    expect(blocksOf(t.requests[1])).toBe(blocksOf(t.requests[0]));
    const first = systemOf(t.requests[0]);
    expect(first).toContain('This is an Assistant session with the assistant agent.');
    // 45 MCP tools sit behind ToolSearch; their server still shows
    expect(first).toContain('- MCP servers: gh.');
    expect(first).toContain('- Browser: ready on the hub (Chromium).');
    expect(first).not.toContain('MadX Arch');

    // a device comes online: the next turn says so
    attach(t, 'arch', 'MadX Arch');
    await t.run(s.id, 'third');
    expect(systemOf(t.requests[2])).toContain('(the hub), MadX Arch.');

    // and goes offline
    t.engine.devices.detach('arch');
    await t.run(s.id, 'fourth');
    expect(systemOf(t.requests[3])).toContain('Offline: MadX Arch.');

    // the hub loses its browser
    browser.available = async () => ({ ok: false });
    await t.run(s.id, 'fifth');
    const last = systemOf(t.requests[4]);
    expect(last).toContain('- Browser: no browser is installed on the hub yet');
    expect(last).not.toContain('Browser: ready');
  }, 60_000);

  test('a chat hears where Delegate sends what it lacks', async () => {
    t = await startTestEngine({ script: [[{ text: 'Hi.' }]] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.run(chat.id, 'can you check the disk on my laptop?');
    const sys = systemOf(t.requests[0]);
    expect(sys).toContain('- This is a Chat with the chat agent.');
    expect(sys).toContain('Delegate hands those to Code (files and the shell, workflows) or the Assistant (the browser, routines, watches).');
    const tools = ((JSON.parse(t.requests[0]) as RequestBody).tools ?? []).map((x) => x.name);
    expect(tools).toContain('ConclaveHelp');
  }, 30_000);
});

describe('the switches', () => {
  test("an agent's platformCard: false leaves the card out", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const coder = t.engine.extensions.agent('coder')!;
    await t.engine.extensions.saveAgent({ ...coder, platformCard: false, source: 'user' }, 'user');
    expect(t.engine.extensions.agent('coder')?.platformCard).toBe(false);
    const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder' });
    await t.run(s.id, 'hello');
    const sys = systemOf(t.requests[0]);
    expect(sys).not.toContain('# Conclave');
    expect(sys).toContain('# Your role: coder');
  }, 30_000);

  test('agents.platformCard: false leaves it out for every agent', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { agents: { platformCard: false } } as never });
    const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'assistant' });
    await t.run(s.id, 'hello');
    expect(systemOf(t.requests[0])).not.toContain('# Conclave');
  }, 30_000);
});
