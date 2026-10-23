/**
 * A throwaway hub with demo data, for screenshots and for trying the apps
 * without a real model or a real hub.
 *
 *   bun scripts/demo-hub.ts [--port 7810] [--url URL] [--token TOKEN] [--password PW] [--info FILE] [--check]
 *
 * It makes a temp home with a small git repo in it, starts a fake model (an
 * Anthropic-compatible server in this process that streams scripted
 * replies), points the hub's anthropic provider at it, and starts the hub on
 * --port with devices on this network allowed. Then it seeds the hub through
 * its own API, so everything the apps show is real hub data:
 *
 *   Fix login redirect     a finished coding session: an Edit with a diff and a passing test run
 *   Push the login fix     waiting on an approval for git push origin fix/login
 *   Move session routes    an open AskUserQuestion: "Keep the old API route?"
 *   Plan the week          a plain chat with a short answer
 *   review-login-fix       a workflow run with one agent still working
 *   Raise the session timeout  a repo session on fernway/portal from a fake
 *                          GitHub (local bare repos and a small API): one
 *                          commit pushed, pull request #1 open, checks passed
 *   Friends                Alice (verified), Ben (his hub does not answer),
 *                          a request in and one out, Eli (a new hub key),
 *                          with notes both ways (seedFriends)
 *   Shares                 an offer from Alice that waits, Ben's accepted
 *                          with a diff for fernway-web, the login fix sent
 *                          to Alice and accepted, one unsent, one expired
 *                          (seedShares)
 *   Shared projects        Fernway portal on fernway/portal with Alice: a note
 *                          each, her memory, the plan chat as a share,
 *                          her pull request in the code view; and Alice's
 *                          invite to Fernway logo (seedSharedProject)
 *
 *   Cars under $8,000      a watch on a fake marketplace that ran twice:
 *                          four cars, then one new, one gone and one
 *                          cheaper, with photos (seedWatch)
 *   Focus blocks tomorrow  a calendar on a fake CalDAV server, and two focus
 *                          blocks the assistant proposed, waiting on Today
 *                          to be approved or declined (seedCalendar)
 *   Riley                  a second person on the hub (docs/design/ACCOUNTS.md),
 *                          Riley Chen to the apps (she signs in as riley),
 *                          with her own chat, Weekend in Lisbon, and her own
 *                          memory, on the hub's Anthropic key up to $10 a
 *                          month. Sam does not see them, nor she his.
 *
 *   conclave               one project on three devices for Group by
 *                          Project: a session on the MacBook in
 *                          ~/code/conclave, one on the hub in a clone at
 *                          ~/srv/conclave, and a Claude Code chat imported
 *                          from the MacBook (seedConclave)
 *
 * Two skills (release-notes, review-pr) and two MCP servers (the hub's
 * own, connected, and github, off) give the "/" menu and its Connectors
 * sheet something to show.
 *
 * The coding sessions run on a device named MacBook: a daemon in this
 * process, paired with a device code like a real one. The hub's own device
 * is named homelab, as an owner would name it.
 *
 * --url is the first address in the pairing link (default
 * http://127.0.0.1:<port>; an Android emulator reaches the host at
 * http://10.0.2.2:<port>). The hub has a password (random, or --password)
 * for the apps' address and password login. --info writes the hub URL,
 * owner token, password, pairing code and link as JSON for scripts.
 * --check seeds, checks through the API
 * that the approval and the question are pending, prints OK and exits.
 * Ctrl-C stops the hub and deletes the temp home.
 *
 * The script runs itself again as a child with HOME set to the temp home, so
 * the hub never reads your own ~/.conclave, ~/.claude or provider keys. The
 * parent only waits for it and deletes the temp home afterwards.
 */
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT_ENV = 'CONCLAVE_DEMO_ROOT';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: '7810' },
    url: { type: 'string' },
    token: { type: 'string' },
    password: { type: 'string' },
    info: { type: 'string' },
    check: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help) {
  console.log('bun scripts/demo-hub.ts [--port 7810] [--url URL] [--token TOKEN] [--password PW] [--info FILE] [--check]');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: a temp home, the child, and the cleanup
// ---------------------------------------------------------------------------

/** The environment for the child: nothing that points at your own config or keys. */
function cleanEnv(home: string, root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CONCLAVE_|CLAUDE_|CODEX_|GEMINI_|OPENAI_|ANTHROPIC_|XDG_(CONFIG|DATA|CACHE|STATE)_HOME$)/i.test(k)) continue;
    if (/(API_KEY|_TOKEN|_SECRET)$/i.test(k)) continue;
    env[k] = v;
  }
  // the hub's own log stays quiet so the connection details read well; CONCLAVE_LOG=info shows it
  const log = process.env.CONCLAVE_LOG || (opts.check ? 'error' : 'warn');
  return { ...env, HOME: home, USERPROFILE: home, [ROOT_ENV]: root, CONCLAVE_CATALOG_OFFLINE: '1', CONCLAVE_LOG: log };
}

async function supervise(): Promise<void> {
  // /tmp over the macOS per-user temp folder: the folder shows in every session, so short reads better
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, 'conclave-demo-')));
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: cleanEnv(root, root),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  // Ctrl-C reaches the child from the terminal too; a signal sent to this process alone is passed on once
  let told = false;
  const stop = () => {
    if (told) return;
    told = true;
    child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const code = await child.exited;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.error(`demo: could not delete ${root}: ${(err as Error).message}`);
  }
  process.exit(code ?? 1);
}

// ---------------------------------------------------------------------------
// The demo repo
// ---------------------------------------------------------------------------

const BUGGY = `/** Where to send someone after they log in. */
export function afterLogin(next: string | null): string {
  return '/home';
}
`;

const OLD_BODY = `export function afterLogin(next: string | null): string {
  return '/home';
}`;

const NEW_BODY = `export function afterLogin(next: string | null): string {
  // only paths on this site: "//evil.example" would leave it
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/home';
}`;

const TESTS = `import { expect, test } from 'bun:test';
import { afterLogin } from './redirect';

test('goes to next when it is a path on this site', () => {
  expect(afterLogin('/billing')).toBe('/billing');
});

test('never leaves the site', () => {
  expect(afterLogin('//evil.example')).toBe('/home');
});

test('goes home without next', () => {
  expect(afterLogin(null)).toBe('/home');
});
`;

const ROUTES = `import { Hono } from 'hono';
import { listSessions, getSession } from './sessions';

export const api = new Hono();

api.get('/api/session', (c) => c.json(listSessions()));
api.get('/api/session/:id', (c) => c.json(getSession(c.req.param('id'))));
`;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=Sam Rivera', '-c', 'user.email=sam@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** fernway-web: main, then fix/login two commits ahead with a test that fails until the fix. */
function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(join(dir, 'package.json'), JSON.stringify({ name: 'fernway-web', private: true, type: 'module', scripts: { test: 'bun test' } }, null, 2) + '\n');
  write(join(dir, 'README.md'), '# fernway-web\n\nThe Fernway customer portal.\n');
  write(join(dir, 'src/auth/redirect.ts'), BUGGY);
  write(join(dir, 'src/api/routes.ts'), ROUTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Customer portal: login and session API');
  git(dir, 'checkout', '-q', '-b', 'fix/login');
  write(join(dir, 'src/auth/redirect.test.ts'), TESTS);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Add tests for the login redirect');
  write(join(dir, 'src/auth/login-form.ts'), `/** The next= parameter the login form carries through. */\nexport function nextParam(url: URL): string | null {\n  return url.searchParams.get('next');\n}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Carry next= through the login form');
}

/** conclave: the MacBook's clone, and the hub's clone of it, both with the GitHub remote. */
function makeConclave(mac: string, hub: string): void {
  mkdirSync(mac, { recursive: true });
  git(mac, 'init', '-q', '-b', 'main');
  write(join(mac, 'package.json'), JSON.stringify({ name: 'conclave', private: true, workspaces: ['packages/*'] }, null, 2) + '\n');
  write(join(mac, 'README.md'), '# Conclave\n\nOne hub, many models, every device.\n');
  write(join(mac, 'packages/web/src/features/chat/SessionList.tsx'), `export function SessionList() {\n  return null;\n}\n`);
  git(mac, 'add', '-A');
  git(mac, 'commit', '-q', '-m', 'Hub, web app and session list');
  git(mac, 'remote', 'add', 'origin', 'https://github.com/sam-rivera/conclave.git');
  mkdirSync(join(hub, '..'), { recursive: true });
  const r = spawnSync('git', ['clone', '-q', mac, hub], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr}`);
  git(hub, 'remote', 'set-url', 'origin', 'https://github.com/sam-rivera/conclave.git');
}

/** A Claude Code chat on the MacBook in the conclave clone, as Claude Code writes it to ~/.claude/projects. */
function writeClaudeChat(home: string, cwd: string, id: string): void {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const t0 = Date.now() - 3 * 3_600_000;
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const base = { isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.42', gitBranch: 'main', entrypoint: 'cli' };
  const u = (n: number) => `c${String(n).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const user = (n: number, parent: number | null, min: number, content: unknown) => ({ ...base, parentUuid: parent ? u(parent) : null, type: 'user', message: { role: 'user', content }, uuid: u(n), timestamp: at(min) });
  const asst = (n: number, parent: number, min: number, text: string) => ({
    ...base,
    parentUuid: u(parent),
    type: 'assistant',
    requestId: `req_${n}`,
    message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 140, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 900 } },
    uuid: u(n),
    timestamp: at(min),
  });
  const lines = [
    user(1, null, 0, 'The code chat should feel like Claude Code. When I press "/" it should list skills, and there should be settings for connectors, hooks and permissions right in the session, not on another page.'),
    asst(2, 1, 2, 'Here is the plan: a "/" menu in three sections (Commands, Skills, Custom), and the settings commands (/mcp, /hooks, /permissions, /context) as sheets over the session.'),
    user(3, 2, 6, 'Good. Connectors should let me turn a server off for one session only, and /context should show what fills the window and where compaction starts.'),
    asst(4, 3, 9, 'Noted. Connectors keeps a per session list of servers that are off; the hub leaves their tools out of that session. /context splits the window into system, tools, messages and tool output, with a tick at the compaction point.'),
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** Skills for the "/" menu: one of the owner's, one from Claude Code's folder. */
function writeSkills(home: string): void {
  write(
    join(home, '.conclave', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes from the git log since a tag\n---\nRead `git log` since the tag in the arguments (or the last tag) and write release notes: Added, Changed, Fixed. One line each, no commit hashes.\n',
  );
  write(
    join(home, '.claude', 'skills', 'review-pr', 'SKILL.md'),
    '---\nname: review-pr\ndescription: Review the current branch against main before a PR\n---\nDiff the branch against main. List bugs first, then risky changes, then small things. Quote the lines.\n',
  );
}

// ---------------------------------------------------------------------------
// The fake model
// ---------------------------------------------------------------------------

type Block = { text: string } | { tool: string; input: Record<string, unknown> };
/** One reply. hold: stream the blocks, then keep the reply open until the hub goes away (an agent still working). */
interface Step {
  blocks: Block[];
  hold?: boolean;
}
/** A conversation the model knows: picked by text in the first user message, then one step per reply. */
interface Scenario {
  match: string;
  steps: Step[];
}

type Msg = { role: string; content: unknown };

function scenarios(repo: string): Scenario[] {
  const file = join(repo, 'src', 'auth', 'redirect.ts');
  // tomorrow in this computer's zone, for the focus blocks (seedCalendar)
  const t = new Date(Date.now() + 86_400_000);
  const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return [
    {
      match: 'Book two focus blocks tomorrow',
      steps: [
        {
          blocks: [
            { text: 'One block in the morning for the review, one after lunch for the demo script.' },
            { tool: 'CalendarEvent', input: { action: 'create', title: 'Focus: review the login fix', start: `${day}T09:30`, end: `${day}T11:00` } },
            { tool: 'CalendarEvent', input: { action: 'create', title: 'Focus: write the demo script', start: `${day}T14:00`, end: `${day}T15:30` } },
          ],
        },
        { blocks: [{ text: 'Both blocks wait for your approval on Today. Nothing is in your calendar until you approve.' }] },
      ],
    },
    {
      match: 'Plan a weekend in Lisbon',
      steps: [
        {
          blocks: [
            {
              text: 'A calm weekend for two:\n\n- **Saturday**: Alfama in the morning, lunch at a tasca, the 28 tram up to Graça for the view, dinner in Bairro Alto.\n- **Sunday**: the train to Cascais (40 minutes from Cais do Sodré), a swim at Praia da Rainha, back for sunset at the Tagus.\n\nBook the Saturday dinner ahead; the rest needs no tickets.',
            },
          ],
        },
      ],
    },
    {
      match: 'even when the URL has ?next=/billing',
      steps: [
        { blocks: [{ text: 'Let me look at the redirect helper first.' }, { tool: 'Read', input: { file_path: file } }] },
        {
          blocks: [
            { text: '`afterLogin` ignores `next` entirely. I will honor it for paths on this site only, so `//evil.example` cannot turn it into an open redirect.' },
            { tool: 'Edit', input: { file_path: file, old_string: OLD_BODY, new_string: NEW_BODY } },
          ],
        },
        { blocks: [{ tool: 'Bash', input: { command: 'bun test src/auth', description: 'Run the auth tests' } }] },
        {
          blocks: [
            {
              text: 'Fixed. `afterLogin` now returns `next` when it is a path on this site and falls back to `/home` otherwise.\n\n- `src/auth/redirect.ts`: accept `next` only when it starts with a single `/`\n- Tests: 3 pass, 0 fail (`bun test src/auth`)\n\nThe change is not committed yet.',
            },
          ],
        },
      ],
    },
    {
      match: 'Push fix/login so I can open a PR',
      steps: [
        { blocks: [{ text: 'Checking what is on the branch first.' }, { tool: 'Bash', input: { command: 'git log --oneline -3', description: 'Show the last commits' } }] },
        { blocks: [{ text: 'Two commits ahead of main. Pushing the branch now.' }, { tool: 'Bash', input: { command: 'git push origin fix/login', description: 'Push fix/login' } }] },
        { blocks: [{ text: 'Pushed. Open the PR from fix/login when you are ready.' }] },
      ],
    },
    {
      match: 'Move the session endpoints under /api/v2',
      steps: [
        {
          blocks: [
            { text: 'Before I move anything: the iOS app 2.3 still calls `/api/session` directly.' },
            {
              tool: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Keep the old API route?',
                    header: 'Old route',
                    multiSelect: false,
                    options: [
                      { label: 'Keep it as an alias (Recommended)', description: '/api/session keeps working and answers like /api/v2/sessions until the apps update' },
                      { label: 'Remove it', description: 'Only /api/v2/sessions answers; iOS 2.3 and older lose the session list' },
                    ],
                  },
                ],
              },
            },
          ],
        },
        { blocks: [{ text: 'Got it. Moving the routes now.' }] },
      ],
    },
    {
      match: 'Raise the session timeout to 30 minutes',
      steps: [
        { blocks: [{ text: 'The timeout lives in src/config.ts. Changing it to 30.' }, { tool: 'Bash', input: { command: "perl -pi -e 's/= 15;/= 30;/' src/config.ts", description: 'Set the timeout to 30 minutes' } }] },
        { blocks: [{ tool: 'Bash', input: { command: "git commit -qam 'Raise the session timeout to 30 minutes'", description: 'Commit the change' } }] },
        { blocks: [{ text: 'Done. `SESSION_TIMEOUT_MINUTES` is 30 now, committed on this branch. Push it and open a pull request when you are ready.' }] },
      ],
    },
    {
      match: 'Plan the week: ship the login fix',
      steps: [
        {
          blocks: [
            {
              text: "Here's a plan that keeps Thursday safe:\n\n- **Mon:** finish the login redirect fix and open the PR\n- **Tue:** review both PRs in the morning, answer feedback on yours after lunch\n- **Wed:** merge, then write the demo script and do one dry run\n- **Thu:** keep the morning for fixes, demo in the afternoon\n- **Fri:** send demo notes and plan next week\n\nWant me to add these as tasks?",
            },
          ],
        },
      ],
    },
    {
      // conclave on the MacBook; its second turn is a skill typed as /release-notes since v0.1
      match: 'In the left list I want a Project grouping',
      steps: [
        { blocks: [{ text: 'Added Group by Project to `SessionList.tsx`. Each project is one group across devices, newest first, and each row says its device. Sessions without a project go under their folder, chats last.' }] },
        { blocks: [{ text: 'Loading the release-notes skill.' }, { tool: 'Skill', input: { skill: 'release-notes', args: 'since v0.1' } }] },
        { blocks: [{ text: 'Release notes since v0.1:\n\n- **Added:** Group by Project in the session lists\n- **Added:** a "/" menu with commands, skills and custom commands\n- **Changed:** imported Claude Code chats join the project of their folder' }] },
      ],
    },
    {
      match: 'Run the core tests here on the hub',
      steps: [{ blocks: [{ text: '`bun test packages/core`: 2,265 pass, 0 fail, 11 skipped.' }] }],
    },
    {
      match: 'Look for ways the redirect in src/auth/redirect.ts can leave the site',
      steps: [{ blocks: [{ text: 'No open redirect: `next` must start with a single `/`, so `//host` and `https://host` both fall back to `/home`.' }] }],
    },
    {
      match: 'Look for inputs src/auth/redirect.ts does not handle',
      steps: [{ blocks: [{ text: 'One gap: `/\\evil.example` starts with a single `/`, and some browsers read the backslash as a slash. Worth a test.' }] }],
    },
    {
      match: 'Write a failing test for each finding',
      steps: [{ hold: true, blocks: [{ text: 'Writing a test for `/\\evil.example` in src/auth/redirect.test.ts...' }] }],
    },
  ];
}

/** A title chore's answer: the first few words of the message it quotes. */
function demoTitle(first: string): string {
  const quoted = /<conversation>([\s\S]*?)<\/conversation>/.exec(first)?.[1] ?? first;
  const words = quoted.replace(/\\n/g, ' ').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).slice(0, 5);
  const t = words.join(' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'New chat';
}

function firstUser(body: { messages?: Msg[] }): string {
  const first = body.messages?.find((m) => m.role === 'user');
  if (!first) return '';
  return typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '');
}

function sseEvents(step: Step, n: number, usage: { input: number; output: number }): string[] {
  const events: unknown[] = [{ type: 'message_start', message: { id: `msg_demo_${n}`, model: 'claude-sonnet-5-5', usage: { input_tokens: usage.input, output_tokens: 0 } } }];
  step.blocks.forEach((b, index) => {
    if ('text' in b) {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_demo_${n}_${index}`, name: b.tool, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    if (!step.hold) events.push({ type: 'content_block_stop', index });
  });
  if (!step.hold) {
    const stop = step.blocks.some((b) => 'tool' in b) ? 'tool_use' : 'end_turn';
    events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: usage.output } }, { type: 'message_stop' });
  }
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
}

/** An Anthropic Messages API look-alike on 127.0.0.1 that answers from the scenarios. */
/**
 * The demo watch's runs (seedWatch): a run's first message names the fake
 * marketplace in the hub's data block; the model reports the listings of
 * that run straight away, without the browser, so the demo needs none.
 */
const watchDemo: { url?: string; runs: Array<Array<Record<string, unknown>>>; n: number } = { runs: [], n: 0 };

function watchStep(first: string, turn: number): Step | undefined {
  if (!watchDemo.url || !first.includes(`Start at: ${watchDemo.url}`)) return undefined;
  if (turn > 0) return { blocks: [{ text: 'Reported. The hub compares the listings.' }] };
  const items = watchDemo.runs[Math.min(watchDemo.n++, watchDemo.runs.length - 1)] ?? [];
  return { blocks: [{ tool: 'WatchReport', input: { items } }] };
}

function startModel(repo: string) {
  const known = scenarios(repo);
  const held = new Set<() => void>();
  let n = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== 'POST' || !path.endsWith('/messages')) return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'demo model: only /v1/messages' } }, { status: 404 });
      const body = (await req.json()) as { messages?: Msg[]; tools?: unknown[]; system?: unknown };
      const first = firstUser(body);
      const system = JSON.stringify(body.system ?? '');
      const scenario = known.find((s) => first.includes(s.match));
      const turn = (body.messages ?? []).filter((m) => m.role === 'assistant').length;
      if (process.env.DEMO_MODEL_LOG) console.error(`demo model: tools=${body.tools?.length ?? 0} turn=${turn} scenario=${scenario?.match ?? '-'} system=${system.slice(0, 80)} first=${first.slice(0, 160)}`);
      // chores carry no tools (titles, memory notes, summaries) and quote the conversation, so they never take a scenario's step
      const chore: Step = { blocks: [{ text: system.includes('You name conversations') ? demoTitle(first) : system.includes('long-term memory') ? '{"add":[],"update":[]}' : 'ok' }] };
      // a conversation the demo has no script for: a plain answer that says so
      const plain: Step = { blocks: [{ text: 'This is the demo model. It has answers for the demo conversations only, so here it can only say that your message arrived.' }] };
      const watched = body.tools?.length ? watchStep(first, turn) : undefined;
      const step: Step = watched ?? (body.tools?.length ? (scenario ? scenario.steps[Math.min(turn, scenario.steps.length - 1)] : plain) : chore);
      const id = ++n;
      const usage = { input: 9_400 + turn * 1_350 + (id % 7) * 113, output: 90 + ((id * 37) % 260) };
      const chunks = sseEvents(step, id, usage);
      const enc = new TextEncoder();
      const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
      if (!step.hold) return new Response(chunks.join(''), { headers });
      // still working: the start of the answer, then pings so the hub's idle timer never fires
      let timer: ReturnType<typeof setInterval> | undefined;
      let end: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          timer = setInterval(() => controller.enqueue(enc.encode('event: ping\ndata: {"type":"ping"}\n\n')), 10_000);
          end = () => {
            clearInterval(timer);
            held.delete(end!);
            try {
              controller.close();
            } catch {
              /* closed already */
            }
          };
          held.add(end);
        },
        cancel() {
          clearInterval(timer);
          if (end) held.delete(end);
        },
      });
      return new Response(stream, { headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    held: () => held.size,
    stop() {
      for (const end of [...held]) end();
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Friends without a second hub
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID made at `t`, for a seeded message. */
function ulidAt(t: number): string {
  let time = '';
  for (let i = 0, n = t; i < 10; i++, n = Math.floor(n / 32)) time = CROCKFORD[n % 32] + time;
  return time + Array.from(randomBytes(16), (b) => CROCKFORD[b % 32]).join('');
}

/**
 * The friends the web mock shows (packages/web/src/mock/friends-data.ts),
 * written into this hub's own friends tables with real keys, so Settings,
 * Friends, a friend's notes and the Inbox show real hub data without a
 * second hub. Nobody answers at their addresses: the hub is started without
 * its regular pull, and a note to one of them waits. Returns the friend ids
 * by seed key.
 */
async function seedFriends(peer: import('../packages/server/src/peer/service.ts').PeerService, db: { query(sql: string): { run(...args: unknown[]): unknown } }): Promise<{ ids: Record<string, string>; keys: Record<string, KeyObject> }> {
  const { FRIEND_SEEDS, blockedReason } = await import('../packages/web/src/mock/friends-data.ts');
  const { fingerprintOf, PeerSubkey } = await import('../packages/server/src/peer/crypto.ts');
  const key = () => generateKeyPairSync('ed25519');
  const raw = (k: KeyObject) => k.export({ format: 'jwk' }).x as string;
  const now = Date.now();
  const ids: Record<string, string> = {};
  const keys: Record<string, KeyObject> = {};
  for (const s of FRIEND_SEEDS) {
    const pair = key();
    const publicKey = raw(pair.publicKey);
    keys[s.key] = pair.privateKey;
    const f = peer.store.insertFriend({
      name: s.name,
      fingerprint: fingerprintOf(publicKey),
      publicKey,
      // a key to seal for, so a share to Alice goes (and waits in the outbox: nobody answers there)
      ...(s.key === 'alice' ? { subkey: PeerSubkey.generate().publicKey } : {}),
      addresses: { addrs: s.addresses, seq: -1 },
      status: s.status,
      direction: s.direction,
      verified: s.verified,
      grants: { receiveShares: true },
      ...(s.status === 'blocked' ? { pendingKey: raw(key().publicKey), blockedReason: blockedReason(s.name) } : {}),
      ...(s.seenAgo !== undefined ? { lastSeen: now - s.seenAgo } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
    });
    db.query('UPDATE friends SET created_at = ? WHERE id = ?').run(now - s.createdAgo, f.id);
    for (const [i, n] of s.notesIn.entries()) {
      const id = ulidAt(now - n.ago);
      peer.store.insertInbox({ friendId: f.id, id, type: 'note', body: { text: n.text }, state: 'received' });
      db.query('UPDATE peer_inbox SET received_at = ? WHERE friend_id = ? AND id = ?').run(now - n.ago, f.id, id);
      // the hub's read mark: Alice's first note and Eli's old one are read (as in the web mock)
      if (i === 0 && (s.key === 'alice' || s.key === 'eli')) peer.markRead(f.id, id);
    }
    for (const n of s.notesOut) {
      const at = now - n.ago;
      const id = ulidAt(at);
      const preview = `note: ${n.text.length > 80 ? `${n.text.slice(0, 79)}…` : n.text}`;
      peer.store.insertOutbox({ id, friendId: f.id, type: 'note', envelope: '{}', body: JSON.stringify({ text: n.text }), nextTry: now + (n.nextTryIn ?? 0), expiresAt: at + 7 * 86_400_000, createdAt: at, preview });
      peer.store.updateOutbox(id, { state: n.state, attempts: n.attempts ?? 1, ...(n.state === 'delivered' ? { deliveredAt: at + 2_000, via: 'push' as const } : {}), ...(n.lastError ? { lastError: n.lastError } : {}) });
    }
    ids[s.key] = f.id;
  }
  return { ids, keys };
}

/**
 * The shares the web mock shows (friends-data.ts SHARE_SEEDS), in this
 * hub's own share tables: an offer from Alice that waits (nothing fetched),
 * Ben's accepted with a diff (a real bundle his seeded key signed, kept as
 * an Accept keeps it, so the view checks out and Apply code plans against
 * fernway-web), the login fix sent to Alice and accepted, one Ben unsent
 * and one from Alice that expired. Returns the received ones' ids by key.
 */
async function seedShares(
  peer: import('../packages/server/src/peer/service.ts').PeerService,
  db: { query(sql: string): { run(...args: unknown[]): unknown } },
  home: string,
  friends: { ids: Record<string, string>; keys: Record<string, KeyObject> },
  sessions: Record<string, string>,
): Promise<Record<string, string>> {
  const { SHARE_SEEDS, shareMessages } = await import('../packages/web/src/mock/friends-data.ts');
  const { BUNDLE_PREFIX, canonicalJson } = await import('../packages/core/src/session/share.ts');
  const { fingerprintOf } = await import('../packages/server/src/peer/crypto.ts');
  const { ulid } = await import('../packages/server/src/peer/ulid.ts');
  const store = peer.shares.store;
  const now = Date.now();
  const out: Record<string, string> = {};
  for (const s of SHARE_SEEDS) {
    const friendId = friends.ids[s.friend];
    const friend = friendId ? peer.store.friend(friendId) : undefined;
    if (!friend) continue;
    const at = now - s.ago;
    if (s.direction === 'out') {
      // what the review would say of the session now, as a send records it
      const sessionId = sessions[s.session ?? 'fix'];
      const p = await peer.shares.preview({ sessionId });
      const id = ulid(at);
      store.insertOut({ id, sessionId, kind: p.kind, title: s.title, ...(s.note ? { note: s.note } : {}), options: p.options, revision: 1, state: 'active', summary: { messages: p.messages, sessions: p.sessions, ...(p.code && !('error' in p.code) ? { code: { kind: p.code.kind, files: p.code.files.length } } : {}), bytes: p.bytes } });
      db.query('UPDATE friend_shares_out SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at + 40 * 60_000, id);
      store.putSend({ shareId: id, friendId, revision: 1, state: 'accepted', acceptedRevision: 1, acceptedAt: at + 40 * 60_000, sentAt: at });
      continue;
    }
    const id = `shr_${s.key}`;
    const shareId = ulid(at);
    let payload: string | undefined;
    if (s.state === 'accepted' && s.turns) {
      // a bundle as Ben's hub signs it, with the share's id and revision
      const signer = friends.keys[s.friend];
      const publicKey = createPublicKey(signer).export({ format: 'jwk' }).x as string;
      const messages = shareMessages(s.turns, at - 40 * 60_000, s.model);
      const body = {
        format: 'conclave-bundle' as const,
        version: 1 as const,
        createdAt: at,
        from: { publicKey, fingerprint: fingerprintOf(publicKey), name: friend.name },
        includes: { thinking: false, toolOutput: true, attachments: true, code: true },
        report: { reminders: 2, recalled: 1, thinking: 1, signatures: 1, redactedThinking: 0, secrets: 0, paths: 3, privateIps: 0, emails: 0, hostnames: 1, toolOutputs: 0, attachments: 0 },
        sessions: [{ id: 'ses_ben_cache', title: s.title, kind: 'agent', mode: 'agent', tags: [], createdAt: at - 40 * 60_000, updatedAt: at, hints: { agent: 'coder', model: s.model ?? 'anthropic/claude-sonnet-5-5' }, messages }],
        share: { id: shareId, revision: 1, title: s.title, ...(s.note ? { note: s.note } : {}) },
        ...(s.code ? { code: { kind: s.code.kind, diff: s.code.diff, files: s.code.files, excluded: [{ path: '.env', reason: 'credential file' }] } } : {}),
      };
      const signature = sign(null, Buffer.from(BUNDLE_PREFIX + canonicalJson(body), 'utf8'), signer).toString('base64url');
      const dir = join(home, 'peer', 'shares', 'in');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      payload = join(dir, `${id}.json`);
      writeFileSync(payload, JSON.stringify({ ...body, signature }), { mode: 0o600 });
    }
    store.insertIn({
      id,
      friendId,
      shareId,
      fingerprint: friend.fingerprint,
      kind: s.kind,
      title: s.title,
      ...(s.note ? { note: s.note } : {}),
      revision: 1,
      summary: s.summary,
      blob: { sha256: randomBytes(32).toString('hex'), size: Math.ceil(s.summary.bytes * 1.4) },
      state: s.state as import('../packages/core/src/client/friends.ts').ReceivedShareState,
      ...(s.state === 'accepted' ? { acceptedRevision: 1, acceptedAt: at + 20 * 60_000 } : {}),
      ...(payload ? { payload } : {}),
      sessions: [],
      receivedAt: at,
      expiresAt: at + 30 * 86_400_000,
    });
    db.query('UPDATE friend_shares_in SET updated_at = ? WHERE id = ?').run(s.state === 'accepted' ? at + 20 * 60_000 : at, id);
    out[s.key] = id;
  }
  return out;
}

/**
 * One shared project, as Settings, Friends, /projects and the Inbox show it:
 * Fernway portal on fernway/portal, owned by this hub, with Alice in it. Her
 * note and memory carry her own signature (her key from seedFriends), so
 * they check out like items her hub sent; nobody answers at her address, so
 * what this hub sends her waits in the outbox. The chat goes to her as a
 * share. And an invite from Alice to a project of hers, waiting in the Inbox.
 */
async function seedSharedProject(peer: import('../packages/server/src/peer/service.ts').PeerService, friends: { ids: Record<string, string>; keys: Record<string, KeyObject> }, chatId: string): Promise<{ portal: string; logo: string }> {
  const { signItem } = await import('../packages/server/src/peer/projects.ts');
  const svc = peer.projects;
  const alice = peer.store.friend(friends.ids.alice)!;
  const key = friends.keys.alice;
  const signer = { publicKey: alice.publicKey, fingerprint: alice.fingerprint, sign: (prefix: string, data: string | Uint8Array) => sign(null, Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(data)]), key).toString('base64url') };
  const p = await svc.create({
    name: 'Fernway portal',
    repo: 'fernway/portal',
    members: [alice.id],
    notes: 'The customer portal. We ship on Fridays once the checks pass.\nAlice takes the footer and the contact form; the session timeout is mine.',
  });
  // Alice accepted (her hub does not run here): her member row as her join leaves it
  const m = svc.store.member(p.id, alice.fingerprint)!;
  svc.store.putMember({ ...m, state: 'active', github: 'alice-k' });
  const now = Date.now();
  const item = (kind: 'note' | 'memory', title: string, text: string, ago: number) =>
    signItem(signer, { v: 1, project: p.id, id: ulidAt(now - ago), author: alice.fingerprint, kind, version: 1, createdAt: now - ago, updatedAt: now - ago, title, text });
  svc.store.putItem(item('note', 'Footer', 'The footer links move to the help center. I keep the old ones until the redirect ships.', 50 * 60_000));
  svc.store.putItem(item('memory', 'procedure', 'Alice reviews pull requests on Fridays before noon.', 45 * 60_000));
  await svc.shareChats(p.id, [chatId], 'owner');

  const logo = ulidAt(now - 20 * 60_000);
  svc.store.insert({ id: logo, ownerFp: alice.fingerprint, name: 'Fernway logo', repo: 'fernway/brand', state: 'invited', metaSeq: 1, shareNew: false });
  svc.store.replaceMembers(logo, [
    { fingerprint: alice.fingerprint, publicKey: alice.publicKey, name: 'Alice', role: 'owner', state: 'active' },
    { fingerprint: peer.fingerprint, publicKey: peer.record().publicKey, name: peer.ourName(), role: 'member', state: 'invited' },
  ]);
  return { portal: p.id, logo };
}

// ---------------------------------------------------------------------------
// conclave on three devices
// ---------------------------------------------------------------------------

/**
 * One project on three devices, for Group by Project: a session on the
 * MacBook, one on the hub in a clone of the same repository, and a Claude
 * Code chat imported from the MacBook. Each turn's end (and the import)
 * teaches the hub the project; this waits until all three have it.
 */
async function seedConclave(
  api: import('../packages/core/src/client/index.ts').ConclaveClient,
  o: { mac: string; macRepo: string; hubRepo: string; home: string; sessionState: (id: string) => Promise<string> },
): Promise<{ mac: string; hub: string; imported: string }> {
  const replied = (id: string, words: string) => async () => {
    const s = await api.getSession(id);
    if (s.status !== 'idle') return false;
    return (await api.messages(id)).some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes(words));
  };
  const hub = await api.createSession({ title: 'Run the core tests on the hub', agent: 'coder', cwd: o.hubRepo, device: 'local', prompt: 'Run the core tests here on the hub and tell me what fails.' });
  await waitFor('the hub session to answer', replied(hub.id, '2,265 pass'), () => o.sessionState(hub.id));
  const mac = await api.createSession({
    title: 'Group the session list by project',
    agent: 'coder',
    cwd: o.macRepo,
    device: o.mac,
    permissionMode: 'acceptEdits',
    prompt: 'In the left list I want a Project grouping: one group for conclave with this chat, the hub one and the imported Claude Code one.',
  });
  await waitFor('the MacBook session to answer', replied(mac.id, 'Group by Project'), () => o.sessionState(mac.id));
  const id = '5d0c9a7e-3b2f-4e1d-8c6a-9f0e1d2c3b4a';
  writeClaudeChat(o.home, o.macRepo, id);
  const imported = await api.importSession('claude-code', id, o.mac);
  // imports land archived; this one stays in the lists, as one the owner went back to
  await api.updateSession(imported.id, { archived: false, title: 'Slash menu like Claude Code' });
  await waitFor(
    'the three conclave sessions to share a project',
    async () => {
      const ids = await Promise.all([hub.id, mac.id, imported.id].map(async (x) => (await api.getSession(x)).projectId));
      return ids[0] && ids.every((x) => x === ids[0]);
    },
    async () => `projects: ${(await Promise.all([hub.id, mac.id, imported.id].map(async (x) => (await api.getSession(x)).projectId ?? 'none'))).join(', ')}`,
  );
  return { mac: mac.id, hub: hub.id, imported: imported.id };
}

// ---------------------------------------------------------------------------
// Child: the hub, the seed, the output
// ---------------------------------------------------------------------------

/**
 * Poll check() until it returns something. On a timeout the error says why
 * when explain() can tell (a session's state, what it waits on); a slow
 * Windows runner gets the same 90 seconds as a laptop.
 */
/**
 * A watch on a fake marketplace (core/test/watches/market.ts) that ran
 * twice: four cars, then one new, one gone and one cheaper. The runs are
 * real routine runs; the demo model reports the listings (watchStep), and
 * the photos come from the fake marketplace through the hub.
 */
async function seedWatch(api: InstanceType<typeof import('../packages/core/src/client/index.ts').ConclaveClient>, engine: object, sessionState: (id: string) => Promise<string>): Promise<{ id: string; stop: () => void }> {
  const { startFakeMarket, CARS } = await import('../packages/core/test/watches/market.ts');
  const { watchesOf } = await import('../packages/core/src/watches/index.ts');
  const market = startFakeMarket();
  const item = (c: (typeof CARS)[number]) => ({ id: c.id, title: c.title, price: `$${c.price.toLocaleString('en-US')}`, location: c.location, url: `${market.url}/marketplace/item/${c.id}/`, image: `${market.url}/img/${c.id}.svg`, fields: { year: c.year, mileage: c.mileage } });
  const yaris = { id: '105', title: '2015 Toyota Yaris', price: 7800, location: 'Hayward, CA', year: '2015', mileage: '86,000 mi' };
  market.listings.push(yaris);
  watchDemo.url = market.url;
  watchDemo.runs = [CARS.map(item), [{ ...item(CARS[0]), price: '$5,900' }, item(CARS[1]), item(CARS[3]), item(yaris)]];
  const at = (new Date().getHours() + 3) % 24;
  const { routine } = watchesOf(engine)!.create(
    {
      name: 'Cars under $8,000',
      schedule: `5 ${at} * * *`,
      url: `${market.url}/marketplace/search?query=cars&maxPrice=8000`,
      prompt: 'Find used cars under $8,000 within 40 miles of Oakland: Honda, Toyota or Mazda, 2010 or newer. Read the price, place, year and mileage of each listing.',
      profile: 'marketplace',
      fields: ['year', 'mileage'],
      filters: { maxPrice: 8000, maxDistance: 40, unit: 'mi', near: 'Oakland, CA', keywords: ['honda', 'toyota', 'mazda'], exclude: ['salvage', 'parts'] },
      currency: 'USD',
    },
    { agent: 'assistant' },
  );
  for (let i = 0; i < 2; i++) {
    const run = await api.runRoutine(routine.id);
    await waitFor(`watch run ${i + 1}`, async () => (await api.routineRuns(routine.id)).find((r) => r.id === run.id && r.status !== 'running'), () => (run.sessionId ? sessionState(run.sessionId) : Promise.resolve('no session')));
  }
  return { id: routine.id, stop: () => market.stop() };
}

/**
 * A calendar on a fake CalDAV server (core/test/pim/fake-caldav.ts), and
 * two focus blocks for tomorrow the assistant proposed, waiting on Today
 * for the owner to approve or decline.
 */
async function seedCalendar(api: InstanceType<typeof import('../packages/core/src/client/index.ts').ConclaveClient>, sessionState: (id: string) => Promise<string>): Promise<{ session: string; stop: () => void }> {
  const { startFakeCaldav } = await import('../packages/core/test/pim/fake-caldav.ts');
  const dav = startFakeCaldav({ user: 'sam' });
  await api.addCaldav({ serverUrl: dav.url, username: dav.user, password: dav.password, label: 'Nextcloud' });
  const s = await api.createSession({ title: 'Focus blocks tomorrow', agent: 'assistant', prompt: 'Book two focus blocks tomorrow: one to review the login fix, one to write the demo script.' });
  await waitFor('two calendar proposals', async () => (await api.proposals()).filter((p) => p.sessionId === s.id).length === 2, () => sessionState(s.id));
  return { session: s.id, stop: () => dav.stop() };
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined | false | null>, explain?: () => Promise<string>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(150);
  }
  const why = explain ? await explain().catch((err) => `no details (${(err as Error).message})`) : '';
  throw new Error(`demo: timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ''}${why ? `. ${why}` : ''}`);
}

async function runHub(root: string): Promise<void> {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, not ${opts.port}`);
  const home = homedir();
  const repo = join(home, 'code', 'fernway-web');
  makeRepo(repo);
  // conclave on the MacBook and its clone on the hub (seedConclave)
  const conclaveMac = join(home, 'code', 'conclave');
  const conclaveHub = join(home, 'srv', 'conclave');
  makeConclave(conclaveMac, conclaveHub);
  writeSkills(home);
  const model = startModel(repo);
  // a stand-in for GitHub: bare repositories over smart HTTP and a small API, for the repo session
  const { FakeGithub } = await import('../packages/core/test/github/fake-github.ts');
  const ghToken = `github_pat_demo_${randomBytes(12).toString('hex')}`;
  const github = new FakeGithub(ghToken, { login: 'sam-rivera', name: 'Sam Rivera' }, join(root, 'github')).start();
  github.addRepo('fernway', 'portal', { description: 'The Fernway customer portal', files: { 'README.md': '# portal\n\nThe Fernway customer portal.\n', 'src/config.ts': 'export const SESSION_TIMEOUT_MINUTES = 15;\n', 'package.json': '{ "name": "portal", "private": true }\n' } });
  github.addRepo('fernway', 'design-system', { private: true, description: 'Tokens and components' });
  github.addRepo('sam-rivera', 'dotfiles', { description: 'My shell and editor setup' });
  // the owner's git identity, as on any machine they commit from
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Sam Rivera\n\temail = sam@example.com\n[commit]\n\tgpgsign = false\n');
  const token = opts.token || `demo-${randomBytes(18).toString('base64url')}`;
  // the hub password, for the apps' address and password login (12 characters or more)
  const password = opts.password || `demo-${randomBytes(9).toString('base64url')}`;

  // the hub's own config file, as a person would write it
  const conclaveHome = join(home, '.conclave');
  mkdirSync(conclaveHome, { recursive: true });
  writeFileSync(
    join(conclaveHome, 'config.json'),
    JSON.stringify(
      {
        defaultModel: 'anthropic/claude-sonnet-5-5',
        smallModel: 'anthropic/claude-haiku-5-5',
        providers: {
          anthropic: { type: 'anthropic', baseUrl: model.url, apiKey: 'demo-key', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
        },
        models: { tiers: { fast: 'anthropic/claude-haiku-5-5', smart: 'anthropic/claude-sonnet-5-5', deep: 'anthropic/claude-opus-5-5' } },
        permissions: { mode: 'default', allow: ['Bash(bun test:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(perl -pi:*)', 'Bash(git commit:*)'], deny: [], ask: [], additionalDirectories: [] },
        github: { apiUrl: github.apiUrl, gitUrl: github.httpGitUrl, pollSeconds: 0 },
        server: { token, remote: { lan: true } },
        ui: { theme: 'system', onboarded: true, name: 'Sam' },
      },
      null,
      2,
    ) + '\n',
  );

  const { createEngine } = await import('../packages/core/src/engine/index.ts');
  const { LocalMachine } = await import('../packages/core/src/machine/local.ts');
  const { runDaemon } = await import('../packages/core/src/machine/daemon.ts');
  const { ConclaveClient, formatFingerprint } = await import('../packages/core/src/client/index.ts');
  const { startServer } = await import('../packages/server/src/app.ts');
  const { pairDeepLink } = await import('../packages/server/src/routes.ts');
  const pkg = (await Bun.file(join(import.meta.dir, '..', 'packages', 'server', 'package.json')).json()) as { version: string };

  const engine = await createEngine({ version: pkg.version });
  let running: ReturnType<typeof startServer>;
  try {
    // the demo's friends have no hubs behind them (seedFriends): the hub does not go looking for them
    running = startServer(engine, { port, peer: { firstPullMs: 6 * 3_600_000, pullEveryMs: 6 * 3_600_000 } });
  } catch (err) {
    await engine.shutdown().catch(() => {});
    model.stop();
    throw new Error(`demo: cannot listen on port ${port}: ${(err as Error).message}. Pick another with --port.`);
  }
  const hub = `http://127.0.0.1:${port}`;
  const api = new ConclaveClient({ baseUrl: hub, token });

  // MacBook: a device daemon in this process, paired with a device code like a real one
  const device = await api.createPairing('device');
  const reg = (await (await fetch(`${hub}/api/daemon/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: device.code, name: 'MacBook' }) })).json()) as { deviceId: string; token: string };
  // it runs here, so tools run on this machine; only what the Devices page shows about it says Mac.
  // The hub reads paths by the device's platform, so on Windows it stays win32 (a Mac's paths are POSIX like Linux's).
  class DemoMac extends LocalMachine {
    override async info() {
      const real = await super.info();
      return { ...real, hostname: 'MacBook', ...(real.platform === 'win32' ? {} : { platform: 'darwin', arch: 'arm64' }) };
    }
  }
  const daemon = runDaemon({ hubUrl: hub, deviceId: reg.deviceId, token: reg.token, name: 'MacBook', machine: new DemoMac({ id: reg.deviceId, name: 'MacBook' }) });
  const mac = reg.deviceId;
  await api.setPassword(password);
  // the owner's name on the hub, which the apps show and the login asks for once Riley is added
  await api.updateMe({ name: 'sam' });
  await waitFor(
    'MacBook to come online',
    async () => (await api.devices()).find((d) => d.id === mac)?.online,
    async () => `Devices: ${(await api.devices()).map((d) => `${d.name} ${d.online ? 'online' : 'offline'}`).join(', ')}`,
  );
  // the owner names the hub device, so the apps say "Hub homelab online" and not this machine's host name
  await api.updateDevice('local', { name: 'homelab' });

  /** A session's state in one line, for a seed step that timed out: its status, what it waits on, its last words. */
  const sessionState = async (id: string): Promise<string> => {
    const s = await api.getSession(id);
    const asks = (await api.approvals()).filter((a) => a.sessionId === id).map((a) => `approval "${a.summary}"`);
    const questions = (await api.questions()).filter((q) => q.sessionId === id).map((q) => `question "${q.questions[0]?.question}"`);
    const last = (await api.messages(id)).slice(-2).map((m) => `${m.role}: ${JSON.stringify(m.content).slice(0, 400)}`);
    return [`"${s.title}" is ${s.status}${s.error ? ` (${s.error})` : ''}`, ...asks, ...questions, ...last].join('; ');
  };

  // what the hub remembers, and a routine
  await api.saveMemory({ content: 'Sam works on fernway-web, the Fernway customer portal, mostly on a MacBook.', kind: 'profile' });
  await api.saveMemory({ content: 'fernway-web runs its tests with bun test.', kind: 'fact', scope: 'project', scopeKey: repo, tags: ['fernway-web'] });
  await api.saveMemory({ content: 'Branches go up as fix/* or feat/*, and main only changes through a PR.', kind: 'procedure', scope: 'project', scopeKey: repo, tags: ['git'] });
  // two hours ahead, so Home shows it as next and never as missed
  const at = (new Date().getHours() + 2) % 24;
  await api.createRoutine({ name: 'PR check', schedule: `0 ${at} * * *`, prompt: 'Check open PRs on fernway-web and the CI runs since the last check. Tell me what needs me.', cwd: repo, device: mac });

  // (a) a finished coding session with a diff and a test run
  const fix = await api.createSession({
    title: 'Fix login redirect',
    agent: 'coder',
    cwd: repo,
    device: mac,
    permissionMode: 'acceptEdits',
    prompt: 'After login we always land on /home, even when the URL has ?next=/billing. Fix the redirect and run the auth tests.',
  });
  await waitFor('the login fix to finish', async () => {
    const s = await api.getSession(fix.id);
    if (s.status !== 'idle') return false;
    const msgs = await api.messages(fix.id);
    return msgs.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('The change is not committed yet'));
  }, () => sessionState(fix.id));

  // (e) a workflow run with one agent still working
  const script = `export const meta = {
  name: 'review-login-fix',
  description: 'Review the login redirect fix before it merges',
  phases: [{ title: 'Find' }, { title: 'Prove' }],
}

phase('Find')
const found = await parallel([
  () => agent('Look for ways the redirect in src/auth/redirect.ts can leave the site.', { label: 'open redirect' }),
  () => agent('Look for inputs src/auth/redirect.ts does not handle.', { label: 'edge cases' }),
])
log(found.filter(Boolean).length + ' reviewers answered')

phase('Prove')
return await agent('Write a failing test for each finding:\\n' + found.filter(Boolean).join('\\n'), { label: 'prove with tests' })
`;
  let workflowRun: string | undefined;
  try {
    const run = await api.startWorkflow({ script, cwd: repo, device: mac });
    workflowRun = run.id;
    await waitFor('the workflow to reach its last agent', async () => model.held() > 0, async () => `run ${(await api.workflowRun(run.id)).run.status}`, 60_000);
  } catch (err) {
    console.error(`demo: no workflow run (${(err as Error).message})`);
  }

  // (d) a plain chat
  const chat = await api.createSession({ kind: 'chat', title: 'Plan the week', prompt: "Plan the week: ship the login fix, review two PRs, and prep Thursday's demo." });
  await waitFor('the chat answer', async () => {
    const s = await api.getSession(chat.id);
    if (s.status !== 'idle') return false;
    return (await api.messages(chat.id)).some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('keeps Thursday safe'));
  }, () => sessionState(chat.id));

  // (c) an open question
  const routes = await api.createSession({ title: 'Move session routes to v2', agent: 'coder', cwd: repo, device: mac, prompt: 'Move the session endpoints under /api/v2 and update the web client.' });
  const question = await waitFor('the question', async () => (await api.questions()).find((q) => q.sessionId === routes.id), () => sessionState(routes.id));

  // (i) a second person (docs/design/ACCOUNTS.md): Riley, with her own chat and memory, on the hub's Anthropic key up to $10 a month
  const rileyPassword = `demo-riley-${randomBytes(6).toString('base64url')}`;
  await api.addPerson({ name: 'riley', displayName: 'Riley Chen', email: 'riley@example.com', password: rileyPassword, providers: { anthropic: { monthlyUsd: 10 } } });
  const rileyLogin = await new ConclaveClient({ baseUrl: hub }).login(rileyPassword, 'Riley laptop', 'web', 'riley');
  const riley = new ConclaveClient({ baseUrl: hub, token: rileyLogin.token, hubKey: rileyLogin.identity?.publicKey });
  await riley.saveMemory({ content: 'Riley is planning a trip to Lisbon in May with her partner.', kind: 'profile' });
  const trip = await riley.createSession({ kind: 'chat', title: 'Weekend in Lisbon', prompt: 'Plan a weekend in Lisbon for two, with one day by the sea.' });
  await waitFor("Riley's chat answer", async () => {
    const s = await riley.getSession(trip.id);
    if (s.status !== 'idle') return false;
    return (await riley.messages(trip.id)).some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('Praia da Rainha'));
  }, async () => `"${(await riley.getSession(trip.id)).status}"`);

  // (b) an approval: default permission mode, so the hub asks before git push
  const push = await api.createSession({ title: 'Push the login fix', agent: 'coder', cwd: repo, device: mac, permissionMode: 'default', prompt: 'Push fix/login so I can open a PR.' });
  const approval = await waitFor('the approval', async () => (await api.approvals()).find((a) => a.sessionId === push.id), () => sessionState(push.id));

  // (f) friends, one of each state, with notes both ways
  const seeded = await seedFriends(running.conclave.ctx.peer, engine.repos.db);
  const friends = seeded.ids;
  // (g) shares: an offer waiting, one accepted with a diff, one sent and accepted, one unsent, one expired
  const shares = await seedShares(running.conclave.ctx.peer, engine.repos.db, engine.config.paths.home, seeded, { fix: fix.id, chat: chat.id });

  // (h) a repo session: a worktree of fernway/portal on the hub, one commit pushed, pull request #1 open, checks passed
  await api.githubConnect(ghToken);
  const repoSession = await api.createRepoSession({ repo: 'fernway/portal', agent: 'coder', title: 'Raise the session timeout', prompt: 'Raise the session timeout to 30 minutes and commit it.' });
  await waitFor('the repo session to commit', async () => {
    const s = await api.getSession(repoSession.id);
    if (s.status !== 'idle') return false;
    return (await api.messages(repoSession.id)).some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('committed on this branch'));
  }, () => sessionState(repoSession.id));
  const draft = await api.prDraft(repoSession.id);
  await api.openPullRequest(repoSession.id, { title: draft.title, body: draft.body });
  github.setChecks('*', [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'success' }]);
  await api.sessionRepo(repoSession.id, true);

  // (i) a shared project on fernway/portal with Alice, and her invite to one of hers; her pull request on GitHub
  github.pulls.push({ number: github.pulls.length + 1, title: 'Footer links to the help center', body: '', head: 'alice/footer', base: 'main', state: 'open', merged: false, draft: true, createdAt: Date.now() - 40 * 60_000, author: 'alice-k' });
  const sharedProjects = await seedSharedProject(running.conclave.ctx.peer, seeded, chat.id);

  // (g) conclave on three devices, one project: the MacBook, the hub and an imported Claude Code chat
  const conclave = await seedConclave(api, { mac, macRepo: conclaveMac, hubRepo: conclaveHub, home, sessionState });

  // (i) a watch that ran twice: cars on a fake marketplace, one new, one gone, one cheaper
  const watch = await seedWatch(api, engine, sessionState);

  // (j) a calendar, and two focus blocks the assistant proposed for tomorrow, waiting on Today
  const calendar = await seedCalendar(api, sessionState);

  // MCP servers for Connectors: the hub's own MCP endpoint (connected) and github (off)
  await api.addMcpServer('conclave', { type: 'http', url: `${hub}/mcp`, headers: { authorization: `Bearer ${token}` } }).catch((err) => console.error(`demo: no conclave MCP server (${(err as Error).message})`));
  await api.addMcpServer('github', { command: 'github-mcp-server', args: ['stdio'], enabled: false }).catch((err) => console.error(`demo: no github MCP server (${(err as Error).message})`));

  // a pairing code for an app, and the link a QR code carries
  const pairing = await api.createPairing('client');
  const first = (opts.url || hub).replace(/\/+$/, '');
  const addresses = [first, ...(pairing.addresses ?? []).filter((a) => a.replace(/\/+$/, '') !== first)];
  const fingerprint = running.conclave.ctx.identity.fingerprint;
  const deepLink = pairDeepLink(addresses, pairing.code, fingerprint);

  const stop = async () => {
    // the agent still working stops first, so shutting down aborts nothing
    if (workflowRun) await api.stopWorkflow(workflowRun).catch(() => {});
    daemon.stop();
    await running.stop().catch(() => {});
    await engine.shutdown().catch(() => {});
    model.stop();
    github.stop();
    watch.stop();
    calendar.stop();
  };

  if (opts.check) {
    const approvals = await api.approvals();
    const questions = await api.questions();
    const pushAsk = approvals.find((a) => a.id === approval.id && JSON.stringify(a.input).includes('git push origin fix/login'));
    const keepAsk = questions.find((q) => q.id === question.id && q.questions[0]?.question === 'Keep the old API route?');
    const diff = await api.diff(fix.id);
    const ran = (await api.messages(fix.id)).some((m) => JSON.stringify(m.content).includes('3 pass'));
    const pr = await api.sessionRepo(repoSession.id);
    const projectIds = new Set(await Promise.all([conclave.mac, conclave.hub, conclave.imported].map(async (id) => (await api.getSession(id)).projectId)));
    const portal = await api.sharedProject(sharedProjects.portal);
    const code = await api.sharedProjectCode(sharedProjects.portal);
    const watched = await api.watch(watch.id);
    const proposals = (await api.proposals()).filter((p) => p.sessionId === calendar.session);
    // each person sees their own: Riley her chat and memory only, Sam none of hers
    const rileySessions = (await riley.listSessions({ limit: 50 })).map((x) => x.id);
    const samSessions = (await api.listSessions({ limit: 500 })).map((x) => x.id);
    const rileyMemory = (await riley.memories({ limit: 50 })).map((m) => m.content).join(' ');
    // each is greeted by their own display name, and Riley never sees Sam's
    const greets = async (c: typeof riley) => ((await c.config()).config.ui as { name?: unknown } | undefined)?.name;
    const [samGreet, rileyGreet, rileyMe] = await Promise.all([greets(api), greets(riley), riley.me()]);
    const problems = [
      !(portal.members.some((m) => m.name === 'Alice' && m.state === 'active') && portal.items.some((i) => i.authorName === 'Alice' && i.kind === 'note') && portal.counts.chats === 1) && 'the shared project has no note from Alice or no chat',
      !code.members.some((m) => m.name === 'Alice' && m.pulls.length === 1) && "the shared project's code view has no pull request from Alice",
      (await api.sharedProject(sharedProjects.logo)).state !== 'invited' && "Alice's invite does not wait",
      (projectIds.size !== 1 || projectIds.has(undefined)) && 'the three conclave sessions are not in one project',
      !pushAsk && 'no pending approval for git push origin fix/login',
      !keepAsk && 'no open question "Keep the old API route?"',
      !diff.files.includes('src/auth/redirect.ts') && 'no diff for src/auth/redirect.ts',
      !ran && 'the test run did not pass',
      (pr.pr?.state !== 'open' || pr.ci !== 'success') && 'the repo session has no open pull request with passing checks',
      (watched.runs.length !== 2 || watched.last?.words !== '1 new, 1 gone, 1 price drop' || watched.count !== 4) && `the watch did not run twice with its changes (${watched.runs.map((r) => r.words).join('; ')})`,
      (rileySessions.length !== 1 || rileySessions[0] !== trip.id) && "Riley does not see exactly her own chat",
      samSessions.includes(trip.id) && "Sam sees Riley's chat",
      (!rileyMemory.includes('Lisbon') || rileyMemory.includes('fernway')) && "Riley's memory is not hers alone",
      (samGreet !== 'Sam' || rileyGreet !== 'Riley Chen' || rileyMe.displayName !== 'Riley Chen') && `the apps do not greet each person by their own display name (Sam: ${String(samGreet)}, Riley: ${String(rileyGreet)})`,
      (proposals.length !== 2 || !proposals.every((p) => p.kind === 'event' && p.status === 'pending')) && 'no two calendar proposals waiting',
    ].filter(Boolean);
    await stop();
    if (problems.length) {
      console.error(`demo: check failed: ${problems.join('; ')}`);
      process.exit(1);
    }
    console.log(`OK: 10 sessions${workflowRun ? ' and a workflow run' : ''}, an approval and a question pending, a pull request open, conclave on three devices in one project, a project shared with Alice, a watch that ran twice, Riley with her own chat, two calendar proposals waiting`);
    process.exit(0);
  }

  const info = { url: hub, addresses, token, password, people: { riley: { password: rileyPassword, session: trip.id } }, code: pairing.code, deepLink, fingerprint, home: root, device: mac, sessions: { fix: fix.id, push: push.id, routes: routes.id, chat: chat.id, repo: repoSession.id, conclaveMac: conclave.mac, conclaveHub: conclave.hub, conclaveImported: conclave.imported, calendar: calendar.session }, workflowRun, friends, shares, sharedProjects, github: github.url };
  if (opts.info) writeFileSync(opts.info, JSON.stringify(info, null, 2) + '\n');

  const web = running.conclave.webDir ? `${hub}/#token=${token}` : 'not built (bun run --filter @conclave/web build, then start this again)';
  console.log(`
Conclave demo hub ${engine.version}, with demo data
  hub          ${hub}
  addresses    ${addresses.join('  ')}
  owner token  ${token}
  password     ${password}  (for an app's address and password login, with the name sam)
  riley        ${rileyPassword}  (a second person: sign in with the name riley and this password)
  web app      ${web}
  key          ${formatFingerprint(fingerprint)}
  pairing code ${pairing.code}  (an app, valid 10 minutes; POST /api/pairing makes another)
  pair link    ${deepLink}
  temp home    ${root} (deleted on exit)

Ctrl-C stops it.`);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('\ndemo: stopping...');
    const force = setTimeout(() => process.exit(1), 10_000);
    void stop().finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// last, so every constant above is set when it runs
if (process.env[ROOT_ENV]) await runHub(process.env[ROOT_ENV]);
else await supervise();
