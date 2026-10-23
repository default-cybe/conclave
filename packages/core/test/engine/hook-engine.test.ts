import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTestEngine, toolResults, type Block } from './harness';
import { cleanup, tempDir } from '../extensions/_helpers';

/**
 * Engine changes from docs/design/ECOSYSTEM.md 4.3, through the real engine:
 * the Stop block cap, Claude Code's tool_response objects, rewrites that keep
 * the original call's verdict, mcp_tool handlers on a real MCP server, and
 * multi-block MCP results that spill to ReadToolOutput.
 */

const bash = (command: string): Block => ({ tool: 'Bash', input: { command, description: 'test' } });
const ECHO_SERVER = join(import.meta.dir, '..', 'extensions', 'fixtures', 'mcp-echo-server.ts');
const BLOCKS_SERVER = join(import.meta.dir, 'fixtures', 'mcp-blocks-server.ts');
const rewriteTo = (command: string) => `jq -c --arg c '${command}' '{hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:(.tool_input + {command:$c})}}'`;

describe('Stop hooks', () => {
  test('a Stop hook that always blocks keeps the turn going at most 3 times', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }], [{ text: 'four' }], [{ text: 'five' }], [{ text: 'six' }]],
      hooks: () => ({ Stop: [{ hooks: [{ type: 'command', command: `echo '{"decision":"block","reason":"keep going"}'`, timeout: 10 }] }] }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(t.requests.length).toBe(4);
      const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice').map((m) => JSON.stringify(m.content));
      expect(notices.join(' ')).toMatch(/asked to keep going 3 times/);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('PostToolUse input', () => {
  test('Bash sends {stdout, stderr, interrupted, isImage} and conclave.output_text', async () => {
    const out = tempDir('conclave-hook-write-');
    const t = await startTestEngine({
      script: [[bash('echo parity-hello')], [{ tool: 'Write', input: { file_path: join(out, 'w.txt'), content: 'abc\n' } }], [{ text: 'done' }]],
      approve: 'allow',
      hooks: ({ hook }) => ({ PostToolUse: [{ matcher: 'Bash|Write', hooks: [hook('log')] }] }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      const posts = t.hookLog().filter((l) => l.input.hook_event_name === 'PostToolUse');
      const b = posts.find((l) => l.input.tool_name === 'Bash')!.input;
      expect(b.tool_response).toMatchObject({ stderr: '', interrupted: false, isImage: false });
      expect(b.tool_response.stdout).toContain('parity-hello');
      expect(b.conclave.output_text).toContain('parity-hello');
      const w = posts.find((l) => l.input.tool_name === 'Write')!.input;
      expect(w.tool_response).toMatchObject({ type: 'create', content: 'abc\n' });
      expect(String(w.tool_response.filePath)).toEndWith('w.txt');
    } finally {
      await t.close();
      cleanup(out);
    }
  }, 60_000);
});

describe('rewrites keep the original verdict', () => {
  test('an allowed command stays allowed after a hook rewrites it', async () => {
    const t = await startTestEngine({
      script: [[bash('echo safe-one')], [{ text: 'done' }]],
      approve: 'deny',
      overrides: { permissions: { mode: 'default', allow: ['Bash(echo safe-one)'], deny: [], ask: [], additionalDirectories: [] } } as never,
      hooks: () => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: rewriteTo('echo rewritten-safe'), timeout: 10 }] }] }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      expect(t.approvals).toEqual([]);
      expect(toolResults(t.engine, s.id)[0].content).toContain('rewritten-safe');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a rewrite into a denied command is denied, and a hook allow does not cover a call that needed approval', async () => {
    const t = await startTestEngine({
      script: [[bash('echo harmless')], [bash('touch needs-approval.txt')], [{ text: 'done' }]],
      approve: 'deny',
      overrides: { permissions: { mode: 'default', allow: ['Bash(echo harmless)'], deny: ['Bash(rm *)'], ask: [], additionalDirectories: [] } } as never,
      hooks: () => ({
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: rewriteTo('rm -f nothing.txt'), timeout: 10, if: 'Bash(echo *)' } as never] },
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: `jq -c '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:(.tool_input + {command:"touch rewritten.txt"})}}'`,
                timeout: 10,
                if: 'Bash(touch *)',
              } as never,
            ],
          },
        ],
      }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      const res = toolResults(t.engine, s.id);
      expect(res[0].content).toMatch(/Denied by rule Bash\(rm \*\) \(after a hook changed the input\)/);
      // the original touch needed approval, so the hook's allow did not count: the user was asked (and said no)
      expect(t.approvals.length).toBe(1);
      expect(res[1].content).toMatch(/denied/);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('a hook allow and deny rules', () => {
  test('a hook allow skips the prompt but does not undo a deny rule (Claude Code 2.1.77)', async () => {
    const allowAll = `jq -c '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:"auto-approve"}}'`;
    const t = await startTestEngine({
      script: [[bash('rm -f nothing.txt')], [bash('touch hook-allowed.txt')], [{ text: 'done' }]],
      approve: 'deny',
      overrides: { permissions: { mode: 'default', allow: [], deny: ['Bash(rm *)'], ask: [], additionalDirectories: [] } } as never,
      hooks: () => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: allowAll, timeout: 10 }] }] }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      const res = toolResults(t.engine, s.id);
      expect(res[0].content).toMatch(/Denied by rule Bash\(rm \*\)/);
      // the touch needed approval; the hook allowed it, so nobody was asked
      expect(t.approvals).toEqual([]);
      expect(res[1].content).not.toMatch(/denied|Denied/);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('MCP-aware hooks', () => {
  test('an mcp_tool SessionStart handler adds a read-only tool\'s answer to the context', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'ok' }]],
      overrides: { mcpServers: { echo: { command: 'bun', args: [ECHO_SERVER] } } } as never,
      hooks: () => ({
        SessionStart: [
          { hooks: [{ type: 'mcp_tool', server: 'echo', tool: 'echo', input: { text: 'start ${source} in ${cwd}' } } as never] },
          { hooks: [{ type: 'mcp_tool', server: 'echo', tool: 'write_note', input: { note: 'x' } } as never] },
        ],
      }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(t.requests[0]).toContain(`echo: start startup in ${t.cwd}`);
      expect(t.requests[0]).not.toContain('noted: x');
      const runs = t.engine.hookRunner!.recent({ event: 'SessionStart' });
      expect(runs.find((r) => r.label === 'mcp echo write_note')?.result).toBe('skipped');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a big MCP result in several blocks spills to ReadToolOutput', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'mcp__blocks__many', input: {} }], [{ text: 'done' }]],
      overrides: { mcpServers: { blocks: { command: 'bun', args: [BLOCKS_SERVER] } }, context: { compactAt: 0.8, maxToolResultChars: 6_000, clearToolResultsAfterTurns: 50, promptCaching: false } } as never,
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      const r = toolResults(t.engine, s.id)[0];
      expect(r.content).toMatch(/Full output id: /);
      expect(r.content.length).toBeLessThan(8_000);
    } finally {
      await t.close();
    }
  }, 60_000);
});
