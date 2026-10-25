/**
 * Daemon conformance: one fixture home and a list of cases that call every
 * device RPC through a Machine (a RemoteMachine on the hub, so the call
 * crosses the real wire). packages/server/test/daemon-conformance.test.ts
 * runs them against the TypeScript daemon and the Rust one
 * (packages/daemon-rs) on a real hub and compares what comes back.
 *
 * A case returns a plain value; errors become { error: { message, code } }.
 * normalize() removes what may differ between two runs (durations, the
 * daemon's own output folder). check() asserts what the result must be.
 */
import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { Machine } from '../../src/machine/types';

export interface CaseCtx {
  /** HOME of every daemon under test (the fixtures). */
  home: string;
  /** This daemon's own folder for writes. */
  out: string;
  /** ts, rust or rust-builtin */
  impl: string;
  /** The fake Syncthing API's address. */
  syncthing: string;
}

export interface Case {
  name: string;
  /** Which RPCs it covers. */
  rpc: string[];
  run(m: Machine, ctx: CaseCtx): Promise<unknown>;
  normalize?(v: unknown, ctx: CaseCtx): unknown;
  check?(v: unknown, ctx: CaseCtx): void;
  /** Leave this one out for the built-in search (it differs on purpose, see DAEMON-RUST.md). */
  rgOnly?: boolean;
  timeoutMs?: number;
}

export type Outcome = { ok: unknown } | { error: { message: string; code?: string } };

export async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await fn() };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    return { error: { message: String(e?.message ?? err), ...(e?.code ? { code: e.code } : {}) } };
  }
}

export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID_A = '6f1c2a10-1111-4a2b-9c3d-000000000001';
const UUID_B = '0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const UUID_C = '0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5c';
const UUID_D = '0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5d';

function put(path: string, data: string | Uint8Array, mtimeSec?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, data);
  if (mtimeSec) utimesSync(path, mtimeSec, mtimeSec);
}

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** Write the fixture tree under home. Distinct mtimes keep "newest first" orders stable. */
export function buildFixtures(home: string, syncthingAddress: string): void {
  const w = join(home, 'work');
  let t = 1_700_000_000;
  const at = () => (t += 60);
  put(join(w, '.git', 'HEAD'), 'ref: refs/heads/main\n', at());
  put(join(w, '.gitignore'), 'ignored.log\nbuild/\n', at());
  put(join(w, 'a.txt'), 'alpha\nbeta\nalpha two\ngamma\ndelta\nalpha three\n', at());
  put(join(w, 'b.md'), '# Title\nalpha in markdown\n', at());
  put(join(w, 'src', 'main.ts'), 'export const alpha = 1;\nfunction Beta() {}\n', at());
  put(join(w, 'src', 'util.ts'), '// ALPHA upper\n', at());
  put(join(w, 'src', 'deep', 'x.md'), 'deep alpha\n', at());
  put(join(w, '.hidden.txt'), 'hidden alpha\n', at());
  put(join(w, 'ignored.log'), 'alpha ignored\n', at());
  put(join(w, 'build', 'out.txt'), 'alpha built\n', at());
  put(join(w, 'long.txt'), `${'x'.repeat(600)}alpha${'y'.repeat(50)}\n`, at());
  put(join(w, 'multi.txt'), 'start\nmiddle\nend\n', at());
  put(join(w, 'bin.dat'), new Uint8Array([0x61, 0x00, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a]), at());

  const f = join(home, 'files');
  put(join(f, 'text.txt'), 'hello world\n', at());
  put(join(f, 'bom.txt'), '﻿bom text', at());
  put(join(f, 'bad.txt'), new Uint8Array([0x66, 0x6f, 0xff, 0xfe, 0x6f, 0xe2, 0x82]), at());
  put(join(f, 'bytes.bin'), new Uint8Array(Array.from({ length: 256 }, (_, i) => i)), at());
  put(join(f, 'empty.txt'), '', at());
  put(join(f, 'unicode.txt'), 'héllo wörld 😀\n', at());
  put(join(f, 'dir', 'inner.txt'), 'inner\n', at());
  symlinkSync('text.txt', join(f, 'link-to-text'));
  symlinkSync('dir', join(f, 'link-to-dir'));
  symlinkSync('/nonexistent/conclave-target', join(f, 'dangling'));
  // more than 2000 entries: readdir leaves sizes out
  mkdirSync(join(f, 'many'));
  for (let i = 0; i < 2001; i++) writeFileSync(join(f, 'many', `f${i}.txt`), 'x');

  // ----- Claude Code: a main session (with a rewound branch) and a subagent transcript
  const proj = join(home, '.claude', 'projects', '-home-me-work');
  const ts = (s: number) => new Date(Date.UTC(2025, 0, 2, 3, 4, s)).toISOString();
  put(
    join(proj, `${UUID_A}.jsonl`),
    jsonl([
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: UUID_A, cwd: '/home/me/work', gitBranch: 'main', entrypoint: 'cli', timestamp: ts(1), message: { role: 'user', content: 'Fix the build please <system-reminder>noise</system-reminder>' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: ts(2), message: { id: 'm1', model: 'claude-sonnet-4-5', content: [{ type: 'thinking', thinking: 'look', signature: 'sig' }, { type: 'text', text: 'Looking.' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: ts(3), message: { id: 'm1', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'cat .env' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } } },
      { type: 'user', uuid: 'r1', parentUuid: 'a2', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'SECRET=abc123456789' }] } },
      { type: 'assistant', uuid: 'a3', parentUuid: 'r1', timestamp: ts(5), message: { id: 'm2', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/home/me/work/a.txt' } }] } },
      { type: 'user', uuid: 'r2', parentUuid: 'a3', timestamp: ts(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'x'.repeat(3000) + 'END' }] }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'r2', timestamp: ts(7), message: { role: 'user', content: '<task-notification>job done</task-notification>' } },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: ts(8), message: { role: 'user', content: [{ type: 'text', text: '<command-name>commit</command-name><command-args>-m wip</command-args>' }] } },
      { type: 'assistant', uuid: 'a4', parentUuid: 'u3', timestamp: ts(9), message: { id: 'm3', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Committed. token=sk-ant-abcdefghijklmnopqrstuvwx' }], stop_reason: 'end_turn' } },
      { type: 'user', uuid: 'dead', parentUuid: 'a1', timestamp: ts(10), message: { role: 'user', content: 'a prompt that was rewound' } },
      { type: 'attachment', uuid: 'q1', parentUuid: 'a4', timestamp: ts(11), attachment: { type: 'queued_command', prompt: 'and run the tests' } },
      { type: 'summary', summary: 'Build fix', leafUuid: 'a4' },
      { type: 'last-prompt', leafUuid: 'u3' },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'brand-new-line' },
      { type: 'custom-title', customTitle: 'Custom', sessionId: UUID_A },
    ]),
    at(),
  );
  put(
    join(proj, UUID_A, 'subagents', 'agent-1.jsonl'),
    jsonl([
      { type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, sessionId: UUID_A, timestamp: ts(20), message: { role: 'user', content: 'Search the code' } },
      { type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, timestamp: ts(21), message: { id: 'sm1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Found it.' }] } },
    ]),
    at(),
  );
  // not a transcript folder: skipped
  put(join(proj, 'memory', 'notes.jsonl'), '{"type":"user"}\n', at());

  // ----- edge cases for the readers: a long session over several render windows,
  // a title with a secret, an emoji and odd spaces, an old build without last-prompt,
  // a file made only of sidechain lines, a lone surrogate, a dangling link
  const edge = join(home, '.claude', 'projects', '-home-me-edge');
  const big: unknown[] = [];
  let parent: string | null = null;
  for (let i = 0; i < 90; i++) {
    const u = `bu${i}`;
    const a = `ba${i}`;
    const r = `br${i}`;
    const z = `bz${i}`;
    const prompt = i === 0 ? `Deploy it  with ghp_${'A1b2'.repeat(10)} please 😀 ${'and then some more words '.repeat(6)}` : `Step ${i}: ${'refactor the parser module carefully '.repeat(30)}`;
    big.push({ type: 'user', uuid: u, parentUuid: parent, sessionId: 'big-session', cwd: '/home/me/edge', timestamp: ts(i % 59), message: { role: 'user', content: prompt } });
    big.push({ type: 'assistant', uuid: a, parentUuid: u, message: { id: `bm${i}`, model: 'claude-opus-4-1', content: [{ type: 'text', text: `Working on ${i}. ${'The parser now handles nested blocks. '.repeat(25)}` }, { type: 'tool_use', id: `bt${i}`, name: i % 7 === 0 ? 'WebFetch' : 'Bash', input: i % 7 === 0 ? { url: 'https://example.com/docs' } : i % 5 === 0 ? { command: 'cat ~/.ssh/id_rsa' } : { command: `npm test -- --grep part${i}` } }] } });
    big.push({ type: 'user', uuid: r, parentUuid: a, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `bt${i}`, content: `PASS part${i}\n${'ok '.repeat(3000)}`, is_error: i % 9 === 0 }] } });
    big.push({ type: 'assistant', uuid: z, parentUuid: r, message: { id: `bf${i}`, model: 'claude-opus-4-1', content: [{ type: 'text', text: `Done with ${i}. [user] not really\n  [tool] fake row` }], stop_reason: 'end_turn' } });
    parent = z;
  }
  put(join(edge, '11111111-2222-4333-8444-555555555555.jsonl'), jsonl(big), at());
  put(
    join(edge, '22222222-2222-4333-8444-555555555555.jsonl'),
    jsonl([
      { type: 'user', uuid: 'o1', sessionId: 'old-build', timestamp: 1_735_787_045, message: { role: 'user', content: [{ type: 'text', text: '<bash-input>ls -la</bash-input>' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }] } },
      { type: 'assistant', uuid: 'o2', timestamp: 1_735_787_046_000, message: { id: 'om1', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
      { type: 'assistant', uuid: 'o3', message: { id: 'om2', content: 'plain string reply' } },
      { type: 'user', uuid: 'o4', isMeta: true, message: { role: 'user', content: 'meta line' } },
      { type: 'user', uuid: 'o5', isCompactSummary: true, message: { role: 'user', content: 'Summary of before' } },
      { type: 'user', uuid: 'o6', origin: { kind: 'Peer' }, message: { role: 'user', content: 'hello from a teammate' } },
      { type: 'user', uuid: 'o7', promptSource: 'system', message: { role: 'user', content: [{ type: 'document', title: 'spec', source: { type: 'text', data: 'doc body ✓' } }] } },
    ]) + '{"type":"user","uuid":"o8","message":{"role":"user","content":"cut \\ud83d emoji"}}\n{broken json\n',
    at(),
  );
  put(
    join(edge, '33333333-2222-4333-8444-555555555555.jsonl'),
    jsonl([
      { type: 'user', uuid: 'c1', isSidechain: true, sessionId: 'side', message: { role: 'user', content: 'sidechain only' } },
      { type: 'assistant', uuid: 'c2', isSidechain: true, parentUuid: 'c1', entrypoint: 'sdk-ts', message: { id: 'cm', content: [{ type: 'text', text: 'ok' }] } },
    ]),
    at(),
  );
  symlinkSync('/nonexistent/conclave-gone.jsonl', join(edge, '44444444-2222-4333-8444-555555555555.jsonl'));
  // codex: a fork whose base is not on this device, and one that names itself
  put(
    join(home, '.codex', 'sessions', '2025', '09', '14', 'rollout-2025-09-14T09-00-00-0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5e.jsonl'),
    jsonl([
      { timestamp: '2025-09-14T09:00:00Z', type: 'session_meta', payload: { id: '0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5e', source: 'mcp', history_base: { thread_id: '0199a0b1-2c3d-4e5f-8a9b-ffffffffffff', items: 5 } } },
      { timestamp: '2025-09-14T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Message Type: request\nTask name: lint\nSender: agent-2\nPayload: run it' } },
      { timestamp: '2025-09-14T09:00:02Z', type: 'response_item', payload: { type: 'local_shell_call', call_id: 'ls1', action: { command: ['ls'] } } },
      { timestamp: '2025-09-14T09:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'ls1', output: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] } },
    ]),
    at(),
  );
  put(
    join(home, '.codex', 'sessions', '2025', '09', '14', 'rollout-2025-09-14T10-00-00-0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5f.jsonl'),
    jsonl([
      { timestamp: '2025-09-14T10:00:00Z', type: 'session_meta', payload: { id: '0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5f', thread_source: 'review', history_base: { threadId: '0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5f', item_count: 1 } } },
      { timestamp: '2025-09-14T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<subagent_notification>done</subagent_notification>' }] } },
    ]),
    at(),
  );

  // ----- Codex: a session, a fork of it, a compressed and an archived one, and titles
  const day = join(home, '.codex', 'sessions', '2025', '09', '12');
  const cts = (s: number) => new Date(Date.UTC(2025, 8, 12, 10, 0, s)).toISOString();
  const baseLines = [
    { timestamp: cts(0), type: 'session_meta', payload: { id: UUID_B, cwd: '/home/me/work', source: 'cli', git: { branch: 'main', repository_url: 'git@github.com:me/work.git' } } },
    { timestamp: cts(1), type: 'turn_context', payload: { model: 'gpt-5', cwd: '/home/me/work' } },
    { timestamp: cts(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }, { type: 'input_text', text: 'Add a test' }] } },
    { timestamp: cts(3), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan it' }] } },
    { timestamp: cts(4), type: 'response_item', payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls","-la"]}' } },
    { timestamp: cts(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '{"output":"a.txt\\nb.md","metadata":{"exit_code":0}}' } },
    { timestamp: cts(6), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' } },
    { timestamp: cts(7), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Done!' } },
    { timestamp: cts(8), type: 'response_item', payload: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { query: 'vitest docs' } } },
    { timestamp: cts(9), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added the test.' }] } },
    { timestamp: cts(10), type: 'event_msg', payload: { type: 'agent_message', message: 'Added the test.' } },
    { timestamp: cts(11), type: 'response_item', payload: { type: 'mystery_item' } },
  ];
  put(join(day, `rollout-2025-09-12T10-00-00-${UUID_B}.jsonl`), jsonl(baseLines), at());
  put(
    join(day, `rollout-2025-09-12T11-00-00-${UUID_C}.jsonl`),
    jsonl([
      { timestamp: cts(20), type: 'session_meta', payload: { id: UUID_C, cwd: '/home/me/work', source: { subagent: { parent_thread_id: UUID_B.toUpperCase() } }, history_base: { thread_id: UUID_B, items: 3 } } },
      { timestamp: cts(21), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue in the fork' }] } },
      { timestamp: cts(22), type: 'compacted', payload: { message: 'Earlier work, summarized' } },
    ]),
    at(),
  );
  put(join(home, '.codex', 'sessions', '2025', '09', '13', `rollout-2025-09-13T09-00-00-${UUID_D}.jsonl.zst`), zstdCompressSync(Buffer.from(jsonl(baseLines.map((l) => (l.type === 'session_meta' ? { ...l, payload: { ...l.payload, id: UUID_D } } : l))))), at());
  put(
    join(home, '.codex', 'archived_sessions', `rollout-2025-08-01T08-00-00-${UUID_A}.jsonl`),
    jsonl([
      { timestamp: '2025-08-01T08:00:00Z', type: 'session_meta', payload: { id: UUID_A, source: 'exec', thread_source: 'memory_consolidation' } },
      { timestamp: '2025-08-01T08:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Old style prompt' } },
      { timestamp: '2025-08-01T08:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Old style answer' } },
    ]),
    at(),
  );
  put(join(home, '.codex', 'session_index.jsonl'), jsonl([{ id: UUID_B, thread_name: 'First title' }, { id: UUID_B, thread_name: '  Testing work  ' }, { thread_id: UUID_D, title: 'Zipped' }]), at());

  // ----- Gemini CLI: a JSONL chat with replays, a legacy object chat and a checkpoint
  const g = join(home, '.gemini');
  put(join(g, 'projects.json'), JSON.stringify({ projects: { '/home/me/work': 'work-proj' } }), at());
  put(
    join(g, 'tmp', 'work-proj', 'chats', 'session-2025-03-01.jsonl'),
    jsonl([
      { sessionId: 'gem-1', projectHash: 'x', startTime: '2025-03-01T00:00:00Z' },
      { id: 'g1', type: 'user', timestamp: '2025-03-01T00:00:01Z', content: [{ text: 'Explain the repo' }] },
      { id: 'g2', type: 'gemini', model: 'gemini-2.5-pro', timestamp: '2025-03-01T00:00:02Z', content: 'It is a hub.', thoughts: [{ subject: 'Reading', description: 'files' }], toolCalls: [{ id: 'tc1', name: 'read_file', args: { path: 'a.txt' }, result: [{ functionResponse: { response: { output: 'alpha' } } }], status: 'success' }] },
      { id: 'g3', type: 'user', content: 'rewound' },
      { $rewindTo: 'g3' },
      { $patch: { id: 'g1', content: 'Explain the whole repo' } },
      { $set: { summary: 'Repo tour' } },
      { id: 'g4', type: 'info', content: 'note' },
    ]),
    at(),
  );
  put(join(g, 'tmp', 'work-proj', 'chats', 'session-old.json'), JSON.stringify({ sessionId: 'gem-old', kind: 'subagent', messages: [{ id: 'o1', type: 'user', content: 'legacy question' }, { id: 'o2', type: 'gemini', content: [{ text: 'legacy answer' }, { inlineData: { data: 'AAAA' } }, { mystery: 1 }] }] }), at());
  put(join(g, 'tmp', 'work-proj', 'chats', 'checkpoint-tag.json'), JSON.stringify([{ role: 'user', parts: [{ text: 'saved q' }] }, { role: 'model', parts: [{ text: 'saved a' }, { functionCall: { name: 'ls', args: {} } }] }]), at());
  put(join(g, 'tmp', 'work-proj', 'logs.json'), '[]', at());

  // ----- Syncthing: config.xml with a GUI the test serves
  put(
    join(home, '.config', 'syncthing', 'config.xml'),
    `<configuration version="37">
    <folder id="proj-1" label="Projects" path="~/work/" type="sendreceive" rescanIntervalS="3600">
        <paused>false</paused>
    </folder>
    <folder id="music" label="" path="/data/music" paused="true"/>
    <gui enabled="true" tls="false" debugging="false">
        <address>${syncthingAddress}</address>
        <apikey>test-api-key</apikey>
    </gui>
</configuration>
`,
    at(),
  );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const w = (c: CaseCtx, ...p: string[]) => join(c.home, 'work', ...p);
const f = (c: CaseCtx, ...p: string[]) => join(c.home, 'files', ...p);
const o = (c: CaseCtx, ...p: string[]) => join(c.out, ...p);
const call = (m: Machine, method: string, params: unknown) => (m as unknown as { call(m: string, p: unknown, e?: unknown): Promise<unknown> }).call(method, params);

/** Replace the daemon's own out folder, so two daemons' results compare. */
function anonymize(v: unknown, ctx: CaseCtx): unknown {
  return JSON.parse(JSON.stringify(v ?? null).split(ctx.out).join('<out>'));
}

const noDuration = (v: unknown) => {
  const r = (v as { ok?: Record<string, unknown> }).ok;
  if (r && typeof r === 'object') delete r.durationMs;
  return v;
};

const sortLines = (v: unknown) => {
  const r = (v as { ok?: { output?: string } }).ok;
  if (r && typeof r.output === 'string') r.output = r.output.split('\n').sort().join('\n');
  return v;
};

/**
 * Lone surrogates become U+FFFD: JavaScript keeps half an emoji that a tool
 * cut, Rust strings cannot hold one (a documented difference, same length).
 */
export function wellFormed(v: unknown): unknown {
  if (typeof v === 'string') return (v as string & { toWellFormed(): string }).toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x)]));
  return v;
}

const roundStat =(s: unknown) => (s && typeof s === 'object' && 'mtimeMs' in s ? { ...(s as object), mtimeMs: Math.floor((s as { mtimeMs: number }).mtimeMs) } : s);

async function runProc(m: Machine, cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }, input?: string, kill?: { after: number; signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' }) {
  const p = m.spawn(cmd, args, opts);
  const out = new Response(p.stdout).arrayBuffer();
  const err = new Response(p.stderr).text();
  if (input !== undefined) {
    p.write(input);
    await Bun.sleep(30);
    p.closeStdin();
  }
  if (kill) {
    await Bun.sleep(kill.after);
    p.kill(kill.signal);
  }
  const code = await p.exited;
  const bytes = new Uint8Array(await out);
  return { code, stdout: dec(bytes), stderr: await err, pid: typeof p.pid };
}

export const CASES: Case[] = [
  // ----- info
  {
    name: 'info reports the machine',
    rpc: ['info'],
    run: (m) => m.info(),
    normalize: (v) => {
      const r = (v as { ok?: Record<string, unknown> }).ok;
      if (r) delete r.daemon;
      return v;
    },
    check: (v, c) => {
      const r = (v as { ok: Record<string, unknown> }).ok;
      expect(r.home).toBe(c.home);
      expect(r.platform).toBe(process.platform);
      expect(r.arch).toBe(process.arch);
      expect(typeof r.hostname).toBe('string');
      expect(Array.isArray(r.capabilities)).toBe(true);
    },
  },
  // ----- stat
  {
    name: 'stat: file, dir, missing, under a file, links',
    rpc: ['stat'],
    run: async (m, c) => {
      const out: Record<string, unknown> = {};
      for (const p of [f(c, 'text.txt'), f(c, 'dir'), f(c, 'nope'), f(c, 'text.txt', 'under'), f(c, 'dangling'), f(c, 'link-to-text'), f(c, 'link-to-dir'), '']) out[p.replace(c.home, '~')] = roundStat(await m.stat(p));
      return out;
    },
    check: (v, c) => {
      const r = (v as { ok: Record<string, { type: string; size: number } | null> }).ok;
      expect(r['~/files/text.txt']).toMatchObject({ type: 'file', size: 12 });
      expect(r['~/files/dir']?.type).toBe('dir');
      expect(r['~/files/nope']).toBeNull();
      expect(r['~/files/text.txt/under']).toBeNull();
      expect(r['~/files/dangling']?.type).toBe('symlink');
      expect(r['~/files/link-to-text']).toMatchObject({ type: 'file', size: 12 });
      expect(r['~/files/link-to-dir']?.type).toBe('dir');
      void c;
    },
  },
  // ----- readdir
  {
    name: 'readdir: entries, types and sizes',
    rpc: ['readdir'],
    run: async (m, c) => (await m.readdir(f(c))).sort((a, b) => a.name.localeCompare(b.name)),
    check: (v) => {
      const r = (v as { ok: Array<{ name: string; type: string; size?: number }> }).ok;
      expect(r.find((e) => e.name === 'text.txt')).toEqual({ name: 'text.txt', type: 'file', size: 12 });
      expect(r.find((e) => e.name === 'dangling')).toEqual({ name: 'dangling', type: 'symlink' });
      expect(r.find((e) => e.name === 'link-to-dir')?.type).toBe('symlink');
      expect(r.find((e) => e.name === 'dir')).toEqual({ name: 'dir', type: 'dir' });
    },
  },
  {
    name: 'readdir: past 2000 entries there are no sizes',
    rpc: ['readdir'],
    run: async (m, c) => {
      const r = await m.readdir(f(c, 'many'));
      return { n: r.length, sized: r.filter((e) => e.size !== undefined).length, types: [...new Set(r.map((e) => e.type))] };
    },
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ n: 2001, sized: 0, types: ['file'] }),
  },
  {
    name: 'grep: before context only, an offset past the end, no limit',
    rpc: ['grep'],
    run: async (m, c) => ({
      before: await m.grep({ pattern: 'delta', path: w(c, 'a.txt'), outputMode: 'content', before: 2 }),
      past: await m.grep({ pattern: 'alpha', path: w(c, 'a.txt'), outputMode: 'content', offset: 99 }),
      zero: await m.grep({ pattern: 'alpha', path: w(c, 'a.txt'), outputMode: 'content', limit: 0 }),
      none: await m.grep({ pattern: 'zzz-not-there', path: w(c), outputMode: 'files' }),
    }),
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => {
      const r = (v as { ok: Record<string, { output: string; total: number; truncated: boolean }> }).ok;
      expect(r.before.output).toBe('~/work/a.txt-3-alpha two\n~/work/a.txt-4-gamma\n~/work/a.txt:5:delta');
      expect(r.past).toEqual({ output: '', total: 3, truncated: false });
      expect(r.zero).toMatchObject({ total: 3, truncated: false });
      expect(r.none).toEqual({ output: '', total: 0, truncated: false });
    },
  },
  { name: 'readdir: a missing folder', rpc: ['readdir'], run: (m, c) => m.readdir(f(c, 'nope')), check: (v) => expect((v as { error: { code: string } }).error.code).toBe('ENOENT') },
  { name: 'readdir: a file', rpc: ['readdir'], run: (m, c) => m.readdir(f(c, 'text.txt')), check: (v) => expect((v as { error: { code: string } }).error.code).toBe('ENOTDIR') },
  // ----- readFile, readText, readRange
  {
    name: 'readFile: all 256 byte values round trip',
    rpc: ['readFile'],
    run: async (m, c) => sha(await m.readFile(f(c, 'bytes.bin'))),
    check: (v) => expect((v as { ok: string }).ok).toBe(sha(new Uint8Array(Array.from({ length: 256 }, (_, i) => i)))),
  },
  { name: 'readFile: empty file', rpc: ['readFile'], run: async (m, c) => (await m.readFile(f(c, 'empty.txt'))).length, check: (v) => expect((v as { ok: number }).ok).toBe(0) },
  { name: 'readFile: missing', rpc: ['readFile'], run: (m, c) => m.readFile(f(c, 'nope')), check: (v, c) => expect(v).toEqual({ error: { message: `ENOENT: no such file or directory, open '${f(c, 'nope')}'`, code: 'ENOENT' } }) },
  { name: 'readFile: a folder', rpc: ['readFile'], run: (m, c) => m.readFile(f(c, 'dir')), check: (v) => expect(v).toEqual({ error: { message: 'EISDIR: illegal operation on a directory, read', code: 'EISDIR' } }) },
  { name: 'readFile: through a symlink', rpc: ['readFile'], run: async (m, c) => dec(await m.readFile(f(c, 'link-to-text'))), check: (v) => expect((v as { ok: string }).ok).toBe('hello world\n') },
  {
    name: 'readText: UTF-8, a BOM kept, bad bytes replaced',
    rpc: ['readText'],
    run: async (m, c) => ({ text: await m.readText(f(c, 'text.txt')), bom: await m.readText(f(c, 'bom.txt')), bad: await m.readText(f(c, 'bad.txt')), uni: await m.readText(f(c, 'unicode.txt')) }),
    check: (v) => {
      const r = (v as { ok: Record<string, string> }).ok;
      expect(r.text).toBe('hello world\n');
      expect(r.uni).toBe('héllo wörld 😀\n');
      expect(r.bad).toBe('fo��o�');
    },
  },
  { name: 'readText: missing', rpc: ['readText'], run: (m, c) => m.readText(f(c, 'nope')), check: (v) => expect((v as { error: { code: string } }).error.code).toBe('ENOENT') },
  {
    name: 'readRange: offsets, the end of the file, negative and huge values',
    rpc: ['readRange'],
    run: async (m, c) => {
      const p = f(c, 'text.txt');
      const rr = async (off: number, len: number) => dec(await m.readRange!(p, off, len));
      return [await rr(0, 5), await rr(6, 100), await rr(100, 5), await rr(-5, 5), await rr(0, 0), await rr(0, 1e12)];
    },
    check: (v) => expect((v as { ok: string[] }).ok).toEqual(['hello', 'world\n', '', 'hello', '', 'hello world\n']),
  },
  { name: 'readRange: missing and a folder', rpc: ['readRange'], run: async (m, c) => [await outcome(() => m.readRange!(f(c, 'nope'), 0, 1)), await outcome(() => m.readRange!(f(c, 'dir'), 0, 1))] },
  // ----- writeFile, mkdir, remove, rename
  {
    name: 'writeFile: text and bytes, parents made, read back',
    rpc: ['writeFile', 'readFile', 'readText'],
    run: async (m, c) => {
      await m.writeFile(o(c, 'w', 'deep', 'note.txt'), 'written ✓\n');
      await m.writeFile(o(c, 'w', 'bin.dat'), new Uint8Array([0, 1, 2, 254, 255]));
      await m.writeFile(o(c, 'w', 'empty.txt'), '');
      return { text: await m.readText(o(c, 'w', 'deep', 'note.txt')), bin: Array.from(await m.readFile(o(c, 'w', 'bin.dat'))), empty: await m.readText(o(c, 'w', 'empty.txt')) };
    },
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ text: 'written ✓\n', bin: [0, 1, 2, 254, 255], empty: '' }),
  },
  {
    name: 'writeFile: onto a folder, and under a file',
    rpc: ['writeFile'],
    run: async (m, c) => {
      await m.mkdir(o(c, 'wf', 'adir'));
      await m.writeFile(o(c, 'wf', 'afile'), 'x');
      return [await outcome(() => m.writeFile(o(c, 'wf', 'adir'), 'x')), await outcome(() => m.writeFile(o(c, 'wf', 'afile', 'below'), 'x'))];
    },
    normalize: anonymize,
    check: (v) => {
      const [a, b] = (v as { ok: Array<{ error: { code: string } }> }).ok;
      expect(a.error.code).toBe('EISDIR');
      expect(b.error.code).toBe('EEXIST');
    },
  },
  {
    name: 'mkdir: nested, again, over a file, under a file',
    rpc: ['mkdir'],
    run: async (m, c) => {
      await m.writeFile(o(c, 'mk', 'file'), 'x');
      return [await outcome(() => m.mkdir(o(c, 'mk', 'a', 'b', 'c'))), await outcome(() => m.mkdir(o(c, 'mk', 'a', 'b', 'c'))), await outcome(() => m.mkdir(o(c, 'mk', 'file'))), await outcome(() => m.mkdir(o(c, 'mk', 'file', 'x')))];
    },
    normalize: anonymize,
    check: (v) => {
      const r = (v as { ok: Outcome[] }).ok;
      expect(r[0]).toEqual({ ok: undefined });
      expect(r[1]).toEqual({ ok: undefined });
      expect((r[2] as { error: { code: string } }).error.code).toBe('EEXIST');
      expect((r[3] as { error: { code: string } }).error.code).toBe('ENOTDIR');
    },
  },
  {
    name: 'remove: a file, a folder needs recursive, a link stays a link, missing',
    rpc: ['remove', 'stat'],
    run: async (m, c) => {
      await m.writeFile(o(c, 'rm', 'f.txt'), 'x');
      await m.writeFile(o(c, 'rm', 'd', 'inner.txt'), 'x');
      const r: Outcome[] = [];
      r.push(await outcome(() => m.remove(o(c, 'rm', 'f.txt'))));
      r.push(await outcome(() => m.remove(o(c, 'rm', 'd'))));
      r.push(await outcome(() => m.remove(o(c, 'rm', 'd'), { recursive: true })));
      r.push(await outcome(() => m.remove(o(c, 'rm', 'nope'))));
      r.push(await outcome(() => m.remove(o(c, 'rm', 'nope'), { recursive: true })));
      return { r, gone: [await m.stat(o(c, 'rm', 'f.txt')), await m.stat(o(c, 'rm', 'd'))] };
    },
    normalize: anonymize,
    check: (v) => {
      const { r, gone } = (v as { ok: { r: Outcome[]; gone: unknown[] } }).ok;
      expect(r[0]).toEqual({ ok: undefined });
      expect(r[1]).toEqual({ error: { message: 'Path is a directory: rm returned EISDIR (is a directory) <out>/rm/d', code: 'ERR_FS_EISDIR' } });
      expect(r[2]).toEqual({ ok: undefined });
      expect(r[3]).toEqual({ error: { message: "ENOENT: no such file or directory, lstat '<out>/rm/nope'", code: 'ENOENT' } });
      expect(gone).toEqual([null, null]);
    },
  },
  {
    name: 'rename: into a new folder, and from nowhere',
    rpc: ['rename'],
    run: async (m, c) => {
      await m.writeFile(o(c, 'mv', 'a.txt'), 'moved');
      const ok = await outcome(() => m.rename(o(c, 'mv', 'a.txt'), o(c, 'mv', 'new', 'dir', 'b.txt')));
      return { ok, text: await m.readText(o(c, 'mv', 'new', 'dir', 'b.txt')), missing: await outcome(() => m.rename(o(c, 'mv', 'nope'), o(c, 'mv', 'x'))) };
    },
    normalize: anonymize,
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ ok: { ok: undefined }, text: 'moved', missing: { error: { message: "ENOENT: no such file or directory, rename '<out>/mv/nope' -> '<out>/mv/x'", code: 'ENOENT' } } }),
  },
  // ----- resolve (an RPC of its own on the wire)
  {
    name: 'resolve: home, relative, dots, trailing slash',
    rpc: ['resolve'],
    run: async (m, c) => {
      const pairs: Array<[string, string]> = [
        ['~', '/'],
        ['~/x/../y', '/'],
        ['src', '~/work'],
        ['src', ''],
        ['  /a/b/  ', '/'],
        ['/a/../b', '/x'],
        ['../up', '/a/b'],
        ['~user/x', '/tmp'],
        ['./a//b/', '/base'],
      ];
      const out: string[] = [];
      for (const [p, cwd] of pairs) out.push((await call(m, 'resolve', { path: p, cwd })) as string);
      return out;
    },
    check: (v, c) => expect((v as { ok: string[] }).ok).toEqual([c.home, `${c.home}/y`, `${c.home}/work/src`, `${c.home}/src`, '/a/b/', '/b', '/a/up', '/tmp/~user/x', '/base/a/b']),
  },
  // ----- glob
  {
    name: 'glob: a slash-free pattern matches at any depth, newest first',
    rpc: ['glob'],
    run: async (m, c) => (await m.glob('*.md', { cwd: w(c) })).map((p) => p.replace(c.home, '~')),
    check: (v) => expect((v as { ok: string[] }).ok).toEqual(['~/work/src/deep/x.md', '~/work/b.md']),
  },
  {
    name: 'glob: ignored files and dot files on request',
    rpc: ['glob'],
    run: async (m, c) => {
      const g = async (p: string, opts: Record<string, unknown> = {}) => (await m.glob(p, { cwd: w(c), ...opts })).map((x) => x.replace(c.home, '~'));
      return { plain: await g('*.txt'), ignored: await g('*.txt', { includeIgnored: true }), dot: await g('*.txt', { dot: true }), dotPattern: await g('.hidden*'), limited: await g('**/*', { limit: 2 }), sub: await g('src/*.ts'), dotslash: await g('./a.txt') };
    },
    check: (v) => {
      const r = (v as { ok: Record<string, string[]> }).ok;
      // rg: a file the pattern names is listed even when hidden, unless .gitignore drops it
      expect(r.plain).toEqual(['~/work/multi.txt', '~/work/long.txt', '~/work/.hidden.txt', '~/work/a.txt']);
      expect(r.ignored).toContain('~/work/build/out.txt');
      expect(r.dot).toContain('~/work/.hidden.txt');
      expect(r.dotPattern).toEqual(['~/work/.hidden.txt']);
      expect(r.limited.length).toBe(2);
      expect(r.sub).toEqual(['~/work/src/util.ts', '~/work/src/main.ts']);
      expect(r.dotslash).toEqual(['~/work/a.txt']);
    },
  },
  {
    name: 'glob: absolute patterns, a literal path, a missing folder',
    rpc: ['glob'],
    run: async (m, c) => ({
      abs: (await m.glob(`${w(c)}/src/**/*.md`, { cwd: '/' })).map((x) => x.replace(c.home, '~')),
      home: (await m.glob('~/work/*.md', { cwd: '/' })).map((x) => x.replace(c.home, '~')),
      literal: (await m.glob(w(c, 'a.txt'), { cwd: '/' })).map((x) => x.replace(c.home, '~')),
      literalDir: await m.glob(w(c, 'src'), { cwd: '/' }),
      missing: await outcome(() => m.glob('*', { cwd: w(c, 'nope') })),
    }),
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => {
      const r = (v as { ok: Record<string, unknown> }).ok;
      expect(r.abs).toEqual(['~/work/src/deep/x.md']);
      // the literal part moves into cwd, and a slash-free rest matches at any depth
      expect(r.home).toEqual(['~/work/src/deep/x.md', '~/work/b.md']);
      expect(r.literal).toEqual(['~/work/a.txt']);
      expect(r.literalDir).toEqual([]);
      expect(r.missing).toEqual({ error: { message: 'Directory does not exist: ~/work/nope' } });
    },
  },
  // ----- grep
  {
    name: 'grep: content with line numbers across files',
    rpc: ['grep'],
    run: (m, c) => m.grep({ pattern: 'alpha', path: w(c), outputMode: 'content' }),
    normalize: (v, c) => sortLines(JSON.parse(JSON.stringify(v).split(c.home).join('~'))),
    check: (v) => {
      const r = (v as { ok: { output: string; total: number } }).ok;
      expect(r.output).toContain('~/work/a.txt:1:alpha');
      expect(r.output).toContain('~/work/.hidden.txt:1:hidden alpha');
      expect(r.output).not.toContain('ignored.log');
      expect(r.output).not.toContain('bin.dat');
      expect(r.output).toContain('[... omitted end of long line]');
    },
  },
  {
    name: 'grep: one file, case-insensitive, context, no line numbers',
    rpc: ['grep'],
    run: async (m, c) => ({
      ctx: await m.grep({ pattern: 'gamma', path: w(c, 'a.txt'), outputMode: 'content', before: 1, after: 1 }),
      ci: await m.grep({ pattern: 'ALPHA', path: w(c, 'src'), outputMode: 'content', caseInsensitive: true }),
      plain: await m.grep({ pattern: 'beta', path: w(c, 'a.txt'), outputMode: 'content', lineNumbers: false }),
      seps: await m.grep({ pattern: 'alpha', path: w(c, 'a.txt'), outputMode: 'content', after: 1 }),
    }),
    normalize: (v, c) => {
      const r = JSON.parse(JSON.stringify(v).split(c.home).join('~'));
      if (r.ok?.ci) r.ok.ci.output = r.ok.ci.output.split('\n').sort().join('\n');
      return r;
    },
    check: (v) => {
      const r = (v as { ok: Record<string, { output: string; total: number }> }).ok;
      expect(r.ctx.output).toBe('~/work/a.txt-3-alpha two\n~/work/a.txt:4:gamma\n~/work/a.txt-5-delta');
      expect(r.ci.total).toBe(3);
      expect(r.plain.output).toBe('~/work/a.txt:beta');
      expect(r.seps.output).toBe('~/work/a.txt:1:alpha\n~/work/a.txt-2-beta\n~/work/a.txt:3:alpha two\n~/work/a.txt-4-gamma\n--\n~/work/a.txt:6:alpha three');
    },
  },
  {
    name: 'grep: files and counts, globs and types, limit and offset',
    rpc: ['grep'],
    run: async (m, c) => ({
      files: await m.grep({ pattern: 'alpha', path: w(c), outputMode: 'files' }),
      count: await m.grep({ pattern: 'alpha', path: w(c), outputMode: 'count' }),
      md: await m.grep({ pattern: 'alpha', path: w(c), outputMode: 'files', glob: '*.md' }),
      two: await m.grep({ pattern: 'alpha', path: w(c), outputMode: 'files', glob: '*.md *.ts' }),
      type: await m.grep({ pattern: 'alpha', path: w(c), outputMode: 'files', type: 'ts' }),
      page: await m.grep({ pattern: 'alpha', path: w(c), outputMode: 'files', limit: 2, offset: 1 }),
    }),
    normalize: (v, c) => {
      const r = JSON.parse(JSON.stringify(v).split(c.home).join('~'));
      if (r.ok?.count) r.ok.count.output = r.ok.count.output.split('\n').sort().join('\n');
      return r;
    },
    check: (v) => {
      const r = (v as { ok: Record<string, { output: string; total: number; truncated: boolean }> }).ok;
      expect(r.files.output.split('\n')[0]).toBe('~/work/long.txt');
      expect(r.files.total).toBe(6);
      expect(r.count.output).toContain('~/work/a.txt:3');
      expect(r.md.output).toBe('~/work/src/deep/x.md\n~/work/b.md');
      expect(r.two.total).toBe(3);
      expect(r.type.output).toBe('~/work/src/main.ts');
      expect(r.page).toMatchObject({ total: 6, truncated: true });
      expect(r.page.output.split('\n').length).toBe(2);
    },
  },
  {
    name: 'grep: multiline',
    rpc: ['grep'],
    run: (m, c) => m.grep({ pattern: 'start.middle', path: w(c, 'multi.txt'), outputMode: 'content', multiline: true }),
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => expect((v as { ok: { output: string } }).ok.output).toBe('~/work/multi.txt:1:start\n~/work/multi.txt:2:middle'),
  },
  {
    name: 'grep: a binary file named on its own',
    rpc: ['grep'],
    run: (m, c) => m.grep({ pattern: 'alpha', path: w(c, 'bin.dat'), outputMode: 'content' }),
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => expect((v as { ok: { output: string } }).ok.output).toBe('~/work/bin.dat: binary file matches (found "\\0" byte around offset 1)'),
  },
  {
    name: 'grep: a bad pattern, a missing path, an unknown type',
    rpc: ['grep'],
    run: async (m, c) => [await outcome(() => m.grep({ pattern: '(', path: w(c), outputMode: 'content' })), await outcome(() => m.grep({ pattern: 'x', path: w(c, 'nope'), outputMode: 'content' })), await outcome(() => m.grep({ pattern: 'x', path: w(c), outputMode: 'content', type: 'nosuchtype' }))],
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => {
      const r = (v as { ok: Array<{ error: { message: string } }> }).ok;
      expect(r[0].error.message).toContain('regex parse error');
      expect(r[1].error.message).toBe('Path does not exist: ~/work/nope');
      expect(r[2].error.message).toBe('rg: unrecognized file type: nosuchtype');
    },
  },
  // ----- exec
  {
    name: 'exec: output, exit code, stderr, stdin',
    rpc: ['exec'],
    run: async (m, c) => ({
      echo: await m.exec('echo hello; echo oops >&2; exit 3', { cwd: c.home }),
      stdin: await m.exec('cat; echo done >&2', { cwd: c.home, stdin: 'piped in ✓' }),
      unicode: await m.exec('printf "h\\303\\251llo \\360\\237\\230\\200"', { cwd: c.home }),
      bad: await m.exec('printf "\\377\\376ok\\342\\202"', { cwd: c.home }),
      pwd: await m.exec('pwd', { cwd: '~/work' }),
      signal: await m.exec('kill -TERM $$', { cwd: c.home }),
    }),
    normalize: (v) => {
      const r = (v as { ok?: Record<string, Record<string, unknown>> }).ok;
      if (r) for (const x of Object.values(r)) delete x.durationMs;
      return v;
    },
    check: (v, c) => {
      const r = (v as { ok: Record<string, { exitCode: number | null; stdout: string; stderr: string }> }).ok;
      expect(r.echo).toMatchObject({ exitCode: 3, stdout: 'hello\n', stderr: 'oops\n', timedOut: false, aborted: false });
      expect(r.stdin).toMatchObject({ exitCode: 0, stdout: 'piped in ✓', stderr: 'done\n' });
      expect(r.unicode.stdout).toBe('héllo 😀');
      expect(r.bad.stdout).toBe('��ok�');
      // pwd prints the real path: macOS keeps temp folders under /private/var, with /var a link
      expect(r.pwd.stdout.trim()).toBe(realpathSync(w(c)));
      expect(r.signal.exitCode).toBeNull();
    },
  },
  {
    name: 'exec: a missing folder, a timeout, an abort',
    rpc: ['exec', 'exec.abort'],
    run: async (m, c) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const t0 = Date.now();
      const [missing, timeout, aborted] = await Promise.all([m.exec('echo hi', { cwd: w(c, 'nope') }), m.exec('sleep 20', { cwd: c.home, timeoutMs: 300 }), m.exec('sleep 20', { cwd: c.home, signal: ac.signal })]);
      return { missing, timeout, aborted, fast: Date.now() - t0 < 5000 };
    },
    normalize: (v, c) => {
      const r = (v as { ok?: Record<string, Record<string, unknown>> }).ok;
      if (r) for (const x of Object.values(r)) if (x && typeof x === 'object') delete x.durationMs;
      return JSON.parse(JSON.stringify(v).split(c.home).join('~'));
    },
    check: (v) => {
      const r = (v as { ok: Record<string, Record<string, unknown>> }).ok;
      expect(r.missing).toEqual({ exitCode: 1, stdout: '', stderr: 'Working directory does not exist: ~/work/nope', timedOut: false, aborted: false });
      expect(r.timeout).toMatchObject({ exitCode: null, timedOut: true, aborted: false });
      expect(r.aborted).toMatchObject({ exitCode: null, timedOut: false, aborted: true });
      expect(r.fast as unknown).toBe(true);
    },
  },
  {
    name: 'exec: long output keeps head and tail, live output streams',
    rpc: ['exec', 'exec.output'],
    run: async (m, c) => {
      const chunks: string[] = [];
      const capped = await m.exec('printf "abcdefghij%.0s" $(seq 1 100)', { cwd: c.home, maxOutputBytes: 50 });
      const live = await m.exec('for i in 1 2 3; do echo line $i; sleep 0.05; done; echo err >&2', { cwd: c.home, onOutput: (s, which) => chunks.push(`${which}:${s}`) });
      const big = await m.exec('seq 1 200000', { cwd: c.home });
      return { capped: capped.stdout, live: live.stdout, streamed: chunks.filter((x) => x.startsWith('stdout:')).map((x) => x.slice(7)).join(''), err: chunks.filter((x) => x.startsWith('stderr:')).join(''), bigLen: big.stdout.length, bigSha: sha(big.stdout) };
    },
    check: (v) => {
      const r = (v as { ok: Record<string, unknown> }).ok;
      expect(r.capped).toBe('abcdefghijabcdefghijabcde\n[... 950 characters of output dropped ...]\nfghijabcdefghijabcdefghij');
      expect(r.live).toBe('line 1\nline 2\nline 3\n');
      expect(r.streamed).toBe(r.live);
      expect(r.err).toBe('stderr:err\n');
      expect(r.bigLen).toBe(1288895);
    },
  },
  {
    name: 'exec: a background child does not hold the result',
    rpc: ['exec'],
    run: async (m, c) => {
      const t0 = Date.now();
      const r = await m.exec('(sleep 3 &) ; echo bg', { cwd: c.home });
      return { stdout: r.stdout, exitCode: r.exitCode, quick: Date.now() - t0 < 2500 };
    },
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ stdout: 'bg\n', exitCode: 0, quick: true }),
  },
  {
    name: 'exec: hub secrets stay out, values passed on purpose and CONCLAVE_PASS_ENV go through',
    rpc: ['exec'],
    run: async (m, c) => ({
      scrub: (await m.exec('echo "[$CONCLAVE_TOKEN][$ANTHROPIC_API_KEY][$CONCLAVE_GITHUB_TOKEN][$OPENAI_API_KEY][$CONFORMANCE_VISIBLE]"', { cwd: c.home })).stdout,
      given: (await m.exec('echo "[$ANTHROPIC_API_KEY][$EXTRA]"', { cwd: c.home, env: { ANTHROPIC_API_KEY: 'given', EXTRA: 'x y' } })).stdout,
    }),
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ scrub: '[][][][passed-through][visible]\n', given: '[given][x y]\n' }),
  },
  // ----- spawn
  {
    name: 'spawn: stdin round trip, stderr and exit code, no shell',
    rpc: ['spawn', 'proc.stdin', 'proc.stdout', 'proc.stderr', 'proc.exit'],
    run: async (m, c) => ({
      cat: await runProc(m, 'cat', [], { cwd: c.home }, 'round trip ✓'),
      sh: await runProc(m, 'sh', ['-c', 'echo out; echo err >&2; exit 4'], { cwd: c.home }),
      args: await runProc(m, 'printf', ['%s|', 'a b', '$HOME', '*'], { cwd: c.home }),
      cwd: await runProc(m, 'pwd', [], { cwd: '~/work' }),
      env: await runProc(m, 'sh', ['-c', 'echo "[$CONCLAVE_TOKEN][$OPENAI_API_KEY][$MINE]"'], { cwd: c.home, env: { MINE: 'mine' } }),
    }),
    check: (v, c) => {
      const r = (v as { ok: Record<string, { code: number | null; stdout: string; stderr: string; pid: string }> }).ok;
      expect(r.cat).toEqual({ code: 0, stdout: 'round trip ✓', stderr: '', pid: 'number' });
      expect(r.sh).toMatchObject({ code: 4, stdout: 'out\n', stderr: 'err\n' });
      expect(r.args.stdout).toBe('a b|$HOME|*|');
      expect(r.cwd.stdout.trim()).toBe(realpathSync(w(c)));
      expect(r.env.stdout).toBe('[][passed-through][mine]\n');
    },
  },
  {
    name: 'spawn: kill with SIGTERM, SIGKILL and SIGINT',
    rpc: ['spawn', 'proc.kill'],
    run: async (m, c) => ({
      term: (await runProc(m, 'sleep', ['30'], { cwd: c.home }, undefined, { after: 200, signal: 'SIGTERM' })).code,
      kill: (await runProc(m, 'sleep', ['30'], { cwd: c.home }, undefined, { after: 200, signal: 'SIGKILL' })).code,
      // the whole group gets it: the shell's trap runs once its sleep dies
      int: (await runProc(m, 'sh', ['-c', 'trap "exit 7" INT; while :; do sleep 0.1; done'], { cwd: c.home }, undefined, { after: 300, signal: 'SIGINT' })).code,
      tree: (await runProc(m, 'sh', ['-c', 'sleep 30; echo never'], { cwd: c.home }, undefined, { after: 200, signal: 'SIGTERM' })).stdout,
    }),
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ term: null, kill: null, int: 7, tree: '' }),
  },
  {
    name: 'spawn: a missing program and a missing folder',
    rpc: ['spawn'],
    run: async (m, c) => ({
      missing: await runProc(m, 'definitely-not-a-program-xyz', [], { cwd: c.home }),
      cwd: await runProc(m, 'cat', [], { cwd: w(c, 'nope') }),
      notExec: await runProc(m, f(c, 'text.txt'), [], { cwd: c.home }),
    }),
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => {
      const r = (v as { ok: Record<string, { code: number | null; stderr: string }> }).ok;
      expect(r.missing).toMatchObject({ code: null, stderr: 'Executable not found in $PATH: "definitely-not-a-program-xyz"\n' });
      expect(r.cwd).toMatchObject({ code: null, stderr: "ENOENT: no such file or directory, posix_spawn 'cat'\n" });
      expect(r.notExec).toMatchObject({ code: null, stderr: "EACCES: permission denied, posix_spawn '~/files/text.txt'\n" });
    },
  },
  {
    name: 'spawn: a large streaming output arrives whole and in order',
    rpc: ['spawn', 'proc.stdout'],
    timeoutMs: 60_000,
    run: async (m, c) => {
      // awk, not seq: macOS seq prints 1000000 and up as 1e+06
      const p = m.spawn('sh', ['-c', "awk 'BEGIN { for (i = 1; i <= 3000000; i++) print i }'; echo tail >&2"], { cwd: c.home });
      const h = createHash('sha256');
      let n = 0;
      const reader = p.stdout.getReader();
      const err = new Response(p.stderr).text();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        h.update(value);
      }
      return { code: await p.exited, bytes: n, sha: h.digest('hex'), stderr: await err };
    },
    check: (v) => {
      const r = (v as { ok: { code: number; bytes: number; stderr: string } }).ok;
      // the numbers 1 to 3000000, one a line, are 22888896 bytes
      expect(r).toMatchObject({ code: 0, bytes: 22888896, stderr: 'tail\n' });
    },
  },
  // ----- protocol 3: the daemon's recent log for the hub's logs export
  {
    name: 'logTail: the lines of this run, secrets filtered, the same shape on each daemon',
    rpc: ['logTail'],
    run: async (m) => {
      const t = await m.logTail!(50);
      const all = [...t.lines, ...(t.file ?? [])];
      return {
        impl: typeof t.impl,
        startedAt: typeof t.startedAt,
        someLines: t.lines.length > 0 && t.lines.length <= 50,
        strings: all.every((l) => typeof l === 'string' && l.length <= 1100),
        online: t.lines.some((l) => /online/.test(l)),
      };
    },
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ impl: 'string', startedAt: 'number', someLines: true, strings: true, online: true }),
  },
  // ----- protocol 4: the daemon updates itself (docs/DESIGN.md, Updates). Both answer the first checks alike;
  // the update itself is tested on each side (packages/server/test/update.test.ts, daemon-rs src/update.rs)
  {
    name: 'selfUpdate: a request without a version, or with one that is not newer, is refused the same way',
    rpc: ['selfUpdate'],
    run: async (m) => {
      const manifest = { schema: 1, version: '0.0.0', signed: true, hub: {}, daemon: {}, desktop: {} } as never;
      return {
        noVersion: await outcome(() => m.selfUpdate!({ version: 'nope', manifest })),
        older: await outcome(() => m.selfUpdate!({ version: '0.0.0', manifest })),
      };
    },
    // the daemon's own version is in the sentence
    normalize: (v) => JSON.parse(JSON.stringify(v).replace(/this daemon \([^)]*\)/g, 'this daemon (V)')),
    check: (v) =>
      expect((v as { ok: unknown }).ok).toEqual({
        noVersion: { error: { message: 'selfUpdate needs a version.', code: 'EINVAL' } },
        older: { error: { message: 'Conclave 0.0.0 is not newer than this daemon (V).', code: 'EUPTODATE' } },
      }),
  },
  // ----- protocol 5: Conclave's turns appended to a Claude Code chat (import/writeback.ts)
  {
    name: 'importAppend: appends once, then refuses a changed file, a cut last line, an open chat and a wrong name',
    rpc: ['importAppend'],
    run: async (m, c) => {
      const sid = '11111111-2222-4333-8444-555555555555';
      const dir = join(c.out, 'wb-claude');
      const path = join(dir, 'projects', '-p', `${sid}.jsonl`);
      const first = '{"a":1}\n';
      await m.writeFile(path, first);
      const ask = (size: number, tail: string) => m.importAppend!({ path, sessionId: sid, text: '{"b":2}\n', expect: { size, tail } });
      const ok = await ask(first.length, sha(first));
      const text = await m.readText(path);
      const changed = await ask(first.length, sha(first));
      await m.writeFile(path, `${first}{"cut`);
      const cut = await ask(first.length + 5, sha(`${first}{"cut`));
      // a dead pid does not hold the chat; the test runner does
      await m.writeFile(join(dir, 'sessions', '1.json'), JSON.stringify({ pid: 2 ** 31 - 2, sessionId: sid }));
      const dead = await ask(first.length + 5, sha(`${first}{"cut`));
      await m.writeFile(join(dir, 'sessions', '2.json'), JSON.stringify({ pid: process.pid, sessionId: sid }));
      const busy = await ask(first.length + 5, sha(`${first}{"cut`));
      const name = await outcome(() => m.importAppend!({ path: join(dir, 'x.jsonl'), sessionId: sid, text: 'x\n', expect: { size: 0, tail: '' } }));
      return { ok: { ok: ok.ok, size: ok.ok && ok.size, mtime: ok.ok && typeof ok.mtime }, text, changed, cut, dead, busy: { ...busy, detail: 'detail' in busy && busy.detail === `sessions/2.json pid ${process.pid}` }, name };
    },
    check: (v) =>
      expect((v as { ok: unknown }).ok).toEqual({
        ok: { ok: true, size: 16, mtime: 'number' },
        text: '{"a":1}\n{"b":2}\n',
        changed: { ok: false, reason: 'changed' },
        cut: { ok: false, reason: 'partialTail' },
        dead: { ok: false, reason: 'partialTail' },
        busy: { ok: false, reason: 'busy', detail: true },
        name: { error: { message: 'importAppend needs a Claude Code session file named after its session id.', code: 'EINVAL' } },
      }),
  },
  // ----- Syncthing
  {
    name: 'syncthingFolders and syncthingStatus (the API key stays on the device)',
    rpc: ['syncthingFolders', 'syncthingStatus'],
    run: async (m) => ({ folders: await m.syncthingFolders!(), status: await m.syncthingStatus!('proj-1'), unknown: await outcome(() => m.syncthingStatus!('nope')) }),
    check: (v, c) => {
      const r = (v as { ok: Record<string, unknown> }).ok;
      expect(r.folders).toEqual([
        { id: 'proj-1', label: 'Projects', path: `${c.home}/work`, paused: false },
        { id: 'music', label: 'music', path: '/data/music', paused: true },
      ]);
      expect(r.status).toEqual({ state: 'idle', needFiles: 2, needBytes: 1024, pullErrors: 0 });
      expect(r.unknown).toEqual({ error: { message: 'no Syncthing folder nope on this device', code: 'ENOENT' } });
    },
  },
  // ----- chat import
  {
    name: 'importScan: every session file, converted on the device',
    rpc: ['importScan'],
    timeoutMs: 30_000,
    run: async (m) => {
      const r = await m.importScan!({});
      const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
      return { rows: [...r.rows].sort((a, b) => byPath(a.found, b.found)), present: [...r.present].sort(byPath), failed: r.failed };
    },
    normalize: (v, c) => JSON.parse(JSON.stringify(v).split(c.home).join('~')),
    check: (v) => {
      const r = (v as { ok: { rows: Array<{ found: { source: string; path: string }; info?: Record<string, unknown>; error?: string }>; present: unknown[] } }).ok;
      expect(r.present.length).toBe(15);
      const row = (end: string) => r.rows.find((x) => x.found.path.endsWith(end))!;
      expect(row(`${UUID_A}.jsonl`).info).toMatchObject({ id: UUID_A, title: 'Custom', kind: 'main' });
      expect(row('agent-1.jsonl').info).toMatchObject({ kind: 'subagent', parentId: UUID_A });
      expect(row(`${UUID_B}.jsonl`).info).toMatchObject({ title: 'Testing work', repo: 'git@github.com:me/work.git', model: 'openai/gpt-5' });
      expect(row(`${UUID_C}.jsonl`).info).toMatchObject({ kind: 'subagent', parentId: UUID_B });
      expect(row(`${UUID_D}.jsonl.zst`).info).toMatchObject({ id: UUID_D, title: 'Zipped' });
      expect(row('checkpoint-tag.json').info?.messages).toBe(2);
      // the long session: a secret never reaches the title, and the estimate spans several windows
      const big = row('11111111-2222-4333-8444-555555555555.jsonl').info!;
      expect(big.title).toContain('[redacted]');
      expect(String(big.title).length).toBeLessThanOrEqual(80);
      expect(big.estTokens as number).toBeGreaterThan(30_000);
      expect(row('33333333-2222-4333-8444-555555555555.jsonl').info?.kind).toBe('subagent');
      expect(row('44444444-2222-4333-8444-555555555555.jsonl').error).toContain('ENOENT');
      expect(row('0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5e.jsonl').info?.unknown).toEqual({ 'history_base:missing': 1 });
      expect(row('0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5f.jsonl').info).toMatchObject({ kind: 'internal', unknown: { 'history_base:loop': 1 } });
    },
  },
  {
    name: 'importScan: known files with the same size and mtime are not read again',
    rpc: ['importScan'],
    run: async (m) => {
      const first = await m.importScan!({ sources: ['codex'] });
      const known = first.present.map((f) => [f.path, f.size, f.mtime] as [string, number, number]);
      const again = await m.importScan!({ sources: ['codex'], known });
      return { first: first.rows.length, again: again.rows.length, present: again.present.length };
    },
    check: (v) => expect((v as { ok: unknown }).ok).toEqual({ first: 6, again: 0, present: 6 }),
  },
  {
    name: 'importRead: each source, long tool results cut on the device, a missing file',
    rpc: ['importRead'],
    timeoutMs: 30_000,
    run: async (m, c) => {
      const p = (...x: string[]) => join(c.home, ...x);
      return {
        claude: await m.importRead!({ source: 'claude-code', path: p('.claude', 'projects', '-home-me-work', `${UUID_A}.jsonl`), maxToolChars: 2000 }),
        sub: await m.importRead!({ source: 'claude-code', path: p('.claude', 'projects', '-home-me-work', UUID_A, 'subagents', 'agent-1.jsonl'), parent: UUID_A }),
        codex: await m.importRead!({ source: 'codex', path: p('.codex', 'sessions', '2025', '09', '12', `rollout-2025-09-12T10-00-00-${UUID_B}.jsonl`) }),
        fork: await m.importRead!({ source: 'codex', path: p('.codex', 'sessions', '2025', '09', '12', `rollout-2025-09-12T11-00-00-${UUID_C}.jsonl`) }),
        gemini: await m.importRead!({ source: 'gemini', path: p('.gemini', 'tmp', 'work-proj', 'chats', 'session-2025-03-01.jsonl') }),
        legacy: await m.importRead!({ source: 'gemini', path: p('.gemini', 'tmp', 'work-proj', 'chats', 'session-old.json') }),
        checkpoint: await m.importRead!({ source: 'gemini', path: p('.gemini', 'tmp', 'work-proj', 'chats', 'checkpoint-tag.json') }),
        big: await m.importRead!({ source: 'claude-code', path: p('.claude', 'projects', '-home-me-edge', '11111111-2222-4333-8444-555555555555.jsonl') }),
        old: await m.importRead!({ source: 'claude-code', path: p('.claude', 'projects', '-home-me-edge', '22222222-2222-4333-8444-555555555555.jsonl') }),
        side: await m.importRead!({ source: 'claude-code', path: p('.claude', 'projects', '-home-me-edge', '33333333-2222-4333-8444-555555555555.jsonl') }),
        zst: await m.importRead!({ source: 'codex', path: p('.codex', 'sessions', '2025', '09', '13', `rollout-2025-09-13T09-00-00-${UUID_D}.jsonl.zst`) }),
        noBase: await m.importRead!({ source: 'codex', path: p('.codex', 'sessions', '2025', '09', '14', 'rollout-2025-09-14T09-00-00-0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5e.jsonl') }),
        loop: await m.importRead!({ source: 'codex', path: p('.codex', 'sessions', '2025', '09', '14', 'rollout-2025-09-14T10-00-00-0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5f.jsonl') }),
        archived: await m.importRead!({ source: 'codex', path: p('.codex', 'archived_sessions', `rollout-2025-08-01T08-00-00-${UUID_A}.jsonl`) }),
        link: await outcome(() => m.importRead!({ source: 'claude-code', path: p('.claude', 'projects', '-home-me-edge', '44444444-2222-4333-8444-555555555555.jsonl') })),
        opencode: await outcome(() => m.importRead!({ source: 'opencode' as never, path: p('files', 'text.txt') })),
        missing: await outcome(() => m.importRead!({ source: 'codex', path: p('nope.jsonl') })),
      };
    },
    normalize: (v, c) => wellFormed(JSON.parse(JSON.stringify(v).split(c.home).join('~'))),
    check: (v) => {
      const r = (v as { ok: Record<string, { messages: Array<{ content: Array<{ content?: unknown; meta?: { clippedFrom?: number } }> }>; title?: string; cwd?: string }> }).ok;
      const clipped = r.claude.messages.flatMap((x) => x.content).find((b) => b.meta?.clippedFrom);
      expect(clipped?.meta?.clippedFrom).toBe(3003);
      expect(r.claude.title).toBe('Custom');
      expect(r.gemini.cwd).toBe('/home/me/work');
      expect(r.gemini.title).toBe('Repo tour');
      expect(r.fork.messages.length).toBeGreaterThan(2);
      expect(r.missing as unknown).toEqual({ error: { message: '~/nope.jsonl is not on this device any more', code: 'ENOENT' } });
    },
  },
  // ----- the rpc frame itself
  {
    name: 'rpc: an unknown method answers with an error',
    rpc: ['rpc'],
    run: (m) => call(m, 'noSuchMethod', {}),
    check: (v) => expect(v).toEqual({ error: { message: 'unknown method noSuchMethod' } }),
  },
];
