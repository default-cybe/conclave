import { describe, expect, test } from 'bun:test';
import { startTestEngine } from './harness';
import { markModelDead, subagentModel } from '../../src/extensions/agent-model';
import { builtinSkills } from '../../src/extensions/builtin-skills';
import { parseAgentMarkdown } from '../../src/extensions/builtin-agents';
import { runSubagent } from '../../src/engine/subagent';
import { runDelegate } from '../../src/engine/delegate';
import { HomeMachine } from '../projects/machines';
import { cleanup, tempDir } from '../extensions/_helpers';
import { memberCanUse } from '../../src/session/member-fallbacks';
import type { Device } from '../../src/types';
import type { Tool } from '../../src/tools/types';

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' } as never, readOnly: true, run: async () => ({ content: '' }) });

describe('Security roster', () => {
  test('group and fallback survive frontmatter parsing', () => {
    const def = parseAgentMarkdown('sec-example', '---\nname: sec-example\ndescription: Test role\nsubagent: true\ngroup: security\nmodel: zai/glm-5.3\nfallback: [cliproxy/claude-opus-5-5]\n---\nRole');
    expect(def.group).toBe('security');
    expect(def.fallback).toEqual(['cliproxy/claude-opus-5-5']);
  });

  test('Task only offers sec-* roles in a chat with Security on', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    try {
      const session = await t.engine.createSession({ title: 's', cwd: t.cwd, kind: 'chat' });
      const names = () => t.engine.subagents(t.engine.getSession(session.id)!).map((a) => a.name);
      expect(names()).not.toContain('sec-recon');
      expect(names()).toContain('general-purpose');
      await t.engine.updateSession(session.id, { chat: { security: true } });
      expect(names().filter((n) => n.startsWith('sec-'))).toHaveLength(9);
      await t.engine.updateSession(session.id, { chat: { security: false } });
      expect(names()).not.toContain('sec-recon');
    } finally { await t.close(); }
  });

  test('unusable or dead profile model picks fallback then parent', () => {
    const host = { config: { get: () => ({ providers: {} }) }, isUsable: (m: string) => m !== 'bad/model' } as Parameters<typeof subagentModel>[0];
    expect(subagentModel(host, undefined, 'bad/model', 'parent/model', undefined, ['good/model'])).toBe('good/model');
    markModelDead(host, 'good/model');
    expect(subagentModel(host, undefined, 'bad/model', 'parent/model', undefined, ['good/model'])).toBe('parent/model');
    // a pin wins over the role's list
    expect(subagentModel(host, undefined, 'bad/model', 'parent/model', 'pin/model', ['good/model'])).toBe('pin/model');
  });

  test('Task and Delegate refuse a sec-* role outside a security chat', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3'] }, script: [[{ text: 'ok' }]], route: () => [{ text: 'BRIEF-DONE' }] });
    try {
      const chat = await t.engine.createSession({ title: 's', cwd: t.cwd, kind: 'chat' });
      await expect(runSubagent(t.engine, { parentSessionId: chat.id, agent: 'sec-recon', prompt: 'map it', description: 'recon' })).rejects.toThrow('runs only in a security chat');
      const home = tempDir('conclave-sec-');
      try {
        const m = new HomeMachine('lab', 'Lab', home);
        t.engine.repos.devices.insert({ id: m.id, name: m.name, tokenHash: 'test', roots: [] });
        t.engine.devices.attach({ ...t.engine.repos.devices.get(m.id)!, online: true, info: m.infoNow() } as Device, m);
        await expect(runDelegate(t.engine, chat.id, { to: 'code', agent: 'sec-validator', device: 'lab', prompt: 'run it', title: 'validate' } as never)).rejects.toThrow('runs only in a security chat');
        await t.engine.updateSession(chat.id, { chat: { security: true } });
        // Delegate walks the role's fallback list too: Opus answered 404, so the hunter runs on GLM
        markModelDead(t.engine, 'cliproxy/claude-opus-5-5');
        const d = await runDelegate(t.engine, chat.id, { to: 'code', agent: 'sec-hunter', device: 'lab', prompt: 'hunt', title: 'hunt' } as never);
        expect(t.engine.getSession(d.sessionId)!.model).toBe('zai/glm-5.3');
      } finally { cleanup(home); }
      const r = await runSubagent(t.engine, { parentSessionId: chat.id, agent: 'sec-recon', prompt: 'map it', description: 'recon' });
      expect(r.text).toContain('BRIEF-DONE');
      expect(t.engine.getSession(r.sessionId)!.model).toBe('zai/glm-5.3');
    } finally { await t.close(); }
  });

  test("a member's role runs on the member's chat model, never a role model their account may not use", async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3'] }, script: [[{ text: 'ok' }]], route: () => [{ text: 'DONE' }] });
    try {
      const alice = t.engine.people.create({ name: 'alice' });
      // the owner's zai key: usable by the owner, not by alice
      expect(t.engine.isUsable('zai/glm-5.3')).toBe(true);
      expect(memberCanUse(t.engine, alice.id, 'zai/glm-5.3')).toBe(false);
      const hers = await t.engine.createSession({ kind: 'chat', cwd: t.cwd }, alice.id);
      t.engine.repos.sessions.update({ ...t.engine.getSession(hers.id)!, chat: { webSearch: true, memory: true, security: true } });
      const r = await runSubagent(t.engine, { parentSessionId: hers.id, agent: 'sec-recon', prompt: 'map it', description: 'recon' });
      expect(t.engine.getSession(r.sessionId)!.agent).toBe('sec-recon');
      expect(t.engine.getSession(r.sessionId)!.model).toBe(t.engine.getSession(hers.id)!.model);
      expect(t.engine.getSession(r.sessionId)!.model).not.toBe('zai/glm-5.3');
    } finally { await t.close(); }
  });

  test('each role gets only its designed MCP tools', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    try {
      const mcp = [
        ...['list_requests', 'get_request', 'get_sitemap', 'list_findings', 'send_request', 'edit_request', 'diff_responses', 'race_window_send'].map((n) => `mcp__caido__caido_${n}`),
        'mcp__semgrep__semgrep_scan', 'mcp__semgrep__semgrep_findings',
        'mcp__rea__batch_decompile', 'mcp__rea__inspect_web_page', 'mcp__rea__capture_browser_scenario', 'mcp__rea__start_gdb_session',
        'mcp__playwright__browser_navigate', 'mcp__playwright__browser_run_code_unsafe', 'mcp__github__search_code',
      ];
      (t.engine as unknown as { mcpCache: unknown }).mcpCache = { tools: mcp.map(tool), at: Date.now() };
      const s = t.engine.getSession((await t.engine.createSession({ title: 's', cwd: t.cwd })).id)!;
      const tools = (name: string) => t.engine.toolsFor(s, t.engine.agentNamed(name, t.cwd, 'owner')!, 'default', 1).map((x) => x.name);
      const web = ['WebFetch', 'WebSearch'];
      expect(tools('sec-recon')).toEqual(expect.arrayContaining(['mcp__semgrep__semgrep_scan', 'mcp__caido__caido_list_requests', 'mcp__caido__caido_get_sitemap', 'mcp__rea__batch_decompile']));
      for (const bad of ['mcp__caido__caido_send_request', 'mcp__caido__caido_edit_request', 'mcp__caido__caido_race_window_send', 'mcp__semgrep__semgrep_findings', 'mcp__rea__inspect_web_page', 'mcp__rea__capture_browser_scenario', 'mcp__rea__start_gdb_session', ...web]) expect(tools('sec-recon')).not.toContain(bad);
      expect(tools('sec-hunter')).toContain('mcp__semgrep__semgrep_scan');
      // read-only roles reach no network: no web tools, no proxy sends, no browser
      for (const role of ['sec-hunter', 'sec-refuter', 'sec-chainer', 'sec-reporter']) {
        const got = tools(role);
        for (const n of [...web, 'mcp__caido__caido_send_request', 'mcp__rea__inspect_web_page', 'mcp__playwright__browser_navigate', 'mcp__github__search_code']) expect(got).not.toContain(n);
        expect(got.filter((n) => n.startsWith('mcp__') && !n.startsWith('mcp__semgrep__semgrep_scan'))).toEqual([]);
      }
      expect(tools('sec-validator')).toEqual(expect.arrayContaining(['mcp__caido__caido_send_request', 'mcp__caido__caido_diff_responses', 'mcp__playwright__browser_navigate']));
      for (const bad of ['mcp__playwright__browser_run_code_unsafe', 'mcp__caido__caido_race_window_send', ...web]) expect(tools('sec-validator')).not.toContain(bad);
      expect(tools('sec-exploiter')).toEqual(expect.arrayContaining(['mcp__rea__batch_decompile', 'mcp__rea__start_gdb_session']));
      for (const bad of ['mcp__rea__inspect_web_page', 'mcp__rea__capture_browser_scenario', 'mcp__caido__caido_send_request', ...web]) expect(tools('sec-exploiter')).not.toContain(bad);
      for (const role of ['sec-fuzzer', 'sec-patcher']) expect(tools(role).filter((n) => n.startsWith('mcp__') || web.includes(n))).toEqual([]);
    } finally { await t.close(); }
  });

  test('hunt skills list only in prompts of agents that name them', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    try {
      const sec = t.engine.agentNamed('security', t.cwd, 'owner')!;
      expect(sec.skills).toHaveLength(11);
      expect(sec.description).toContain('Confirms scope');
      const prompt = async (agent: string) => {
        const s = t.engine.getSession((await t.engine.createSession({ title: 's', cwd: t.cwd, agent })).id)!;
        return JSON.stringify(await t.engine.systemPromptFor(s, t.engine.agentNamed(agent, t.cwd, 'owner')!, 'mock/claude-sonnet-5-5', 'agent', ['Skill']));
      };
      expect(await prompt('coder')).not.toContain('cve-violation-hunt');
      expect(await prompt('security')).toContain('cve-violation-hunt');
    } finally { await t.close(); }
  });

  test('all shipped hunt skills say in-scope and authorised', () => {
    const skills = builtinSkills().filter((s) => s.name !== 'web-studio');
    expect(skills).toHaveLength(11);
    for (const skill of skills) {
      expect(skill.body).toMatch(/authorised testing of in-scope assets only/i);
      // no pipe-to-shell installers and nothing that looks like a key or token
      expect(skill.body).not.toMatch(/\b(curl|wget|iwr|irm)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\biex\b/i);
      expect(skill.body).not.toMatch(/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/);
    }
  });
});
