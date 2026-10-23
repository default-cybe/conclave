import { describe, expect, test } from 'bun:test';
import { CLEAR_BATCH_TOKENS, CLEAR_PROTECT_TOKENS, markCleared, planClearing } from '../../src/session/context-edit';
import { buildProviderMessages } from '../../src/session/transcript';
import { buildSystemPrompt, type PromptParts } from '../../src/session/prompt';
import type { ProviderMessage } from '../../src/providers/types';
import type { ContentBlock, Message } from '../../src/types';

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `msg_${seq}`, sessionId: 'ses_x', seq, role, kind: 'normal', content, createdAt: seq, model: 'm/x', ...extra };
}

/** One tool call and its result, as two stored messages. */
function call(name: string, input: Record<string, unknown>, result: string, isError = false): Message[] {
  const id = `toolu_${seq + 1}`;
  return [msg('assistant', [{ type: 'tool_use', id, name, input }]), msg('user', [{ type: 'tool_result', toolUseId: id, content: result, isError }])];
}

const build = (all: Message[]) => buildProviderMessages(all, { modelRef: 'm/x', toolNames: new Set(['Bash', 'Read', 'Write', 'Edit', 'TodoWrite']), cache: true });
/** A request's messages as the bytes a cache compares: breakpoint flags are not part of the prefix. */
const bytes = (msgs: ProviderMessage[]) => msgs.map((m) => JSON.stringify({ role: m.role, content: m.content }));

/** Apply a clearing pass to stored messages, as applyClearing does through the engine. */
function clearPass(all: Message[], opts = {}): number {
  const plan = planClearing(all, opts);
  for (const m of markCleared(all, plan, 1)) all[all.findIndex((x) => x.id === m.id)] = m;
  return plan.results.size + plan.inputs.size;
}

describe('batch clearing plan', () => {
  test('nothing is cleared while old prunable output stays under the batch threshold', () => {
    const all = [msg('user', [{ type: 'text', text: 'go' }]), ...call('Bash', { command: 'a' }, 'x'.repeat(100_000))];
    expect(planClearing(all).results.size).toBe(0);
  });

  test('past the threshold every old prunable result clears in one batch; the newest output, small and exempt results stay', () => {
    const all: Message[] = [msg('user', [{ type: 'text', text: 'go' }])];
    for (let i = 0; i < 12; i++) all.push(...call('Bash', { command: `cmd ${i}` }, String.fromCharCode(97 + i).repeat(40_000)));
    all.push(...call('Bash', { command: 'small' }, 'tiny'));
    all.push(...call('TodoWrite', { todos: [] }, 't'.repeat(10_000)));
    const plan = planClearing(all, { protectTokens: CLEAR_PROTECT_TOKENS, batchTokens: CLEAR_BATCH_TOKENS });
    // 50k tokens = 200k chars protected: the newest five 40k results stay
    expect(plan.results.size).toBe(7);
    const kept = all.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && !plan.results.has(b.toolUseId)).length;
    expect(kept).toBe(12 - 7 + 2);
  });

  test('a Write payload is stubbed only after a later Read or write of the same path succeeded', () => {
    const big = 'w'.repeat(5_000);
    const all: Message[] = [
      msg('user', [{ type: 'text', text: 'go' }]),
      ...call('Write', { file_path: '/a.ts', content: big }, 'Created /a.ts'),
      ...call('Write', { file_path: '/b.ts', content: big }, 'Created /b.ts'),
      ...call('Read', { file_path: '/a.ts' }, 'ok'),
      ...call('Edit', { file_path: '/b.ts', old_string: 'x', new_string: 'y' }, 'refused', true),
    ];
    const plan = planClearing(all, { protectTokens: 0, batchTokens: 0 });
    const writeA = (all[1].content[0] as { id: string }).id;
    expect([...plan.inputs.keys()]).toEqual([writeA]);

    clearPass(all, { protectTokens: 0, batchTokens: 0 });
    const out = JSON.stringify(build(all));
    expect(out).toContain('"file_path":"/a.ts","content":"[5000 chars cleared to save context]"');
    // /b.ts was only touched by a failed Edit afterwards: its payload stays
    expect(out).toContain(big);
  });

  test('a cleared result goes as a stub that names its output, and the stored content stays', () => {
    const all = [msg('user', [{ type: 'text', text: 'go' }]), ...call('Bash', { command: 'log' }, 'L'.repeat(9_000))];
    expect(clearPass(all, { protectTokens: 0, batchTokens: 0 })).toBe(1);
    const stored = all[2].content[0] as { content: string; meta: Record<string, unknown> };
    expect(stored.content).toBe('L'.repeat(9_000));
    expect(stored.meta.cleared).toEqual({ at: 1, chars: 9_000 });
    const text = JSON.stringify(build(all));
    expect(text).toContain('[Old tool result cleared to save context (9000 chars). Full output id: toolu_');
    expect(text).not.toContain('LLLL');
    // a second pass finds nothing new to clear
    expect(clearPass(all, { protectTokens: 0, batchTokens: 0 })).toBe(0);
  });
});

describe('cache prefix across turns', () => {
  /**
   * 40 user turns, each with two ~15k-char tool results: 120 requests. Every
   * request must start with the bytes of the request before it, except when
   * a clearing batch runs. The old rule (clear results older than 12 turns)
   * moved its boundary on every turn from the 14th on, so it broke the prefix
   * 27 times in the same session.
   */
  test('the request prefix stays byte-identical between turns; only a clearing batch changes it', () => {
    const all: Message[] = [];
    let prev: string[] | undefined;
    let requests = 0;
    let breaks = 0;
    let batches = 0;
    // one model request: the clearing pass, then the build, compared with the request before
    const request = () => {
      requests++;
      const batch = clearPass(all) > 0;
      if (batch) batches++;
      const cur = bytes(build(all));
      if (prev && !prev.every((m, i) => cur[i] === m)) {
        breaks++;
        expect(batch).toBe(true);
      }
      prev = cur;
    };
    for (let turn = 0; turn < 40; turn++) {
      all.push(msg('user', [{ type: 'text', text: `step ${turn}` }]));
      request();
      all.push(...call('Bash', { command: `build ${turn}` }, `b${turn} `.repeat(3_000)));
      request();
      all.push(...call('Read', { file_path: `/f${turn}.ts` }, `r${turn} `.repeat(3_000)));
      request();
      all.push(msg('assistant', [{ type: 'text', text: `done ${turn}` }]));
    }
    expect(requests).toBe(120);
    expect(batches).toBeGreaterThan(0);
    expect(breaks).toBe(batches);
    // about 280k tokens of output: protect 50k, then one batch per 30k past it
    expect(breaks).toBeLessThanOrEqual(8);

    // the same session under the old rule: results over 2,000 chars clear once they are 12 user turns old
    const oldRule = (msgs: Message[]) => {
      const turnOf = new Map<string, number>();
      let turns = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && msgs[i].content.some((b) => b.type === 'text')) turns++;
        turnOf.set(msgs[i].id, turns);
      }
      return msgs.map((m) => (turnOf.get(m.id)! > 12 ? { ...m, content: m.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 2_000 ? { ...b, content: '[cleared]' } : b)) } : m));
    };
    const fresh = all.map((m) => ({ ...m, content: m.content.map((b) => (b.type === 'tool_result' ? { ...b, meta: undefined } : b)) }));
    let oldBreaks = 0;
    let before: string[] | undefined;
    for (let n = 1; n <= fresh.length; n++) {
      if (fresh[n - 1].role !== 'user') continue;
      const cur = bytes(build(oldRule(fresh.slice(0, n))));
      if (before && !before.every((m, i) => cur[i] === m)) oldBreaks++;
      before = cur;
    }
    // from the 14th turn on, every new turn moves the boundary
    expect(oldBreaks).toBe(27);
    console.log(`cache prefix breaks over ${requests} requests: batch rule ${breaks} (${batches} batches), old 12-turn rule ${oldBreaks}`);
  });
});

describe('system prompt has no volatile tokens', () => {
  test('no UUIDs, JWTs, ISO times or long hex in the built prompt', () => {
    const parts: PromptParts = {
      session: { id: 'ses_0mvdggp4klsn8ewf8kc', title: 't', agent: 'coder', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'default', cwd: '/home/u/code/app', device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: 1, updatedAt: 1, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } },
      agent: { name: 'coder', description: 'd', prompt: 'You write code.', source: 'builtin' },
      modelRef: 'anthropic/claude-sonnet-5-5',
      mode: 'agent',
      toolNames: ['Read', 'Skill'],
      platform: 'linux',
      hostname: 'madx',
      isGitRepo: true,
      deviceName: 'madx',
      projectInstructions: [{ path: '/home/u/code/app/AGENTS.md', content: 'Use bun.' }],
      profile: [{ id: 'mem_1', scope: 'global', kind: 'profile', content: 'Prefers short replies.', tags: [], importance: 0.5, createdAt: 1, updatedAt: 1, useCount: 0 }],
      skills: [{ name: 'pdf', description: 'Read PDFs', path: '/s/pdf/SKILL.md', dir: '/s/pdf', source: 'user' } as never],
      subagents: [],
      date: '2026-10-18',
      testCommand: 'bun test',
    };
    const text = buildSystemPrompt(parts).map((b) => b.text).join('\n');
    const volatile = [
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
      /\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{32}\b/i,
      /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm|utc)?\b/i,
    ];
    for (const re of volatile) expect(text).not.toMatch(re);
    expect(text).toContain("Today's date: 2026-10-18");
  });
});
