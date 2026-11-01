/**
 * A long coding session for the mock, to try scrolling a big transcript:
 * open the mock with ?long=300 and go to /s/s_long. Each turn is a prompt,
 * thinking, reads and searches, an edit with its diff, a test run and a long
 * markdown answer with a code block, the shape of a Claude Code chat
 * imported from a Mac and continued here. Generated, so it is the same on
 * every load.
 */
import type { ContentBlock, Message, Session } from '@conclave/core/types';

const MIN = 60_000;

/** The turn count from ?long=N (0 when absent). */
export function longTurns(): number {
  if (typeof location === 'undefined') return 0;
  const n = Number(new URLSearchParams(location.search).get('long'));
  return Number.isFinite(n) && n > 0 ? Math.min(2000, Math.floor(n)) : 0;
}

const FILES = ['packages/server/src/auth.ts', 'packages/web/src/features/chat/MessageList.tsx', 'packages/core/src/session/stream.ts', 'packages/core/src/importers/claude-code.ts', 'packages/web/src/store/store.ts', 'packages/cli/src/index.ts'];
const WORDS = 'the session keeps its transcript in order so a fork copies messages up to a sequence and the hub streams deltas to every client while tool results arrive as user messages with their own ids'.split(' ');

function words(n: number, at: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(at * 7 + i * 3) % WORDS.length]);
  const s = out.join(' ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}

function code(i: number, lines: number): string {
  const out = [`export async function step${i}(input: Input): Promise<Output> {`];
  for (let l = 0; l < lines; l++) out.push(`  const v${l} = await load(input.items[${l}], { retry: ${l % 3}, label: 'item ${l}' }); // ${WORDS[(i + l) % WORDS.length]}`);
  out.push('  return { ok: true, count: input.items.length };', '}');
  return out.join('\n');
}

function answer(i: number): string {
  return [
    `## What changed in step ${i}`,
    '',
    words(60, i),
    '',
    `- **${FILES[i % FILES.length]}**: ${words(14, i + 1)}`,
    `- \`step${i}\` now awaits each item, ${words(10, i + 2)}`,
    `- ${words(18, i + 3)}`,
    '',
    '```ts',
    code(i, 18),
    '```',
    '',
    '| Check | Before | After |',
    '|---|---|---|',
    `| tests | ${40 + (i % 9)} pass | ${41 + (i % 9)} pass |`,
    `| bundle | ${300 + i} kB | ${298 + i} kB |`,
    '',
    words(45, i + 4),
  ].join('\n');
}

export function longSession(n: number, now: number): { session: Session; messages: Message[] } {
  const S = 's_long';
  const model = 'claude-code/opus';
  const messages: Message[] = [];
  let seq = 0;
  const t0 = now - n * 4 * MIN;
  const push = (role: Message['role'], content: ContentBlock[], at: number, extra: Partial<Message> = {}) => {
    seq++;
    messages.push({ id: `m_long_${seq}`, sessionId: S, seq, role, kind: 'normal', content, createdAt: at, ...extra });
  };
  const asst = (content: ContentBlock[], at: number) => push('assistant', content, at, { model, agent: 'coder' });
  for (let i = 0; i < n; i++) {
    const at = t0 + i * 4 * MIN;
    const file = FILES[i % FILES.length];
    // the later turns were continued here: their thinking carries the hub's time
    const timed = i >= n * 0.8;
    const think = (k: number): ContentBlock => ({ type: 'thinking', thinking: words(70 + (k % 40), i + k), ...(timed ? { durationMs: 3_000 + ((i * 7 + k) % 20) * 1_000 } : {}) });
    push('user', [{ type: 'text', text: `${words(20, i)} Then run the tests for ${file}.` }], at);
    asst([think(1), { type: 'text', text: words(24, i + 5) }, { type: 'tool_use', id: `tl_${i}_r`, name: 'Read', input: { file_path: file } }, { type: 'tool_use', id: `tl_${i}_g`, name: 'Grep', input: { pattern: `step${i}`, path: 'packages' } }], at + 5_000);
    push('user', [{ type: 'tool_result', toolUseId: `tl_${i}_r`, content: code(i, 30) }, { type: 'tool_result', toolUseId: `tl_${i}_g`, content: `${file}:12: step${i}\n${file}:40: step${i}(input)` }], at + 9_000);
    asst([think(2), { type: 'text', text: words(16, i + 6) }, { type: 'tool_use', id: `tl_${i}_e`, name: 'Edit', input: { file_path: file, old_string: code(i, 8), new_string: code(i + 1, 9) } }], at + 20_000);
    push('user', [{ type: 'tool_result', toolUseId: `tl_${i}_e`, content: `The file ${file} has been updated.` }], at + 22_000);
    asst([{ type: 'tool_use', id: `tl_${i}_b`, name: 'Bash', input: { command: `bun test ${file.replace('/src/', '/test/').replace(/\.tsx?$/, '.test.ts')}`, description: 'Run the tests' } }], at + 30_000);
    push('user', [{ type: 'tool_result', toolUseId: `tl_${i}_b`, content: `bun test v1.4.2\n\n✓ step${i} > loads every item [1.2ms]\n✓ step${i} > retries [0.8ms]\n\n ${40 + (i % 9)} pass\n 0 fail`, meta: { exitCode: 0, durationMs: 1_800 } }], at + 34_000);
    asst([{ type: 'text', text: answer(i) }], at + 60_000);
  }
  const session: Session = {
    id: S,
    title: 'Long session: transcript import and sync',
    agent: 'coder',
    model,
    mode: 'agent',
    permissionMode: 'acceptEdits',
    cwd: '~/code/conclave',
    device: 'arch-desktop',
    status: 'idle',
    tags: ['conclave'],
    pinned: false,
    archived: false,
    createdAt: t0,
    updatedAt: now - MIN,
    stats: { messages: messages.length, inputTokens: n * 40_000, outputTokens: n * 2_000, cacheReadTokens: n * 30_000, costUsd: 0 },
  };
  return { session, messages };
}
