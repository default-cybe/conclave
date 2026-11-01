/**
 * `conclave sessions send` and `conclave friends shares` between two real
 * hubs: the review, send, the Inbox card, accept, view, fork, reference, the
 * handoff draft, and unsend.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Session } from '@conclave/core/types.ts';
import { OWNER } from '../../server/test/helpers';
import { befriend, makePeerHub, waitFor, type PeerHub } from '../../server/test/peer-helpers';
import { describeSummary, findShare } from '../src/commands/shares';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
const TOKEN = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';
let a: PeerHub;
let b: PeerHub;
let home: string;

beforeAll(async () => {
  a = makePeerHub('Alice');
  b = makePeerHub('Bob');
  await befriend(a, b);
  home = mkdtempSync(join(tmpdir(), 'conclave-shares-cli-'));
  const now = Date.now();
  const s: Session = {
    id: 'ses_cats', title: 'Cat names', agent: 'assistant', model: 'anthropic/claude-opus-test', mode: 'agent', permissionMode: 'default', cwd: '/home/me', device: 'local', kind: 'chat', chat: { webSearch: false, memory: true },
    status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now, stats: { messages: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  };
  a.engine.repos.sessions.insert(s);
  const add = (m: Omit<Message, 'sessionId' | 'createdAt'>) => a.engine.repos.messages.insert({ ...m, sessionId: 'ses_cats', createdAt: now + m.seq });
  add({ id: 'c1', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: `Names for a grey cat? Mail me at kai@example.org, key ${TOKEN}` }] });
  add({ id: 'c2', seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'Miso, Smoke or Ash.' }] });
});
afterAll(async () => {
  await a?.close();
  await b?.close();
  rmSync(home, { recursive: true, force: true });
});

async function cli(hub: PeerHub, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { CONCLAVE_HUB: _hub, CONCLAVE_TOKEN: _token, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, ENTRY, ...args, '--hub', hub.url, '--token', OWNER], { env: { ...env, CONCLAVE_HOME: home, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe('conclave sessions send and conclave friends shares', () => {
  test('review, send, accept, view, fork, reference, handoff and unsend', async () => {
    const review = await cli(a, ['sessions', 'send', 'ses_cats', '--to', 'Bob', '--dry-run']);
    expect(review.stderr).toBe('');
    expect(review.stdout).toContain('Cat names (chat, 2 of 2 messages, 1 session)');
    expect(review.stdout).toContain('Taken out: 1 secret, 1 email.');
    expect(review.stdout).not.toContain(TOKEN);
    expect(review.stdout).toContain('Nothing was sent.');
    const emailId = /([0-9a-f]{12})\s+email/.exec(review.stdout)![1];
    expect((await cli(a, ['sessions', 'send', 'ses_cats', '--dry-run', '--show'])).stdout).toContain('kai@example.org');

    const sent = await cli(a, ['sessions', 'send', 'ses_cats', '--to', 'Bob', '--note', 'For your new cat', '--keep', emailId]);
    expect(sent.stderr).toBe('');
    expect(sent.stdout).toContain("Sent 'Cat names' to Bob (chat, 2 messages).");

    await waitFor('the card on Bob', async () => ((await b.api('/api/shares/received')).body as unknown[]).length === 1);
    const list = await cli(b, ['friends', 'shares']);
    expect(list.stdout).toContain("Alice sent 'Cat names' (chat, 2 messages)");
    expect(list.stdout).toContain('waiting for you');

    const accepted = await cli(b, ['friends', 'shares', 'accept', 'cat']);
    expect(accepted.stdout).toContain("Fetched 'Cat names' from Alice's hub. Its signature checks out against their key.");
    const view = await cli(b, ['friends', 'shares', 'view', 'cat']);
    expect(view.stdout).toContain("Signed by Alice's hub key.");
    expect(view.stdout).toContain("Alice's hub · assistant: Miso, Smoke or Ash.");
    expect(view.stdout).toContain('kai@example.org');
    expect(view.stdout).not.toContain(TOKEN);

    const fork = await cli(b, ['friends', 'shares', 'fork', 'cat']);
    expect(fork.stdout).toMatch(/Forked as ses_\w+: Cat names \(from Alice\)\./);
    expect((await cli(b, ['friends', 'shares', 'reference', 'cat'])).stdout).toContain('read only');
    const draft = await cli(b, ['friends', 'shares', 'handoff', 'cat']);
    expect(draft.stdout).toContain(`Handoff from Alice's hub: "Cat names".`);
    expect(draft.stdout).toContain('--brief-file');

    expect((await cli(a, ['friends', 'shares', 'sent'])).stdout).toContain('Bob: accepted');
    const unsent = await cli(a, ['friends', 'shares', 'unsend', 'cat']);
    expect(unsent.stdout).toContain("Unsent 'Cat names'. Bob's hub is asked to delete the copy.");
    await waitFor('the unsend on Bob', async () => ((await b.api('/api/shares/received')).body as Array<{ state: string }>)[0].state === 'revoked');
    expect((await cli(b, ['friends', 'shares'])).stdout).toContain('unsent');

    const nothing = await cli(b, ['friends', 'shares', 'accept', 'dogs']);
    expect(nothing.code).toBe(1);
    expect(nothing.stderr).toContain('No share matches "dogs"');
  }, 60_000);

  test('helpers', () => {
    const list = [
      { id: 'shr_aa11', title: 'Cat names' },
      { id: 'shr_bb22', title: 'Cat food' },
    ];
    expect(findShare(list, 'shr_bb', 'u').title).toBe('Cat food');
    expect(findShare(list, 'names', 'u').id).toBe('shr_aa11');
    expect(() => findShare(list, 'cat', 'u')).toThrow('More than one share matches');
    expect(describeSummary('session', { messages: 1, sessions: 1, code: { kind: 'git-bundle', files: 3 }, bytes: 1 })).toBe('(session, 1 message, git bundle 3 files)');
  });
});
