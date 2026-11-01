/**
 * A scripted ACP agent for tests. Run with `bun fake-agent.ts`.
 * The prompt text picks a scenario: basic, fs <path>, term, slow, stubborn,
 * echo, crash, ask-exec, ask-read, mode, to-plan.
 *
 * FAKE_ACP_MODES offers permission modes like claude-agent-acp's (default,
 * acceptEdits, plan, bypassPermissions): "config" as a config option of
 * category mode, "legacy" as session modes set with session/set_mode. In
 * bypassPermissions, ask-exec runs without asking, as Claude Code does.
 */
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

process.stderr.write('fake agent booting\n');

type Ctx = acp.AgentContext;
const sessions = new Map<string, { model: string; effort?: string; mode: string; cancel?: () => void; history: string[] }>();
const calls: Record<string, unknown[]> = { newSession: [], loadSession: [], setConfig: [], setMode: [], cancel: [] };
const MODES = process.env.FAKE_ACP_MODES;
const MODE_IDS = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function modeOption(current: string): acp.SessionConfigOption {
  return { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current, options: MODE_IDS.map((id) => ({ value: id, name: id })) };
}

function modeState(current: string): acp.SessionModeState {
  return { currentModeId: current, availableModes: MODE_IDS.map((id) => ({ id, name: id })) };
}

function modelOption(current: string): acp.SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: [
      { value: 'fake-default', name: 'Default' },
      { value: 'fake-opus-1', name: 'Opus' },
      { value: 'fake-haiku-1', name: 'Haiku' },
      // a model the account offers that no catalog knows yet (FAKE_ACP_NEW_MODEL, e.g. Codex's "daybreak")
      ...(process.env.FAKE_ACP_NEW_MODEL ? [{ value: process.env.FAKE_ACP_NEW_MODEL, name: process.env.FAKE_ACP_NEW_MODEL_NAME ?? process.env.FAKE_ACP_NEW_MODEL }] : []),
    ],
  };
}

/** Effort like claude-agent-acp's: Opus has all five levels, Default has no xhigh, Haiku has no Effort option. */
function effortOption(model: string, current = 'default'): acp.SessionConfigOption | undefined {
  if (model === 'fake-haiku-1') return undefined;
  const levels = model === 'fake-opus-1' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'max'];
  return {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: current,
    options: [{ value: 'default', name: 'Default' }, ...levels.map((l) => ({ value: l, name: l === 'xhigh' ? 'Xhigh' : l[0].toUpperCase() + l.slice(1) }))],
  };
}

function configOptions(s: { model: string; effort?: string; mode?: string }): acp.SessionConfigOption[] {
  const effort = effortOption(s.model, s.effort);
  return [...(MODES === 'config' ? [modeOption(s.mode ?? 'default')] : []), modelOption(s.model), ...(effort ? [effort] : [])];
}

async function say(cx: Ctx, sessionId: string, text: string) {
  await cx.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}

async function update(cx: Ctx, sessionId: string, u: Record<string, unknown>) {
  // cast: we deliberately send kinds the schema may not know
  await cx.notify('session/update', { sessionId, update: u as unknown as acp.SessionUpdate });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runPrompt(params: acp.PromptRequest, cx: Ctx): Promise<acp.PromptResponse> {
  const sid = params.sessionId;
  const s = sessions.get(sid);
  if (!s) throw acp.RequestError.invalidParams(undefined, `no session ${sid}`);
  const text = params.prompt.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  s.history.push(text);
  // a subagent's profile block (engine/subagent.ts) comes before the brief; the scenario word is the brief's
  const first = text.replace(/<prior_conversation>[\s\S]*?<\/prior_conversation>/g, '').replace(/<agent-profile[\s\S]*?<\/agent-profile>/g, '').split('\n').find((l) => l.trim()) ?? '';
  const word = first.trim().split(/\s+/)[0];

  await update(cx, sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  await update(cx, sid, { sessionUpdate: 'future_kind', foo: 1 });

  switch (word) {
    case 'basic': {
      await say(cx, sid, 'Hello ');
      await update(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read README', kind: 'read', status: 'pending', rawInput: { path: '/p/README.md' } });
      await update(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file body' } }] });
      // streamed tool call: input arrives in a later update
      await update(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit config', kind: 'edit', status: 'pending', rawInput: {}, _meta: { claudeCode: { toolName: 'Edit' } } });
      await update(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', rawInput: { file_path: '/p/config.json', old_string: 'a', new_string: 'b' } });
      const perm = await cx.request('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 't2', title: 'Edit config', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
          { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const allowed = perm.outcome.outcome === 'selected' && perm.outcome.optionId !== 'r1';
      if (allowed) {
        await update(cx, sid, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't2',
          status: 'completed',
          content: [{ type: 'diff', path: '/p/config.json', oldText: 'a', newText: 'b' }],
        });
      } else {
        await update(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected' } }] });
      }
      await update(cx, sid, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'step one', priority: 'high', status: 'completed' },
          { content: 'step two', priority: 'low', status: 'pending' },
        ],
      });
      await update(cx, sid, {
        sessionUpdate: 'usage_update',
        used: 1000,
        size: 200000,
        _meta: { '_claude/model': 'fake-opus-model', '_claude/rateLimit': { status: 'allowed', resetsAt: 2_000_000_000, rateLimitType: 'five_hour', utilization: 0.42 } },
      });
      await say(cx, sid, `done (${perm.outcome.outcome === 'selected' ? perm.outcome.optionId : 'cancelled'}).`);
      return { stopReason: 'end_turn', usage: { totalTokens: 175, inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedWriteTokens: 5 } };
    }
    case 'fs': {
      const path = first.trim().split(/\s+/)[1];
      const read = await cx.request('fs/read_text_file', { sessionId: sid, path, line: 2, limit: 2 });
      await say(cx, sid, `read:${read.content}`);
      try {
        await cx.request('fs/write_text_file', { sessionId: sid, path: path + '.out', content: read.content.toUpperCase() });
        await say(cx, sid, ' wrote');
      } catch (err) {
        await say(cx, sid, ` write-failed:${(err as Error).message}`);
      }
      return { stopReason: 'end_turn' };
    }
    case 'term': {
      const t1 = await cx.request('terminal/create', { sessionId: sid, command: 'echo', args: ['hi there'] });
      await update(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 'b1', title: 'echo hi there', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi there' }, content: [{ type: 'terminal', terminalId: t1.terminalId }] });
      const exit = await cx.request('terminal/wait_for_exit', { sessionId: sid, terminalId: t1.terminalId });
      const out = await cx.request('terminal/output', { sessionId: sid, terminalId: t1.terminalId });
      await update(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed', content: [{ type: 'terminal', terminalId: t1.terminalId }] });
      await cx.request('terminal/release', { sessionId: sid, terminalId: t1.terminalId });
      const t2 = await cx.request('terminal/create', { sessionId: sid, command: 'echo a && echo b' });
      await cx.request('terminal/wait_for_exit', { sessionId: sid, terminalId: t2.terminalId });
      const out2 = await cx.request('terminal/output', { sessionId: sid, terminalId: t2.terminalId });
      const t3 = await cx.request('terminal/create', { sessionId: sid, command: 'sleep', args: ['30'] });
      await cx.request('terminal/kill', { sessionId: sid, terminalId: t3.terminalId });
      const exit3 = await cx.request('terminal/wait_for_exit', { sessionId: sid, terminalId: t3.terminalId });
      await say(cx, sid, JSON.stringify({ exit: exit.exitCode, out: out.output, out2: out2.output, killed: exit3.signal ?? exit3.exitCode }));
      return { stopReason: 'end_turn' };
    }
    case 'slow': {
      await say(cx, sid, 'working');
      await new Promise<void>((resolve) => {
        s.cancel = resolve;
        setTimeout(resolve, 20_000);
      });
      return { stopReason: 'cancelled' };
    }
    case 'stubborn': {
      await say(cx, sid, 'ignoring cancel');
      await sleep(60_000);
      return { stopReason: 'end_turn' };
    }
    case 'ask-exec':
    case 'ask-read': {
      const kind = word === 'ask-exec' ? 'execute' : 'read';
      // Claude Code in bypassPermissions runs the tool without a permission request
      if (s.mode === 'bypassPermissions') {
        await say(cx, sid, 'outcome:bypassed');
        return { stopReason: 'end_turn' };
      }
      const perm = await cx.request('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'p1', title: kind === 'execute' ? 'rm -rf build' : 'Read secrets', kind, status: 'pending', rawInput: kind === 'execute' ? { command: 'rm -rf build' } : { path: '/p/secret' } },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      await say(cx, sid, `outcome:${perm.outcome.outcome === 'selected' ? perm.outcome.optionId : 'cancelled'}`);
      return { stopReason: 'end_turn' };
    }
    case 'think': {
      await update(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 'k1', title: 'Thinking', kind: 'think', status: 'pending', rawInput: {} });
      await say(cx, sid, 'after');
      return { stopReason: 'end_turn' };
    }
    case 'mode': {
      await say(cx, sid, `mode=${s.mode}`);
      return { stopReason: 'end_turn' };
    }
    case 'to-plan': {
      // the agent changes its own mode mid turn (Claude Code entering plan mode) and says so
      s.mode = 'plan';
      await update(cx, sid, MODES === 'config' ? { sessionUpdate: 'config_option_update', configOptions: configOptions(s) } : { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
      await say(cx, sid, 'mode=plan');
      return { stopReason: 'end_turn' };
    }
    case 'echo': {
      await say(cx, sid, `model=${s.model}${s.effort ? ` effort=${s.effort}` : ''}\n${text}`);
      return { stopReason: 'end_turn' };
    }
    case 'refuse': {
      // the agent declines and says so in its stop reason, as ACP allows
      await say(cx, sid, 'I will not do that.');
      return { stopReason: 'refusal' };
    }
    case 'calls': {
      await say(cx, sid, JSON.stringify(calls));
      return { stopReason: 'end_turn' };
    }
    case 'crash': {
      process.stderr.write('fatal: something broke\n');
      process.exit(3);
    }
    default:
      await say(cx, sid, 'ok');
      return { stopReason: 'end_turn' };
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>);

acp
  .agent({ name: 'fake-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true } },
    agentInfo: { name: 'fake-agent', version: '1.2.3' },
  }))
  .onRequest('session/new', (ctx) => {
    calls.newSession.push({ cwd: ctx.params.cwd, mcpServers: ctx.params.mcpServers });
    const sessionId = `s${sessions.size + 1}_${Math.random().toString(36).slice(2, 8)}`;
    const s = { model: 'fake-default', mode: 'default', history: [] as string[] };
    sessions.set(sessionId, s);
    return { sessionId, configOptions: configOptions(s), ...(MODES === 'legacy' ? { modes: modeState(s.mode) } : {}) };
  })
  .onRequest('session/load', async (ctx) => {
    calls.loadSession.push(ctx.params.sessionId);
    // a harness that cannot resume this session here (another machine, a deleted transcript)
    if (process.env.FAKE_ACP_FAIL_LOAD) throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
    const s = { model: 'fake-default', mode: 'default', history: [] as string[] };
    sessions.set(ctx.params.sessionId, s);
    // replay history; the client must ignore it
    await ctx.client.notify('session/update', {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } },
    });
    return { configOptions: configOptions(s), ...(MODES === 'legacy' ? { modes: modeState(s.mode) } : {}) };
  })
  .onRequest('session/set_mode', (ctx) => {
    calls.setMode.push(ctx.params.modeId);
    const s = sessions.get(ctx.params.sessionId);
    if (MODES !== 'legacy' || !s || !MODE_IDS.includes(ctx.params.modeId)) throw acp.RequestError.invalidParams(undefined, `no mode ${ctx.params.modeId}`);
    s.mode = ctx.params.modeId;
    return {};
  })
  .onRequest('session/set_config_option', (ctx) => {
    const p = ctx.params as { sessionId: string; configId: string; value: unknown };
    calls.setConfig.push({ configId: p.configId, value: p.value });
    const s = sessions.get(p.sessionId);
    if (s && p.configId === 'model') s.model = String(p.value);
    if (s && p.configId === 'effort') s.effort = p.value === 'default' ? undefined : String(p.value);
    if (s && p.configId === 'mode') s.mode = String(p.value);
    return { configOptions: configOptions(s ?? { model: 'fake-default' }) };
  })
  .onRequest('authenticate', () => ({}))
  .onRequest('session/prompt', (ctx) => runPrompt(ctx.params, ctx.client))
  .onNotification('session/cancel', (ctx) => {
    calls.cancel.push(ctx.params.sessionId);
    sessions.get(ctx.params.sessionId)?.cancel?.();
  })
  .connect(stream);
