/**
 * Each account's own agents, skills, commands, workflows and learned skills
 * (docs/design/ACCOUNTS.md 2). A real engine and server with the owner and
 * two members, alice and bob. Alice's live under <home>/accounts/<alice>/;
 * bob and the owner never see them, and the owner's lists stay as they were.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import { EngineToolHost } from '@conclave/core/engine/host.ts';
import { runCommand } from '@conclave/core/engine/commands.ts';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-skills-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

let root: string;
let home: string;
let engine: Engine;
let running: RunningServer;
let base: string;
const tok: Record<string, string> = { owner: OWNER };
const id: Record<string, string> = { owner: 'owner' };

async function call(token: string, method: string, path: string, json?: unknown): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text };
}

const names = (list: Array<{ name?: string; id?: string }>) => list.map((x) => x.name ?? x.id);

beforeAll(async () => {
  process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';
  root = mkdtempSync(join(tmpdir(), 'conclave-people-skills-'));
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  home = join(root, 'home');
  engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'mock/claude-sonnet-5-5',
      smallModel: 'mock/claude-sonnet-5-5',
      providers: { mock: { type: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['claude-sonnet-5-5'] } },
    } as never,
  });
  engine.config.update({ server: { ...engine.config.get().server, token: OWNER } });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
  base = running.url;
  for (const name of ['alice', 'bob']) {
    const made = await call(OWNER, 'POST', '/api/people', { name, password: PASSWORD, providers: { mock: { monthlyUsd: 50 } } });
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: name, password: PASSWORD, name: `${name} laptop`, platform: 'web' }) }).then((r) => r.json() as Promise<{ token: string }>);
    tok[name] = login.token;
    id[name] = made.body.person.id;
  }
}, 60_000);

afterAll(async () => {
  await running?.stop();
  await engine?.shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('per-account extensions', () => {
  test('alice writes only under accounts/<alice>/, and only she sees her things', async () => {
    const configBefore = readFileSync(join(home, 'config.json'), 'utf8');
    const ownerSkillsBefore = existsSync(join(home, 'skills')) ? readdirSync(join(home, 'skills')) : [];
    const ownerBefore = { agents: names((await call(OWNER, 'GET', '/api/agents')).body), skills: names((await call(OWNER, 'GET', '/api/skills')).body), workflows: names((await call(OWNER, 'GET', '/api/workflows')).body) };
    const aliceHome = join(home, 'accounts', id.alice);

    // a learned skill through SkillManage's host, from alice's session
    const s = await call(tok.alice, 'POST', '/api/sessions', { title: 'alice chat', kind: 'chat' });
    expect(s.status).toBeLessThan(300);
    const host = new EngineToolHost(engine, engine.runnerFor(s.body.id));
    host.learnedSkills.create({ name: 'alice-zq-skill', description: 'Alice method for her own tasks, use when asked.', body: '## Steps\n\n1. do it' });
    expect(existsSync(join(aliceHome, 'learned-skills', 'alice-zq-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'learned-skills', 'alice-zq-skill'))).toBe(false);

    // an agent through the API
    const put = await call(tok.alice, 'PUT', '/api/agents/alice-zq-agent', { description: 'Alice agent', prompt: 'You help alice.' });
    expect(put.status).toBe(200);
    expect(existsSync(join(aliceHome, 'agents', 'alice-zq-agent.md'))).toBe(true);
    expect(existsSync(join(home, 'agents', 'alice-zq-agent.md'))).toBe(false);

    // a workflow and a command placed in her folder
    mkdirSync(join(aliceHome, 'workflows'), { recursive: true });
    writeFileSync(join(aliceHome, 'workflows', 'alice-zq-flow.js'), "export const meta = { name: 'alice-zq-flow', description: 'Alice flow', phases: [{ title: 'Work' }] };\nphase('Work');\nreturn 1;");
    mkdirSync(join(aliceHome, 'commands'), { recursive: true });
    writeFileSync(join(aliceHome, 'commands', 'alice-zq-cmd.md'), '---\ndescription: runs a shell line\n---\nToday: !`date`');
    await engine.extensions.reload();

    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(configBefore);
    expect(existsSync(join(home, 'skills')) ? readdirSync(join(home, 'skills')) : []).toEqual(ownerSkillsBefore);

    // alice sees builtin plus her own
    const aAgents = (await call(tok.alice, 'GET', '/api/agents')).body as Array<{ name: string; source: string }>;
    expect(aAgents.some((a) => a.name === 'alice-zq-agent' && a.source === 'account')).toBe(true);
    expect(aAgents.some((a) => a.source === 'builtin')).toBe(true);
    expect(aAgents.every((a) => ['builtin', 'plugin', 'account'].includes(a.source))).toBe(true);
    const aSkills = (await call(tok.alice, 'GET', '/api/skills')).body as Array<{ name: string; source: string }>;
    expect(aSkills.some((k) => k.name === 'alice-zq-skill' && k.source === 'account')).toBe(true);
    expect(aSkills.some((k) => k.source === 'builtin')).toBe(true);
    expect(names((await call(tok.alice, 'GET', '/api/commands')).body)).toContain('alice-zq-cmd');
    expect(names((await call(tok.alice, 'GET', '/api/workflows')).body)).toContain('alice-zq-flow');
    expect((await call(tok.alice, 'GET', '/api/workflows/alice-zq-flow')).status).toBe(200);
    expect(names((await call(tok.alice, 'GET', '/api/skills/learned')).body)).toEqual(['alice-zq-skill']);
    expect((await host.listSkills()).some((k) => k.name === 'alice-zq-skill')).toBe(true);
    expect((await host.loadSkill('alice-zq-skill'))?.body).toContain('do it');

    // bob and the owner see none of it, and her names are 404 to them
    for (const w of ['bob', 'owner']) {
      const t = tok[w];
      for (const path of ['/api/agents', '/api/skills', '/api/commands', '/api/workflows', '/api/skills/learned']) expect((await call(t, 'GET', path)).text).not.toContain('alice-zq');
      expect((await call(t, 'GET', '/api/workflows/alice-zq-flow')).status).toBe(404);
      expect((await call(t, 'GET', '/api/skills/learned/alice-zq-skill')).status).toBe(404);
      expect((await call(t, 'DELETE', '/api/skills/learned/alice-zq-skill')).status).toBe(404);
    }
    expect((await call(tok.bob, 'DELETE', '/api/agents/alice-zq-agent')).status).toBe(404);
    expect(existsSync(join(aliceHome, 'agents', 'alice-zq-agent.md'))).toBe(true);
    const bobSession = await call(tok.bob, 'POST', '/api/sessions', { title: 'bob chat', kind: 'chat' });
    const bobHost = new EngineToolHost(engine, engine.runnerFor(bobSession.body.id));
    expect(await bobHost.loadSkill('alice-zq-skill')).toBeUndefined();
    expect(bobHost.learnedSkills.list()).toEqual([]);
    expect((await runCommand(engine, bobSession.body.id, '/alice-zq-cmd')).output).toContain('Unknown command');
    expect((await call(tok.bob, 'POST', '/api/sessions', { title: 'x', kind: 'chat', agent: 'alice-zq-agent' })).status).toBe(404);

    // the owner's lists are unchanged
    expect({ agents: names((await call(OWNER, 'GET', '/api/agents')).body), skills: names((await call(OWNER, 'GET', '/api/skills')).body), workflows: names((await call(OWNER, 'GET', '/api/workflows')).body) }).toEqual(ownerBefore);

    // alice's own shell-line command is refused, and nothing runs
    const out = await runCommand(engine, s.body.id, '/alice-zq-cmd');
    expect(out.output).toContain('did not run');
    expect(out.output).toContain('shell lines');
  });
});
