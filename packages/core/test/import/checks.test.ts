/**
 * The pieces of the import that decide without a model: the sync plan
 * (append, absorb, diverge), the reply checks (evidence in the window,
 * known words, secrets, length), private spans and secret file reads, and
 * the dedupe of learned items (IDF veto, a second session promotes).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { planSync } from '../../src/import/ledger';
import { checkItems, parseLearnReply } from '../../src/import/learn';
import { readsSecretFile, stripPrivate } from '../../src/import/render';
import type { ImportedMessage } from '../../src/importers/types';
import type { Message } from '../../src/types';
import { SqliteMemory } from '../../src/memory/store';
import { setup } from '../memory/helpers';

const src = (id: string, role: 'user' | 'assistant', text: string): ImportedMessage => ({
  role,
  kind: 'normal',
  content: [{ type: 'text', text }],
  createdAt: 0,
  meta: { external: { source: 'claude-code', id }, ...(role === 'user' ? { origin: 'human' } : {}) },
});
const stored = (m: ImportedMessage, seq: number, ext = true): Message => ({ ...m, id: `m${seq}`, sessionId: 's', seq, meta: ext ? m.meta : {} });

describe('sync plan', () => {
  const a = [src('u1', 'user', 'Add a contact form'), src('a1', 'assistant', 'Done.'), src('u2', 'user', 'Deploy it'), src('a2', 'assistant', 'Deployed.')];

  test('unchanged, then append when the source grew', () => {
    const session = a.slice(0, 2).map((m, i) => stored(m, i + 1));
    expect(planSync(a.slice(0, 2), session).state).toBe('unchanged');
    const p = planSync(a, session);
    expect(p.state).toBe('append');
    expect(p.state === 'append' && p.append.map((m) => (m.meta?.external as { id: string }).id)).toEqual(['u2', 'a2']);
  });

  test("Conclave's own harness turns in the source are absorbed, not copied", () => {
    const session = [...a.slice(0, 2).map((m, i) => stored(m, i + 1)), stored(a[2], 3, false), stored(a[3], 4, false)];
    const p = planSync(a, session);
    expect(p).toMatchObject({ state: 'unchanged', absorbed: ['u2', 'a2'] });
  });

  test('both sides grew: diverged', () => {
    const session = [...a.slice(0, 2).map((m, i) => stored(m, i + 1)), stored(src('x', 'user', 'Only in Conclave'), 3, false)];
    expect(planSync(a, session).state).toBe('diverged');
  });

  test('a copy that is behind adds nothing; a rewound source with new messages diverges', () => {
    const session = a.map((m, i) => stored(m, i + 1));
    // a Syncthing copy that has not caught up yet
    expect(planSync(a.slice(0, 2), session).state).toBe('unchanged');
    // the owner rewound in the tool and went another way: never interleave
    const rewound = [...a.slice(0, 2), src('u9', 'user', 'Actually use a form service instead')];
    expect(planSync(rewound, session)).toMatchObject({ state: 'diverged' });
  });
});

describe('reply checks', () => {
  const window = '[user] I always deploy the portfolio with `bun run deploy` from the repo root.\n[assistant] Deployed.';
  const item = (over: Record<string, unknown>) => ({ kind: 'procedure', content: 'The user deploys the portfolio with bun run deploy.', scope: 'project', subject: 'portfolio', evidence: 'deploy the portfolio with `bun run deploy`', basis: 'user_said', supersedes: '', ...over });

  test('each rule drops by reason', () => {
    const dropped: Record<string, number> = {};
    const ok = checkItems(
      [
        item({}),
        item({ evidence: 'DEPLOY   the Portfolio with `bun run deploy`' }),
        item({ evidence: 'deploy to vercel', content: 'x'.repeat(20) }),
        item({ basis: 'guess', content: 'The user likes guesses a lot.' }),
        item({ kind: 'feeling', content: 'The user feels fine today.' }),
        item({ content: 'y'.repeat(201) }),
        item({ content: 'The deploy token is GITHUB_TOKEN=ghx_notreal_abcdefghijk.' }),
        item({ content: 'The user deploys from the root.', supersedes: 'mem_unknown' }),
        'not an object',
      ],
      window,
      new Set(['mem_known']),
      new Set(),
      dropped,
    );
    expect(dropped).toEqual({ duplicate: 1, evidence: 1, basis: 1, kind: 1, length: 1, secret: 1, supersedes: 1, shape: 1 });
    expect(ok.map((i) => i.content)).toEqual(['The user deploys the portfolio with bun run deploy.', 'The user deploys from the root.']);
    // a bad supersede target is cleared, the item kept
    expect(ok[1].supersedes).toBeUndefined();
  });

  test('replies that are not JSON are counted by the caller', () => {
    expect(parseLearnReply('no json here')).toBeUndefined();
    expect(parseLearnReply('```json\n{"episode": "x", "items": []}\n```')).toEqual({ episode: 'x', items: [] });
  });
});

describe('what the learning job never reads', () => {
  test('private spans, nested and unclosed', () => {
    expect(stripPrivate('a <private>b <private>c</private> d</private> e')).toBe('a  e');
    expect(stripPrivate('keep <private>secret')).toBe('keep');
  });

  test('reads of secret files', () => {
    const t = (input: Record<string, unknown>) => readsSecretFile({ type: 'tool_use', id: 't', name: 'x', input });
    expect(t({ file_path: '/home/kai/code/portfolio/.env' })).toBe(true);
    expect(t({ command: 'cat ~/.ssh/id_ed25519' })).toBe(true);
    expect(t({ command: 'cat certs/server.pem' })).toBe(true);
    expect(t({ path: '/home/kai/.aws/credentials' })).toBe(true);
    expect(t({ command: 'cat .env.production | grep URL' })).toBe(true);
    expect(t({ file_path: '/home/kai/code/portfolio/src/env.ts' })).toBe(false);
    expect(t({ command: 'bun run deploy' })).toBe(false);
  });
});

describe('learned item dedupe', () => {
  let env: ReturnType<typeof setup>;
  afterEach(() => env?.cleanup());

  const mk = () => {
    env = setup({ memory: { enabled: true } } as never);
    return new SqliteMemory({ db: env.db, bus: env.bus, config: env.config, complete: async () => '' });
  };
  const meta = (session: string, observedAt = 1) => ({ source: 'claude-code', extSessionId: session, observedAt, basis: 'user_said' as const, batchId: 'imp_1' });

  test('a rare word on one side blocks the merge (madx and pve)', async () => {
    const m = mk();
    const a = await m.saveLearned({ content: 'madx runs Proxmox backups every night at 02:00.', kind: 'fact', meta: meta('s1') });
    const b = await m.saveLearned({ content: 'pve runs Proxmox backups every night at 02:00.', kind: 'fact', meta: meta('s2') });
    expect(b.merged).toBe(false);
    expect(b.entry.id).not.toBe(a.entry.id);
  });

  test('the same preference from a second session raises the count and leaves the review queue', async () => {
    const m = mk();
    const a = await m.saveLearned({ content: 'The user prefers Resend over nodemailer for email.', kind: 'profile', meta: { ...meta('s1'), review: 'pending' } });
    expect(m.reviewQueue().map((x) => x.id)).toEqual([a.entry.id]);
    const again = await m.saveLearned({ content: 'The user prefers Resend over nodemailer for email.', kind: 'profile', meta: { ...meta('s1'), review: 'pending' } });
    expect(again.entry.meta?.seenCount).toBe(1);
    const other = await m.saveLearned({ content: 'The user prefers Resend over nodemailer for email.', kind: 'profile', meta: { ...meta('s2', 5), review: 'pending' } });
    expect(other).toMatchObject({ merged: true });
    expect(other.entry.meta).toMatchObject({ seenCount: 2, review: 'accepted', observedAt: 5 });
    expect(m.reviewQueue()).toEqual([]);
  });
});
