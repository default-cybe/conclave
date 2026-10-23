/**
 * The Claude Code style commands of a session (the "/" menu): a skill typed
 * as /<name> args runs through the Skill tool, /compact takes
 * instructions, /context says what fills the context, and connectors turn
 * off for one session.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from './harness';
import { SUMMARY_HEADINGS } from '../../src/session/prompt';
import { checkMcpOff, mcpOff, sessionAllowsServerTool } from '../../src/session/connectors';
import { splitMessages } from '../../src/session/context-usage';
import type { Message } from '../../src/types';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const SUMMARIZE = 'Conversation to summarize';
const shaped = (lead: string) => `${lead}\n\n${SUMMARY_HEADINGS.map((h) => `## ${h}\nnone`).join('\n')}`;

function skill(cwd: string, name: string) {
  const dir = join(cwd, '.conclave', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Write release notes from the git log\n---\nRead the git log since the last tag and write release notes.\n`);
}

const lastUser = (msgs: Message[]) => [...msgs].reverse().find((m) => m.role === 'user')!;

describe('a skill typed as /<name> args', () => {
  test('sends the line with a note to load the skill through the Skill tool', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok, loading it' }]] });
    skill(t.cwd, 'release-notes');
    const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
    expect(t.engine.extensions.skills(t.cwd).some((k) => k.name === 'release-notes')).toBe(true);
    const r = await t.engine.command(s.id, '/release-notes since v0.1');
    expect(r.output).toBeUndefined();
    await t.engine.runnerFor(s.id).waitIdle();
    const user = lastUser(t.engine.getMessages(s.id));
    const texts = user.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    expect(texts[0]).toBe('/release-notes since v0.1');
    expect(texts.some((x) => x.includes('Call the Skill tool with skill "release-notes"') && x.includes('"since v0.1"'))).toBe(true);
    // the model got both in one user message
    expect(t.requests.at(-1)).toContain('Call the Skill tool with skill');
  });

  test('a session in Chat mode, or an agent without the Skill tool, says why it cannot run', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    skill(t.cwd, 'release-notes');
    const chat = await t.engine.createSession({ title: 'c', cwd: t.cwd, mode: 'chat' });
    expect((await t.engine.command(chat.id, '/release-notes')).output).toContain('Switch this session to Agent mode');
    const plain = await t.engine.createSession({ title: 'p', cwd: t.cwd });
    expect((await t.engine.command(plain.id, '/no-such-thing')).output).toBe('Unknown command: /no-such-thing');
  });
});

describe('/compact with instructions', () => {
  test('the summary request carries them, and the hub says when there is nothing to compact', async () => {
    t = await startTestEngine({ modelOverrides: { 'claude-sonnet-5-5': { contextWindow: 200_000 } }, script: [[{ text: 'done' }]], chore: (_b, text) => (text.includes(SUMMARIZE) ? [{ text: shaped('SUMMARY') }] : undefined) });
    const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
    expect(await t.engine.compact(s.id, 'keep the API names')).toBe(false);
    expect((await t.engine.command(s.id, '/compact')).output).toBe('Nothing to compact yet.');
    for (const [role, text] of [['user', 'first ask'], ['assistant', 'a'.repeat(60_000)], ['user', 'second ask'], ['assistant', 'b'.repeat(60_000)], ['user', 'third'], ['assistant', 'c'.repeat(60_000)]] as const) {
      t.engine.addMessage(s.id, { role, kind: 'normal', content: [{ type: 'text', text }] });
    }
    expect((await t.engine.command(s.id, '/compact keep the API names')).output).toBe('Compacted.');
    const asked = t.chores.find((c) => c.includes(SUMMARIZE))!;
    expect(asked).toContain('Also keep these details:\\nkeep the API names');
  }, 60_000);
});

describe('/context', () => {
  test('splits messages from tool output and adds up the parts', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
    t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'x'.repeat(400) }] });
    t.engine.addMessage(s.id, { role: 'assistant', kind: 'normal', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } }] });
    t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'y'.repeat(4_000) }] });
    const u = await t.engine.contextUsage(s.id);
    expect(u.parts.toolOutput).toBe(1_000);
    expect(u.parts.messages).toBeGreaterThanOrEqual(100);
    expect(u.parts.system).toBeGreaterThan(500);
    expect(u.parts.tools).toBeGreaterThan(1_000);
    expect(u.total).toBe(u.parts.system + u.parts.tools + u.parts.messages + u.parts.toolOutput);
    expect(u.compactTokens).toBe(Math.round(u.window * u.compactAt));
    expect(u.toolCount).toBeGreaterThan(5);
    expect(u.messageCount).toBe(3);
    expect(u.summarized).toBe(false);
  });

  test('splitMessages counts images and thinking with the messages', () => {
    const m = (content: Message['content']) => ({ id: 'm', sessionId: 's', seq: 1, role: 'assistant', kind: 'normal', content, createdAt: 0 }) as Message;
    expect(splitMessages([m([{ type: 'thinking', thinking: 'z'.repeat(40) }])])).toEqual({ messages: 10, toolOutput: 0 });
  });
});

describe('connectors off for one session', () => {
  test('the patch keeps the list in meta, clears with null, and refuses junk', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { mcpServers: { notes: { command: 'true' }, github: { command: 'true' } } } as never });
    const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
    const off = t.engine.updateSession(s.id, { mcpOff: ['github', 'github'] });
    expect(mcpOff(off)).toEqual(['github']);
    expect(Object.keys(t.engine.mcpServersForHarness(off))).toEqual(['notes']);
    expect(Object.keys(t.engine.mcpServersForHarness(t.engine.requireSession(s.id)))).toEqual(['notes']);
    const back = t.engine.updateSession(s.id, { mcpOff: null });
    expect(back.meta?.mcpOff).toBeUndefined();
    expect(Object.keys(t.engine.mcpServersForHarness(back)).sort()).toEqual(['github', 'notes']);
    expect(() => t!.engine.updateSession(s.id, { mcpOff: 'github' as never })).toThrow('mcpOff must be a list of server names');
  });

  test('MCP tools of a server that is off leave the session; built-in tools stay', () => {
    const s = { meta: { mcpOff: ['github'] } };
    expect(sessionAllowsServerTool(s, 'mcp__github__create_issue')).toBe(false);
    expect(sessionAllowsServerTool(s, 'mcp__github_enterprise__x')).toBe(true);
    expect(sessionAllowsServerTool(s, 'Read')).toBe(true);
    expect(checkMcpOff(null)).toEqual([]);
  });
});
