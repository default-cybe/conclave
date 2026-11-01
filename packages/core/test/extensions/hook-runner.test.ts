import { describe, test, expect, afterAll } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTEXT_BUDGET, Hooks, capContext, ifMatches, interpolateInput, mergeOutcomes, summarize } from '../../src/extensions/hooks';
import type { HookInput, RuntimeHookCommand } from '../../src/extensions/types';
import type { HookEvent, HooksConfig } from '../../src/config/schema';
import { tempDir, cleanup } from './_helpers';

/** Runner changes from ECOSYSTEM.md 4.3 (P0 and P1). */

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

function input(over: Partial<HookInput> = {}): HookInput {
  return { session_id: 's1', cwd: process.cwd(), hook_event_name: 'PreToolUse', ...over };
}
const one = (event: HookEvent, h: RuntimeHookCommand, matcher?: string): HooksConfig => ({ [event]: [{ ...(matcher ? { matcher } : {}), hooks: [h] }] }) as HooksConfig;
const cmd = (command: string, extra: Partial<RuntimeHookCommand> = {}): RuntimeHookCommand => ({ type: 'command', command, ...extra });

describe('prompt hooks read Claude Code\'s {ok, reason} answer', () => {
  test('ok false blocks with the reason, ok true does nothing', async () => {
    const no = new Hooks({ complete: async () => '{"ok": false, "reason": "bun test did not run in this turn"}' });
    const out = await no.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: one('Stop', { type: 'prompt', prompt: 'check' }) });
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('bun test did not run in this turn');
    expect(out.trace?.[0].result).toBe('block');

    const yes = new Hooks({ complete: async () => 'Looks fine.\n```json\n{"ok": true}\n```' });
    const ok = await yes.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: one('Stop', { type: 'prompt', prompt: 'check' }) });
    expect(ok.blocked).toBe(false);
    expect(ok.trace?.[0].result).toBe('noop');
  });

  test('ok false on PreToolUse denies the call', async () => {
    const h = new Hooks({ complete: async () => '{"ok":false,"reason":"writes outside the repo"}' });
    const out = await h.run('PreToolUse', input({ tool_name: 'Write' }), { matcherValue: 'Write', hooks: one('PreToolUse', { type: 'prompt', prompt: 'x' }) });
    expect(out.permissionDecision).toBe('deny');
    expect(out.reason).toBe('writes outside the repo');
  });

  test('a prompt hook that takes too long times out instead of holding the turn', async () => {
    const h = new Hooks({ complete: ({ signal }) => new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')))) });
    const out = await h.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: one('Stop', { type: 'prompt', prompt: 'x', timeout: 0.2 }) });
    expect(out.blocked).toBe(false);
    expect(out.trace?.[0].result).toBe('timeout');
    expect(out.systemMessages[0]).toMatch(/timed out after 0.2s/);
  });
});

describe('outcomes and summaries', () => {
  test('a deny with no reason uses the systemMessage (hookify)', async () => {
    const h = new Hooks();
    const json = JSON.stringify({ systemMessage: 'hookify rule block-rm-rf: rm -rf is blocked here.', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    const out = await h.run('PreToolUse', input({ tool_name: 'Bash' }), { matcherValue: 'Bash', hooks: one('PreToolUse', cmd(`echo '${json}'`)) });
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('hookify rule block-rm-rf: rm -rf is blocked here.');
  });

  test('summarize says replace for an output rewrite', () => {
    expect(summarize({ blocked: false, additionalContext: [], systemMessages: [], updatedToolOutput: 'short' })).toBe('replace');
  });

  test('a block\'s reason wins over an allow\'s', () => {
    const m = mergeOutcomes([
      { blocked: false, additionalContext: [], systemMessages: [], permissionDecision: 'allow', reason: 'fine' },
      { blocked: true, additionalContext: [], systemMessages: [], permissionDecision: 'deny', reason: 'force push' },
    ]);
    expect(m.reason).toBe('force push');
  });

  test('exit 127 says a program is missing', async () => {
    const out = await new Hooks().run('PostToolUse', input({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), { matcherValue: 'Bash', hooks: one('PostToolUse', cmd('no-such-program-xyz --flag')) });
    expect(out.trace?.[0].result).toBe('error');
    expect(out.systemMessages[0]).toMatch(/was not found \(exit 127\)/);
    expect(out.trace?.[0].note).toMatch(/not on PATH/);
  });
});

describe('if rules on MCP tools', () => {
  test('mcp__server__* and mcp__server both match that server\'s tools', () => {
    const i = input({ tool_name: 'mcp__github__create_issue', tool_input: {} });
    expect(ifMatches('mcp__github__*', i)).toBe(true);
    expect(ifMatches('mcp__github', i)).toBe(true);
    expect(ifMatches('mcp__*', i)).toBe(true);
    expect(ifMatches('mcp__gitlab__*', i)).toBe(false);
    expect(ifMatches('mcp__github__create_*', i)).toBe(true);
    expect(ifMatches('mcp__github__list_*', i)).toBe(false);
  });
});

describe('rewrites run in order', () => {
  test('the second PreToolUse rewrite sees the first one\'s input, and the trace says so', async () => {
    const add = (tag: string) =>
      cmd(`jq -c --arg t ${tag} '{hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:(.tool_input + {tags:((.tool_input.tags // []) + [$t])})}}'`);
    const hooks: HooksConfig = { PreToolUse: [{ hooks: [add('repo:conclave'), add('device:local')] }] };
    const out = await new Hooks().run('PreToolUse', input({ tool_name: 'MemorySave', tool_input: { content: 'x', tags: ['homelab'] } }), { matcherValue: 'MemorySave', hooks });
    expect(out.updatedInput).toEqual({ content: 'x', tags: ['homelab', 'repo:conclave', 'device:local'] });
    expect(out.trace?.[1].note).toMatch(/Changed the input after/);
  });
});

describe('onFailure, once, suppressOutput and statusMessage', () => {
  test('onFailure block fails closed on a crash and on a timeout', async () => {
    const h = new Hooks();
    const crash = await h.run('PreToolUse', input({ tool_name: 'Bash' }), { matcherValue: 'Bash', hooks: one('PreToolUse', cmd('exit 1', { onFailure: 'block' })) });
    expect(crash.blocked).toBe(true);
    expect(crash.permissionDecision).toBe('deny');
    expect(crash.reason).toMatch(/blocks on failure failed \(exit 1\)/);
    const slow = await h.run('PreToolUse', input({ tool_name: 'Bash' }), { matcherValue: 'Bash', hooks: one('PreToolUse', cmd('sleep 5', { onFailure: 'block', timeout: 0.2 })) });
    expect(slow.blocked).toBe(true);
    expect(slow.reason).toMatch(/timed out/);
    const open = await h.run('PreToolUse', input({ tool_name: 'Bash' }), { matcherValue: 'Bash', hooks: one('PreToolUse', cmd('exit 1')) });
    expect(open.blocked).toBe(false);
  });

  test('once runs a handler once per session', async () => {
    const h = new Hooks();
    const hooks = one('SessionStart', cmd('echo hello once', { once: true }));
    const a = await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks });
    const b = await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks });
    const c = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', session_id: 's2' }), { hooks });
    expect(a.additionalContext).toEqual(['hello once']);
    expect(b.additionalContext).toEqual([]);
    expect(c.additionalContext).toEqual(['hello once']);
  });

  test('once does not hide a handler from the Hooks tab test runner (session "test")', async () => {
    const h = new Hooks();
    const hooks = one('SessionStart', cmd('echo hello once', { once: true }));
    for (let i = 0; i < 3; i++) {
      const o = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', session_id: 'test' }), { hooks });
      expect(o.additionalContext).toEqual(['hello once']);
    }
  });

  test('suppressOutput keeps stdout out of the run log, statusMessage is reported while it runs', async () => {
    const seen: string[] = [];
    const h = new Hooks({ onStatus: (_i, text, done) => void seen.push(`${done ? 'done' : 'start'} ${text}`) });
    const out = await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks: one('SessionStart', cmd('echo secret-ish context', { suppressOutput: true, statusMessage: 'Loading notes' })) });
    expect(out.additionalContext).toEqual(['secret-ish context']);
    expect(out.trace?.[0].stdout).toBe('');
    expect(h.recent().at(-1)?.stdout).toBe('');
    expect(seen).toEqual(['start Loading notes', 'done Loading notes']);
  });
});

describe('context budgets', () => {
  test('capContext cuts and says how much', () => {
    const r = capContext(['a'.repeat(30), 'b'.repeat(30)], 40);
    expect(r.over).toBe(20);
    expect(r.list.join('')).toContain('[cut by Conclave: 20 chars over budget]');
    expect(r.list.slice(0, -1).join('').length).toBe(40);
  });

  test('UserPromptSubmit is capped per handler; SessionStart in total; additionalContextLimit per handler', async () => {
    const h = new Hooks();
    const big = (n: number) => `printf '%${n}s' | tr ' ' x`;
    const p = await h.run('UserPromptSubmit', input({ hook_event_name: 'UserPromptSubmit', session_id: 'b1' }), { hooks: one('UserPromptSubmit', cmd(big(5000))) });
    expect(p.additionalContext[0].length).toBe(CONTEXT_BUDGET.prompt);
    expect(p.trace?.[0].note).toMatch(/cut to 2000 chars/);
    expect(p.trace?.[0].contextChars).toBeGreaterThan(CONTEXT_BUDGET.prompt);

    const hooks: HooksConfig = { SessionStart: [{ hooks: [cmd(big(8000)), cmd(big(8000))] }] };
    const s = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', session_id: 'b2' }), { hooks });
    const total = s.additionalContext.filter((x) => !x.startsWith('[cut')).reduce((n, x) => n + x.length, 0);
    expect(total).toBe(CONTEXT_BUDGET.start);
    expect(s.systemMessages.join(' ')).toMatch(/4000 chars over the 12000 char budget/);

    const lim = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', session_id: 'b3' }), { hooks: one('SessionStart', cmd(big(900), { additionalContextLimit: 300 })) });
    expect(lim.additionalContext[0].length).toBe(300);
    // priced per session from recent runs: about 2000+ chars, so 500+ tokens
    expect(h.tokensPerSession('UserPromptSubmit', big(5000))).toBeGreaterThanOrEqual(500);
  });
});

describe('mcp_tool handlers', () => {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const h = new Hooks({
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { text: tool === 'fail' ? 'boom' : `notes for ${String(args.query)}`, isError: tool === 'fail' };
    },
    toolReadOnly: async (_s, tool) => (tool === 'search_notes' || tool === 'fail' ? true : tool === 'write_note' ? false : undefined),
  });

  test('a read-only tool runs with ${path} from the hook input and its text becomes context', async () => {
    const out = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', cwd: '/home/kai/code/conclave' }), {
      hooks: one('SessionStart', { type: 'mcp_tool', server: 'basic-memory', tool: 'search_notes', input: { query: '${cwd}', page_size: 5 } }),
    });
    expect(calls.at(-1)).toEqual({ server: 'basic-memory', tool: 'search_notes', args: { query: '/home/kai/code/conclave', page_size: 5 } });
    expect(out.additionalContext).toEqual(['notes for /home/kai/code/conclave']);
    expect(out.trace?.[0].label).toBe('mcp basic-memory search_notes');
  });

  test('a write tool is skipped unless allowWrite, and errors are reported', async () => {
    const before = calls.length;
    const skipped = await h.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: one('Stop', { type: 'mcp_tool', server: 'basic-memory', tool: 'write_note', input: {} }) });
    expect(calls.length).toBe(before);
    expect(skipped.systemMessages[0]).toMatch(/not marked read only/);
    await h.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: one('Stop', { type: 'mcp_tool', server: 'basic-memory', tool: 'write_note', input: {}, allowWrite: true }) });
    expect(calls.length).toBe(before + 1);
    const err = await h.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: one('Stop', { type: 'mcp_tool', server: 'basic-memory', tool: 'fail', input: {} }) });
    expect(err.trace?.[0].result).toBe('error');
  });

  test('interpolateInput keeps types for whole placeholders and leaves other ${} alone', () => {
    const src = { tool_input: { file_path: 'src/a.ts', n: 3 }, cwd: '/r' };
    expect(interpolateInput<Record<string, unknown>>({ a: '${tool_input.n}', b: 'at ${tool_input.file_path}', c: '${secret:x}', d: ['${cwd}'] }, src)).toEqual({ a: 3, b: 'at src/a.ts', c: '${secret:x}', d: ['/r'] });
  });
});

describe('plugin hook environment', () => {
  const root = tempDir('conclave-plugin-env-');
  dirs.push(root);
  const dump = (name: string) => cmd(`env | grep -E '^(PLUGIN_ROOT|PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_CONFIG_DIR|CONCLAVE)=' | sort > ${join(root, name)}`);
  const read = (name: string) => Object.fromEntries(readFileSync(join(root, name), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  test('Claude-format plugins get CLAUDE_ names only and their own config dir; Codex plugins also get PLUGIN_ROOT', async () => {
    const claudeRoot = join(root, 'claude-plugin');
    const codexRoot = join(root, 'codex-plugin');
    mkdirSync(join(claudeRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(claudeRoot, '.claude-plugin', 'plugin.json'), '{"name":"ponytail"}');
    mkdirSync(join(codexRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(join(codexRoot, '.codex-plugin', 'plugin.json'), '{"name":"cx"}');
    const h = new Hooks();
    const data = join(root, 'data', 'ponytail');
    await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks: one('SessionStart', { ...dump('claude.env'), plugin: 'ponytail', pluginRoot: claudeRoot, pluginData: data }) });
    await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks: one('SessionStart', { ...dump('codex.env'), plugin: 'cx', pluginRoot: codexRoot, pluginData: join(root, 'data', 'cx') }) });
    await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks: one('SessionStart', { ...dump('shared.env'), plugin: 'ponytail', pluginRoot: claudeRoot, pluginData: data, shareClaudeConfig: true }) });
    const c = read('claude.env');
    // a status line that does nothing, so mode plugins do not ask the model to set one up
    expect(JSON.parse(readFileSync(join(data, 'claude-config', 'settings.json'), 'utf8')).statusLine).toEqual({ type: 'command', command: 'true' });
    expect(c.CLAUDE_PLUGIN_ROOT).toBe(claudeRoot);
    expect(c.CLAUDE_PLUGIN_DATA).toBe(data);
    expect(c.PLUGIN_ROOT).toBeUndefined();
    expect(c.PLUGIN_DATA).toBeUndefined();
    expect(c.CONCLAVE).toBe('1');
    expect(c.CLAUDE_CONFIG_DIR).toBe(join(data, 'claude-config'));
    expect(existsSync(join(data, 'claude-config'))).toBe(true);
    const x = read('codex.env');
    expect(x.PLUGIN_ROOT).toBe(codexRoot);
    expect(x.PLUGIN_DATA).toBe(join(root, 'data', 'cx'));
    expect(read('shared.env').CLAUDE_CONFIG_DIR).not.toBe(join(data, 'claude-config'));
  });

  test('without node on PATH, hooks get a node shim that runs Bun', async () => {
    const shim = join(root, 'shim');
    const savedPath = process.env.PATH;
    const bunDir = Bun.which('bun')!.replace(/\/bun$/, '');
    process.env.PATH = `${bunDir}:/usr/bin:/bin`;
    try {
      if (Bun.which('node')) return; // node lives in /usr/bin here; nothing to prove
      const h = new Hooks({ shimDir: shim });
      const out = await h.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks: one('SessionStart', cmd(`node -e 'console.log("from " + typeof Bun)'`)) });
      expect(out.additionalContext).toEqual(['from object']);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('a plugin hook for a session whose folder is on another device', () => {
  test('starts in the plugin data folder instead of failing', async () => {
    const data = join(tempDir(), 'plugin-data');
    dirs.push(data);
    const h = new Hooks();
    const conf = one('SessionStart', cmd('pwd', { plugin: 'caveman', pluginData: data }));
    const out = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', cwd: '/Users/someone/not/on/this/hub' }), { hooks: conf });
    expect(out.systemMessages.join(' ')).not.toContain('did not start');
    expect(out.trace?.[0].result).not.toBe('error');
    expect(existsSync(data)).toBe(true);
  });

  // root may enter any folder, so this needs a normal user (CI runs as one)
  test.skipIf(process.getuid?.() === 0)('starts in the plugin data folder when the hub cannot enter the session folder', async () => {
    const locked = join(tempDir(), 'locked');
    mkdirSync(locked, { mode: 0o000 });
    const data = join(tempDir(), 'plugin-data-2');
    dirs.push(locked, data);
    const h = new Hooks();
    const out = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', cwd: locked }), { hooks: one('SessionStart', cmd('pwd', { plugin: 'caveman', pluginData: data })) });
    chmodSync(locked, 0o700);
    expect(out.systemMessages.join(' ')).not.toContain('did not start');
  });

  test("the owner's own hook still says it could not start there", async () => {
    const h = new Hooks();
    const out = await h.run('SessionStart', input({ hook_event_name: 'SessionStart', cwd: '/Users/someone/not/on/this/hub' }), { hooks: one('SessionStart', cmd('pwd')) });
    expect(out.systemMessages.join(' ')).toContain('did not start');
  });
});
