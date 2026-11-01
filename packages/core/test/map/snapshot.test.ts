/**
 * The Map snapshot (src/map/snapshot.ts): the live map from session status
 * and the engine's open asks, and a replay rebuilt from stored rows.
 *
 *   bun test packages/core/test/map
 */
import { describe, expect, test } from 'bun:test';
import { buildMapSnapshot, dayStart, MAP_MAX_NODES } from '../../src/map/snapshot';
import { toolTarget, toolsFromRows } from '../../src/map/tools';
import type { MapNode } from '../../src/client/map';
import { HOUR, MIN, hub } from './fixture';

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);

/** A busy afternoon: a chat, a coding session with a subagent, one waiting, one failed, one paused, a project on the Mac and a workflow. */
function busy() {
  const h = hub(NOW);
  const project = h.projects.create('fernway-web', { gitRoots: ['abc'], remotes: [], shallow: false });

  h.session({ id: 'ses_chat', kind: 'chat', agent: 'chat', title: 'Plan the week', createdAt: NOW - 3 * HOUR, updatedAt: NOW - 2 * HOUR });
  h.message('ses_chat', 'user', NOW - 3 * HOUR, [{ type: 'text', text: 'plan' }]);
  h.message('ses_chat', 'assistant', NOW - 3 * HOUR + 5_000, [{ type: 'text', text: 'here' }]);
  h.turn('ses_chat', NOW - 3 * HOUR, NOW - 3 * HOUR + 6_000);
  h.usage('ses_chat', NOW - 3 * HOUR + 6_000, 1_200, 300, 0.01);

  // running, with Bash still open
  h.session({ id: 'ses_fix', title: 'Fix login redirect', status: 'running', device: 'mac', cwd: '/Users/sam/code/fernway-web', projectId: project.id, createdAt: NOW - 20 * MIN, updatedAt: NOW - 5_000 });
  h.message('ses_fix', 'user', NOW - 20 * MIN, [{ type: 'text', text: 'fix it' }]);
  h.turn('ses_fix', NOW - 20 * MIN);
  h.tool('ses_fix', NOW - 18 * MIN, 'Read', { file_path: '/Users/sam/code/fernway-web/src/auth/redirect.ts' }, 1_200);
  h.tool('ses_fix', NOW - 15 * MIN, 'Edit', { file_path: '/Users/sam/code/fernway-web/src/auth/redirect.ts', old_string: 'a', new_string: 'b' }, 140);
  h.tool('ses_fix', NOW - 30_000, 'Bash', { command: 'bun test src/auth\n# second line' });
  h.usage('ses_fix', NOW - 15 * MIN, 9_000, 400, 0.05, 20_000, 3_000);
  h.usage('ses_fix', NOW - 20_000, 9_400, 900, 0.06, 22_000, 0);

  // its subagent, finished
  h.session({ id: 'ses_explore', title: 'Find JWT usages', agent: 'explore', parentId: 'ses_fix', device: 'mac', cwd: '/Users/sam/code/fernway-web', createdAt: NOW - 17 * MIN, updatedAt: NOW - 16 * MIN });
  h.tool('ses_explore', NOW - 17 * MIN, 'Grep', { pattern: 'jwtVerify' }, 300);
  h.message('ses_explore', 'assistant', NOW - 16 * MIN, [{ type: 'text', text: 'found 3' }]);
  h.usage('ses_explore', NOW - 16 * MIN, 3_000, 200, 0.004);

  // waiting on an approval
  h.session({ id: 'ses_push', title: 'Push the login fix', status: 'waiting_approval', device: 'mac', cwd: '/Users/sam/code/fernway-web', projectId: project.id, createdAt: NOW - 10 * MIN, updatedAt: NOW - 9 * MIN });
  h.turn('ses_push', NOW - 10 * MIN);
  h.tool('ses_push', NOW - 9 * MIN, 'Bash', { command: 'git push origin fix/login' });
  h.repos.approvals.requested({ id: 'ap_1', sessionId: 'ses_push', tool: 'Bash', requestedAt: NOW - 9 * MIN });

  // failed, and paused on a limit, on the hub itself
  h.session({ id: 'ses_nmap', title: 'Parse nmap XML', status: 'error', error: 'Connection refused', cwd: '/home/sam/code/scantools', createdAt: NOW - 2 * HOUR, updatedAt: NOW - 100 * MIN });
  h.turn('ses_nmap', NOW - 2 * HOUR, NOW - 100 * MIN, 'error');
  h.message('ses_nmap', 'user', NOW - 2 * HOUR, [{ type: 'text', text: 'parse' }]);
  h.session({ id: 'ses_arch', title: 'Suspend after kernel 6.17', status: 'waiting_reset', resumeAt: NOW + 80 * MIN, cwd: '/home/sam', createdAt: NOW - 3 * HOUR, updatedAt: NOW - 40 * MIN });
  h.message('ses_arch', 'user', NOW - 3 * HOUR, [{ type: 'text', text: 'why' }]);

  // a workflow started from the API: its host session stays off the map, its agents hang off the run
  h.session({ id: 'ses_host', title: 'Workflow: review-login-fix', tags: ['workflow'], device: 'mac', cwd: '/Users/sam/code/fernway-web', projectId: project.id, createdAt: NOW - 8 * MIN, updatedAt: NOW - 8 * MIN });
  h.run({ id: 'wfr_1', name: 'review-login-fix', sessionId: 'ses_host', host: true, status: 'running', device: 'mac', cwd: '/Users/sam/code/fernway-web', createdAt: NOW - 8 * MIN });
  h.session({ id: 'ses_a1', title: 'open redirect', parentId: 'ses_host', status: 'idle', device: 'mac', cwd: '/Users/sam/code/fernway-web', createdAt: NOW - 8 * MIN, updatedAt: NOW - 6 * MIN });
  h.call({ runId: 'wfr_1', seq: 1, label: 'open redirect', child: 'ses_a1', state: 'done', startedAt: NOW - 8 * MIN, finishedAt: NOW - 6 * MIN, agentType: 'reviewer' });
  h.message('ses_a1', 'assistant', NOW - 6 * MIN, [{ type: 'text', text: 'no issue' }]);
  h.usage('ses_a1', NOW - 6 * MIN, 5_000, 600, 0.02);
  h.session({ id: 'ses_a2', title: 'prove with tests', parentId: 'ses_host', status: 'running', device: 'mac', cwd: '/Users/sam/code/fernway-web', createdAt: NOW - 5 * MIN, updatedAt: NOW - 10_000 });
  h.call({ runId: 'wfr_1', seq: 2, label: 'prove with tests', child: 'ses_a2', state: 'running', startedAt: NOW - 5 * MIN });
  h.tool('ses_a2', NOW - 20_000, 'Write', { file_path: '/Users/sam/code/fernway-web/src/auth/redirect.test.ts', content: 'x' });
  h.usage('ses_a2', NOW - 30_000, 4_000, 1_200, 0.03);

  // archived, and too old: never on the map
  h.session({ id: 'ses_archived', archived: true, createdAt: NOW - HOUR, updatedAt: NOW - HOUR });
  h.session({ id: 'ses_old', createdAt: NOW - 40 * HOUR, updatedAt: NOW - 30 * HOUR });

  // a title chore with no session still counts for today
  h.usage(undefined, NOW - HOUR, 500, 20, 0.001);

  const approvals = [{ id: 'ap_1', sessionId: 'ses_push', toolUseId: 'toolu_x', tool: 'Bash', input: { command: 'git push origin fix/login' }, summary: 'Run: git push', createdAt: NOW - 9 * MIN }];
  return { ...h, project, approvals };
}

const byId = (nodes: MapNode[]) => Object.fromEntries(nodes.map((n) => [n.id, n]));

describe('the live map', () => {
  const h = busy();
  const snap = buildMapSnapshot({ repos: h.repos, hubName: 'homelab', devices: h.devices, approvals: h.approvals, questions: [], now: NOW });
  const n = byId(snap.nodes);

  test('every session of the last day, without archived, old or host sessions', () => {
    expect(snap.live).toBe(true);
    expect(snap.at).toBe(NOW);
    expect(Object.keys(n).sort()).toEqual(['ses_a1', 'ses_a2', 'ses_arch', 'ses_chat', 'ses_explore', 'ses_fix', 'ses_nmap', 'ses_push', 'wf:wfr_1'].sort());
  });

  test('state from the status and the open approval', () => {
    expect(n.ses_fix.state).toBe('running');
    expect(n.ses_push.state).toBe('waiting');
    expect(n.ses_push.waitingOn).toBe('approval');
    expect(n.ses_nmap.state).toBe('failed');
    expect(n.ses_nmap.error).toBe('Connection refused');
    expect(n.ses_arch.state).toBe('paused');
    expect(n.ses_arch.resumeAt).toBe(NOW + 80 * MIN);
    expect(n.ses_chat.state).toBe('idle');
    // a finished subagent is done, not idle
    expect(n.ses_explore.state).toBe('done');
    expect(n['wf:wfr_1'].state).toBe('running');
  });

  test('kinds and what hangs off what', () => {
    expect(n.ses_chat.kind).toBe('chat');
    expect(n.ses_fix.kind).toBe('session');
    expect(n.ses_explore.kind).toBe('subagent');
    expect(n.ses_explore.parentId).toBe('ses_fix');
    expect(n['wf:wfr_1'].kind).toBe('workflow');
    expect(n['wf:wfr_1'].parentId).toBeUndefined();
    expect(n.ses_a1.kind).toBe('agent');
    expect(n.ses_a1.parentId).toBe('wf:wfr_1');
    expect(n.ses_a1.agent).toBe('reviewer');
    expect(n.ses_a2.title).toBe('prove with tests');
  });

  test('groups: the project on the Mac, folders on the hub, the chats', () => {
    const g = Object.fromEntries(snap.groups.map((x) => [x.id, x]));
    const pg = `p:${h.project.id}@mac`;
    expect(g[pg]).toMatchObject({ kind: 'project', name: 'fernway-web', device: 'mac' });
    expect(g.chats).toMatchObject({ kind: 'chats', name: 'Chats', device: 'local' });
    expect(g['f:local:/home/sam/code/scantools']).toMatchObject({ kind: 'folder', name: 'scantools' });
    expect(g['f:local:/home/sam']).toMatchObject({ kind: 'folder', name: 'Home folder' });
    // children sit in their parent's group
    for (const id of ['ses_fix', 'ses_explore', 'ses_push', 'wf:wfr_1', 'ses_a1', 'ses_a2']) expect(n[id].group).toBe(pg);
    expect(n.ses_chat.group).toBe('chats');
    expect(snap.devices.map((d) => [d.id, d.online])).toEqual([
      ['local', true],
      ['mac', true],
    ]);
  });

  test('tools: the open one now, the finished ones newest first with target and duration', () => {
    expect(n.ses_fix.tool).toMatchObject({ name: 'Bash', target: 'bun test src/auth', startedAt: NOW - 30_000 });
    expect(n.ses_fix.tool?.durationMs).toBeUndefined();
    expect(n.ses_fix.tools.map((t) => [t.name, t.target, t.durationMs])).toEqual([
      ['Edit', 'redirect.ts', 140],
      ['Read', 'redirect.ts', 1_200],
    ]);
    expect(n.ses_push.tool?.target).toBe('git push origin fix/login');
    // a finished node has no tool running
    expect(n.ses_explore.tool).toBeUndefined();
    expect(n.ses_explore.tools[0]).toMatchObject({ name: 'Grep', target: 'jwtVerify', durationMs: 300 });
  });

  test('usage, tokens per minute and the rate', () => {
    expect(n.ses_fix.usage).toEqual({ inputTokens: 18_400, outputTokens: 1_300, cacheReadTokens: 42_000, cacheWriteTokens: 3_000, costUsd: 0.11 });
    expect(n.ses_fix.tokensPerMin).toBe(900);
    expect(n.ses_fix.rate).toBeCloseTo(15, 5);
    expect(n.ses_explore.rate).toBe(0);
    // the run adds up its agents
    expect(n['wf:wfr_1'].usage.outputTokens).toBe(1_800);
    expect(n['wf:wfr_1'].usage.costUsd).toBeCloseTo(0.05, 5);
  });

  test('totals and the hub', () => {
    // two agents running (the run itself does not count), one waiting
    expect(snap.totals.running).toBe(2);
    expect(snap.totals.waiting).toBe(1);
    expect(snap.hub).toEqual({ name: 'homelab', state: 'waiting' });
    const today = dayStart(NOW, 0);
    expect(snap.totals.today.from).toBe(today);
    // every usage row since midnight UTC, the one without a session too
    expect(snap.totals.today.tokens).toBe(1_200 + 300 + 9_000 + 400 + 9_400 + 900 + 3_000 + 200 + 5_000 + 600 + 4_000 + 1_200 + 500 + 20);
    expect(snap.conflicts).toBeUndefined();
    expect(snap.nodes.every((x) => x.stuckSince === undefined)).toBe(true);
  });

  test('the live view adds the tool it saw start and the rate it measured', () => {
    const live = {
      current: (id: string) => (id === 'ses_fix' ? { id: 'toolu_live', name: 'Bash', target: 'bun test', startedAt: NOW - 2_000 } : undefined),
      recent: (id: string) => (id === 'ses_fix' ? [{ id: 'toolu_r', name: 'Read', target: 'login-form.ts', startedAt: NOW - 60_000, durationMs: 80 }] : []),
      rate: (id: string) => (id === 'ses_fix' ? { rate: 42, perMin: 2_400 } : undefined),
    };
    const s = buildMapSnapshot({ repos: h.repos, hubName: 'homelab', devices: h.devices, approvals: h.approvals, live, now: NOW });
    const fix = byId(s.nodes).ses_fix;
    expect(fix.tool?.id).toBe('toolu_live');
    expect(fix.rate).toBe(42);
    expect(fix.tokensPerMin).toBe(2_400);
    expect(fix.tools[0]).toMatchObject({ name: 'Read', target: 'login-form.ts' });
  });
});

describe('replay', () => {
  const h = busy();
  const at = (t: number) => byId(buildMapSnapshot({ repos: h.repos, hubName: 'homelab', devices: h.devices, approvals: h.approvals, now: NOW }, { at: t }).nodes);

  test('a session in the middle of its turn runs, with the tool open at that time', () => {
    const n = at(NOW - 15 * MIN + 50);
    expect(n.ses_fix.state).toBe('running');
    expect(n.ses_fix.tool).toMatchObject({ name: 'Edit', target: 'redirect.ts' });
    expect(n.ses_fix.tools.map((t) => t.name)).toEqual(['Read']);
    // usage up to that time only
    expect(n.ses_fix.usage.outputTokens).toBe(400);
    // nodes that did not exist yet are not there
    expect(n.ses_push).toBeUndefined();
    expect(n['wf:wfr_1']).toBeUndefined();
  });

  test('an open approval at that time is waiting', () => {
    const n = at(NOW - 5 * MIN);
    expect(n.ses_push.state).toBe('waiting');
    expect(n.ses_push.waitingOn).toBe('approval');
  });

  test('an approval answered later was open; one answered before was not', () => {
    h.repos.approvals.requested({ id: 'ap_old', sessionId: 'ses_nmap', tool: 'Bash', requestedAt: NOW - 2 * HOUR + 1_000 });
    h.repos.approvals.resolved('ap_old', 'allow', NOW - 2 * HOUR + 60_000);
    expect(at(NOW - 2 * HOUR + 30_000).ses_nmap.state).toBe('waiting');
    expect(at(NOW - 2 * HOUR + 90_000).ses_nmap.state).toBe('running');
    // after the turn ended in an error
    expect(at(NOW - 90 * MIN).ses_nmap.state).toBe('failed');
  });

  test('a subagent runs between its first and last message, then is done', () => {
    expect(at(NOW - 16.5 * MIN).ses_explore.state).toBe('running');
    expect(at(NOW - 15 * MIN).ses_explore.state).toBe('done');
  });

  test('workflow agents follow their call, the run its start and finish', () => {
    const mid = at(NOW - 7 * MIN);
    expect(mid['wf:wfr_1'].state).toBe('running');
    expect(mid.ses_a1.state).toBe('running');
    expect(mid.ses_a1.parentId).toBe('wf:wfr_1');
    expect(mid.ses_a2).toBeUndefined();
    expect(at(NOW - 2 * MIN).ses_a1.state).toBe('done');
  });

  test('a replay says so, and stops at 24 hours back', () => {
    const s = buildMapSnapshot({ repos: h.repos, hubName: 'homelab', devices: h.devices, now: NOW }, { at: NOW - 48 * HOUR });
    expect(s.live).toBe(false);
    expect(s.at).toBe(NOW - 24 * HOUR);
    expect(s.from).toBe(NOW - 24 * HOUR);
    // the devices' online state then is not known
    expect(s.devices.every((d) => d.online === undefined)).toBe(true);
    // the chat a day ago had not started
    expect(byId(s.nodes).ses_chat).toBeUndefined();
  });

  test('the running rate in a replay comes from the usage rows', () => {
    const n = at(NOW - 10_000);
    expect(n.ses_fix.state).toBe('running');
    expect(n.ses_fix.tokensPerMin).toBe(900);
    expect(n.ses_fix.rate).toBeCloseTo(15, 5);
  });
});

describe('a busy day stays readable', () => {
  test('every live node is kept, then the most recent, up to the cap', () => {
    const h = hub(NOW);
    for (let i = 0; i < 120; i++) h.session({ id: `ses_done_${String(i).padStart(3, '0')}`, createdAt: NOW - 20 * HOUR + i * MIN, updatedAt: NOW - 20 * HOUR + i * MIN });
    h.session({ id: 'ses_old_live', status: 'running', createdAt: NOW - 23 * HOUR, updatedAt: NOW - 23 * HOUR });
    h.session({ id: 'ses_child', parentId: 'ses_old_live', status: 'running', createdAt: NOW - 23 * HOUR, updatedAt: NOW - 23 * HOUR });
    const s = buildMapSnapshot({ repos: h.repos, hubName: 'hub', devices: h.devices, now: NOW });
    expect(s.nodes.length).toBe(MAP_MAX_NODES);
    const ids = new Set(s.nodes.map((n) => n.id));
    expect(ids.has('ses_old_live')).toBe(true);
    expect(ids.has('ses_child')).toBe(true);
    expect(ids.has('ses_done_119')).toBe(true);
    expect(ids.has('ses_done_000')).toBe(false);
  });
});

describe('accounts', () => {
  test("today's tokens and cost are the account's own: a member never sees the owner's", () => {
    // found in a real run: a member who had used nothing saw "1M tokens and $1.55 today", the owner's
    const h = hub(NOW);
    h.usage(undefined, NOW - HOUR, 1_000, 100, 0.5);
    h.repos.usage.insert({ id: 'u_member', ts: NOW - HOUR, source: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 40, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01, accountId: 'acc_riley' });
    const owner = buildMapSnapshot({ repos: h.repos, hubName: 'hub', devices: h.devices, now: NOW });
    expect(owner.totals.today).toMatchObject({ tokens: 1_100, costUsd: 0.5 });
    const member = buildMapSnapshot({ repos: h.repos, accountId: 'acc_riley', hubName: 'hub', devices: [], now: NOW });
    expect(member.totals.today).toMatchObject({ tokens: 42, costUsd: 0.01 });
  });
});

describe('days and tools', () => {
  test('today starts at local midnight', () => {
    // 15:00 UTC is 17:00 in Berlin summer time (offset -120): midnight there is 22:00 UTC the day before
    expect(dayStart(NOW, -120)).toBe(Date.UTC(2026, 9, 19, 22, 0, 0));
    expect(dayStart(NOW, 420)).toBe(Date.UTC(2026, 9, 20, 7, 0, 0));
  });

  test('targets in a few words', () => {
    expect(toolTarget({ file_path: '/a/b/redirect.ts' })).toBe('redirect.ts');
    expect(toolTarget({ file_path: 'C:\\code\\app\\main.rs' })).toBe('main.rs');
    expect(toolTarget({ command: 'bun   test\nsecond' })).toBe('bun test');
    expect(toolTarget({ command: 'x'.repeat(80) })?.length).toBe(48);
    expect(toolTarget({ pattern: 'jwtVerify', path: '/src' })).toBe('jwtVerify');
    expect(toolTarget({ url: 'https://docs.example.com/guide/start?x=1' })).toBe('docs.example.com/guide/start');
    expect(toolTarget({ query: 'caddy vs traefik' })).toBe('caddy vs traefik');
    expect(toolTarget({ description: 'Find JWT usages', subagent_type: 'explore' })).toBe('Find JWT usages');
    expect(toolTarget({})).toBeUndefined();
    expect(toolTarget(undefined)).toBeUndefined();
  });

  test('a result without a duration takes the time between the messages', () => {
    const t = toolsFromRows([
      { at: 1_000, type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/a.ts' } },
      { at: 1_000, type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'q' } },
      { at: 3_500, type: 'tool_result', id: 'a' },
      { at: 3_500, type: 'tool_result', id: 'b', durationMs: 900, error: true },
      { at: 4_000, type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(t.open).toMatchObject({ id: 'c', name: 'Bash', target: 'ls' });
    expect(t.done.map((x) => [x.id, x.durationMs, x.startedAt, !!x.error])).toEqual([
      ['b', 900, 2_600, true],
      ['a', 2_500, 1_000, false],
    ]);
  });
});
