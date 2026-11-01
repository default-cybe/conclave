/**
 * A tiny stand-in for the hub: the few routes `conclave run` and the TUI use,
 * plus a WebSocket that streams engine events for each prompt.
 *
 * Prompts pick a scenario: containing "approve" asks for a Bash approval,
 * "fail" ends in an error, anything else answers "Hello world!".
 */
import type { Server, ServerWebSocket } from 'bun';
import type { ApprovalResponse, EngineEvent, Message, Session } from '@conclave/core/types.ts';

export interface FakeHub {
  url: string;
  token: string;
  server: Server<unknown>;
  sessions: Map<string, Session>;
  messages: Map<string, Message[]>;
  approvals: Array<{ id: string; response: ApprovalResponse }>;
  requests: string[];
  stop(): void;
}

const MARKDOWN = `# Plan

Here is **the plan** with \`inline code\` and a [link](https://example.com).

1. First step
2. Second step
   - nested *detail*

\`\`\`ts
// load config
const cfg = await loadConfig("x");
export function add(a: number, b: number) {
  return a + b;
}
\`\`\`

| Model | Cost |
| --- | ---: |
| sonnet | $3 |
| glm-5 | $0.6 |

> A quoted note.

Done.`;

export function startFakeHub(opts: { token?: string } = {}): FakeHub {
  const token = opts.token ?? 'test-token';
  const sockets = new Set<ServerWebSocket<unknown>>();
  const sessions = new Map<string, Session>();
  const messages = new Map<string, Message[]>();
  const approvals: FakeHub['approvals'] = [];
  const waiters = new Map<string, (r: ApprovalResponse) => void>();
  const questionWaiters = new Map<string, (a: Record<string, string>) => void>();
  const requests: string[] = [];
  let seq = 0;
  let ids = 0;

  const emit = (ev: EngineEvent) => {
    const frame = JSON.stringify({ ...ev, seq: ++seq, ts: Date.now() });
    for (const ws of sockets) ws.send(frame);
  };
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const update = (id: string, patch: Partial<Session>) => {
    const s = { ...sessions.get(id)!, ...patch, updatedAt: Date.now() };
    sessions.set(id, s);
    emit({ type: 'session.updated', session: s });
    return s;
  };
  const addMessage = (m: Message) => {
    messages.get(m.sessionId)!.push(m);
  };

  async function runTurn(sid: string, text: string) {
    const list = messages.get(sid)!;
    const user: Message = { id: `m${++ids}`, sessionId: sid, seq: list.length + 1, role: 'user', kind: 'normal', content: [{ type: 'text', text }], createdAt: Date.now() };
    addMessage(user);
    update(sid, { status: 'running' });
    emit({ type: 'message.created', message: user });
    await tick();
    const aid = `m${++ids}`;
    const assistant: Message = { id: aid, sessionId: sid, seq: list.length + 1, role: 'assistant', kind: 'normal', content: [], model: 'fake/model-1', createdAt: Date.now() };
    addMessage(assistant);
    emit({ type: 'message.created', message: assistant });
    if (text.includes('fail')) {
      await tick();
      update(sid, { status: 'error', error: 'provider exploded' });
      return;
    }
    if (text.includes('long')) {
      for (let i = 1; i <= 120; i++) {
        await new Promise((r) => setTimeout(r, 40));
        if (sessions.get(sid)!.status !== 'running') return;
        emit({ type: 'message.delta', sessionId: sid, messageId: aid, index: 0, kind: 'text', text: `line ${i} of a long answer\n` });
      }
      assistant.content = [{ type: 'text', text: Array.from({ length: 120 }, (_, i) => `line ${i + 1} of a long answer`).join('\n') }];
      assistant.stopReason = 'end_turn';
      emit({ type: 'message.updated', message: assistant });
      update(sid, { status: 'idle' });
      return;
    }
    if (text.includes('ask me')) {
      update(sid, { status: 'waiting_input' });
      const qid = `q${ids}`;
      const answer = await new Promise<Record<string, string>>((resolve) => {
        questionWaiters.set(qid, resolve);
        emit({
          type: 'question.asked',
          question: {
            id: qid,
            sessionId: sid,
            createdAt: Date.now(),
            questions: [
              { question: 'Which database?', header: 'Storage', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }] },
              { question: 'Which extras?', multiSelect: true, options: [{ label: 'FTS' }, { label: 'WAL' }, { label: 'Backups' }] },
            ],
          },
        });
      });
      emit({ type: 'question.answered', id: qid, sessionId: sid });
      update(sid, { status: 'running' });
      assistant.content = [{ type: 'text', text: `You picked: ${JSON.stringify(answer)}` }];
      assistant.stopReason = 'end_turn';
      emit({ type: 'message.updated', message: assistant });
      update(sid, { status: 'idle' });
      return;
    }
    if (text.includes('markdown')) {
      const md = MARKDOWN;
      emit({ type: 'message.delta', sessionId: sid, messageId: aid, index: 0, kind: 'thinking', text: 'Let me think about how to format this nicely for the user.' });
      for (let i = 0; i < md.length; i += 12) {
        await new Promise((r) => setTimeout(r, 4));
        emit({ type: 'message.delta', sessionId: sid, messageId: aid, index: 1, kind: 'text', text: md.slice(i, i + 12) });
      }
      assistant.content = [{ type: 'thinking', thinking: 'Let me think about how to format this nicely for the user.' }, { type: 'text', text: md }];
      assistant.stopReason = 'end_turn';
      emit({ type: 'message.updated', message: assistant });
      await tick();
      update(sid, { status: 'idle' });
      return;
    }
    if (text.includes('jury')) {
      assistant.content = [];
      const jurors = [
        ['Juror 1', 'anthropic/claude-sonnet-5-5', 'Use **SQLite** with WAL mode.'],
        ['Juror 2', 'openai/gpt-5.5', 'Postgres if you expect many writers; otherwise SQLite.'],
      ];
      for (const [author, model, body] of jurors) {
        const m: Message = { id: `m${++ids}`, sessionId: sid, seq: list.length + 1, role: 'assistant', kind: 'aside', author, model, group: 'g1', content: [{ type: 'text', text: body }], stopReason: 'end_turn', createdAt: Date.now() };
        addMessage(m);
        emit({ type: 'message.created', message: m });
        await tick();
      }
      assistant.content = [{ type: 'text', text: 'Verdict: SQLite. Both jurors agree it fits a single-user hub.' }];
      assistant.group = 'g1';
      assistant.stopReason = 'end_turn';
      emit({ type: 'message.updated', message: assistant });
      await tick();
      update(sid, { status: 'idle' });
      return;
    }
    if (text.includes('escape codes')) {
      // a file the agent printed, with an OSC 52 clipboard write in it
      const toolUseId = `toolu_${ids}`;
      const input = { command: 'cat notes.txt' };
      assistant.content = [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }];
      emit({ type: 'tool.started', sessionId: sid, messageId: aid, toolUseId, name: 'Bash', input });
      emit({ type: 'tool.completed', sessionId: sid, toolUseId, result: { type: 'tool_result', toolUseId, content: '\x1b]52;c;ZXZpbA==\x07notes' } });
      assistant.content.push({ type: 'text', text: 'Read it.' });
      assistant.stopReason = 'end_turn';
      emit({ type: 'message.updated', message: assistant });
      update(sid, { status: 'idle' });
      return;
    }
    if (text.includes('edit')) {
      const toolUseId = `toolu_${ids}`;
      const input = { file_path: '/home/user/proj/src/app.ts', old_string: 'a', new_string: 'b' };
      assistant.content = [{ type: 'tool_use', id: toolUseId, name: 'Edit', input }];
      assistant.stopReason = 'tool_use';
      emit({ type: 'message.updated', message: assistant });
      emit({ type: 'tool.started', sessionId: sid, messageId: aid, toolUseId, name: 'Edit', input });
      await new Promise((r) => setTimeout(r, 300));
      const diff = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,3 @@', ' import x from "y";', '-const a = 1;', '+const a = 2;', ' export default a;'].join('\n');
      const result = { type: 'tool_result' as const, toolUseId, content: 'Edited', meta: { diff, path: input.file_path } };
      emit({ type: 'tool.completed', sessionId: sid, toolUseId, result });
      const tr: Message = { id: `m${++ids}`, sessionId: sid, seq: list.length + 1, role: 'user', kind: 'normal', content: [result], createdAt: Date.now() };
      addMessage(tr);
      emit({ type: 'message.created', message: tr });
      update(sid, { status: 'idle' });
      return;
    }
    if (text.includes('approve')) {
      const toolUseId = `toolu_${ids}`;
      const input = { command: 'rm -rf build' };
      assistant.content = [
        { type: 'text', text: 'Cleaning up.' },
        { type: 'tool_use', id: toolUseId, name: 'Bash', input },
      ];
      assistant.stopReason = 'tool_use';
      emit({ type: 'message.updated', message: assistant });
      const approvalId = `ap${ids}`;
      update(sid, { status: 'waiting_approval' });
      const response = await new Promise<ApprovalResponse>((resolve) => {
        waiters.set(approvalId, resolve);
        emit({ type: 'approval.requested', approval: { id: approvalId, sessionId: sid, toolUseId, tool: 'Bash', input, summary: 'Run: rm -rf build', createdAt: Date.now() } });
      });
      emit({ type: 'approval.resolved', id: approvalId, sessionId: sid, response });
      const denied = response.decision === 'deny';
      const result = { type: 'tool_result' as const, toolUseId, content: denied ? 'Permission denied' : 'removed', isError: denied };
      if (!denied) emit({ type: 'tool.started', sessionId: sid, messageId: aid, toolUseId, name: 'Bash', input });
      emit({ type: 'tool.completed', sessionId: sid, toolUseId, result });
      const tr: Message = { id: `m${++ids}`, sessionId: sid, seq: list.length + 1, role: 'user', kind: 'normal', content: [result], createdAt: Date.now() };
      addMessage(tr);
      emit({ type: 'message.created', message: tr });
      update(sid, { status: 'running' });
      const final: Message = {
        id: `m${++ids}`,
        sessionId: sid,
        seq: list.length + 1,
        role: 'assistant',
        kind: 'normal',
        content: [{ type: 'text', text: denied ? 'Skipped the cleanup.' : 'Done.' }],
        model: 'fake/model-1',
        stopReason: 'end_turn',
        createdAt: Date.now(),
      };
      addMessage(final);
      emit({ type: 'message.created', message: final });
      await tick();
      update(sid, { status: 'idle' });
      return;
    }
    for (const [i, chunk] of ['Hello', ' world', '!'].entries()) {
      await tick();
      emit({ type: 'message.delta', sessionId: sid, messageId: aid, index: 0, kind: 'text', text: chunk });
      if (i === 0) emit({ type: 'message.delta', sessionId: sid, messageId: aid, index: 0, kind: 'text', text: '' });
    }
    assistant.content = [{ type: 'text', text: 'Hello world!' }];
    assistant.stopReason = 'end_turn';
    assistant.usage = { inputTokens: 12, outputTokens: 3 };
    emit({ type: 'message.updated', message: assistant });
    await tick();
    update(sid, { status: 'idle', stats: { messages: 2, inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, costUsd: 0.0001 } });
  }

  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      requests.push(`${req.method} ${path}`);
      if (path === '/api/health') return json({ ok: true, version: 'fake' });
      if (path === '/api/ws') {
        if (url.searchParams.get('token') !== token) return new Response('unauthorized', { status: 401 });
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response('upgrade failed', { status: 400 });
      }
      if (req.headers.get('authorization') !== `Bearer ${token}`) return json({ error: 'unauthorized' }, 401);
      if (path === '/api/info') return json({ name: 'fake hub', version: 'fake', startedAt: Date.now(), devices: 1, defaultModel: 'fake/model-1', features: [] });
      if (path === '/api/sessions' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;
        const id = `s${++ids}`;
        const s: Session = {
          id,
          title: '',
          agent: (body.agent as string) ?? 'assistant',
          model: (body.model as string) ?? 'fake/model-1',
          mode: 'agent',
          permissionMode: 'default',
          cwd: (body.cwd as string) ?? '/',
          device: (body.device as string) ?? 'local',
          status: 'idle',
          tags: [],
          pinned: false,
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        };
        sessions.set(id, s);
        messages.set(id, []);
        emit({ type: 'session.created', session: s });
        return json(s);
      }
      if (path === '/api/sessions' && req.method === 'GET') return json([...sessions.values()]);
      let m = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (m && req.method === 'GET') return sessions.has(m[1]) ? json(sessions.get(m[1])) : json({ error: 'not found' }, 404);
      m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
      if (m && req.method === 'GET') return json(messages.get(m[1]) ?? []);
      if (m && req.method === 'POST') {
        const body = (await req.json()) as { text: string };
        void runTurn(m[1], body.text);
        return json({ queued: false });
      }
      m = /^\/api\/sessions\/([^/]+)\/abort$/.exec(path);
      if (m) {
        update(m[1], { status: 'idle' });
        return json({ ok: true });
      }
      m = /^\/api\/approvals\/([^/]+)$/.exec(path);
      if (m && req.method === 'POST') {
        const response = (await req.json()) as ApprovalResponse;
        approvals.push({ id: m[1], response });
        waiters.get(m[1])?.(response);
        return json({ ok: true });
      }
      m = /^\/api\/devices\/([^/]+)\/files$/.exec(path);
      if (m) {
        const { readdirSync } = await import('node:fs');
        try {
          const dir = url.searchParams.get('path') ?? '/';
          const entries = readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, path: `${dir}/${d.name}`, type: d.isDirectory() ? 'dir' : 'file' }));
          return json(entries);
        } catch {
          return json({ error: 'not found' }, 404);
        }
      }
      m = /^\/api\/questions\/([^/]+)$/.exec(path);
      if (m && req.method === 'POST') {
        const body = (await req.json()) as { answers: Record<string, string> };
        questionWaiters.get(m[1])?.(body.answers);
        return json({ ok: true });
      }
      m = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (m && req.method === 'PATCH') {
        const body = (await req.json()) as Partial<Session>;
        return json(update(m[1], body));
      }
      if (path === '/api/approvals') return json([]);
      if (path === '/api/questions') return json([]);
      if (path === '/api/models')
        return json([
          { provider: 'anthropic', name: 'Anthropic', type: 'anthropic', configured: true, enabled: true, models: [{ id: 'claude-sonnet-5-5', ref: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', name: 'Sonnet', contextWindow: 200000, maxOutput: 64000, vision: true, tools: true, thinking: true, caching: 'explicit', inputPrice: 3, outputPrice: 15, cacheReadPrice: 0.3, cacheWritePrice: 3.75 }] },
          { provider: 'zai', name: 'Z.ai', type: 'anthropic', configured: false, enabled: true, models: [{ id: 'glm-5', ref: 'zai/glm-5', provider: 'zai', name: 'GLM 5', contextWindow: 128000, maxOutput: 32000, vision: false, tools: true, thinking: true, caching: 'automatic', inputPrice: 0.6, outputPrice: 2.2, cacheReadPrice: 0.1, cacheWritePrice: 0 }] },
        ]);
      if (path === '/api/commands') return json([]);
      if (path === '/api/limits') return json([]);
      return json({ error: `no route ${req.method} ${path}` }, 404);
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: 'hello', seq }));
      },
      message() {},
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    server: server as unknown as Server<unknown>,
    sessions,
    messages,
    approvals,
    requests,
    stop: () => server.stop(true),
  };
}
