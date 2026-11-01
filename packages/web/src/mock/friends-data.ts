/**
 * Friends to show without a second hub (docs/design/FRIENDS.md): one of
 * each state, with notes both ways. The web mock (mock/friends.ts) serves
 * them, and the demo hub (scripts/demo-hub.ts) writes them into its own
 * friends tables, with real keys, for the screenshots. Times are how long
 * before now; only type imports here, so the demo hub can load it as is.
 *
 * Shares (SHARE_SEEDS): an offer from Alice that waits, one from Ben
 * accepted with a diff, one you sent Alice that she accepted, and one of
 * each end: unsent by Ben, expired from Alice.
 */
import type { BundleMessage, FriendStatus, OutboxState, ReceivedShareState, SentShareState, ShareSummary } from '@conclave/core/client';
import type { HubAddress } from '@conclave/core/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface FriendSeed {
  /** A short stable name for scripts. */
  key: string;
  name: string;
  status: FriendStatus;
  direction: 'in' | 'out';
  verified: boolean;
  /** The mock's key fingerprint; the demo hub makes a real key instead. */
  fingerprint: string;
  /** The mock's safety code; the demo hub's comes from both keys. */
  safetyCode: string;
  /** A key change: the new key's fingerprint in the mock. */
  pendingFingerprint?: string;
  addresses: Array<{ url: string; kind: HubAddress['kind'] }>;
  createdAgo: number;
  seenAgo?: number;
  lastError?: string;
  /** Notes from them. */
  notesIn: Array<{ ago: number; text: string }>;
  /** Notes to them. */
  notesOut: Array<{ ago: number; text: string; state: OutboxState; attempts?: number; nextTryIn?: number; lastError?: string }>;
}

export const blockedReason = (name: string) => `${name}'s hub answers with a new key its old key did not sign. Nothing is sent or taken until you confirm it.`;

export const FRIEND_SEEDS: FriendSeed[] = [
  {
    key: 'alice',
    name: 'Alice',
    status: 'active',
    direction: 'out',
    verified: true,
    fingerprint: '9b41e07a3c5d28f6a1e94c0b7d3f2a65',
    safetyCode: '18342 90311 55120 07718',
    addresses: [{ url: 'https://hub.alice-moreau.net', kind: 'own' }],
    createdAgo: 41 * DAY,
    seenAgo: 3 * MIN,
    notesIn: [
      { ago: 16 * DAY + 2 * HOUR, text: 'Your hub found mine. The safety code matches what you read out on the call.' },
      { ago: 52 * MIN, text: 'Lunch on Friday? I want to show you the routine that sorts my receipts.' },
      { ago: 11 * MIN, text: 'Also: my tunnel moved this morning. Did the new address reach you?' },
    ],
    notesOut: [{ ago: 16 * DAY + 1 * HOUR + 47 * MIN, text: 'Great. I marked you verified on my side too.', state: 'delivered' }],
  },
  {
    key: 'ben',
    name: 'Ben',
    status: 'active',
    direction: 'in',
    verified: false,
    fingerprint: 'c27d5e81f04a39b6d2e8017c5a94f3b0',
    safetyCode: '62019 44873 10295 83346',
    addresses: [{ url: 'https://lantern-orbit-fig.trycloudflare.com', kind: 'quick' }],
    createdAgo: 9 * DAY,
    seenAgo: 2 * DAY + 3 * HOUR,
    lastError: "Could not reach Ben's hub. https://lantern-orbit-fig.trycloudflare.com did not answer (The operation timed out.).",
    notesIn: [{ ago: 2 * DAY + 4 * HOUR, text: 'Off on a trip until Monday. My hub sleeps while I am away.' }],
    notesOut: [{ ago: 20 * HOUR, text: "Sending you the notes from Thursday's demo. No rush.", state: 'queued', attempts: 6, nextTryIn: 38 * MIN, lastError: "Could not reach Ben's hub. https://lantern-orbit-fig.trycloudflare.com did not answer (The operation timed out.)." }],
  },
  {
    key: 'chen',
    name: 'Chen',
    status: 'pending',
    direction: 'in',
    verified: false,
    fingerprint: '5f0a8c2e9d17b4436e1f0a9c8b72d5e3',
    safetyCode: '30458 71926 05513 48207',
    addresses: [{ url: 'https://conclave.chenwei.dev', kind: 'stable' }],
    createdAgo: 2 * HOUR,
    notesIn: [],
    notesOut: [],
  },
  {
    key: 'out',
    name: 'Hub 7c2e 91ab',
    status: 'pending',
    direction: 'out',
    verified: false,
    fingerprint: '7c2e91ab40d65f83e2c1b09a7f4d6e18',
    safetyCode: '91170 26684 37052 64491',
    addresses: [{ url: 'https://river-pine-studio.trycloudflare.com', kind: 'quick' }],
    createdAgo: 5 * HOUR,
    notesIn: [],
    notesOut: [],
  },
  {
    key: 'eli',
    name: 'Eli',
    status: 'blocked',
    direction: 'out',
    verified: true,
    fingerprint: 'e4b90d3a17c6f25e8a0b4d91c3f7e602',
    safetyCode: '48803 15562 90147 22635',
    pendingFingerprint: '0a6dc91e5b3f7248d1e09c6a4b2f8e37',
    addresses: [{ url: 'https://eli.homelab.network', kind: 'stable' }],
    createdAgo: 63 * DAY,
    seenAgo: 25 * MIN,
    notesIn: [{ ago: 20 * DAY, text: 'Moving the hub to the new mini PC soon.' }],
    notesOut: [],
  },
];

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

/** One turn of a shared session, as people read it; shareMessages makes the stored messages. */
export interface ShareTurn {
  role: 'user' | 'assistant';
  text?: string;
  /** Tool calls in this assistant turn, each with its result. */
  tools?: Array<{ name: string; input: Record<string, unknown>; result: string }>;
}

export interface ShareSeed {
  key: string;
  /** The friend's seed key. */
  friend: string;
  /** in: the friend sent it; out: you sent it to them. */
  direction: 'in' | 'out';
  kind: 'chat' | 'session';
  title: string;
  note?: string;
  ago: number;
  /** in: the received state; out: how the friend has it. */
  state: ReceivedShareState | SentShareState;
  /** out: the demo's own session it came from (scripts/demo-hub.ts sessions). */
  session?: 'fix' | 'chat';
  summary: ShareSummary;
  /** in, accepted: what the share holds, quoted. */
  turns?: ShareTurn[];
  /** in, accepted: the code. */
  code?: { kind: 'diff'; files: string[]; diff: string };
  model?: string;
}

/** Ben's cache for the session lookup, against fernway-web (scripts/demo-hub.ts) as it is on fix/login. */
const CACHE_DIFF = `diff --git a/src/api/cache.ts b/src/api/cache.ts
new file mode 100644
index 0000000..6602abe
--- /dev/null
+++ b/src/api/cache.ts
@@ -0,0 +1,11 @@
+/** A small cache for session lookups: an entry lives 30 seconds. */
+const TTL_MS = 30_000;
+const entries = new Map<string, { at: number; value: unknown }>();
+
+export function cached<T>(key: string, load: () => T, now = Date.now()): T {
+  const hit = entries.get(key);
+  if (hit && now - hit.at < TTL_MS) return hit.value as T;
+  const value = load();
+  entries.set(key, { at: now, value });
+  return value;
+}
diff --git a/src/api/routes.ts b/src/api/routes.ts
index 0073080..d2d7a7b 100644
--- a/src/api/routes.ts
+++ b/src/api/routes.ts
@@ -1,7 +1,8 @@
 import { Hono } from 'hono';
+import { cached } from './cache';
 import { listSessions, getSession } from './sessions';

 export const api = new Hono();

 api.get('/api/session', (c) => c.json(listSessions()));
-api.get('/api/session/:id', (c) => c.json(getSession(c.req.param('id'))));
+api.get('/api/session/:id', (c) => c.json(cached(\`session:\${c.req.param('id')}\`, () => getSession(c.req.param('id')))));
`;

const ROUTES_BEFORE = `import { Hono } from 'hono';
import { listSessions, getSession } from './sessions';

export const api = new Hono();

api.get('/api/session', (c) => c.json(listSessions()));
api.get('/api/session/:id', (c) => c.json(getSession(c.req.param('id'))));
`;

const CACHE_TURNS: ShareTurn[] = [
  { role: 'user', text: 'Session lookups hit the database on every request. Put a small cache in front of getSession and keep the tests green.' },
  { role: 'assistant', text: 'Let me read the routes first.', tools: [{ name: 'Read', input: { file_path: 'src/api/routes.ts' }, result: ROUTES_BEFORE }] },
  {
    role: 'assistant',
    text: 'Every request to `/api/session/:id` calls `getSession`. A 30 second cache in front of it is enough here.',
    tools: [
      { name: 'Write', input: { file_path: 'src/api/cache.ts', content: '/** A small cache for session lookups: an entry lives 30 seconds. */' }, result: 'Wrote src/api/cache.ts' },
      { name: 'Edit', input: { file_path: 'src/api/routes.ts', old_string: 'getSession(', new_string: 'cached(' }, result: 'Edited src/api/routes.ts' },
      { name: 'Bash', input: { command: 'bun test', description: 'Run the tests' }, result: '12 pass\n0 fail\nRan 12 tests across 4 files.' },
    ],
  },
  {
    role: 'assistant',
    text: 'Done. `getSession` now goes through a 30 second cache keyed by the session id.\n\n- `src/api/cache.ts`: the cache\n- `src/api/routes.ts`: uses it for `/api/session/:id`\n\nTests: 12 pass, 0 fail.',
  },
  { role: 'user', text: 'What happens when a session is deleted?' },
  { role: 'assistant', text: 'It stays in the cache for up to 30 seconds and the route still returns it. Dropping the entry in `deleteSession` fixes that. I did not change it yet.' },
];

export const SHARE_SEEDS: ShareSeed[] = [
  {
    key: 'offer',
    friend: 'alice',
    direction: 'in',
    kind: 'session',
    title: 'Fix flaky auth test',
    note: 'Can you finish it? The clock test still fails on CI about one run in five.',
    ago: 26 * MIN,
    state: 'offered',
    summary: { messages: 42, sessions: 1, code: { kind: 'diff', files: 3 }, bytes: 48_200 },
  },
  {
    key: 'accepted',
    friend: 'ben',
    direction: 'in',
    kind: 'session',
    title: 'Cache the session lookup',
    note: 'This took p95 from 180 ms to 40 ms here. The cache key needs a second look.',
    ago: 3 * DAY + 2 * HOUR,
    state: 'accepted',
    summary: { messages: 8, sessions: 1, code: { kind: 'diff', files: 2 }, bytes: 9_800 },
    turns: CACHE_TURNS,
    code: { kind: 'diff', files: ['src/api/cache.ts', 'src/api/routes.ts'], diff: CACHE_DIFF },
    model: 'anthropic/claude-sonnet-5-5',
  },
  {
    key: 'sent',
    friend: 'alice',
    direction: 'out',
    kind: 'session',
    title: 'Fix login redirect',
    note: 'The open redirect check you asked about on Friday.',
    ago: 5 * HOUR,
    state: 'accepted',
    session: 'fix',
    summary: { messages: 9, sessions: 1, code: { kind: 'diff', files: 1 }, bytes: 21_400 },
  },
  {
    key: 'revoked',
    friend: 'ben',
    direction: 'in',
    kind: 'chat',
    title: 'Pick a router for the new flat',
    ago: 6 * DAY,
    state: 'revoked',
    summary: { messages: 14, sessions: 1, bytes: 12_100 },
  },
  {
    key: 'expired',
    friend: 'alice',
    direction: 'in',
    kind: 'chat',
    title: 'Reading list for the term',
    ago: 34 * DAY,
    state: 'expired',
    summary: { messages: 6, sessions: 1, bytes: 4_300 },
  },
];

/**
 * A seed's turns as stored messages, the way a bundle carries them: each
 * tool call in the assistant message, its result in a user message after.
 */
export function shareMessages(turns: ShareTurn[], start: number, model?: string): BundleMessage[] {
  const out: BundleMessage[] = [];
  let n = 0;
  const at = () => start + n * 40_000;
  for (const t of turns) {
    const id = () => `ext_${++n}`;
    if (t.role === 'user') {
      out.push({ role: 'user', kind: 'normal', content: [{ type: 'text', text: t.text ?? '' }], createdAt: at(), meta: { external: { id: id() } } });
      continue;
    }
    const calls = (t.tools ?? []).map((c, i) => ({ ...c, id: `toolu_${n}_${i}` }));
    out.push({
      role: 'assistant',
      kind: 'normal',
      content: [...(t.text ? [{ type: 'text' as const, text: t.text }] : []), ...calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input }))],
      ...(model ? { model } : {}),
      createdAt: at(),
      stopReason: calls.length ? 'tool_use' : 'end_turn',
      meta: { external: { id: id() } },
    });
    if (calls.length) out.push({ role: 'user', kind: 'normal', content: calls.map((c) => ({ type: 'tool_result' as const, toolUseId: c.id, content: c.result })), createdAt: at(), meta: { external: { id: id() } } });
  }
  return out;
}
