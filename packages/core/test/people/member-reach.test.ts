/**
 * What a member's session may reach of the owner's (docs/design/ACCOUNTS.md
 * 2 and 5), through the paths that do not go through a tool's machine: an
 * agent harness process the owner left in the pool, the hub's MCP servers and
 * harness environment, slash commands, /agent and Task subagents.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, type TestEngine } from '../engine/harness';
import { HUB_REFUSED } from '../../src/people/guard';
import { OWNER_ID } from '../../src/people/context';
import { LocalMachine } from '../../src/machine/local';
import type { Device } from '../../src/types';
import type { AcpAdapter } from '../../src/acp/adapter';

const AGENT = join(import.meta.dir, '..', 'acp', 'fake-agent.ts');
const FAKE = { type: 'acp', name: 'Fake', command: process.execPath, args: [AGENT], models: ['default'] };

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const transcript = (engine: TestEngine['engine'], id: string) => JSON.stringify(engine.getMessages(id));
const poolSize = (engine: TestEngine['engine']) => (engine.acp as AcpAdapter).poolSize;

/** A device of `accountId`, connected, that runs on this computer (stands in for the member's own laptop). */
function memberDevice(engine: TestEngine['engine'], accountId: string): string {
  const id = `dev_${accountId.slice(-6)}`;
  engine.repos.devices.insert({ id, name: 'her laptop', tokenHash: 'x', accountId });
  engine.devices.attach({ id, name: 'her laptop', online: true, roots: [], createdAt: Date.now() } as unknown as Device, new LocalMachine());
  return id;
}

describe("a member's agent harness", () => {
  test("never gets a harness process the owner left on the hub, nor runs one there", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    engine.config.update({ providers: { fake: FAKE } } as never);
    const secret = join(t.cwd, 'owner-notes.txt');
    writeFileSync(secret, 'line one\nOWNER-SECRET-LINE\nline three\n');

    // the owner's harness turn on the hub leaves its process in the pool
    const own = await engine.createSession({ agent: 'coder', model: 'fake/default', cwd: t.cwd } as never, OWNER_ID);
    await t.run(own.id, 'hello');
    expect(transcript(engine, own.id)).toContain('ok');
    expect(poolSize(engine)).toBe(1);

    // a member's session in the same folder on the hub asks the harness to read the owner's file
    const alice = engine.people.create({ name: 'alice' });
    const s = await engine.createSession({ agent: 'coder', model: 'fake/default', cwd: t.cwd } as never, alice.id);
    await t.run(s.id, `fs ${secret}`);
    const said = transcript(engine, s.id);
    expect(said).not.toContain('OWNER-SECRET-LINE');
    expect(said).toContain(HUB_REFUSED);
    expect(existsSync(`${secret}.out`)).toBe(false);
    // and no harness started for her on the hub
    expect(poolSize(engine)).toBe(1);
  }, 60_000);

  test("gets neither the hub's MCP servers nor the hub's secrets in its environment", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    engine.config.setSecret('values', 'owner-harness-key', 'sk-OWNER-HARNESS');
    engine.config.update({ providers: { fake: { ...FAKE, env: { FAKE_KEY: '${secret:owner-harness-key}', FAKE_MODE: 'quiet' } } } } as never);
    const alice = engine.people.create({ name: 'alice' });
    const device = memberDevice(engine, alice.id);
    const s = await engine.createSession({ agent: 'coder', model: 'fake/default', device } as never, alice.id);
    const o = await engine.createSession({ agent: 'coder', model: 'fake/default', cwd: t.cwd } as never, OWNER_ID);
    // set after the sessions exist, so nothing tries to start these servers
    engine.config.update({ mcpServers: { 'owner-github': { type: 'http', url: 'https://mcp.example.com/github', headers: { Authorization: 'Bearer sk-OWNER-MCP' } } } } as never);

    expect(Object.keys(engine.mcpServersForHarness(engine.requireSession(o.id)))).toEqual(['owner-github']);
    expect(engine.mcpServersForHarness(engine.requireSession(s.id))).toEqual({});
    expect((await engine.harnessEnv(engine.requireSession(o.id), 'fake')).FAKE_KEY).toBe('sk-OWNER-HARNESS');
    const env = await engine.harnessEnv(engine.requireSession(s.id), 'fake');
    expect(JSON.stringify(env)).not.toContain('sk-OWNER-HARNESS');
    // what is not a secret of the hub still applies
    expect(env.FAKE_MODE).toBe('quiet');
  }, 60_000);
});

describe("the owner's own commands and agents", () => {
  function ownerFiles(t: TestEngine) {
    // the owner's ~/.claude (CLAUDE_CONFIG_DIR in tests) and a project of theirs on the hub's disk
    mkdirSync(join(t.claudeDir, 'commands'), { recursive: true });
    writeFileSync(join(t.claudeDir, 'commands', 'owner-plan.md'), '---\ndescription: mine\n---\nOWNER-PRIVATE-COMMAND $ARGUMENTS\n');
    mkdirSync(join(t.claudeDir, 'agents'), { recursive: true });
    writeFileSync(join(t.claudeDir, 'agents', 'owner-spy.md'), '---\nname: owner-spy\ndescription: the owner\'s own\n---\nOWNER-PRIVATE-AGENT prompt\n');
    mkdirSync(join(t.cwd, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(t.cwd, '.claude', 'commands', 'proj-plan.md'), 'OWNER-PROJECT-COMMAND\n');
  }

  test("are not a member's slash commands, nor her /agent", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    ownerFiles(t);
    await engine.extensions.reload();
    // the owner has them
    const o = await engine.createSession({ agent: 'coder', cwd: t.cwd } as never, OWNER_ID);
    expect((await engine.command(o.id, '/agent'))?.output).toContain('owner-spy');

    const alice = engine.people.create({ name: 'alice', settings: { providers: { mock: {} } } });
    const s = await engine.createSession({ agent: 'coder', cwd: t.cwd } as never, alice.id);
    expect((await engine.command(s.id, '/owner-plan now'))?.output).toBe('Unknown command: /owner-plan');
    expect((await engine.command(s.id, '/proj-plan'))?.output).toBe('Unknown command: /proj-plan');
    await engine.runnerFor(s.id).waitIdle();
    const said = transcript(engine, s.id) + t.requests.join('\n');
    expect(said).not.toContain('OWNER-PRIVATE-COMMAND');
    expect(said).not.toContain('OWNER-PROJECT-COMMAND');

    const agents = (await engine.command(s.id, '/agent'))?.output ?? '';
    expect(agents).toContain('coder');
    expect(agents).not.toContain('owner-spy');
    await engine.command(s.id, '/agent owner-spy');
    expect(engine.requireSession(s.id).agent).toBe('coder');
  }, 60_000);

  test("are not a member's Task subagents", async () => {
    t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'look', prompt: 'echo hello', subagent_type: 'owner-spy', model: 'fake/default' } }], [{ text: 'done' }]],
      approve: 'allow',
    });
    const { engine } = t;
    engine.config.update({ providers: { fake: FAKE } } as never);
    ownerFiles(t);
    await engine.extensions.reload();
    const alice = engine.people.create({ name: 'alice', settings: { providers: { mock: {} } } });
    const device = memberDevice(engine, alice.id);
    const s = await engine.createSession({ agent: 'coder', device, cwd: t.cwd } as never, alice.id);
    await t.run(s.id, 'use the spy');
    const task = toolResults(engine, s.id).find((r) => r.name === 'Task');
    expect(task).toBeDefined();
    // the subagent ran (on her device), with a profile that is not the owner's
    expect(task!.content).toContain('echo hello');
    expect(task!.content).not.toContain('OWNER-PRIVATE-AGENT');
    const child = engine.listSessions({ accountId: alice.id, parentId: s.id })[0];
    expect(child?.agent).not.toBe('owner-spy');
  }, 60_000);
});
