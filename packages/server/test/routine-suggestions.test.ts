/**
 * Routine suggestion routes (ECOSYSTEM.md 2.3) over the fake engine: the
 * list, Add with agent creation, and the refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { hasCodeRepos } from '../src/routes-suggestions';
import { ROUTINE_SUGGESTIONS } from '@conclave/core/scheduler/suggestions.ts';
import { startHub, OWNER, type TestHub } from './helpers';

let hub: TestHub;
let client: ConclaveClient;

beforeAll(() => {
  hub = startHub();
  client = new ConclaveClient({ baseUrl: hub.url, token: OWNER });
});

afterAll(async () => {
  await hub.stop();
});

describe('routine suggestion routes', () => {
  test('GET /api/routines/suggestions lists every suggestion with its state', async () => {
    const dto = await client.routineSuggestions();
    expect(dto.suggestions.length).toBe(ROUTINE_SUGGESTIONS.length);
    expect(dto.closed).toEqual(expect.arrayContaining(['routine-allow', 'bash-allow-safe', 'agent-tools-allow']));
    expect(dto.agents['ops-watch']).toEqual({ exists: false });
    const backup = dto.suggestions.find((s) => s.id === 'backup-check')!;
    expect(backup.added).toEqual([]);
    expect(backup.waitingOn).toEqual([]);
    expect(dto.suggestions.find((s) => s.id === 'uni-calendar-sync')!.waitingOn).toEqual(['routine-env']);
    // the route is not read as a routine id
    expect((await hub.api('/api/routines/suggestions')).status).toBe(200);
    expect((await hub.api('/api/routines/suggestions', { token: null })).status).toBe(401);
  });

  test('Add creates the missing agent, then the routine with its rules', async () => {
    // no Proxmox host on the fake hub: without a device Add asks for one
    expect((await hub.api('/api/routines/suggestions/backup-check/add', { method: 'POST', json: {} })).status).toBe(400);
    const res = await client.addRoutineSuggestion('backup-check', { devices: ['local'], enabled: false, overrides: { notify: 'on_attention' } });
    expect(res.agentCreated).toBe('ops-watch');
    expect(res.routines.length).toBe(1);
    const r = res.routines[0];
    expect(r).toMatchObject({ name: 'Backup check', agent: 'ops-watch', enabled: false, notify: 'on_attention', suggestion: 'backup-check', device: 'local' });
    expect(r.allow?.length).toBeGreaterThan(0);
    expect(hub.engine.extensions.agent('ops-watch')?.disallowedTools).toContain('Write');

    const dto = await client.routineSuggestions();
    expect(dto.agents['ops-watch']).toEqual({ exists: true });
    expect(dto.suggestions.find((s) => s.id === 'backup-check')!.added).toEqual([r.id]);
    // a second suggestion on the same agent does not create it again
    const again = await client.addRoutineSuggestion('unpushed-work', {});
    expect(again.agentCreated).toBeUndefined();
  });

  test('refusals: unknown, waiting on the hub, no folder, bad body', async () => {
    const post = (id: string, json: unknown) => hub.api(`/api/routines/suggestions/${id}/add`, { method: 'POST', json });
    expect((await post('nope', {})).status).toBe(404);
    const waiting = await post('uni-calendar-sync', {});
    expect(waiting.status).toBe(409);
    expect(((await waiting.json()) as { error: string }).error).toContain('routine-env');
    const folder = await post('docs-drift', {});
    expect(folder.status).toBe(400);
    expect(((await folder.json()) as { error: string }).error).toContain('Pick a folder');
    expect((await post('backup-check', { devices: 'local' })).status).toBe(400);
    expect((await post('backup-check', { devices: ['ghost'] })).status).toBe(400);
    expect((await post('backup-check', { overrides: { allow: ['Bash'] } })).status).toBe(400);
    expect((await post('backup-check', { enabled: 'yes' })).status).toBe(400);
    // runs as an agent this hub does not have and cannot create
    expect((await post('librarian-deep-pass', {})).status).toBe(400);
  });

  test('wrong types in the sheet edits get a sentence, and a bad schedule stops Add before the agent is made', async () => {
    const post = (id: string, json: unknown) => hub.api(`/api/routines/suggestions/${id}/add`, { method: 'POST', json });
    for (const overrides of [{ allow: 'Bash' }, { deny: 'Bash' }, { prompt: 5 }, { notify: 'loud' }]) {
      const res = await post('github-inbox', { overrides });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).not.toContain('is not a function');
    }
    const bad = await post('token-cost-review', { devices: ['local'], overrides: { schedule: 'bad' } });
    expect(bad.status).toBe(400);
    expect((await client.routineSuggestions()).agents.steward).toEqual({ exists: false });
  });
});

describe('routine routes', () => {
  test('PATCH with a schedule the hub cannot read is a 400, not a 500', async () => {
    const r = await client.createRoutine({ name: 'brief', schedule: '5 8 * * *', prompt: 'morning' });
    const res = await hub.api(`/api/routines/${r.id}`, { method: 'PATCH', json: { schedule: 'bad' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid schedule');
  });

  test('Run now and the webhook answer when the run starts, not when it ends', async () => {
    const r = await client.createRoutine({ name: 'long', schedule: '5 8 * * *', prompt: 'take a while' });
    const res = await hub.api(`/api/routines/${r.id}/trigger`, { method: 'POST', token: null, headers: { 'x-conclave-secret': 'hook-secret' }, body: 'hang' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ routineId: r.id, status: 'running', sessionId: 'ses_fake', trigger: 'webhook' });
    expect((await client.runRoutine(r.id)).status).toBe('running');
  });
});

describe('code on the hub', () => {
  test('the deep pass is offered on the hub when ~/code holds a repo, three levels down at most, as its precheck finds them', () => {
    const home = mkdtempSync(join(tmpdir(), 'conclave-home-'));
    try {
      expect(hasCodeRepos(home)).toBe(false);
      mkdirSync(join(home, 'code', 'a', 'b', 'c', '.git'), { recursive: true });
      mkdirSync(join(home, 'code', '.cache', 'x', '.git'), { recursive: true });
      expect(hasCodeRepos(home)).toBe(false);
      mkdirSync(join(home, 'code', 'org', 'app', '.git'), { recursive: true });
      expect(hasCodeRepos(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Basic Memory connected in setup', () => {
  test('routines that need it find it, because it runs as the hub basic-memory server', async () => {
    // found in a real setup: step 6 connected Basic Memory, and routines still said "Needs Basic Memory. Add it"
    const needs = async () => (await client.routineSuggestions()).suggestions.find((s) => s.id === 'cve-watch')!.missing.map((m) => m.id);
    expect(await needs()).toContain('basic-memory');
    // "Use a Basic Memory vault" with the server URL left empty
    const conn = await client.addMemoryConnection({ type: 'basic-memory', name: 'Basic Memory', mode: 'mirror', options: { project: 'main' } });
    expect(conn.options).toMatchObject({ server: 'basic-memory', project: 'main' });
    expect(hub.engine.config.get().mcpServers['basic-memory']).toEqual({ command: 'uvx', args: ['basic-memory', 'mcp'] });
    expect(await needs()).not.toContain('basic-memory');
  });
});
