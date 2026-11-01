/**
 * A realistic fixture home for the owner (kai on arch-desktop), built from
 * the shapes measured in real transcripts (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.15):
 *
 * Claude Code
 * - portfolio: a branched file with an edited prompt (dead branch), parallel
 *   tool results, a queued prompt, a task notification, a compaction, a
 *   refusal fallback that retracts a reply, a .env read, a <private> span,
 *   system reminders and an unknown line type; plus a subagent transcript.
 * - homelab: host facts, a secret in the owner's text.
 * - the homelab session id reused in another project folder with other content.
 * - an sdk-ts automation run and a one-line chat (too short).
 * Codex
 * - a main thread with git info and titles in session_index.jsonl (last wins),
 *   a subagent notice and an inter-agent message;
 * - a paginated fork of it (history_base), with a _rolloutId name;
 * - an archived rollout compressed as .jsonl.zst in two frames;
 * - a memory_consolidation thread (internal, never learned) and an exec run.
 * Gemini CLI
 * - a chat with $rewindTo, $patch and $set records, and projects.json.
 * Exports
 * - a claude.ai and a ChatGPT conversations.json (the ChatGPT one has an
 *   edited prompt on a dead branch), and a zip writer for them.
 *
 * Usable by tests (buildOwnerHome in a /tmp/conclave-* folder) and by the
 * real hub check (bun test/importers/owner-home.ts <dir>).
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

export const OWNER = {
  claudeA: '7f3c2a10-5b1e-4c2d-9a8e-1f0b2c3d4e5f',
  claudeB: '2b9d4e61-8a7c-4f3e-b2d1-6c5e4f3a2b1c',
  claudeC: '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4',
  claudeD: '4c3b2a19-0f8e-4d7c-b6a5-e4d3c2b1a0f9',
  codexT1: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  codexT2: '0199b2c3-d4e5-7f6a-9b0c-1d2e3f4a5b6c',
  codexT3: '0198f0e1-d2c3-7b4a-8596-a7b8c9d0e1f2',
  codexT4: '0199c3d4-e5f6-7a7b-8c9d-0e1f2a3b4c5d',
  codexT5: '0199d4e5-f6a7-7b8c-9d0e-1f2a3b4c5d6e',
  gemini: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
} as const;

const HOME_USER = '/home/kai';
const PORTFOLIO = `${HOME_USER}/code/portfolio`;
const HOMELAB = `${HOME_USER}/code/homelab`;

export const OWNER_PATHS = {
  claudeA: `.claude/projects/-home-kai-code-portfolio/${OWNER.claudeA}.jsonl`,
  claudeSub: `.claude/projects/-home-kai-code-portfolio/${OWNER.claudeA}/subagents/agent-a1b2c3d4.jsonl`,
  claudeB: `.claude/projects/-home-kai-code-homelab/${OWNER.claudeB}.jsonl`,
  claudeBOld: `.claude/projects/-home-kai-code-homelab-old/${OWNER.claudeB}.jsonl`,
  claudeC: `.claude/projects/-home-kai-code-portfolio/${OWNER.claudeC}.jsonl`,
  claudeD: `.claude/projects/-home-kai/${OWNER.claudeD}.jsonl`,
  claudeSettings: '.claude/settings.json',
  codexT1: `.codex/sessions/2026/03/14/rollout-2026-03-14T12-00-00-${OWNER.codexT1}.jsonl`,
  codexT2: `.codex/sessions/2026/03/15/rollout-2026-03-15T10-00-00-${OWNER.codexT2}_r2a.jsonl`,
  codexT3: `.codex/archived_sessions/rollout-2026-02-01T08-00-00-${OWNER.codexT3}.jsonl.zst`,
  codexT4: `.codex/sessions/2026/03/16/rollout-2026-03-16T03-00-00-${OWNER.codexT4}.jsonl`,
  codexT5: `.codex/sessions/2026/03/16/rollout-2026-03-16T04-00-00-${OWNER.codexT5}.jsonl`,
  codexIndex: '.codex/session_index.jsonl',
  gemini: `.gemini/tmp/portfolio/chats/session-2026-04-01T10-00-${OWNER.gemini.slice(0, 8)}.jsonl`,
  geminiProjects: '.gemini/projects.json',
};

const uid = (p: string, n: number) => `${p}${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ts = (base: string, min: number) => new Date(Date.parse(base) + min * 60_000).toISOString();

function cc(sid: string, cwd: string, extra: Record<string, unknown> = {}) {
  return { isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.42', gitBranch: 'main', entrypoint: 'cli', ...extra };
}

function ccUser(sid: string, cwd: string, uuid: string, parent: string | null, at: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { ...cc(sid, cwd), parentUuid: parent, type: 'user', message: { role: 'user', content }, uuid, timestamp: at, ...extra };
}

function ccAsst(sid: string, cwd: string, uuid: string, parent: string, at: string, msgId: string, content: unknown[], extra: { model?: string; stop?: string | null } = {}) {
  return {
    ...cc(sid, cwd),
    parentUuid: parent,
    type: 'assistant',
    requestId: `req_${msgId}`,
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: extra.model ?? 'claude-opus-4-6',
      content,
      stop_reason: extra.stop ?? null,
      usage: { input_tokens: 12, output_tokens: 140, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 900 },
    },
    uuid,
    timestamp: at,
  };
}

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

export function claudeSessionA(): string {
  const S = OWNER.claudeA;
  const C = PORTFOLIO;
  const T = '2026-03-14T09:00:00.000Z';
  const u = (n: number) => uid('a', n);
  return jsonl([
    { type: 'file-history-snapshot', messageId: u(1), snapshot: { trackedFileBackups: {}, timestamp: T }, isSnapshotUpdate: false },
    ccUser(S, C, u(1), null, ts(T, 0), 'Set up the contact form on the portfolio site. Use Resend for email, not nodemailer.\n<system-reminder>The user opened src/pages/contact.astro in the IDE.</system-reminder>'),
    ccAsst(S, C, u(2), u(1), ts(T, 1), 'msg_01', [{ type: 'thinking', thinking: 'Look at the contact page first.', signature: 'sigA1' }]),
    ccAsst(S, C, u(3), u(2), ts(T, 1), 'msg_01', [{ type: 'text', text: "I'll look at the page first." }]),
    ccAsst(S, C, u(4), u(3), ts(T, 1), 'msg_01', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: `${C}/src/pages/contact.astro` } }], { stop: 'tool_use' }),
    ccUser(S, C, u(5), u(4), ts(T, 2), [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '<form class="contact">\n  <input name="email" />\n</form>' }]),
    ccAsst(S, C, u(6), u(5), ts(T, 3), 'msg_02', [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'cat .env', description: 'Show env file' } }]),
    ccAsst(S, C, u(7), u(6), ts(T, 3), 'msg_02', [{ type: 'tool_use', id: 'toolu_03', name: 'Grep', input: { pattern: 'nodemailer', path: C } }], { stop: 'tool_use' }),
    ccUser(S, C, u(8), u(7), ts(T, 4), [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'RESEND_API_KEY=re_FakeKeyForTests_1234567890abcdef\nSITE_URL=https://kai.dev' }]),
    ccUser(S, C, u(9), u(8), ts(T, 4), [{ type: 'tool_result', tool_use_id: 'toolu_03', content: 'package.json:14:    "nodemailer": "^6.9.0",' }]),
    ccAsst(S, C, u(10), u(9), ts(T, 6), 'msg_03', [{ type: 'text', text: 'The form posts nowhere yet. I added a Resend client in src/lib/mail.ts and removed nodemailer from package.json.' }], { stop: 'end_turn' }),
    // dead branch: the owner edited the next prompt
    ccUser(S, C, u(11), u(10), ts(T, 8), 'Actually make it post to /api/contact'),
    ccAsst(S, C, u(12), u(11), ts(T, 9), 'msg_04', [{ type: 'text', text: 'Sure, posting to /api/contact.' }], { stop: 'end_turn' }),
    ccUser(S, C, u(13), u(10), ts(T, 10), 'Make the form post to /api/contact and validate it with zod. <private>my bank pin is 4242</private>'),
    { ...cc(S, C), parentUuid: u(13), type: 'attachment', attachment: { type: 'queued_command', prompt: 'also add a honeypot field', humanTurn: true }, uuid: u(14), timestamp: ts(T, 10) },
    ccAsst(S, C, u(15), u(14), ts(T, 11), 'msg_05', [{ type: 'text', text: 'Adding the endpoint, zod validation and a honeypot field.' }]),
    ccAsst(S, C, u(16), u(15), ts(T, 11), 'msg_05', [{ type: 'tool_use', id: 'toolu_05', name: 'Edit', input: { file_path: `${C}/src/pages/api/contact.ts`, old_string: '', new_string: 'export const POST = ...' } }], { stop: 'tool_use' }),
    ccUser(S, C, u(17), u(16), ts(T, 12), [{ type: 'tool_result', tool_use_id: 'toolu_05', content: '<persisted-output>The file src/pages/api/contact.ts has been updated.</persisted-output>' }]),
    ccUser(S, C, u(18), u(17), ts(T, 13), '<task-notification>Background command "bun run build" finished with exit code 0</task-notification>', { origin: { kind: 'task-notification' } }),
    ccAsst(S, C, u(19), u(18), ts(T, 14), 'msg_06', [{ type: 'text', text: 'Build passes.' }], { stop: 'end_turn' }),
    { type: 'mystery-telemetry', uuid: u(20), timestamp: ts(T, 15) },
    { ...cc(S, C), parentUuid: null, logicalParentUuid: u(19), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 167_000 }, uuid: u(21), timestamp: ts(T, 30) },
    ccUser(S, C, u(22), u(21), ts(T, 30), 'This session is being continued from a previous conversation that ran out of context. Summary: contact form with Resend, zod and a honeypot.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    ccUser(S, C, u(23), u(22), ts(T, 32), 'Ship it. I always deploy the portfolio with `bun run deploy` from the repo root, never from CI. The launch is next friday.'),
    ccAsst(S, C, u(24), u(23), ts(T, 33), 'msg_07', [{ type: 'text', text: "I can't help with that." }], { stop: 'refusal' }),
    { ...cc(S, C), parentUuid: u(24), type: 'system', subtype: 'model_refusal_fallback', retractedMessageUuids: [u(24)], fallbackModel: 'claude-sonnet-4-5', uuid: u(25), timestamp: ts(T, 33) },
    ccAsst(S, C, u(26), u(23), ts(T, 34), 'msg_08', [{ type: 'text', text: 'Running bun run deploy from the repo root.' }, { type: 'tool_use', id: 'toolu_08', name: 'Bash', input: { command: 'bun run deploy' } }], { model: 'claude-sonnet-4-5', stop: 'tool_use' }),
    ccUser(S, C, u(27), u(26), ts(T, 36), [{ type: 'tool_result', tool_use_id: 'toolu_08', content: 'Deployed to https://kai.dev in 41s' }]),
    ccAsst(S, C, u(28), u(27), ts(T, 37), 'msg_09', [{ type: 'text', text: 'Deployed. The site is live at https://kai.dev.' }], { model: 'claude-sonnet-4-5', stop: 'end_turn' }),
    { type: 'custom-title', customTitle: 'Portfolio contact form', sessionId: S },
    { type: 'ai-title', aiTitle: 'Contact form with Resend', sessionId: S },
    { type: 'summary', summary: 'Contact form with Resend and zod', leafUuid: u(28) },
    { type: 'last-prompt', lastPrompt: 'Ship it.', leafUuid: u(23), sessionId: S },
  ]);
}

/** Lines the owner adds in Claude Code after the import (the source grew). */
export function claudeSessionAGrowth(): string {
  const S = OWNER.claudeA;
  const C = PORTFOLIO;
  const T = '2026-03-15T08:00:00.000Z';
  const u = (n: number) => uid('a', n);
  return jsonl([
    ccUser(S, C, u(40), u(28), ts(T, 0), 'The launch moved. Also add Plausible analytics to the layout.'),
    ccAsst(S, C, u(41), u(40), ts(T, 1), 'msg_20', [{ type: 'text', text: 'Added the Plausible script to src/layouts/Base.astro.' }], { stop: 'end_turn' }),
    { type: 'last-prompt', lastPrompt: 'The launch moved.', leafUuid: u(40), sessionId: S },
  ]);
}

export function claudeSubagent(): string {
  const S = OWNER.claudeA;
  const C = PORTFOLIO;
  const T = '2026-03-14T09:03:00.000Z';
  const u = (n: number) => uid('s', n);
  return jsonl([
    { ...ccUser(S, C, u(1), null, ts(T, 0), 'Find every use of nodemailer in the repo.'), isSidechain: true, agentId: 'a1b2c3d4' },
    { ...ccAsst(S, C, u(2), u(1), ts(T, 1), 'msg_s1', [{ type: 'text', text: 'Only package.json line 14.' }], { stop: 'end_turn' }), isSidechain: true, agentId: 'a1b2c3d4' },
  ]);
}

export function claudeSessionB(): string {
  const S = OWNER.claudeB;
  const C = HOMELAB;
  const T = '2026-03-20T19:00:00.000Z';
  const u = (n: number) => uid('b', n);
  return jsonl([
    ccUser(S, C, u(1), null, ts(T, 0), 'madx is my homelab server, an LXC on pve. When a service hangs, restart it with systemctl, never reboot madx.'),
    ccAsst(S, C, u(2), u(1), ts(T, 1), 'msg_b1', [{ type: 'text', text: 'Understood. Which service is hanging?' }], { stop: 'end_turn' }),
    ccUser(S, C, u(3), u(2), ts(T, 2), 'caddy. The tunnel uses CLOUDFLARE_API_TOKEN=FakeTok3nForTests1234567 from /etc/caddy/env, keep it there.'),
    ccAsst(S, C, u(4), u(3), ts(T, 3), 'msg_b2', [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'ssh madx systemctl restart caddy && ssh madx systemctl is-active caddy' } }], { stop: 'tool_use' }),
    ccUser(S, C, u(5), u(4), ts(T, 4), [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'active' }]),
    ccAsst(S, C, u(6), u(5), ts(T, 5), 'msg_b3', [{ type: 'text', text: 'Restarted caddy on madx; systemctl says it is active.' }], { stop: 'end_turn' }),
    ccUser(S, C, u(7), u(6), ts(T, 7), 'Good. Proxmox backups go to the PBS datastore on pve every night at 02:00, so do not restart pve before 03:00.'),
    ccAsst(S, C, u(8), u(7), ts(T, 8), 'msg_b4', [{ type: 'text', text: 'Noted: no pve restarts before 03:00.' }], { stop: 'end_turn' }),
    { type: 'last-prompt', lastPrompt: 'Good.', leafUuid: u(7), sessionId: S },
  ]);
}

/** The same session id in another project folder, with other content (Claude Code ids repeat across folders). */
export function claudeSessionBOld(): string {
  const S = OWNER.claudeB;
  const C = `${HOMELAB}-old`;
  const T = '2026-01-10T19:00:00.000Z';
  const u = (n: number) => uid('o', n);
  return jsonl([
    ccUser(S, C, u(1), null, ts(T, 0), 'List the containers on pve and their memory limits. I want to retire the old wiki container this month, since nobody has opened it since the move to markdown notes.'),
    ccAsst(S, C, u(2), u(1), ts(T, 1), 'msg_o1', [{ type: 'text', text: 'There are 9 containers; the wiki one has 2 GB.' }], { stop: 'end_turn' }),
    ccUser(S, C, u(3), u(2), ts(T, 3), 'Retire the wiki container after exporting its pages to markdown in the homelab repo docs folder. Keep the export script in scripts/ so I can run it again.'),
    ccAsst(S, C, u(4), u(3), ts(T, 4), 'msg_o2', [{ type: 'text', text: 'Exported 214 pages to docs/wiki and stopped container 104.' }], { stop: 'end_turn' }),
  ]);
}

export function claudeSessionC(): string {
  const S = OWNER.claudeC;
  const C = PORTFOLIO;
  const T = '2026-03-18T06:00:00.000Z';
  const u = (n: number) => uid('c', n);
  return jsonl([
    { ...ccUser(S, C, u(1), null, ts(T, 0), 'Summarize the git log for the release notes. Output markdown only, no commentary.'), entrypoint: 'sdk-ts' },
    { ...ccAsst(S, C, u(2), u(1), ts(T, 1), 'msg_c1', [{ type: 'text', text: '- Contact form\n- Dark mode' }], { stop: 'end_turn' }), entrypoint: 'sdk-ts' },
  ]);
}

export function claudeSessionD(): string {
  const S = OWNER.claudeD;
  const C = HOME_USER;
  const T = '2026-03-19T22:00:00.000Z';
  return jsonl([ccUser(S, C, uid('d', 1), null, ts(T, 0), 'hi'), ccAsst(S, C, uid('d', 2), uid('d', 1), ts(T, 0), 'msg_d1', [{ type: 'text', text: 'Hi! What are we working on?' }], { stop: 'end_turn' })]);
}

// ----- Codex -----------------------------------------------------------------

function cx(at: string, type: string, payload: unknown) {
  return { timestamp: at, type, payload };
}

function cxMeta(id: string, at: string, cwd: string, extra: Record<string, unknown> = {}) {
  return cx(at, 'session_meta', {
    id,
    timestamp: at,
    cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.98.0',
    instructions: null,
    source: 'cli',
    thread_source: 'user',
    model_provider: 'openai',
    git: { commit_hash: '4f1c2a9b7e3d1f0a8c6b5e4d3c2b1a0f9e8d7c6b', branch: 'main', repository_url: 'git@github.com:kai/portfolio.git' },
    ...extra,
  });
}

const cxUser = (at: string, text: string) => cx(at, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const cxAsst = (at: string, text: string) => cx(at, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

export function codexT1(): string {
  const T = '2026-03-14T12:00:00.000Z';
  const C = PORTFOLIO;
  return jsonl([
    cxMeta(OWNER.codexT1, ts(T, 0), C),
    cx(ts(T, 0), 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>workspace-write</permissions instructions>' }] }),
    cxUser(ts(T, 0), `# AGENTS.md instructions for ${C}\n\nUse bun.`),
    cxUser(ts(T, 0), `<environment_context>\n  <cwd>${C}</cwd>\n</environment_context>`),
    cx(ts(T, 0), 'turn_context', { cwd: C, approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: 'gpt-5.5-codex', effort: 'medium', summary: 'auto' }),
    cxUser(ts(T, 1), 'Add a dark mode toggle. Keep the CSS in src/styles/tokens.css, no tailwind.'),
    cx(ts(T, 1), 'event_msg', { type: 'user_message', message: 'Add a dark mode toggle. Keep the CSS in src/styles/tokens.css, no tailwind.' }),
    cx(ts(T, 2), 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Finding the styles**' }], content: null, encrypted_content: 'gAAAA' }),
    cx(ts(T, 2), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'rg --files src/styles'], workdir: C }), call_id: 'call_c1' }),
    cx(ts(T, 3), 'response_item', { type: 'function_call_output', call_id: 'call_c1', output: JSON.stringify({ output: 'src/styles/tokens.css\nsrc/styles/base.css\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) }),
    cxAsst(ts(T, 5), 'Added a toggle in src/components/Theme.astro and dark tokens in src/styles/tokens.css.'),
    cxUser(ts(T, 6), '<subagent_notification>{"agent":"reviewer","status":"done","summary":"No issues in Theme.astro"}</subagent_notification>'),
    cxUser(ts(T, 6), 'Message Type: handoff\nTask name: review theme\nSender: reviewer\nPayload: Looks good, ship it.'),
    cx(ts(T, 7), 'response_item', { type: 'ghost_snapshot', ghost_commit: { id: 'abc' } }),
    cxUser(ts(T, 8), 'Commit it with a conventional commit message. I always use conventional commits in this repo.'),
    cx(ts(T, 8), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git commit -am "feat: dark mode toggle"'], workdir: C }), call_id: 'call_c2' }),
    cx(ts(T, 9), 'response_item', { type: 'function_call_output', call_id: 'call_c2', output: JSON.stringify({ output: '[main 1a2b3c4] feat: dark mode toggle\n 2 files changed', metadata: { exit_code: 0 } }) }),
    cxAsst(ts(T, 10), 'Committed as feat: dark mode toggle.'),
    cxUser(ts(T, 11), 'Also make the toggle remember the choice in localStorage and follow prefers-color-scheme on the first visit, so the site never flashes the wrong theme.'),
    cxAsst(ts(T, 12), 'The toggle now stores the choice and reads prefers-color-scheme before the first paint.'),
  ]);
}

/** A paginated fork of T1: its history starts with T1's first items. */
export function codexT2(): string {
  const T = '2026-03-15T10:00:00.000Z';
  const C = PORTFOLIO;
  return jsonl([
    cxMeta(OWNER.codexT2, ts(T, 0), C, { history_base: { thread_id: OWNER.codexT1, items: 9 }, forked_from_id: OWNER.codexT1 }),
    cx(ts(T, 0), 'turn_context', { cwd: C, model: 'gpt-5.5-codex' }),
    cxUser(ts(T, 1), 'Now add a test for the toggle with bun test and happy-dom. Cover the stored choice and the first visit without one.'),
    cxAsst(ts(T, 3), 'Added src/components/Theme.test.ts; bun test passes.'),
    cxUser(ts(T, 4), 'Good, keep tests next to the component files from now on, named like Theme.test.ts, not in a separate tests folder.'),
    cxAsst(ts(T, 5), 'Will do.'),
  ]);
}

export function codexT3(): string {
  const T = '2026-02-01T08:00:00.000Z';
  const C = HOMELAB;
  return jsonl([
    cxMeta(OWNER.codexT3, ts(T, 0), C, { git: { branch: 'main', repository_url: 'https://github.com/kai/homelab.git' } }),
    cx(ts(T, 0), 'turn_context', { cwd: C, model: 'gpt-5.4' }),
    cxUser(ts(T, 1), 'Write a backup check script for the PBS datastore on pve. It should alert me on ntfy if the last backup is older than 26 hours. Use the ntfy topic homelab-alerts and keep the script in plain bash.'),
    cxAsst(ts(T, 4), 'Wrote scripts/pbs-check.sh; it reads the last snapshot time with proxmox-backup-client.'),
    cxUser(ts(T, 5), 'Run it from cron on madx at 07:15 every day, and log to /var/log/pbs-check.log so I can see the last run.'),
    cxAsst(ts(T, 6), 'Added a cron entry on madx: 15 7 * * * /opt/homelab/scripts/pbs-check.sh'),
  ]);
}

export function codexT4(): string {
  const T = '2026-03-16T03:00:00.000Z';
  return jsonl([
    cxMeta(OWNER.codexT4, ts(T, 0), PORTFOLIO, { thread_source: 'memory_consolidation', source: 'internal' }),
    cxUser(ts(T, 1), 'Consolidate the memories from these rollouts into MEMORY.md. Keep only durable facts about the user.'),
    cxAsst(ts(T, 2), 'Updated ~/.codex/memories/MEMORY.md.'),
  ]);
}

export function codexT5(): string {
  const T = '2026-03-16T04:00:00.000Z';
  return jsonl([
    cxMeta(OWNER.codexT5, ts(T, 0), PORTFOLIO, { source: 'exec' }),
    cxUser(ts(T, 1), 'Run the lint and print the count of warnings. Print the number only.'),
    cxAsst(ts(T, 2), '0'),
  ]);
}

export function codexIndex(): string {
  return jsonl([
    { id: OWNER.codexT1, thread_name: 'Dark mode toggle', updated_at: '2026-03-14T12:05:00Z' },
    { id: OWNER.codexT3, thread_name: 'PBS backup check', updated_at: '2026-02-01T08:06:00Z' },
    { id: OWNER.codexT1, thread_name: 'Dark mode toggle for the portfolio', updated_at: '2026-03-14T12:10:00Z' },
  ]);
}

// ----- Gemini CLI ------------------------------------------------------------

export function geminiChat(): string {
  const T = '2026-04-01T10:00:00.000Z';
  return jsonl([
    { sessionId: OWNER.gemini, projectHash: 'portfolio', startTime: T, lastUpdated: ts(T, 9), kind: 'main' },
    { id: 'gm1', timestamp: ts(T, 0), type: 'user', content: [{ text: 'How do I make the hero image on the portfolio load faster? Lighthouse says the largest contentful paint is 3.8 seconds on mobile, and the hero is a 2.4 MB PNG.' }] },
    { id: 'gm2', timestamp: ts(T, 1), type: 'gemini', model: 'gemini-3-pro', content: 'Use a smaller WebP.', thoughts: [{ subject: 'Images', description: 'Compare formats.' }] },
    { id: 'gm3', timestamp: ts(T, 2), type: 'user', content: 'wrong, redo that' },
    { $rewindTo: 'gm3' },
    { id: 'gm4', timestamp: ts(T, 3), type: 'user', content: 'Use astro:assets with AVIF. I prefer AVIF over WebP for photos on all my sites. Keep a JPEG fallback for old Safari and lazy load everything below the fold.' },
    {
      id: 'gm5',
      timestamp: ts(T, 5),
      type: 'gemini',
      model: 'gemini-3-pro',
      content: 'Switching to WebP.',
      toolCalls: [{ id: 'gt1', name: 'replace', args: { file_path: `${PORTFOLIO}/src/components/Hero.astro` }, status: 'success', resultDisplay: 'Edited Hero.astro' }],
    },
    { $patch: { id: 'gm5', content: 'Switched the hero to astro:assets with AVIF output.' } },
    { id: 'gm6', timestamp: ts(T, 8), type: 'info', content: 'Checkpoint saved.' },
    { $set: { summary: 'Faster hero image with AVIF' } },
  ]);
}

// ----- chat app exports --------------------------------------------------------

export function claudeAiExport(): unknown[] {
  return [
    {
      uuid: 'c0a1b2c3-1111-4222-8333-944455556666',
      name: 'Lisbon trip food',
      created_at: '2026-05-02T18:00:00.000000Z',
      updated_at: '2026-05-02T18:20:00.000000Z',
      project_uuid: 'p-travel',
      chat_messages: [
        { uuid: 'cm-1', sender: 'human', text: 'I am vegetarian. Find dinner places in Alfama for Friday.', content: [{ type: 'text', text: 'I am vegetarian. Find dinner places in Alfama for Friday.' }], created_at: '2026-05-02T18:00:00Z', attachments: [], files: [] },
        { uuid: 'cm-2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Three vegetarian-friendly places in Alfama: ...' }, { type: 'voice_note', title: 'x' }], created_at: '2026-05-02T18:01:00Z' },
        { uuid: 'cm-3', sender: 'human', text: 'Book nothing, just list them. I never want you to make reservations for me.', content: [], created_at: '2026-05-02T18:05:00Z' },
        { uuid: 'cm-4', sender: 'assistant', text: 'Understood, listing only.', content: [], created_at: '2026-05-02T18:06:00Z' },
      ],
    },
    { uuid: 'c0a1b2c3-2222-4222-8333-944455556666', name: '', created_at: '2026-05-03T09:00:00Z', updated_at: '2026-05-03T09:00:00Z', chat_messages: [] },
  ];
}

export function chatGptExport(): unknown[] {
  const node = (id: string, parent: string | null, children: string[], role: string | null, text: string | null, at: number, extra: Record<string, unknown> = {}) => ({
    id,
    parent,
    children,
    message: role ? { id, author: { role }, create_time: at, content: { content_type: 'text', parts: [text] }, metadata: { model_slug: 'gpt-5.5', ...extra } } : null,
  });
  const t = Date.parse('2026-06-10T07:00:00Z') / 1000;
  return [
    {
      title: 'Gym plan',
      create_time: t,
      update_time: t + 600,
      conversation_id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      current_node: 'n5',
      mapping: {
        // the owner edited the first prompt: the edit is a sibling of the original under the root
        root: node('root', null, ['n1', 'n3'], null, null, t),
        n1: node('n1', 'root', ['n2'], 'user', 'Make me a 3 day gym plan.', t + 10),
        n2: node('n2', 'n1', [], 'assistant', 'Here is a 5 day plan.', t + 20),
        n3: node('n3', 'root', ['n4'], 'user', 'Make me a 3 day gym plan. I train Monday, Wednesday and Friday mornings.', t + 30),
        n4: node('n4', 'n3', ['n5'], 'assistant', 'Monday push, Wednesday pull, Friday legs.', t + 40),
        n5: node('n5', 'n4', [], 'user', 'Good. I have a bad left knee, so no deep squats.', t + 50),
      },
    },
  ];
}

/** A zip of the given files, deflated, as a chat app export would arrive. */
export function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const comp = new Uint8Array(deflateRawSync(data));
    const nameB = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameB.length + comp.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    local.set(comp, 30 + nameB.length);
    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    locals.push(local);
    central.push(cd);
    offset += local.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const b of [...locals, ...central, end]) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

// ----- build -------------------------------------------------------------------

const MTIMES: Partial<Record<keyof typeof OWNER_PATHS, string>> = {
  claudeA: '2026-03-14T09:37:00Z',
  claudeSub: '2026-03-14T09:04:00Z',
  claudeB: '2026-03-20T19:08:00Z',
  claudeBOld: '2026-01-10T19:04:00Z',
  claudeC: '2026-03-18T06:01:00Z',
  claudeD: '2026-03-19T22:00:30Z',
  codexT1: '2026-03-14T12:10:00Z',
  codexT2: '2026-03-15T10:05:00Z',
  codexT3: '2026-02-01T08:06:00Z',
  codexT4: '2026-03-16T03:02:00Z',
  codexT5: '2026-03-16T04:02:00Z',
  gemini: '2026-04-01T10:09:00Z',
};

function put(home: string, rel: string, content: string | Uint8Array): void {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export interface OwnerHome {
  home: string;
  path(key: keyof typeof OWNER_PATHS): string;
}

/** Write the fixture home. Without a dir it goes to a fresh /tmp/conclave-owner-* folder. */
export function buildOwnerHome(dir?: string): OwnerHome {
  const home = dir ?? mkdtempSync(join(tmpdir(), 'conclave-owner-'));
  mkdirSync(home, { recursive: true });
  put(home, OWNER_PATHS.claudeA, claudeSessionA());
  put(home, OWNER_PATHS.claudeSub, claudeSubagent());
  put(home, OWNER_PATHS.claudeB, claudeSessionB());
  put(home, OWNER_PATHS.claudeBOld, claudeSessionBOld());
  put(home, OWNER_PATHS.claudeC, claudeSessionC());
  put(home, OWNER_PATHS.claudeD, claudeSessionD());
  put(home, OWNER_PATHS.claudeSettings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(bun test:*)'] } }, null, 2));
  put(home, OWNER_PATHS.codexT1, codexT1());
  put(home, OWNER_PATHS.codexT2, codexT2());
  // archived and compressed in two zstd frames, as a log rotated mid-file would be
  const t3 = codexT3();
  const cut = t3.indexOf('\n', t3.length / 2) + 1;
  put(home, OWNER_PATHS.codexT3, new Uint8Array([...Bun.zstdCompressSync(Buffer.from(t3.slice(0, cut))), ...Bun.zstdCompressSync(Buffer.from(t3.slice(cut)))]));
  put(home, OWNER_PATHS.codexT4, codexT4());
  put(home, OWNER_PATHS.codexT5, codexT5());
  put(home, OWNER_PATHS.codexIndex, codexIndex());
  put(home, OWNER_PATHS.gemini, geminiChat());
  put(home, OWNER_PATHS.geminiProjects, JSON.stringify({ projects: { [PORTFOLIO]: 'portfolio' } }, null, 2));
  for (const [k, at] of Object.entries(MTIMES)) {
    const t = new Date(at!);
    utimesSync(join(home, OWNER_PATHS[k as keyof typeof OWNER_PATHS]), t, t);
  }
  return { home, path: (k) => join(home, OWNER_PATHS[k]) };
}

/** The owner keeps going in Claude Code: the portfolio session grows. */
export function growClaudeA(home: string, at = '2026-03-15T08:02:00Z'): void {
  const p = join(home, OWNER_PATHS.claudeA);
  appendFileSync(p, claudeSessionAGrowth());
  const t = new Date(at);
  utimesSync(p, t, t);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: bun owner-home.ts <dir>');
    process.exit(2);
  }
  const h = buildOwnerHome(dir);
  put(h.home, 'exports/claude-ai/conversations.json', JSON.stringify(claudeAiExport()));
  put(h.home, 'exports/claude-ai.zip', zipOf({ 'conversations.json': JSON.stringify(claudeAiExport()), 'projects.json': JSON.stringify([{ uuid: 'p-travel', name: 'Travel' }]) }));
  put(h.home, 'exports/chatgpt.zip', zipOf({ 'conversations.json': JSON.stringify(chatGptExport()) }));
  console.log(h.home);
}
