/**
 * The transcript sanitizer and the signed bundle (session/share.ts): what a
 * shared copy of a session keeps, what it leaves out, and that a bundle's
 * signature holds only for the bytes that were signed.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import type { ContentBlock, Device, Message, Session } from '../../src/types';
import { BUNDLE_PREFIX, buildBundle, canonicalJson, collectBundle, exportSession, redactMessages, verifyBundle, type BundleSigner } from '../../src/session/share';
import { reminder } from '../../src/session/transcript';

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], extra: Partial<Message> = {}): Message {
  seq++;
  return { id: `msg_${seq}`, sessionId: 'ses_a', seq, role, kind: 'normal', content, createdAt: 1_000 + seq, ...extra };
}

/** Long, mixed case, digits: what the high-entropy secret rule would eat if it ran over attachment data. */
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg' + 'Q2xhdWRlQ29uY2xhdmVTaGFyZTEyMzQ1Njc4OTBBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWg';
const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const ANT = 'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function signer(): BundleSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from((createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 32),
    signBundle: (payload) => sign(null, Buffer.from(BUNDLE_PREFIX + payload, 'utf8'), privateKey).toString('base64url'),
  };
}

describe('redactMessages', () => {
  test('reminders and recalled memories are gone', () => {
    const { messages, report } = redactMessages([
      msg('user', [{ type: 'text', text: 'How do I deploy?' }, reminder('Relevant memories (from earlier sessions; may be outdated):\n- [mem_1] The owner lives in Berlin')], { meta: { recalled: ['mem_1'], auto: true } }),
      msg('user', [{ type: 'text', text: 'Before <system-reminder>\nhook context about the owner\n</system-reminder>\nafter' }]),
      msg('user', [reminder('only a reminder')]),
    ]);
    const all = JSON.stringify(messages);
    expect(all).not.toContain('system-reminder');
    expect(all).not.toContain('Berlin');
    expect(all).not.toContain('mem_1');
    expect(all).not.toContain('hook context');
    expect(messages).toHaveLength(2);
    expect(messages[0].meta).toEqual({ auto: true });
    expect(messages[1].content).toEqual([{ type: 'text', text: 'Before after' }]);
    expect(report.reminders).toBe(3);
    expect(report.recalled).toBe(1);
  });

  test('secrets are redacted in tool input and tool output', () => {
    const { messages, report } = redactMessages([
      msg('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `GITHUB_TOKEN=${GH} gh pr list`, env: { nested: [ANT] } } }]),
      msg('user', [{ type: 'tool_result', toolUseId: 'toolu_1', content: `key is ${ANT}` }]),
      msg('user', [{ type: 'tool_result', toolUseId: 'toolu_2', content: [{ type: 'text', text: `token ${GH}` }] }]),
    ]);
    const all = JSON.stringify(messages);
    expect(all).not.toContain(GH);
    expect(all).not.toContain(ANT);
    expect(all).toContain('[redacted]');
    expect(report.secrets).toBeGreaterThanOrEqual(4);
    // ids are never run through the text rules
    expect((messages[0].content[0] as { id: string }).id).toBe('toolu_1');
  });

  test('base64 images and documents stay byte for byte', () => {
    const image: ContentBlock = { type: 'image', mediaType: 'image/png', data: BASE64 };
    const doc: ContentBlock = { type: 'document', mediaType: 'application/pdf', data: BASE64, title: 'report.pdf' };
    const { messages } = redactMessages([
      msg('user', [{ type: 'text', text: 'look' }, image, doc]),
      msg('user', [{ type: 'tool_result', toolUseId: 't', content: [{ type: 'text', text: 'shot' }, { type: 'image', mediaType: 'image/png', data: BASE64 }] }]),
    ]);
    expect(messages[0].content[1]).toEqual(image);
    expect((messages[0].content[2] as { data: string }).data).toBe(BASE64);
    const inner = (messages[1].content[0] as { content: Array<{ data?: string }> }).content[1];
    expect(inner.data).toBe(BASE64);
  });

  test('thinking and signatures: dropped by default, text kept on request without its signature', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'let me think', signature: 'c2lnbmF0dXJl' },
      { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' },
      { type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: 'a' }, signature: 'Z2VtaW5p' },
    ];
    const off = redactMessages([msg('assistant', blocks)]);
    expect(off.messages[0].content.map((b) => b.type)).toEqual(['tool_use']);
    expect(off.report).toMatchObject({ thinking: 1, redactedThinking: 1, signatures: 2 });
    expect(JSON.stringify(off.messages)).not.toContain('Z2VtaW5p');
    const on = redactMessages([msg('assistant', blocks)], { includeThinking: true });
    expect(on.messages[0].content[0]).toEqual({ type: 'thinking', thinking: 'let me think' });
  });

  test('paths become relative to the session folder, other homes become ~ (Linux)', () => {
    const { messages, report } = redactMessages(
      [
        msg('assistant', [
          { type: 'text', text: 'Edited /home/alice/proj/src/a.ts and /home/alice/proj. Notes in /home/alice/notes.md, logs in /home/bob/logs, not /home/alice/project2/x.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd /home/alice/proj && cat /home/alice/.ssh/config' } },
        ]),
        msg('user', [{ type: 'tool_result', toolUseId: 't1', content: 'ok', meta: { path: '/home/alice/proj/src/a.ts', diff: '--- /home/alice/proj/src/a.ts\n+++ /home/alice/proj/src/a.ts\n-x\n+y', outputId: 'out_1', cwd: '/home/alice/proj' } }]),
      ],
      { cwd: '/home/alice/proj', home: '/home/alice' },
    );
    const text = (messages[0].content[0] as { text: string }).text;
    expect(text).toBe('Edited src/a.ts and .. Notes in ~/notes.md, logs in ~/logs, not ~/project2/x.');
    expect((messages[0].content[1] as unknown as { input: { command: string } }).input.command).toBe('cd . && cat ~/.ssh/config');
    const meta = (messages[1].content[0] as { meta: Record<string, unknown> }).meta;
    expect(meta).toEqual({ path: 'src/a.ts', diff: '--- src/a.ts\n+++ src/a.ts\n-x\n+y' });
    expect(JSON.stringify(messages)).not.toContain('alice');
    expect(report.paths).toBeGreaterThanOrEqual(8);
  });

  test('macOS and Windows forms', () => {
    const mac = redactMessages([msg('user', [{ type: 'text', text: 'open /Users/carol/code/app/main.swift and /Users/dan/Downloads, not /Users/Shared/x' }])], { cwd: '/Users/carol/code/app', home: '/Users/carol' });
    expect((mac.messages[0].content[0] as { text: string }).text).toBe('open main.swift and ~/Downloads, not /Users/Shared/x');

    const win = redactMessages(
      [
        msg('user', [{ type: 'text', text: 'see C:\\Users\\dave\\proj\\src\\a.ts, c:/users/dave/proj/README.md, C:\\Users\\erin\\Desktop and "C:\\\\Users\\\\dave\\\\proj\\\\b.ts"' }]),
      ],
      { cwd: 'C:\\Users\\dave\\proj', home: 'C:\\Users\\dave' },
    );
    expect((win.messages[0].content[0] as { text: string }).text).toBe('see src\\a.ts, README.md, ~\\Desktop and "b.ts"');
  });

  test('private addresses, emails and device names get placeholders', () => {
    const { messages, report } = redactMessages(
      [msg('assistant', [{ type: 'text', text: 'ssh root@madx at 192.168.1.20, 10.0.0.5:8080 or 100.101.3.4; mail kai@example.org; git@github.com:me/repo stays; public 8.8.8.8 stays; madxy stays' }])],
      { hostnames: ['madx', 'local', 'pc'] },
    );
    expect((messages[0].content[0] as { text: string }).text).toBe(
      'ssh root@[host] at [private ip], [private ip]:8080 or [private ip]; mail [email]; git@github.com:me/repo stays; public 8.8.8.8 stays; madxy stays',
    );
    expect(report).toMatchObject({ privateIps: 3, emails: 1, hostnames: 1 });
  });

  test('tool output and attachments can be left out', () => {
    const { messages, report } = redactMessages(
      [
        msg('user', [{ type: 'text', text: 'here' }, { type: 'image', mediaType: 'image/png', data: BASE64 }]),
        msg('user', [{ type: 'tool_result', toolUseId: 't', content: 'secret file body', meta: { path: '/x/y/z', diff: 'd' } }]),
      ],
      { includeToolOutput: false, includeAttachments: false, includeDiffs: false },
    );
    expect(messages[0].content[1]).toEqual({ type: 'text', text: '[image left out]' });
    expect(messages[1].content[0]).toMatchObject({ type: 'tool_result', toolUseId: 't', content: '[tool output left out]', meta: { path: '/x/y/z' } });
    expect(JSON.stringify(messages)).not.toContain(BASE64);
    expect(report).toMatchObject({ toolOutputs: 1, attachments: 1 });
  });
});

// ---------------------------------------------------------------------------

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id, title: `Session ${id}`, agent: 'coder', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'bypass',
    cwd: '/home/alice/proj', device: 'dev_1', status: 'idle', tags: ['work'], pinned: false, archived: false, createdAt: 1, updatedAt: 2,
    stats: { messages: 0, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, costUsd: 1.25 },
    routineId: 'rtn_1', taskId: 'tsk_1', external: { 'claude-code': 'ext-1' }, meta: { untrusted: false, secretish: 'x' },
    ...extra,
  };
}

function hub() {
  const repos = new Repos(openDb(':memory:'));
  const devices: Device[] = [{ id: 'dev_1', name: 'madx', online: true, roots: [], createdAt: 1, info: { hostname: 'madx.lan', platform: 'linux', arch: 'x64', home: '/home/alice', shell: 'bash', clis: {}, capabilities: [] } }];
  return { repos, devices: { list: () => devices } };
}

describe('export and bundle', () => {
  function seed() {
    const h = hub();
    h.repos.sessions.insert(session('ses_root', { projectId: 'prj_1' }));
    h.repos.sessions.insert(session('ses_child', { parentId: 'ses_root', agent: 'explore', title: 'Look around' }));
    h.repos.sessions.insert(session('ses_other'));
    const add = (sessionId: string, m: Message) => h.repos.messages.insert({ ...m, sessionId });
    add('ses_root', msg('user', [{ type: 'text', text: `Fix /home/alice/proj/src/a.ts with ${GH}` }, reminder('Relevant memories:\n- [mem_9] lives in Berlin')], { meta: { recalled: ['mem_9'] }, usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.5 } }));
    add('ses_root', msg('assistant', [{ type: 'tool_use', id: 'tu_task', name: 'Task', input: { prompt: 'look at /home/alice/proj' } }, { type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/home/alice/proj/src/a.ts' } }]));
    add('ses_root', msg('user', [
      { type: 'tool_result', toolUseId: 'tu_task', content: 'found it', meta: { sessionId: 'ses_child', agent: 'explore' } },
      // a result naming a session the root did not start is not followed
      { type: 'tool_result', toolUseId: 'tu_edit', content: 'edited', meta: { path: '/home/alice/proj/src/a.ts', diff: '--- /home/alice/proj/src/a.ts\n+++ /home/alice/proj/src/a.ts', sessionId: 'ses_other' } },
    ]));
    add('ses_child', msg('user', [{ type: 'text', text: 'look at /home/alice/proj' }]));
    add('ses_child', msg('assistant', [{ type: 'text', text: 'ok' }], { stopReason: 'end_turn', model: 'anthropic/claude-haiku-5' }));
    h.repos.db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    h.repos.db
      .query('INSERT INTO projects (id, name, identity, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('prj_1', 'proj', JSON.stringify({ gitRoots: ['abc123'], remotes: ['github.com/me/proj'], shallow: false, syncthing: { folderId: 'st-1', rel: 'proj' }, cloneUrl: 'git@github.com:me/proj.git', head: 'def456' }), 1, 1);
    return h;
  }

  test('the default export is sanitized, raw keeps the rows', () => {
    const h = seed();
    const md = exportSession(h, 'ses_root', 'md');
    expect(md.content).toContain('src/a.ts');
    for (const bad of ['system-reminder', 'Berlin', GH, '/home/alice']) expect(md.content).not.toContain(bad);
    const json = exportSession(h, 'ses_root', 'json');
    const doc = JSON.parse(json.content);
    expect(doc.format).toBe('conclave-export');
    expect(Object.keys(doc.session).sort()).toEqual(['createdAt', 'hints', 'id', 'kind', 'mode', 'tags', 'title', 'updatedAt']);
    for (const bad of ['system-reminder', 'Berlin', 'mem_9', GH, '/home/alice', 'costUsd', 'ext-1', 'rtn_1']) expect(json.content).not.toContain(bad);
    expect(doc.report.secrets).toBe(1);
    const raw = exportSession(h, 'ses_root', 'json', { raw: true });
    expect(raw.content).toContain('Berlin');
    expect(raw.content).toContain('/home/alice');
  });

  test('a bundle holds the root and its subagents, only the shared fields, and verifies', () => {
    const h = seed();
    const s = signer();
    const b = buildBundle(h, 'ses_root', { signer: s, now: 42 });
    expect(b.format).toBe('conclave-bundle');
    expect(b.version).toBe(1);
    expect(b.createdAt).toBe(42);
    expect(b.from).toEqual({ publicKey: s.publicKey, fingerprint: s.fingerprint });
    expect(b.includes).toEqual({ thinking: false, toolOutput: true, attachments: true, code: false });
    expect(b.sessions.map((x) => x.id)).toEqual(['ses_root', 'ses_child']);
    expect(b.sessions[1].parentId).toBe('ses_root');
    expect(b.sessions[0].parentId).toBeUndefined();
    expect(Object.keys(b.sessions[0]).sort()).toEqual(['createdAt', 'hints', 'id', 'kind', 'messages', 'mode', 'tags', 'title', 'updatedAt']);
    expect(b.sessions[0].hints).toEqual({ agent: 'coder', model: 'anthropic/claude-sonnet-5-5' });
    const m = b.sessions[0].messages[0];
    expect(Object.keys(m).sort()).toEqual(['content', 'createdAt', 'kind', 'meta', 'role']);
    expect(m.meta).toEqual({ external: { id: expect.stringMatching(/^msg_/) } });
    expect(b.sessions[1].messages[1]).toMatchObject({ model: 'anthropic/claude-haiku-5', stopReason: 'end_turn' });
    const text = JSON.stringify(b);
    for (const bad of ['system-reminder', 'Berlin', 'mem_9', GH, '/home/alice', 'madx', 'costUsd', 'bypass', 'dev_1', 'rtn_1', 'tsk_1', 'ext-1', 'secretish', 'prj_1', '"diff"']) expect(text).not.toContain(bad);
    expect(b.project).toBeUndefined();
    expect(verifyBundle(b)).toEqual({ ok: true, fingerprint: s.fingerprint });
    expect(verifyBundle(JSON.parse(JSON.stringify(b)), { fingerprint: s.fingerprint }).ok).toBe(true);
  });

  test('a changed byte, another key or a wrong fingerprint fails', () => {
    const h = seed();
    const s = signer();
    const b = buildBundle(h, 'ses_root', { signer: s });
    const text = JSON.stringify(b);
    const i = text.indexOf('Look around');
    const changed = JSON.parse(text.slice(0, i) + 'L0ok around' + text.slice(i + 11));
    expect(verifyBundle(changed)).toEqual({ ok: false, reason: 'the signature does not match' });
    const other = signer();
    expect(verifyBundle({ ...b, from: { publicKey: other.publicKey, fingerprint: other.fingerprint } }).ok).toBe(false);
    expect(verifyBundle(b, { fingerprint: other.fingerprint })).toEqual({ ok: false, reason: 'signed by a different hub' });
    expect(verifyBundle({ ...b, signature: '' }).ok).toBe(false);
    expect(verifyBundle({ format: 'other' }).ok).toBe(false);
  });

  test('code: edit diffs with relative paths and the project without local paths', () => {
    const h = seed();
    const b = buildBundle(h, 'ses_root', { signer: signer(), code: true, toolOutput: false });
    const result = b.sessions[0].messages[2].content[1] as { content: string; meta: Record<string, unknown> };
    expect(result.content).toBe('[tool output left out]');
    expect(result.meta.diff).toBe('--- src/a.ts\n+++ src/a.ts');
    expect(b.project).toEqual({ name: 'proj', gitRoots: ['abc123'], remotes: ['github.com/me/proj'], shallow: false, head: 'def456' });
    expect(verifyBundle(b).ok).toBe(true);
  });

  test('canonical JSON sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
  });
});

describe('the review before sending to a friend', () => {
  function seeded() {
    const h = hub();
    h.repos.sessions.insert(session('ses_r'));
    const add = (m: Message) => h.repos.messages.insert({ ...m, sessionId: 'ses_r' });
    add(msg('user', [{ type: 'text', text: `Deploy /home/alice/proj with ${GH}, mail kai@example.org` }], { id: 'r1' }));
    add(msg('assistant', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: `curl -H "Authorization: token ${GH}" https://x.test` } }], { id: 'r2' }));
    add(msg('user', [{ type: 'tool_result', toolUseId: 'tu_1', content: 'line 1\nline 2\nline 3\nline 4\nline 5' }], { id: 'r3' }));
    add(msg('assistant', [{ type: 'text', text: 'done on madx' }], { id: 'r4' }));
    return h;
  }

  test('each value the text rules found is an item with a stable id', () => {
    const c = collectBundle(seeded(), 'ses_r');
    const secret = c.items.find((i) => i.rule === 'secret' && i.original.includes(GH));
    expect(secret).toMatchObject({ replacement: '[redacted]', kept: false, count: 2, messageIds: ['r1', 'r2'] });
    expect(c.items.find((i) => i.rule === 'email')).toMatchObject({ original: 'kai@example.org', replacement: '[email]', count: 1 });
    expect(c.items.find((i) => i.rule === 'hostname')).toMatchObject({ original: 'madx', messageIds: ['r4'] });
    expect(c.items.find((i) => i.rule === 'path')).toMatchObject({ original: '/home/alice/proj', replacement: '.' });
    // the same rule and value get the same id on the next review
    expect(collectBundle(seeded(), 'ses_r').items.map((i) => i.id)).toEqual(c.items.map((i) => i.id));
    expect(c.items[0].rule).toBe('secret');
  });

  test('keep anyway leaves the value in, and the report does not count it', () => {
    const first = collectBundle(seeded(), 'ses_r');
    const email = first.items.find((i) => i.rule === 'email')!;
    const kept = collectBundle(seeded(), 'ses_r', { keep: [email.id] });
    expect(kept.items.find((i) => i.id === email.id)?.kept).toBe(true);
    expect(JSON.stringify(kept.sessions)).toContain('kai@example.org');
    expect(kept.report.emails).toBe(0);
    expect(first.report.emails).toBe(1);
    expect(JSON.stringify(kept.sessions)).not.toContain(GH);
  });

  test('a range stops at a message, and tool output can be cut to a summary', () => {
    const c = collectBundle(seeded(), 'ses_r', { upTo: 'r3', toolOutput: 'summary' });
    expect(c.upTo).toEqual({ id: 'r3', seq: expect.any(Number) });
    expect(c.total).toBe(4);
    expect(c.sessions[0].messages).toHaveLength(3);
    expect(c.includes).toMatchObject({ toolOutput: true, toolSummaries: true });
    const result = c.sessions[0].messages[2].content[0] as { content: string };
    expect(result.content).toBe('line 1\nline 2\nline 3\n[output cut to a summary: 5 lines, 34 characters]');
    expect(c.report.toolOutputs).toBe(1);
    expect(() => collectBundle(seeded(), 'ses_r', { upTo: 'nope' })).toThrow('not in this session');
  });

  test('a share and its code are signed with the bundle', () => {
    const s = signer();
    const b = buildBundle(seeded(), 'ses_r', {
      signer: s,
      share: { id: '01J0000000000000000000000A', revision: 2, title: 'Fix' },
      attach: { kind: 'diff', diff: '--- a/x\n+++ b/x\n', files: ['x'], excluded: [{ path: '.env', reason: 'credential file' }] },
    });
    expect(verifyBundle(b).ok).toBe(true);
    expect(verifyBundle({ ...b, code: { ...b.code!, diff: '--- a/y\n' } }).ok).toBe(false);
    expect(verifyBundle({ ...b, share: { ...b.share!, revision: 3 } }).ok).toBe(false);
  });
});
