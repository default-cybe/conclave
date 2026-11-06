import { describe, expect, test } from 'bun:test';
import { startTestEngine } from './harness';
import { noHarnesses, runScript } from '../workflows/helpers';
import { subagentModel } from '../../src/extensions/agent-model';
import { roleDef, rolesProblem } from '../../src/security/roles';
import { guardAnchor } from '../../src/session/scope-guard';
import { ensureHuntFolder } from '../../src/security/workspace';
import { parseScope } from '../../src/security/scope';
import { runSubagent } from '../../src/engine/subagent';
import { runDelegate } from '../../src/engine/delegate';
import { HomeMachine } from '../projects/machines';
import { cleanup, tempDir } from '../extensions/_helpers';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConclaveConfig } from '../../src/config/schema';
import type { Device } from '../../src/types';

const role = { name: 'sec-hunter', group: 'security' as const, model: 'cliproxy/claude-opus-5-5', fallback: ['zai/glm-5.3'] };

describe('Security role routing (SECURITY-MODE.md 1.4)', () => {
  const host = (roles: Record<string, { model?: string; fallback?: string[] }> = {}, bad: string[] = []) =>
    ({ config: { get: () => ({ providers: {}, security: { roles } }) as unknown as ConclaveConfig }, isUsable: (m: string) => !bad.includes(m) }) as Parameters<typeof subagentModel>[0];
  const pick = (h: ReturnType<typeof host>, opts: { named?: string; pin?: string } = {}) => {
    const d = roleDef(h, role);
    return subagentModel(h, opts.named, d.model, 'parent/model', opts.pin, d.fallback);
  };

  test('1 a model the owner names wins over the pin and the table', () => {
    expect(pick(host({ 'sec-hunter': { model: 'table/model' } }), { named: 'named/model', pin: 'pin/model' })).toBe('named/model');
  });
  test('2 the pin wins over the table', () => {
    expect(pick(host({ 'sec-hunter': { model: 'table/model' } }), { pin: 'pin/model' })).toBe('pin/model');
  });
  test('3 the table wins over the profile', () => {
    expect(pick(host({ 'sec-hunter': { model: 'table/model' } }))).toBe('table/model');
  });
  test('3 an unusable table model gives way to its own fallback, then the profile', () => {
    expect(pick(host({ 'sec-hunter': { model: 'table/model', fallback: ['tfb/model'] } }, ['table/model']))).toBe('tfb/model');
    expect(pick(host({ 'sec-hunter': { model: 'table/model' } }, ['table/model']))).toBe('cliproxy/claude-opus-5-5');
  });
  test('4 an empty row is the profile default', () => {
    expect(pick(host({ 'sec-hunter': {} }))).toBe('cliproxy/claude-opus-5-5');
    expect(pick(host())).toBe('cliproxy/claude-opus-5-5');
  });
  test('5 nothing usable is the parent model', () => {
    expect(pick(host({ 'sec-hunter': { model: 'table/model' } }, ['table/model', 'cliproxy/claude-opus-5-5', 'zai/glm-5.3']))).toBe('parent/model');
  });
  test('a member never gets the table, and only models of theirs', () => {
    const h = host({ 'sec-hunter': { model: 'table/model' } });
    expect(roleDef(h, role, (m) => m === 'zai/glm-5.3')).toMatchObject({ model: 'zai/glm-5.3', fallback: [] });
    expect(roleDef(h, role, () => false).model).toBeUndefined();
  });
  test('agents outside the security group are untouched', () => {
    const coder = { name: 'coder', model: 'fast' };
    expect(roleDef(host({ coder: { model: 'x/y' } }), coder)).toBe(coder);
  });
  test('rolesProblem checks the patch', () => {
    expect(rolesProblem({ 'sec-hunter': { model: 'zai/glm-5.3', fallback: ['cliproxy/claude-opus-5-5'] } })).toBeUndefined();
    expect(rolesProblem({ 'sec-hunter': null })).toBeUndefined();
    expect(rolesProblem({ coder: { model: 'a/b' } })).toContain('sec-*');
    expect(rolesProblem({ 'sec-hunter': { model: 'opus' } })).toContain('provider/model');
    expect(rolesProblem({ 'sec-hunter': { fallback: 'a/b' } })).toContain('list');
  });
});

describe('Security switch', () => {
  test('on loads the security agent, off restores the previous one; it persists', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    try {
      const s = await t.engine.createSession({ title: 's', cwd: t.cwd, agent: 'coder' });
      const on = t.engine.updateSession(s.id, { chat: { security: true } });
      expect(on.agent).toBe('security');
      expect(t.engine.getSession(s.id)!.chat?.security).toBe(true);
      expect(t.engine.repos.sessions.get(s.id)!.agent).toBe('security');
      // the scope guard anchors on the switch
      expect(guardAnchor(t.engine as never, t.engine.getSession(s.id)!)?.id).toBe(s.id);
      const off = t.engine.updateSession(s.id, { chat: { security: false } });
      expect(off.agent).toBe('coder');
      expect(off.chat?.security).toBeFalsy();
      expect(off.meta?.securityPrev).toBeUndefined();
    } finally { await t.close(); }
  });

  test('a chat goes back to the chat agent', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    try {
      const c = await t.engine.createSession({ kind: 'chat', cwd: t.cwd });
      const before = c.agent;
      expect(t.engine.updateSession(c.id, { chat: { security: true } }).agent).toBe('security');
      expect(t.engine.updateSession(c.id, { chat: { security: false } }).agent).toBe(before);
    } finally { await t.close(); }
  });

  test('carries to Task and Delegate children, under the same scope anchor', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3'] }, script: [[{ text: 'ok' }]], route: () => [{ text: 'DONE' }] });
    const home = tempDir('conclave-secsw-');
    try {
      const parent = await t.engine.createSession({ title: 's', cwd: t.cwd });
      t.engine.updateSession(parent.id, { chat: { security: true } });
      const r = await runSubagent(t.engine, { parentSessionId: parent.id, agent: 'general-purpose', prompt: 'x', description: 'x' });
      const child = t.engine.getSession(r.sessionId)!;
      expect(child.chat?.security).toBe(true);
      expect(t.engine.subagents(child).some((a) => a.name === 'sec-recon')).toBe(true);
      expect(guardAnchor(t.engine as never, child)?.id).toBe(parent.id);
      const m = new HomeMachine('lab', 'Lab', home);
      t.engine.repos.devices.insert({ id: m.id, name: m.name, tokenHash: 'test', roots: [] });
      t.engine.devices.attach({ ...t.engine.repos.devices.get(m.id)!, online: true, info: m.infoNow() } as Device, m);
      const d = await runDelegate(t.engine, parent.id, { to: 'code', agent: 'coder', device: 'lab', prompt: 'go', title: 'job' } as never);
      const job = t.engine.getSession(d.sessionId)!;
      expect(job.chat?.security).toBe(true);
      expect(guardAnchor(t.engine as never, job)?.id).toBe(parent.id);
    } finally { cleanup(home); await t.close(); }
  });

  test('Task: the pin overrides the Roles table, and the table overrides the profile', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3', 'glm-5.2'] }, script: [[{ text: 'ok' }]], route: () => [{ text: 'DONE' }] });
    try {
      t.engine.config.update({ security: { roles: { 'sec-recon': { model: 'zai/glm-5.2' } } } } as never);
      const parent = await t.engine.createSession({ title: 's', cwd: t.cwd });
      t.engine.updateSession(parent.id, { chat: { security: true } });
      const r = await runSubagent(t.engine, { parentSessionId: parent.id, agent: 'sec-recon', prompt: 'x', description: 'x' });
      expect(t.engine.getSession(r.sessionId)!.model).toBe('zai/glm-5.2');
      t.engine.updateSession(parent.id, { chat: { sameModel: true } });
      const p = await runSubagent(t.engine, { parentSessionId: parent.id, agent: 'sec-recon', prompt: 'x', description: 'x' });
      expect(t.engine.getSession(p.sessionId)!.model).toBe(t.engine.getSession(parent.id)!.model);
    } finally { await t.close(); }
  });

  test('workflow: a sec-* role takes the Roles table, under the pin the chat model, and a named model wins (design PR 4)', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3', 'glm-5.2'] }, script: [[{ text: 'unused' }]], route: (body) => (JSON.stringify(body).includes('WF-') ? [{ text: 'ok' }] : undefined) });
    try {
      noHarnesses(t.engine);
      t.engine.config.update({ security: { roles: { 'sec-recon': { model: 'zai/glm-5.2' } } } } as never);
      const script = `export const meta = { name: 'roles', description: 'x' }
await agent('WF-ROLE', { agentType: 'sec-recon', label: 'role' })
await agent('WF-NAMED', { agentType: 'sec-recon', model: 'zai/glm-5.3', label: 'named' })
return 'ok'`;
      const s = await t.engine.createSession({ cwd: t.cwd, permissionMode: 'bypass' });
      t.engine.updateSession(s.id, { chat: { security: true } });
      // the steps of the latest run only: the ones made since `seen`
      let seen = new Set<string>();
      const step = (label: string) => t.engine.listSessions({ parentId: s.id }).find((c) => !seen.has(c.id) && (c.meta?.workflow as { label?: string } | undefined)?.label === label)!;
      expect((await runScript(t, script, { sessionId: s.id })).status).toBe('done');
      expect(step('role').model).toBe('zai/glm-5.2');
      expect(step('named').model).toBe('zai/glm-5.3');
      t.engine.updateSession(s.id, { chat: { sameModel: true } });
      seen = new Set(t.engine.listSessions({ parentId: s.id }).map((c) => c.id));
      expect((await runScript(t, script, { sessionId: s.id })).status).toBe('done');
      expect(step('role').model).toBe(t.engine.getSession(s.id)!.model);
      expect(step('named').model).toBe('zai/glm-5.3');
    } finally { await t.close(); }
  });

  test("members cannot route to owner-only models through the Roles table", async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], extraProviders: { zai: ['glm-5.3', 'glm-5.2'] }, script: [[{ text: 'ok' }]], route: () => [{ text: 'DONE' }] });
    try {
      t.engine.config.update({ security: { roles: { 'sec-recon': { model: 'zai/glm-5.2' } } } } as never);
      const alice = t.engine.people.create({ name: 'alice' });
      const hers = await t.engine.createSession({ kind: 'chat', cwd: t.cwd }, alice.id);
      t.engine.repos.sessions.update({ ...t.engine.getSession(hers.id)!, chat: { webSearch: true, memory: true, security: true } });
      const r = await runSubagent(t.engine, { parentSessionId: hers.id, agent: 'sec-recon', prompt: 'x', description: 'x' });
      const model = t.engine.getSession(r.sessionId)!.model;
      expect(model).toBe(t.engine.getSession(hers.id)!.model);
      expect(model).not.toBe('zai/glm-5.2');
    } finally { await t.close(); }
  });

  test('the first message sets the lane; a chip change is logged', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    try {
      const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
      expect(() => t.engine.updateSession(s.id, { lane: 'web' })).toThrow('Security on');
      t.engine.updateSession(s.id, { chat: { security: true } });
      await t.engine.send(s.id, { text: 'CVE-2025-1234 in https://github.com/acme/lib' });
      expect(t.engine.getSession(s.id)!.meta?.lane).toEqual({ lane: 'variant', detected: ['variant', 'source'] });
      t.engine.updateSession(s.id, { lane: 'source' });
      expect(t.engine.getSession(s.id)!.meta?.lane).toEqual({ lane: 'source', detected: ['variant', 'source'], by: 'owner' });
      const log = t.engine.listAudit({ sessionId: s.id }).filter((a) => a.action === 'security.lane');
      expect(log).toHaveLength(2);
      expect(() => t.engine.updateSession(s.id, { lane: 'nope' as never })).toThrow('lane must be');
    } finally { await t.close(); }
  });

  test('the Security start mode makes the hunt folder, keeping what exists', async () => {
    const t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'ok' }]] });
    const dir = tempDir('conclave-hunt-');
    try {
      const cwd = join(dir, 'acme');
      const s = await t.engine.createSession({ title: 'hunt', cwd, chat: { security: true } });
      expect(s.agent).toBe('security');
      expect(parseScope(readFileSync(join(cwd, 'scope.yaml'), 'utf8')).inScope).toEqual([]);
      expect(existsSync(join(cwd, 'targets')) && existsSync(join(cwd, 'playbook'))).toBe(true);
      // a second run makes nothing and keeps an edited scope
      const other = join(dir, 'kept');
      mkdirSync(other);
      writeFileSync(join(other, 'scope.yaml'), 'program: kept\nin_scope: [app.example.com]\n');
      const local = new HomeMachine('local', 'Hub', dir);
      const made = await ensureHuntFolder(local, other);
      expect(made).toEqual(['targets/', 'playbook/']);
      expect(readFileSync(join(other, 'scope.yaml'), 'utf8')).toContain('app.example.com');
      expect(await ensureHuntFolder(local, other)).toEqual([]);
    } finally { cleanup(dir); await t.close(); }
  });
});
