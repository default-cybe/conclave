import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../../src/engine';
import type { HooksConfig } from '../../../src/config/schema';
import { Hooks } from '../../../src/extensions/hooks';
import { tempDir, cleanup } from '../_helpers';
import claude from './fixtures/claude-hook-parity.json';

/**
 * Hook parity with real Claude Code.
 *
 * fixtures/hooks/parity-hook.ts ran under Claude Code 2.1.301 (results in
 * fixtures/claude-hook-parity.json). Here the same script runs inside the real
 * Conclave engine, driven by a mock model that makes the same tool calls
 * Claude made. Each case records what Conclave did and compares it with what
 * Claude did. EXPECTED is the parity table in docs/extensions/COMPATIBILITY.md;
 * when an engine fix closes a gap, this test fails and the table must be updated.
 */

const HOOK = join(import.meta.dir, 'fixtures', 'hooks', 'parity-hook.ts');
const EXPECTED: Record<string, 'same' | 'gap'> = {
  'PreToolUse exit 2 blocks and the model sees stderr': 'same',
  'PreToolUse deny blocks and the model sees the reason': 'same',
  'PreToolUse ask forces an approval prompt': 'same',
  'PreToolUse allow skips the approval prompt': 'same',
  'PreToolUse updatedInput rewrites the command': 'same',
  'PostToolUse exit 2 stderr reaches the model': 'same',
  'PostToolUse additionalContext reaches the model': 'same',
  'if filter limits which calls run the hook': 'same',
  'UserPromptSubmit JSON additionalContext reaches the model': 'same',
  'UserPromptSubmit plain stdout reaches the model': 'same',
  'SessionStart JSON additionalContext reaches the model': 'same',
  'SessionStart plain stdout reaches the model': 'same',
  'Stop block makes the model continue once': 'same',
  'Stop input stop_hook_active is false on the first stop': 'same',
};

const dirs: string[] = [];
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
afterAll(() => {
  cleanup(...dirs);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
});

type Block = { text: string } | { tool: string; input: Record<string, unknown> };

function sse(blocks: Block[], turn: number): string {
  const events: unknown[] = [{ type: 'message_start', message: { id: `msg_${turn}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 0 } } }];
  blocks.forEach((b, index) => {
    if ('text' in b) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${turn}_${index}`, name: b.tool, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  const stop = blocks.some((b) => 'tool' in b) ? 'tool_use' : 'end_turn';
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const bash = (command: string): Block => ({ tool: 'Bash', input: { command, description: 'parity' } });

interface RunResult {
  /** Request bodies of the main agent turns, as JSON text. */
  requests: string[];
  toolResults: Array<{ command: string; content: string; isError: boolean }>;
  finalText: string;
  approvals: string[];
  hookLog: Array<{ mode: string; input: Record<string, any> }>;
  cwd: string;
}

/** Run one session in the real engine with `hooks` set in config and a scripted model. */
async function runScenario(hooks: (log: string) => HooksConfig, script: Block[][], prompt = 'go'): Promise<RunResult> {
  const home = tempDir('conclave-parity-home-');
  const cwd = tempDir('conclave-parity-cwd-');
  const claudeDir = tempDir('conclave-parity-claude-');
  dirs.push(home, cwd, claudeDir);
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const log = join(home, 'hooks.log');

  const requests: string[] = [];
  let turn = 0;
  const mock = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { tools?: unknown[] };
      // Chores (titles and the like) carry no tools; answer them without using the script.
      if (!body.tools?.length) return new Response(sse([{ text: 'ok' }], 999), { headers: { 'content-type': 'text/event-stream' } });
      requests.push(JSON.stringify(body));
      const blocks = script[Math.min(turn, script.length - 1)];
      turn++;
      return new Response(sse(blocks, turn), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const engine = await createEngine({
    home,
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'mock/claude-sonnet-5-5',
      smallModel: 'mock/claude-sonnet-5-5',
      providers: { mock: { type: 'anthropic', baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'test', models: ['claude-sonnet-5-5'] } },
      permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [] },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
      hooks: hooks(log),
    } as never,
  });

  // Headless, like `claude -p`: nobody answers a prompt, so every approval is denied.
  const approvals: string[] = [];
  const off = engine.bus.on((e: { type: string; approval?: { id: string; summary: string; input?: unknown } }) => {
    if (e.type === 'approval.requested' && e.approval) {
      approvals.push(`${e.approval.summary} ${JSON.stringify(e.approval.input ?? {})}`);
      queueMicrotask(() => engine.resolveApproval(e.approval!.id, { decision: 'deny', message: 'headless' }));
    }
  });

  try {
    const s = await engine.createSession({ title: 'parity', cwd, model: 'mock/claude-sonnet-5-5' });
    const runner = engine.runnerFor(s.id);
    await runner.enqueue({ text: prompt });
    await Promise.race([runner.waitIdle(), Bun.sleep(30_000)]);
    const msgs = engine.getMessages(s.id);
    const commands = new Map<string, string>();
    for (const m of msgs) for (const b of m.content as Array<Record<string, any>>) if (b.type === 'tool_use') commands.set(b.id, String(b.input?.command ?? ''));
    const toolResults: RunResult['toolResults'] = [];
    for (const m of msgs) {
      for (const b of m.content as Array<Record<string, any>>) {
        if (b.type !== 'tool_result') continue;
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        toolResults.push({ command: commands.get(b.toolUseId) ?? '', content, isError: !!b.isError });
      }
    }
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    const finalText = ((last?.content ?? []) as Array<Record<string, any>>).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const hookLog = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { requests, toolResults, finalText, approvals, hookLog, cwd };
  } finally {
    off();
    await engine.shutdown();
    mock.stop(true);
  }
}

const cmd = (log: string, mode: string) => ({ type: 'command' as const, command: `HOOK_LOG=${log} bun ${HOOK} ${mode}`, timeout: 30 });

const rows: Array<{ case: string; claude: string; conclave: string; status: 'same' | 'gap' }> = [];
function compare(name: string, claudeSaw: unknown, conclaveSaw: unknown, describeClaude: string, describeConclave: string) {
  rows.push({ case: name, claude: describeClaude, conclave: describeConclave, status: JSON.stringify(claudeSaw) === JSON.stringify(conclaveSaw) ? 'same' : 'gap' });
}

describe('hook parity with Claude Code 2.1.301', () => {
  test('PreToolUse: exit 2, deny, ask, allow, updatedInput', async () => {
    const r = await runScenario(
      (log) => ({ PreToolUse: [{ matcher: 'Bash', hooks: [cmd(log, 'pretool')] }] }),
      [[bash('echo cg-exit2')], [bash('echo cg-deny')], [bash('echo cg-ask')], [bash('touch cg-allow.txt')], [bash('echo cg-rewrite')], [{ text: 'done' }]],
    );
    const res = (needle: string) => r.toolResults.find((t) => t.command.includes(needle));
    const ran = (needle: string) => {
      const t = res(needle);
      return !!t && !t.isError;
    };

    expect(r.toolResults).toHaveLength(5);
    const exit2 = res('cg-exit2')!;
    compare('PreToolUse exit 2 blocks and the model sees stderr', { ran: false, reason: true }, { ran: ran('cg-exit2'), reason: exit2.content.includes('cg-exit2 is not allowed here') }, claude.pretool['cg-exit2'].toolResult, exit2.content);
    const deny = res('cg-deny')!;
    compare('PreToolUse deny blocks and the model sees the reason', { ran: false, reason: true }, { ran: ran('cg-deny'), reason: deny.content.includes('cg-deny refused by policy') }, claude.pretool['cg-deny'].toolResult, deny.content);
    const ask = res('cg-ask')!;
    compare('PreToolUse ask forces an approval prompt', { prompted: true, ran: false }, { prompted: r.approvals.some((a) => a.includes('cg-ask')), ran: ran('cg-ask') }, `prompted; headless denied: ${claude.pretool['cg-ask'].toolResult}`, `${r.approvals.some((a) => a.includes('cg-ask')) ? 'prompted' : 'no prompt'}; result: ${ask.content.trim()}`);
    compare('PreToolUse allow skips the approval prompt', { ran: true, prompted: false }, { ran: existsSync(join(r.cwd, 'cg-allow.txt')), prompted: r.approvals.some((a) => a.includes('cg-allow')) }, 'touch ran without a prompt', existsSync(join(r.cwd, 'cg-allow.txt')) ? 'touch ran without a prompt' : 'touch did not run');
    const rewrite = res('cg-rewrite')!;
    compare('PreToolUse updatedInput rewrites the command', { output: 'cg-rewritten-by-hook' }, { output: rewrite.content.trim().split('\n')[0] }, claude.pretool['cg-rewrite'].toolResult, rewrite.content.trim().split('\n')[0]);

    // Same stdin keys Claude sends for PreToolUse.
    const pre = r.hookLog.find((l) => l.mode === 'pretool')!.input;
    for (const k of claude.stdinFields.PreToolUse) expect(pre).toHaveProperty(k);
    expect(pre.hook_event_name).toBe('PreToolUse');
    expect(pre.permission_mode).toBe('default');
  }, 60_000);

  test('PostToolUse feedback and the if filter', async () => {
    const r = await runScenario(
      (log) => ({
        PreToolUse: [{ matcher: 'Bash', hooks: [{ ...cmd(log, 'block-always'), if: 'Bash(echo cg-if*)' } as never] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [cmd(log, 'posttool')] }],
      }),
      [[bash('echo cg-if-yes')], [bash('echo cg-plain')], [bash('echo cg-post2')], [bash('echo cg-postctx')], [{ text: 'done' }]],
    );
    const res = (needle: string) => r.toolResults.find((t) => t.command.includes(needle))!;
    const ifRuns = r.hookLog.filter((l) => l.mode === 'block-always').map((l) => l.input.tool_input.command);
    compare('if filter limits which calls run the hook', { yes: true, plain: false }, { yes: ifRuns.includes('echo cg-if-yes') && res('cg-if-yes').isError, plain: ifRuns.includes('echo cg-plain') }, 'hook ran only for echo cg-if-yes and blocked it', `hook ran for: ${ifRuns.join(', ') || 'nothing'}`);
    compare('PostToolUse exit 2 stderr reaches the model', true, res('cg-post2').content.includes('cg-post2 output looked wrong'), claude.posttool['cg-post2'].delivery, res('cg-post2').content.replace(/\s+/g, ' ').trim());
    compare('PostToolUse additionalContext reaches the model', true, res('cg-postctx').content.includes('post codeword is FIG'), claude.posttool['cg-postctx'].delivery, res('cg-postctx').content.replace(/\s+/g, ' ').trim());
  }, 60_000);

  test('SessionStart, UserPromptSubmit and Stop', async () => {
    const b = await runScenario(
      (log) => ({
        SessionStart: [{ hooks: [cmd(log, 'session-json')] }],
        UserPromptSubmit: [{ hooks: [cmd(log, 'prompt-plain')] }],
        Stop: [{ hooks: [cmd(log, 'stop')] }],
      }),
      [[bash('touch cg-control.txt')], [{ text: 'first answer' }], [{ text: 'MANGO' }]],
    );
    const c = await runScenario(
      (log) => ({
        SessionStart: [{ hooks: [cmd(log, 'session-plain')] }],
        UserPromptSubmit: [{ hooks: [cmd(log, 'prompt-json')] }],
      }),
      [[{ text: 'PLUM, KIWI' }]],
    );
    const firstB = b.requests[0] ?? '';
    const firstC = c.requests[0] ?? '';
    compare('UserPromptSubmit JSON additionalContext reaches the model', true, firstC.includes('second codeword is KIWI'), 'reached the model', firstC.includes('KIWI') ? 'reached the model' : 'missing');
    compare('UserPromptSubmit plain stdout reaches the model', true, firstB.includes('second codeword is KIWI'), 'reached the model', firstB.includes('KIWI') ? 'reached the model' : 'missing');
    compare('SessionStart JSON additionalContext reaches the model', true, firstB.includes('first codeword is PLUM'), 'reached the model (source: startup)', b.hookLog.some((l) => l.mode === 'session-json') ? 'hook ran' : 'SessionStart never fired');
    compare('SessionStart plain stdout reaches the model', true, firstC.includes('first codeword is PLUM'), 'reached the model', c.hookLog.some((l) => l.mode === 'session-plain') ? 'hook ran' : 'SessionStart never fired');

    // Control: without a PreToolUse hook, touch needs approval in both (headless: denied).
    expect(b.approvals.some((a) => a.includes('cg-control'))).toBe(true);

    const stops = b.hookLog.filter((l) => l.mode === 'stop').map((l) => l.input.stop_hook_active);
    compare('Stop block makes the model continue once', { continued: true, final: 'MANGO' }, { continued: stops.length === 2, final: b.finalText.trim() }, `${claude.stop.feedbackMessage.split('\n')[0]} then final text MANGO`, `stop hook calls: ${stops.length}; final text: ${b.finalText.trim()}`);
    compare('Stop input stop_hook_active is false on the first stop', [false, true], stops, 'first stop false (after a tool turn), second true', `stop_hook_active per call: ${JSON.stringify(stops)}`);
  }, 90_000);

  test('parity table matches EXPECTED', () => {
    // Printed so docs/extensions/COMPATIBILITY.md can be refreshed from a run.
    console.log('\n| Case | Claude Code 2.1.301 | Conclave | Status |\n| --- | --- | --- | --- |');
    for (const r of rows) console.log(`| ${r.case} | ${r.claude.replace(/\|/g, '\\|').slice(0, 140)} | ${r.conclave.replace(/\|/g, '\\|').slice(0, 140)} | ${r.status} |`);
    const got = Object.fromEntries(rows.map((r) => [r.case, r.status]));
    expect(got).toEqual(EXPECTED);
  });
});

describe('hook runner unit parity', () => {
  test('exit 2 with empty stderr still blocks (Claude), with a default reason', async () => {
    const out = await new Hooks().run('PreToolUse', { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, {
      matcherValue: 'Bash',
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] },
    });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain('exit 2');
  });

  test('Agent matchers fire on the Task tool and Edit matchers on MultiEdit', async () => {
    const runner = new Hooks();
    const hooks: HooksConfig = { PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'echo x' }] }, { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo y' }] }] };
    const base = { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse' as const };
    expect(runner.plan('PreToolUse', { ...base, tool_name: 'Task' }, { matcherValue: 'Task', hooks }).map((h) => h.command)).toEqual(['echo x']);
    expect(runner.plan('PreToolUse', { ...base, tool_name: 'MultiEdit' }, { matcherValue: 'MultiEdit', hooks }).map((h) => h.command)).toEqual(['echo y']);
  });

  test('plugin hooks get CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PROJECT_DIR', async () => {
    const data = tempDir();
    dirs.push(data);
    const out = await new Hooks().run('PreToolUse', { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, {
      matcherValue: 'Bash',
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'printf "%s|%s|%s" "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA" "$CLAUDE_PROJECT_DIR" >&2; exit 2',
                pluginRoot: '/opt/plug',
                pluginData: join(data, 'd'),
              } as never,
            ],
          },
        ],
      },
    });
    expect(out.reason).toBe(`/opt/plug|${join(data, 'd')}|/tmp`);
    expect(existsSync(join(data, 'd'))).toBe(true);
  });

  test('Gemini-style top-level decisions are understood', async () => {
    const run = (json: string) =>
      new Hooks().run('PreToolUse', { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls', a: 1 } }, {
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `echo '${json}'` }] }] },
      });
    const deny = await run('{"decision":"deny","reason":"no"}');
    expect(deny.blocked).toBe(true);
    expect(deny.permissionDecision).toBe('deny');
    const merged = await run('{"hookSpecificOutput":{"tool_input":{"command":"pwd"}}}');
    expect(merged.updatedInput).toEqual({ command: 'pwd', a: 1 });
  });

  test('async hooks do not hold up the event', async () => {
    const started = Date.now();
    const out = await new Hooks().run('PostToolUse', { session_id: 's', cwd: '/tmp', hook_event_name: 'PostToolUse' }, {
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'sleep 2', async: true } as never] }] },
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(out.trace?.[0].result).toBe('async');
  });
});
