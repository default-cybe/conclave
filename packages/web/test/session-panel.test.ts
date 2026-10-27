/**
 * The session panel's cards (features/chat/panel.ts): which a conversation
 * gets, what it made (Outputs), the background shells it started, and how
 * full its context is.
 */
import { describe, expect, test } from 'bun:test';
import type { ContentBlock, Message } from '@conclave/core/types';
import { backgroundShells, callCostWord, contextPercent, costWord, outputsWord, panelCards, sessionOutputs, stateWord, statusParts } from '../src/features/chat/panel';

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], at = 1000 + seq * 10): Message {
  seq++;
  return { id: `m${seq}`, sessionId: 's', seq, role, content, createdAt: at } as Message;
}
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
const result = (toolUseId: string, content: string | ContentBlock[], extra: Record<string, unknown> = {}): ContentBlock => ({ type: 'tool_result', toolUseId, content: content as never, ...extra });

describe('which cards', () => {
  test('Code has them all; the assistant no Environment or Changes; a chat its Context, Outputs and Memory used', () => {
    expect(panelCards({ kind: 'session', agent: 'coder' } as never)).toEqual(['environment', 'context', 'connectors', 'plan', 'outputs', 'changes', 'tasks', 'memory']);
    expect(panelCards({ kind: 'session', agent: 'assistant' } as never)).toEqual(['context', 'connectors', 'plan', 'outputs', 'tasks', 'memory']);
    expect(panelCards({ kind: 'chat', agent: 'chat' } as never)).toEqual(['context', 'outputs', 'memory']);
  });
});

describe('Outputs', () => {
  test('one row per file written (the last write wins), failed writes left out, pictures and pages too, newest first', () => {
    const list = sessionOutputs([
      msg('assistant', [use('w1', 'Write', { file_path: '/home/kai/code/site/index.html', content: '<!doctype html><title>Status</title><p>ok</p>' })], 100),
      msg('user', [result('w1', 'Wrote 1 line')], 110),
      msg('assistant', [use('e1', 'Edit', { file_path: '/home/kai/code/site/src/app.ts', old_string: 'a', new_string: 'b' }), use('e2', 'Edit', { file_path: '/home/kai/code/site/src/bad.ts' })], 200),
      msg('user', [result('e1', 'ok'), result('e2', 'old_string not found', { isError: true })], 210),
      msg('assistant', [use('e3', 'Edit', { file_path: '/home/kai/code/site/index.html', old_string: 'ok', new_string: 'fine' })], 300),
      msg('user', [result('e3', 'ok')], 310),
      msg('assistant', [use('shot', 'mcp__browser__screenshot', {})], 400),
      msg('user', [result('shot', [{ type: 'text', text: 'Took it' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] as ContentBlock[])], 410),
      msg('assistant', [{ type: 'text', text: 'Here it is:\n\n```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```\n\nand some code:\n\n```ts\nconst x = 1;\n```' }], 500),
    ]);
    expect(list.map((o) => [o.kind, o.label])).toEqual([
      ['artifact', 'SVG drawing'],
      ['image', 'Image'],
      ['file', 'index.html'],
      ['file', 'app.ts'],
    ]);
    const html = list.find((o) => o.label === 'index.html')!;
    // the Edit came last, so the row opens that call; it has no content of its own to preview
    expect(html).toMatchObject({ path: '/home/kai/code/site/index.html', detail: 'code/site', toolUseId: 'e3' });
    expect(html.page).toBeUndefined();
    expect(list.find((o) => o.label === 'app.ts')?.detail).toBe('site/src');
    expect(list[0].page?.lang).toBe('svg');
    expect(list[1].image).toEqual({ mediaType: 'image/png', data: 'AAAA', url: undefined });
  });

  test('a page written to a file previews, with its title', () => {
    const [o] = sessionOutputs([msg('assistant', [use('w', 'Write', { file_path: '/tmp/x/report.html', content: '<html><title>Rack</title></html>' })])]);
    expect(o.page).toEqual({ lang: 'html', code: '<html><title>Rack</title></html>' });
    const [a] = sessionOutputs([msg('assistant', [{ type: 'text', text: '```html\n<html><head><title>Status page</title></head></html>\n```' }])]);
    expect(a).toMatchObject({ kind: 'artifact', label: 'Status page' });
  });

  test('the value', () => {
    expect(outputsWord([])).toBe('None yet');
    expect(outputsWord(sessionOutputs([msg('assistant', [use('w', 'Write', { file_path: 'a.ts', content: 'x' }), use('v', 'Write', { file_path: 'b.ts', content: 'y' })])]))).toBe('2 files');
  });
});

describe('background shells', () => {
  test('running until BashOutput or KillShell says it ended', () => {
    const shells = backgroundShells([
      msg('assistant', [use('b1', 'Bash', { command: 'bun run dev', run_in_background: true, description: 'Dev server' }), use('b2', 'Bash', { command: 'bun test --watch', run_in_background: true })], 100),
      msg('user', [result('b1', 'Command running in background with id bash_1.', { meta: { shellId: 'bash_1', background: true } }), result('b2', 'Command running in background with id bash_2. Use BashOutput')], 110),
      msg('assistant', [use('b3', 'Bash', { command: 'ls' })], 200),
      msg('user', [result('b3', 'a b c')], 210),
      msg('assistant', [use('o1', 'BashOutput', { bash_id: 'bash_2' })], 300),
      msg('user', [result('o1', 'done', { meta: { shellId: 'bash_2', status: 'completed', exitCode: 0 } })], 310),
    ]);
    expect(shells.map((x) => [x.id, x.state, x.description ?? x.command])).toEqual([
      ['bash_1', 'running', 'Dev server'],
      ['bash_2', 'completed', 'bun test --watch'],
    ]);
    const killed = backgroundShells([
      msg('assistant', [use('b1', 'Bash', { command: 'python -m http.server', run_in_background: true })]),
      msg('user', [result('b1', 'x', { meta: { shellId: 'bash_7', background: true } })]),
      msg('assistant', [use('k', 'KillShell', { shell_id: 'bash_7' })]),
      msg('user', [result('k', 'Killed shell bash_7 (python -m http.server).', { meta: { shellId: 'bash_7' } })]),
    ]);
    expect(killed[0].state).toBe('killed');
  });
});

describe('Context', () => {
  test('a percent of the window, at least 1 once something is in it', () => {
    expect(contextPercent(0, 200_000)).toBeUndefined();
    expect(contextPercent(1000, undefined)).toBeUndefined();
    expect(contextPercent(9_800, 1_000_000)).toBe(1);
    expect(contextPercent(50_000, 200_000)).toBe(25);
    expect(contextPercent(300_000, 200_000)).toBe(100);
  });
});

describe('status line', () => {
  const priced = { inputPrice: 3, outputPrice: 15 };
  test('cost: the bill, plan when a plan served it or nothing is priced per token, local on this machine', () => {
    expect(costWord({ costUsd: 1.5 }, 'anthropic/claude-opus-5-5', priced)).toBe('$1.50');
    expect(costWord({ costUsd: 0, apiValueUsd: 4 }, 'anthropic/claude-opus-5-5', priced)).toBe('plan');
    expect(costWord({ costUsd: 0 }, 'anthropic/claude-opus-5-5', priced)).toBe('$0');
    expect(costWord({ costUsd: 0 }, 'anthropic/claude-opus-5-5', { inputPrice: 0, outputPrice: 0 })).toBe('plan');
    expect(costWord({ costUsd: 0 }, 'anthropic/claude-opus-5-5', undefined)).toBe('plan');
    expect(costWord({ costUsd: 0 }, 'ollama/qwen3', priced)).toBe('local');
  });

  test('call cost: the bill, plan for tokens a plan paid, never $0, nothing before any use', () => {
    expect(callCostWord(0.42, 1000, 'anthropic/claude-opus-5-5')).toBe('$0.42');
    // a priced model through the plan gateway bills 0 and carries no API value: plan, not $0
    expect(callCostWord(0, 1000, 'anthropic/claude-opus-5-5')).toBe('plan');
    expect(callCostWord(0, 1000, undefined)).toBe('plan');
    expect(callCostWord(0, 1000, 'ollama/qwen3')).toBe('local');
    expect(callCostWord(0, 0, 'anthropic/claude-opus-5-5')).toBe('');
  });

  test('state: running, waiting on you, idle and the rest, in the session list words', () => {
    expect(stateWord('running')).toEqual({ word: 'running', tone: 'live' });
    expect(stateWord('waiting_approval').word).toBe('waiting on you');
    expect(stateWord('waiting_input').word).toBe('waiting on you');
    expect(stateWord('waiting_reset').word).toBe('waiting for reset');
    expect(stateWord('waiting_reset', Date.UTC(2026, 9, 27, 15, 5)).word).toMatch(/^resumes \d{1,2}:\d{2}/);
    expect(stateWord('error').tone).toBe('fault');
    expect(stateWord('idle').word).toBe('idle');
    expect(stateWord(undefined).word).toBe('idle');
  });

  test('parts: model, plan, context, tokens and cost; unknown parts left out', () => {
    const parts = statusParts({ model: 'anthropic/claude-opus-5-5', plan: 'neu-claude, Max 20x', contextPct: 12, tokens: 48_000, cost: 'plan' });
    expect(parts).toHaveLength(5);
    expect(parts.slice(1)).toEqual(['on neu-claude, Max 20x', '12% context', '48K tokens', 'plan']);
    // a fresh session: just the model, no "0 tokens" or "$0"
    expect(statusParts({ model: 'anthropic/claude-opus-5-5', tokens: 0, cost: '$0' })).toHaveLength(1);
  });
});
