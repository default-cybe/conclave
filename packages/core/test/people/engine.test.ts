/**
 * Accounts on a real engine (docs/design/ACCOUNTS.md): recall, extraction,
 * memory and past-chat search stay inside the account; a member's tools
 * never run on the hub's computer; the hub's keys work for a member only
 * where the owner allows, and stop at the monthly budget; Conclave's own
 * MCP tools see the caller's account only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults, until, type TestEngine } from '../engine/harness';
import { HUB_REFUSED } from '../../src/people/guard';
import { callHubTool, hubMcpApiFor } from '../../src/engine/hub-mcp';
import { OWNER_ID, runAs } from '../../src/people/context';
import { projectsOf } from '../../src/projects/attached';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const MEMORY = { memory: { enabled: true, autoExtract: true, autoInject: true, injectLimit: 5 } };
const transcript = (engine: TestEngine['engine'], id: string) => JSON.stringify(engine.getMessages(id));

describe('memory stays inside the account', () => {
  test('recall, extraction, MemorySearch and SessionSearch never cross accounts', async () => {
    t = await startTestEngine({
      script: [[{ text: 'ok' }]],
      overrides: MEMORY as never,
      // a turn that asks for a search calls the tool, then answers
      route: (body, text) => {
        const done = text.includes('tool_result');
        if (text.includes('SEARCH-MEMORY')) return done ? [{ text: 'searched' }] : [{ tool: 'MemorySearch', input: { query: 'flowerpot' } }];
        if (text.includes('SEARCH-CHATS')) return done ? [{ text: 'searched' }] : [{ tool: 'SessionSearch', input: { query: 'flowerpot' } }];
        return undefined;
      },
      // extraction from alice's chat learns one fact; from any other chat, nothing
      chore: (body, text) => {
        if (!text.includes('long-term memory')) return undefined;
        const add = text.includes('What do I study') ? [{ content: 'Alice keeps bees on the roof garden', kind: 'fact' }] : [];
        return [{ text: JSON.stringify({ add, update: [] }) }];
      },
    });
    const { engine } = t;
    await engine.memory.save({ content: 'The spare key sits under the blue flowerpot by the door', kind: 'fact' } as never);
    await engine.memory.save({ content: 'The owner is called Kaivo', kind: 'profile' } as never);
    const alice = engine.people.create({ name: 'alice', settings: { providers: { mock: {} } } });
    await engine.memoryFor(alice.id).save({ content: 'Alice studies marine biology in Kiel', kind: 'profile' } as never);

    // the owner's chat mentions the flowerpot, so a chat search could find it
    const own = await engine.createSession({ kind: 'chat', cwd: t.cwd } as never, OWNER_ID);
    await t.run(own.id, 'Remind me: where is the spare key? Under the blue flowerpot?');
    const ownerRequest = t.requests[t.requests.length - 1];
    expect(ownerRequest).toContain('flowerpot');
    expect(ownerRequest).toContain('Kaivo');
    expect(ownerRequest).not.toContain('marine biology');

    const s = await engine.createSession({ kind: 'chat', cwd: t.cwd } as never, alice.id);
    expect(engine.requireSession(s.id).accountId).toBe(alice.id);
    const from = t.requests.length;
    await t.run(s.id, 'Where is the spare key? What do I study?');
    const req = t.requests.slice(from).join('\n');
    expect(req).toContain('marine biology');
    expect(req).not.toContain('flowerpot');
    expect(req).not.toContain('Kaivo');

    // extraction writes to alice's memory, and its prompt holds none of the owner's
    expect(await until(() => engine.memoryFor(alice.id).list({ limit: 50 }).some((m) => m.content.includes('bees')))).toBe(true);
    expect(engine.memory.list({ limit: 50 }).some((m) => m.content.includes('bees'))).toBe(false);
    for (const c of t.chores.filter((c) => c.includes('Alice') || c.includes('What do I study'))) {
      expect(c).not.toContain('flowerpot');
      expect(c).not.toContain('Kaivo');
    }

    // the tools search alice's memory and chats only
    const search = await engine.createSession({ kind: 'chat', cwd: t.cwd } as never, alice.id);
    await t.run(search.id, 'SEARCH-MEMORY please');
    const chats = await engine.createSession({ kind: 'chat', cwd: t.cwd } as never, alice.id);
    await t.run(chats.id, 'SEARCH-CHATS please');
    const results = [...toolResults(engine, search.id), ...toolResults(engine, chats.id)];
    expect(results.map((r) => r.name).sort()).toEqual(['MemorySearch', 'SessionSearch']);
    // (the query word comes back in "No memories match"; the owner's note and chat do not)
    for (const r of results) {
      expect(r.content).not.toContain('by the door');
      expect(r.content).not.toContain('Remind me');
      expect(r.content).not.toContain(own.id);
    }

    // so does Conclave's MCP endpoint for a token of alice's
    const api = hubMcpApiFor(engine, alice.id);
    expect(await callHubTool(api, 'memory_search', { query: 'flowerpot' })).toBe('No memories matched.');
    expect(await callHubTool(api, 'memory_context', {})).toContain('marine biology');
    expect(await callHubTool(api, 'memory_context', {})).not.toContain('Kaivo');
    expect(await callHubTool(api, 'sessions_search', { query: 'flowerpot' })).toBe('No sessions matched.');
    expect(await callHubTool(hubMcpApiFor(engine, OWNER_ID), 'sessions_search', { query: 'flowerpot' })).toContain(own.id);
    await callHubTool(api, 'memory_save', { content: 'Alice cycles to work' });
    expect(engine.memory.list({ limit: 50 }).some((m) => m.content.includes('cycles'))).toBe(false);
    expect(engine.memoryFor(alice.id).list({ limit: 50 }).some((m) => m.content.includes('cycles'))).toBe(true);
    // the owner's search for a word of alice's finds nothing
    expect(await engine.memory.search('marine biology', { limit: 5 })).toEqual([]);
  }, 60_000);
});

describe("a member's tools on the hub", () => {
  test('are refused, and nothing runs', async () => {
    const marker = join('/tmp', `conclave-member-ran-${process.pid}-${Date.now()}`);
    t = await startTestEngine({
      script: [[{ tool: 'Bash', input: { command: `echo ran > ${marker}` } }, { tool: 'Read', input: { file_path: '/etc/hostname' } }], [{ text: 'done' }]],
      approve: 'allow',
    });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice', settings: { providers: { mock: {} } } });
    const s = await engine.createSession({ agent: 'coder' } as never, alice.id);
    // a member's session on the hub starts in their own place, never in the owner's folders
    expect(engine.requireSession(s.id).device).toBe('local');
    await t.run(s.id, 'run it');
    const results = toolResults(engine, s.id);
    expect(results.map((r) => r.name)).toEqual(['Bash', 'Read']);
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain(HUB_REFUSED);
    }
    expect(existsSync(marker)).toBe(false);
    // no approval was even asked: there is nothing to approve
    expect(t.approvals).toEqual([]);
  }, 30_000);

  test('leave no diff and no missing folder: the session page shows neither a refusal nor "~ is not on the hub"', async () => {
    // found in a real run: a member's session page got a 403 for its diff and the line "~ is not on homelab"
    t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice', settings: { providers: { mock: {} } } });
    const s = await engine.createSession({ agent: 'coder' } as never, alice.id);
    const svc = projectsOf(engine);
    expect(svc).toBeDefined();
    await runAs(alice.id, async () => {
      expect(await engine.diff(s.id)).toEqual({ diff: '', files: [] });
      expect((await svc!.location(s.id)).state).toBe('ok');
      // the machine itself still refuses
      await expect(engine.machineFor(engine.requireSession(s.id)).stat('/')).rejects.toThrow(HUB_REFUSED);
    });
  }, 30_000);
});

describe("the hub's keys", () => {
  test('need the owner’s allowance, and stop at the monthly budget', async () => {
    t = await startTestEngine({
      script: [[{ text: 'ok' }]],
      // $100 per million tokens: one scripted turn costs about a tenth of a cent
      modelOverrides: { 'claude-sonnet-5-5': { inputPrice: 100, outputPrice: 100 } } as never,
    });
    const { engine } = t;
    const bob = engine.people.create({ name: 'bob' });
    const s = await engine.createSession({ kind: 'chat' } as never, bob.id);
    let from = t.requests.length;
    await t.run(s.id, 'hello');
    expect(t.requests.length).toBe(from);
    expect(engine.requireSession(s.id).status).toBe('error');
    expect(transcript(engine, s.id)).toContain("You can't use");

    // allowed with a budget: the first turn runs and is paid by the hub
    const carol = engine.people.create({ name: 'carol', settings: { providers: { mock: { monthlyUsd: 0.0005 } } } });
    // named already: a call in flight holds its estimate (budget-parallel.test.ts), so a title call started
    // first would hold more than this tiny budget and the turn would wait for it
    const c = await engine.createSession({ kind: 'chat', title: 'Budget' } as never, carol.id);
    from = t.requests.length;
    await t.run(c.id, 'hello');
    expect(t.requests.length).toBe(from + 1);
    const spent = engine.access.spent(carol.id, 'mock');
    expect(spent).toBeGreaterThan(0.0005);
    const rows = engine.repos.db.query('SELECT paid_by, account_id FROM usage WHERE session_id = ?').all(c.id) as Array<{ paid_by: string; account_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ paid_by: 'hub', account_id: carol.id });

    // over the budget: refused before anything reaches the model
    from = t.requests.length;
    const chores = t.chores.length;
    await t.run(c.id, 'again');
    expect(t.requests.length).toBe(from);
    expect(t.chores.length).toBe(chores);
    expect(transcript(engine, c.id)).toContain('monthly budget');
    expect(engine.access.info(carol.id, 'mock')).toMatchObject({ source: 'hub', hubAllowed: true, monthlyUsd: 0.0005 });

    // a key of her own: her calls use it, and the hub's budget no longer applies
    engine.accountSecrets.set(carol.id, 'providers', 'mock', 'sk-carol-own');
    expect(engine.access.source(carol.id, 'mock')).toBe('own');
    from = t.requests.length;
    await t.run(c.id, 'with my key');
    expect(t.requests.length).toBe(from + 1);
    const last = engine.repos.db.query('SELECT paid_by FROM usage WHERE session_id = ? ORDER BY ts DESC LIMIT 1').get(c.id) as { paid_by: string };
    expect(last.paid_by).toBe('own');
    expect(engine.access.spent(carol.id, 'mock')).toBeCloseTo(spent, 6);

    // the owner is never limited
    const o = await engine.createSession({ kind: 'chat' } as never, OWNER_ID);
    from = t.requests.length;
    await t.run(o.id, 'hello');
    expect(t.requests.length).toBe(from + 1);
  }, 60_000);
});
