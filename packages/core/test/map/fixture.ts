/**
 * A small hub in an in-memory database for the Map tests: sessions with
 * their messages, tool calls, usage rows, turns and approvals, a project,
 * and a workflow run with two agents.
 */
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { WorkflowStore } from '../../src/workflows/store';
import { ProjectStore } from '../../src/projects/store';
import type { ContentBlock, Device, Session, SessionStatus } from '../../src/types';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function hub(now: number) {
  const repos = new Repos(openDb(':memory:'));
  new WorkflowStore(repos.db);
  const projects = new ProjectStore(repos.db);
  let seqs = new Map<string, number>();
  let n = 0;

  const session = (s: Partial<Session> & { id: string; createdAt: number }): Session => {
    const full: Session = {
      title: s.id,
      agent: 'coder',
      model: 'anthropic/claude-sonnet-5-5',
      mode: 'agent',
      permissionMode: 'default',
      cwd: '/home/sam/code/app',
      device: 'local',
      status: 'idle' as SessionStatus,
      tags: [],
      pinned: false,
      archived: false,
      updatedAt: s.createdAt,
      stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      ...s,
    };
    repos.sessions.insert(full);
    return full;
  };

  const message = (sessionId: string, role: 'user' | 'assistant', at: number, content: ContentBlock[]) => {
    const seq = (seqs.get(sessionId) ?? 0) + 1;
    seqs.set(sessionId, seq);
    repos.messages.insert({ id: `msg_${++n}`, sessionId, seq, role, kind: 'normal', content, createdAt: at });
  };

  /** A tool call: the assistant's tool_use at `at`, the result `ms` later (unless open). */
  const tool = (sessionId: string, at: number, name: string, input: Record<string, unknown>, ms?: number, error?: boolean) => {
    const id = `toolu_${++n}`;
    message(sessionId, 'assistant', at, [{ type: 'text', text: 'working' }, { type: 'tool_use', id, name, input }]);
    if (ms !== undefined) message(sessionId, 'user', at + ms, [{ type: 'tool_result', toolUseId: id, content: 'ok', ...(error ? { isError: true } : {}), meta: { durationMs: ms } }]);
    return id;
  };

  const usage = (sessionId: string | undefined, ts: number, input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) =>
    repos.usage.insert({ id: `u_${++n}`, ts, sessionId, source: 'api', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: 0, costUsd: cost });

  const turn = (sessionId: string, started: number, ended?: number, outcome?: string) => {
    const id = repos.turns.start({ sessionId, startedAt: started });
    if (ended !== undefined) repos.turns.end(id, { endedAt: ended, outcome: outcome ?? 'done' });
    return id;
  };

  const run = (r: { id: string; name: string; sessionId: string; host?: boolean; status: string; device?: string; cwd?: string; createdAt: number; startedAt?: number; finishedAt?: number }) =>
    repos.db
      .query(
        `INSERT INTO workflow_runs (id, name, source, script, script_sha, session_id, host_session, device, cwd, status, created_at, started_at, finished_at) VALUES (?, ?, 'builtin', '', '', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.name, r.sessionId, r.host ? 1 : 0, r.device ?? 'local', r.cwd ?? '/home/sam/code/app', r.status, r.createdAt, r.startedAt ?? r.createdAt, r.finishedAt ?? null);

  const call = (c: { runId: string; seq: number; label: string; child: string; state: string; startedAt: number; finishedAt?: number; agentType?: string }) =>
    repos.db
      .query(`INSERT INTO workflow_calls (run_id, seq, key, occurrence, kind, label, agent_type, state, child_session_id, started_at, finished_at) VALUES (?, ?, ?, 0, 'agent', ?, ?, ?, ?, ?, ?)`)
      .run(c.runId, c.seq, `k${c.seq}`, c.label, c.agentType ?? 'workflow', c.state, c.child, c.startedAt, c.finishedAt ?? null);

  const devices: Device[] = [
    { id: 'local', name: 'homelab', online: true, roots: [], createdAt: now - 30 * 24 * HOUR, info: { hostname: 'homelab', platform: 'linux', arch: 'x64', home: '/home/sam', shell: 'bash', clis: {}, capabilities: [] } },
    { id: 'mac', name: 'MacBook', online: true, roots: [], createdAt: now - 20 * 24 * HOUR, info: { hostname: 'MacBook', platform: 'darwin', arch: 'arm64', home: '/Users/sam', shell: 'zsh', clis: {}, capabilities: [] } },
  ];

  return { repos, projects, session, message, tool, usage, turn, run, call, devices };
}
