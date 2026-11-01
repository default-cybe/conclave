import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter, claudeRateLimitWindows, effortOfChoice, matchChoice, pickOption, summarizeCall, toAcpMcpServers, toAcpPrompt } from '../../src/acp/adapter';
import type { HarnessEvent, HarnessTurnOptions } from '../../src/acp/types';
import type { ApprovalRequest, ApprovalResponse } from '../../src/types';
import type { ProviderConfig } from '../../src/config/schema';
import { TestMachine } from './test-machine';

const AGENT = join(import.meta.dir, 'fake-agent.ts');
const providers: Record<string, ProviderConfig> = {
  fake: { type: 'acp', command: process.execPath, args: [AGENT] },
  // permission modes like claude-agent-acp's: as a config option, or as session modes
  modes: { type: 'acp', command: process.execPath, args: [AGENT], env: { FAKE_ACP_MODES: 'config' } },
  legacyModes: { type: 'acp', command: process.execPath, args: [AGENT], env: { FAKE_ACP_MODES: 'legacy' } },
  sleepy: { type: 'acp', command: 'sh', args: ['-c', `sleep 3; exec '${process.execPath}' '${AGENT}'`] },
  missing: { type: 'acp', command: 'definitely-not-a-real-binary-xyz' },
  api: { type: 'anthropic' },
};
const cwd = mkdtempSync(join(tmpdir(), 'conclave-acp-'));
const adapters: AcpAdapter[] = [];

function makeAdapter(opts?: ConstructorParameters<typeof AcpAdapter>[1]) {
  const a = new AcpAdapter((id) => providers[id], opts);
  adapters.push(a);
  return a;
}

afterAll(async () => {
  for (const a of adapters) await a.shutdown();
});

type Approver = (req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'sessionId'>) => Promise<ApprovalResponse>;

function turn(text: string, extra: Partial<HarnessTurnOptions> & { approve?: Approver } = {}) {
  const approvals: Array<Omit<ApprovalRequest, 'id' | 'createdAt' | 'sessionId'>> = [];
  const approve: Approver = extra.approve ?? (async () => ({ decision: 'allow' }));
  const opts: HarnessTurnOptions = {
    harness: 'fake',
    machine: extra.machine ?? new TestMachine(),
    cwd,
    prompt: [{ type: 'text', text }],
    permission: 'ask',
    signal: new AbortController().signal,
    requestApproval: async (req) => {
      approvals.push(req);
      return approve(req);
    },
    ...extra,
  };
  return { opts, approvals };
}

async function collect(it: AsyncIterable<HarnessEvent>, onEvent?: (e: HarnessEvent) => void): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of it) {
    out.push(e);
    onEvent?.(e);
  }
  return out;
}

const text = (evs: HarnessEvent[]) => evs.map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
const done = (evs: HarnessEvent[]) => evs.find((e) => e.type === 'done') as Extract<HarnessEvent, { type: 'done' }>;

describe('AcpAdapter end to end', () => {
  test('basic turn: text, thinking, tools, approval, diff, plan, rate limit, usage', async () => {
    const a = makeAdapter();
    const { opts, approvals } = turn('basic');
    const evs = await collect(a.runTurn(opts));

    expect(evs[0]).toMatchObject({ type: 'session' });
    expect(evs.some((e) => e.type === 'thinking_delta' && e.text === 'thinking')).toBe(true);
    expect(text(evs)).toBe('Hello done (a1).');

    const t1 = evs.find((e) => e.type === 'tool_call' && e.id === 't1');
    expect(t1).toMatchObject({ name: 'Read', title: 'Read README', kind: 'read', input: { path: '/p/README.md' } });
    expect(evs.find((e) => e.type === 'tool_update' && e.id === 't1')).toMatchObject({ status: 'completed', output: 'file body' });

    // the streamed call is held until its input arrives
    const t2 = evs.filter((e) => e.type === 'tool_call' && e.id === 't2');
    expect(t2).toHaveLength(1);
    expect(t2[0]).toMatchObject({ name: 'Edit', input: { file_path: '/p/config.json' } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolUseId: 't2', tool: 'Edit', summary: 'Edit /p/config.json', harness: 'fake' });
    expect(evs.find((e) => e.type === 'tool_update' && e.id === 't2')).toMatchObject({
      status: 'completed',
      diff: { path: '/p/config.json', oldText: 'a', newText: 'b' },
    });

    expect(evs.find((e) => e.type === 'plan')).toEqual({
      type: 'plan',
      entries: [
        { content: 'step one', status: 'completed', priority: 'high' },
        { content: 'step two', status: 'pending', priority: 'low' },
      ],
    });
    expect(evs.find((e) => e.type === 'rate_limit')).toEqual({ type: 'rate_limit', windows: [{ name: '5h', usedPercent: 42, resetsAt: 2_000_000_000_000 }] });
    expect(evs.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 },
      model: 'fake-opus-model',
    });
    expect(done(evs)).toEqual({ type: 'done', stopReason: 'end_turn' });
    expect(evs[evs.length - 1].type).toBe('done');
  });

  test('approval scopes map to the offered options', async () => {
    const a = makeAdapter();
    const always = await collect(a.runTurn(turn('basic', { approve: async () => ({ decision: 'allow', scope: 'always' }) }).opts));
    expect(text(always)).toContain('done (aa).');
    const denied = await collect(a.runTurn(turn('basic', { approve: async () => ({ decision: 'deny' }) }).opts));
    expect(text(denied)).toContain('done (r1).');
    expect(denied.find((e) => e.type === 'tool_update' && e.id === 't2')).toMatchObject({ status: 'failed', output: 'rejected' });
  });

  test('reuses the pooled process and an open session on the next turn', async () => {
    const machine = new TestMachine();
    const a = makeAdapter();
    const first = await collect(a.runTurn(turn('hello', { machine }).opts));
    const sid = (first[0] as { id: string }).id;
    const second = await collect(a.runTurn(turn('calls', { machine, resumeId: sid }).opts));
    expect(second[0]).toEqual({ type: 'session', id: sid });
    expect(machine.spawned).toHaveLength(1);
    expect(a.poolSize).toBe(1);
    const calls = JSON.parse(text(second));
    expect(calls.loadSession).toEqual([]);
    expect(calls.newSession).toHaveLength(1);
    expect(calls.newSession[0].cwd).toBe(cwd);
  });

  test('loads a session in a fresh process and ignores replayed history', async () => {
    const a = makeAdapter();
    const evs = await collect(a.runTurn(turn('calls', { resumeId: 'old-session-1' }).opts));
    expect(evs[0]).toEqual({ type: 'session', id: 'old-session-1' });
    expect(text(evs)).not.toContain('REPLAYED');
    expect(JSON.parse(text(evs)).loadSession).toEqual(['old-session-1']);
  });

  test('sets the model through session config options and prepends prior context on new sessions', async () => {
    const a = makeAdapter();
    const evs = await collect(a.runTurn(turn('echo', { model: 'opus', priorContext: 'user: hi\nassistant: hello' }).opts));
    const out = text(evs);
    expect(out).toContain('model=fake-opus-1');
    expect(out).toContain('<prior_conversation>\nuser: hi\nassistant: hello\n</prior_conversation>');
    // prior context is only for brand new sessions
    const sid = (evs[0] as { id: string }).id;
    const again = await collect(a.runTurn(turn('echo', { model: 'opus', resumeId: sid, priorContext: 'ignored' }).opts));
    expect(text(again)).not.toContain('prior_conversation');
    const calls = JSON.parse(text(await collect(a.runTurn(turn('calls', { resumeId: sid }).opts))));
    expect(calls.setConfig).toEqual([{ configId: 'model', value: 'fake-opus-1' }]);
  });

  test('sets Effort through the harness option at the nearest level it offers, and says which levels it has', async () => {
    const a = makeAdapter();
    const machine = new TestMachine();
    const opus = await collect(a.runTurn(turn('echo', { machine, model: 'opus', effort: 'max' }).opts));
    expect(opus.find((e) => e.type === 'effort')).toEqual({ type: 'effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(text(opus)).toContain('model=fake-opus-1 effort=max');
    const sid = (opus[0] as { id: string }).id;
    // no setting after one: the harness's own default again
    const back = await collect(a.runTurn(turn('echo', { machine, model: 'opus', resumeId: sid }).opts));
    expect(text(back)).toContain('model=fake-opus-1\n');
    // the default model has no xhigh: the nearest level it has, the lower one on a tie
    const def = await collect(a.runTurn(turn('echo', { effort: 'xhigh' }).opts));
    expect(def.find((e) => e.type === 'effort')).toEqual({ type: 'effort', levels: ['low', 'medium', 'high', 'max'] });
    expect(text(def)).toContain('effort=high');
    // Off is not a harness level: its lowest
    expect(text(await collect(a.runTurn(turn('echo', { effort: 'off' }).opts)))).toContain('effort=low');
    // a model without the option offers none, and nothing is set
    const haiku = await collect(a.runTurn(turn('echo', { model: 'haiku', effort: 'high' }).opts));
    expect(haiku.find((e) => e.type === 'effort')).toEqual({ type: 'effort', levels: [] });
    expect(text(haiku)).toContain('model=fake-haiku-1\n');
  });

  test('passes MCP servers in ACP shape', async () => {
    const a = makeAdapter();
    const evs = await collect(
      a.runTurn(
        turn('calls', {
          mcpServers: {
            mem: { command: 'mem-server', args: ['--x'], env: { K: 'v' } },
            web: { type: 'http', url: 'http://h/mcp', headers: { A: 'b' } },
            off: { command: 'nope', enabled: false },
          },
        }).opts,
      ),
    );
    const calls = JSON.parse(text(evs));
    expect(calls.newSession[0].mcpServers).toEqual([
      { name: 'mem', command: 'mem-server', args: ['--x'], env: [{ name: 'K', value: 'v' }] },
      { type: 'http', name: 'web', url: 'http://h/mcp', headers: [{ name: 'A', value: 'b' }] },
    ]);
  });

  test('fs requests go through the machine, with line and limit', async () => {
    const a = makeAdapter();
    const file = join(cwd, 'notes.txt');
    writeFileSync(file, 'line1\nline2\nline3\nline4\n');
    const evs = await collect(a.runTurn(turn(`fs ${file}`).opts));
    expect(text(evs)).toBe('read:line2\nline3 wrote');
    expect(readFileSync(file + '.out', 'utf8')).toBe('LINE2\nLINE3');

    const ro = await collect(a.runTurn(turn(`fs ${file}`, { permission: 'readonly' }).opts));
    expect(text(ro)).toContain('write-failed');
  });

  test('terminals run on the machine and feed tool output', async () => {
    const a = makeAdapter();
    const evs = await collect(a.runTurn(turn('term').opts));
    const res = JSON.parse(text(evs));
    expect(res.exit).toBe(0);
    expect(res.out).toBe('hi there\n');
    expect(res.out2).toBe('a\nb\n');
    expect(res.killed).toBe('SIGTERM');
    const upd = evs.filter((e) => e.type === 'tool_update' && e.id === 'b1') as Array<Extract<HarnessEvent, { type: 'tool_update' }>>;
    expect(upd[upd.length - 1]).toMatchObject({ status: 'completed', output: 'hi there\n' });
  });

  test('readonly and auto permission modes answer without asking', async () => {
    const a = makeAdapter();
    const ro1 = turn('ask-exec', { permission: 'readonly' });
    expect(text(await collect(a.runTurn(ro1.opts)))).toBe('outcome:no');
    const ro2 = turn('ask-read', { permission: 'readonly' });
    expect(text(await collect(a.runTurn(ro2.opts)))).toBe('outcome:yes');
    const auto = turn('ask-exec', { permission: 'auto' });
    expect(text(await collect(a.runTurn(auto.opts)))).toBe('outcome:yes');
    expect(ro1.approvals.length + ro2.approvals.length + auto.approvals.length).toBe(0);
    const ask = turn('ask-exec', { approve: async () => ({ decision: 'deny', message: 'no' }) });
    expect(text(await collect(a.runTurn(ask.opts)))).toBe('outcome:no');
    expect(ask.approvals[0]).toMatchObject({ tool: 'Bash', summary: 'Run: rm -rf build', input: { command: 'rm -rf build' } });
  });

  test('bypass reaches the harness: an auto turn switches it to bypassPermissions, a turn that asks puts the mode back', async () => {
    const a = makeAdapter();
    const machine = new TestMachine();
    // in bypass the harness never asks, so neither does the hub
    const auto = turn('ask-exec', { harness: 'modes', machine, permission: 'auto' });
    const first = await collect(a.runTurn(auto.opts));
    expect(text(first)).toBe('outcome:bypassed');
    expect(auto.approvals).toHaveLength(0);
    const sid = (first[0] as { id: string }).id;
    // the next bypass turn on the same session sets nothing again
    expect(text(await collect(a.runTurn(turn('mode', { harness: 'modes', machine, permission: 'auto', resumeId: sid }).opts)))).toBe('mode=bypassPermissions');
    // the session left bypass: the harness asks again, through the hub
    const ask = turn('ask-exec', { harness: 'modes', machine, resumeId: sid, approve: async () => ({ decision: 'deny' }) });
    expect(text(await collect(a.runTurn(ask.opts)))).toBe('outcome:no');
    expect(ask.approvals).toHaveLength(1);
    const calls = JSON.parse(text(await collect(a.runTurn(turn('calls', { harness: 'modes', machine, resumeId: sid }).opts))));
    expect(calls.setConfig).toEqual([
      { configId: 'mode', value: 'bypassPermissions' },
      { configId: 'mode', value: 'default' },
    ]);
    expect(calls.setMode).toEqual([]);
    expect(machine.spawned).toHaveLength(1);
  });

  test('bypass reaches a harness that lists session modes through session/set_mode', async () => {
    const a = makeAdapter();
    const machine = new TestMachine();
    const auto = turn('ask-exec', { harness: 'legacyModes', machine, permission: 'auto' });
    const first = await collect(a.runTurn(auto.opts));
    expect(text(first)).toBe('outcome:bypassed');
    const sid = (first[0] as { id: string }).id;
    // plan mode (readonly) puts the mode back too; the read-only turn still answers prompts itself
    const ro = turn('ask-exec', { harness: 'legacyModes', machine, permission: 'readonly', resumeId: sid });
    expect(text(await collect(a.runTurn(ro.opts)))).toBe('outcome:no');
    expect(ro.approvals).toHaveLength(0);
    const calls = JSON.parse(text(await collect(a.runTurn(turn('calls', { harness: 'legacyModes', machine, resumeId: sid }).opts))));
    expect(calls.setMode).toEqual(['bypassPermissions', 'default']);
  });

  test('a harness with no bypass mode keeps its mode, and auto answers its prompts', async () => {
    const a = makeAdapter();
    const machine = new TestMachine();
    const auto = turn('ask-exec', { machine, permission: 'auto' });
    const first = await collect(a.runTurn(auto.opts));
    expect(text(first)).toBe('outcome:yes');
    expect(auto.approvals).toHaveLength(0);
    const calls = JSON.parse(text(await collect(a.runTurn(turn('calls', { machine, resumeId: (first[0] as { id: string }).id }).opts))));
    expect(calls.setConfig).toEqual([]);
    expect(calls.setMode).toEqual([]);
  });

  test('a turn that asks changes only a mode a bypass turn set', async () => {
    for (const harness of ['modes', 'legacyModes']) {
      const a = makeAdapter();
      const machine = new TestMachine();
      // a session no bypass turn touched: nothing is set
      const first = await collect(a.runTurn(turn('mode', { harness, machine }).opts));
      expect(text(first)).toBe('mode=default');
      const sid = (first[0] as { id: string }).id;
      // bypass, then the harness moves itself to plan during the turn and says so
      expect(text(await collect(a.runTurn(turn('to-plan', { harness, machine, permission: 'auto', resumeId: sid }).opts)))).toBe('mode=plan');
      // the next turn that asks leaves the harness's own choice alone
      expect(text(await collect(a.runTurn(turn('mode', { harness, machine, resumeId: sid }).opts)))).toBe('mode=plan');
      const calls = JSON.parse(text(await collect(a.runTurn(turn('calls', { harness, machine, resumeId: sid }).opts))));
      expect(harness === 'modes' ? calls.setConfig : calls.setMode).toEqual(harness === 'modes' ? [{ configId: 'mode', value: 'bypassPermissions' }] : ['bypassPermissions']);
    }
  });

  test('abort sends session/cancel and finishes as cancelled', async () => {
    const a = makeAdapter();
    const ctl = new AbortController();
    const evs = await collect(a.runTurn(turn('slow', { signal: ctl.signal }).opts), (e) => {
      if (e.type === 'text_delta') ctl.abort();
    });
    expect(done(evs).stopReason).toBe('cancelled');
    expect(a.poolSize).toBe(1);
    const sid = (evs[0] as { id: string }).id;
    const calls = JSON.parse(text(await collect(a.runTurn(turn('calls', { resumeId: sid }).opts))));
    expect(calls.cancel).toEqual([sid]);
  });

  test('an agent that ignores cancel is killed after the grace period', async () => {
    const a = makeAdapter({ cancelGraceMs: 300 });
    const ctl = new AbortController();
    const started = Date.now();
    const evs = await collect(a.runTurn(turn('stubborn', { signal: ctl.signal }).opts), (e) => {
      if (e.type === 'text_delta') ctl.abort();
    });
    expect(done(evs).stopReason).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(a.poolSize).toBe(0);
  });

  test('a pending approval is cancelled when the turn is aborted', async () => {
    const a = makeAdapter();
    const ctl = new AbortController();
    const { opts } = turn('ask-exec', {
      signal: ctl.signal,
      approve: () => {
        setTimeout(() => ctl.abort(), 20);
        return new Promise(() => {});
      },
    });
    const evs = await collect(a.runTurn(opts));
    expect(text(evs)).toBe('outcome:cancelled');
    expect(done(evs).stopReason).toBe('cancelled');
  });

  test('a call that never gets input is emitted before later text', async () => {
    const a = makeAdapter();
    const evs = await collect(a.runTurn(turn('think').opts));
    const call = evs.findIndex((e) => e.type === 'tool_call' && e.id === 'k1');
    const after = evs.findIndex((e) => e.type === 'text_delta' && e.text === 'after');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(after);
    expect(evs[call]).toMatchObject({ name: 'Think', title: 'Thinking', input: {} });
  });

  test('abort during a slow harness start finishes at once', async () => {
    const a = makeAdapter();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const started = Date.now();
    const evs = await collect(a.runTurn(turn('hello', { harness: 'sleepy', signal: ctl.signal }).opts));
    expect(done(evs).stopReason).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('a crash reports an error with the stderr tail', async () => {
    const a = makeAdapter();
    const evs = await collect(a.runTurn(turn('crash').opts));
    const d = done(evs);
    expect(d.stopReason).toBe('error');
    expect(d.error).toContain('fatal: something broke');
    expect(d.error).toContain('fake agent booting');
    expect(a.poolSize).toBe(0);
  });

  test('unknown or non-ACP harnesses fail cleanly', async () => {
    const a = makeAdapter();
    expect(done(await collect(a.runTurn(turn('x', { harness: 'nope' }).opts))).error).toContain('Unknown harness');
    expect(done(await collect(a.runTurn(turn('x', { harness: 'api' }).opts))).error).toContain('not an ACP harness');
    const missing = done(await collect(a.runTurn(turn('x', { harness: 'missing' }).opts)));
    expect(missing.stopReason).toBe('error');
  });

  test('idle processes are swept; shutdown kills the rest', async () => {
    const a = makeAdapter({ idleMs: 60_000 });
    await collect(a.runTurn(turn('hello').opts));
    expect(a.poolSize).toBe(1);
    a.sweep(Date.now() + 1000);
    expect(a.poolSize).toBe(1);
    a.sweep(Date.now() + 61_000);
    expect(a.poolSize).toBe(0);
    await collect(a.runTurn(turn('hello').opts));
    await a.shutdown();
    expect(a.poolSize).toBe(0);
  });

  test('probe checks the command and initializes', async () => {
    const a = makeAdapter();
    const machine = new TestMachine();
    expect(await a.probe('fake', machine)).toMatchObject({ ok: true, version: 'fake-agent 1.2.3' });
    const missing = await a.probe('missing', machine);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('not found');
    expect((await a.probe('api', machine)).ok).toBe(false);
  });
});

describe('ACP mapping helpers', () => {
  test('pickOption falls back to the nearest offered kind', () => {
    const opts = [
      { optionId: 'x', name: 'Always', kind: 'allow_always' as const },
      { optionId: 'r', name: 'Never', kind: 'reject_always' as const },
    ];
    expect(pickOption(opts, 'allow_once')).toEqual({ outcome: { outcome: 'selected', optionId: 'x' } });
    expect(pickOption(opts, 'reject_once')).toEqual({ outcome: { outcome: 'selected', optionId: 'r' } });
    expect(pickOption([], 'allow_once')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  test('summarizeCall makes one-liners', () => {
    expect(summarizeCall({ kind: 'execute', input: { command: ['git', 'status'] } })).toBe('Run: git status');
    expect(summarizeCall({ kind: 'move', input: { from: 'a', to: 'b' } })).toBe('Move a -> b');
    expect(summarizeCall({ kind: 'read', input: {}, locations: [{ path: '/x' }] })).toBe('Read /x');
    expect(summarizeCall({ kind: 'other', title: 'Do\nthings', input: {} })).toBe('Do things');
  });

  test('effortOfChoice reads a harness Effort value or name as a level', () => {
    expect(effortOfChoice('xhigh', 'Xhigh')).toBe('xhigh');
    expect(effortOfChoice('x', 'Extra high')).toBe('xhigh');
    expect(effortOfChoice('MAX')).toBe('max');
    expect(effortOfChoice('maximum')).toBe('max');
    expect(effortOfChoice('default', 'Default')).toBeUndefined();
    expect(effortOfChoice('minimal')).toBeUndefined();
  });

  test('matchChoice finds ids by id, name or substring', () => {
    const c = [
      { id: 'claude-opus-4-1', name: 'Opus' },
      { id: 'sonnet', name: 'Sonnet 4.5' },
    ];
    expect(matchChoice(c, 'sonnet')).toBe('sonnet');
    expect(matchChoice(c, 'Opus')).toBe('claude-opus-4-1');
    expect(matchChoice(c, 'opus-4')).toBe('claude-opus-4-1');
    expect(matchChoice(c, 'gpt')).toBeUndefined();
  });

  test('toAcpMcpServers drops transports the agent cannot use', () => {
    const s = { a: { url: 'http://x' }, b: { type: 'sse' as const, url: 'http://y' }, c: { command: 'c' } };
    expect(toAcpMcpServers(s, {})).toEqual([{ name: 'c', command: 'c', args: [], env: [] }]);
    expect(toAcpMcpServers(s, { http: true, sse: true })).toHaveLength(3);
  });

  test('toAcpPrompt maps images and documents by capability', () => {
    const blocks = [
      { type: 'image' as const, mediaType: 'image/png', data: 'AAAA' },
      { type: 'document' as const, mediaType: 'text/plain', data: Buffer.from('doc text').toString('base64'), title: 'n.txt' },
    ];
    expect(toAcpPrompt(blocks, undefined, {})).toEqual([
      { type: 'text', text: '[image omitted: this harness does not accept images]' },
      { type: 'text', text: '<document title="n.txt">\ndoc text\n</document>' },
    ]);
    const rich = toAcpPrompt(blocks, 'ctx', { image: true, embeddedContext: true });
    expect(rich[0]).toEqual({ type: 'text', text: '<prior_conversation>\nctx\n</prior_conversation>' });
    expect(rich[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(rich[2]).toMatchObject({ type: 'resource', resource: { text: 'doc text', mimeType: 'text/plain' } });
  });

  test('claudeRateLimitWindows maps SDK rate limit info', () => {
    expect(claudeRateLimitWindows({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1_700_000_000 })).toEqual([
      { name: '7d opus', usedPercent: 100, resetsAt: 1_700_000_000_000 },
    ]);
    expect(claudeRateLimitWindows({ status: 'allowed' })).toEqual([]);
  });
});
