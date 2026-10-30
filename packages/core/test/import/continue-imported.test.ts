/**
 * A chat imported from a claude.ai export lives under Imported
 * (session/imported.ts) and can be continued: the first message here
 * unarchives it, and that turn's model request carries the imported turns
 * as real conversation turns, in order, with the attachment's text and the
 * artifact's code. A member's import is theirs only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { inImported, importedLabel, continuedPatch } from '../../src/session/imported';
import { OWNER_ID, runAs } from '../../src/people/context';
import { zipOf } from '../importers/owner-home';

let t: TestEngine;
let svc: ImportService;

/** One claude.ai conversation with an attachment, an artifact, thinking and a web search result. */
function exportOf(uuid: string, name: string): unknown[] {
  return [
    {
      uuid,
      name,
      created_at: '2026-04-02T09:00:00Z',
      updated_at: '2026-04-02T09:10:00Z',
      chat_messages: [
        {
          uuid: `${uuid}-1`,
          sender: 'human',
          text: 'Turn this CSV into a chart page.',
          content: [{ type: 'text', text: 'Turn this CSV into a chart page.' }],
          created_at: '2026-04-02T09:00:00Z',
          attachments: [{ file_name: 'sales.csv', extracted_content: 'month,total\njan,12\nfeb,19' }],
          files: [{ file_name: 'logo.png' }],
        },
        {
          uuid: `${uuid}-2`,
          sender: 'assistant',
          text: '',
          content: [
            { type: 'thinking', thinking: 'Plan the chart.' },
            { type: 'text', text: 'Here is the page.' },
            { type: 'tool_use', id: 'toolu_art1', name: 'artifacts', input: { command: 'create', id: 'chart', type: 'text/html', title: 'Sales chart', content: '<canvas id="c"></canvas><script>draw()</script>' } },
            { type: 'tool_result', tool_use_id: 'toolu_art1', content: [{ type: 'text', text: 'OK' }] },
            { type: 'text', text: 'Open it to see January and February.' },
          ],
          created_at: '2026-04-02T09:01:00Z',
        },
        { uuid: `${uuid}-3`, sender: 'human', text: 'Make February red.', content: [{ type: 'text', text: 'Make February red.' }], created_at: '2026-04-02T09:05:00Z' },
        { uuid: `${uuid}-4`, sender: 'assistant', text: 'Done, February is red now.', content: [{ type: 'text', text: 'Done, February is red now.' }], created_at: '2026-04-02T09:06:00Z' },
      ],
    },
  ];
}

async function importExport(conv: unknown[]): Promise<string> {
  const up = svc.upload('claude-ai', zipOf({ 'conversations.json': JSON.stringify(conv) }), 'export.zip');
  const device = `upload:${up.uploadId}`;
  const b = await svc.startBatch({ device, query: {}, mode: 'chats', includeSkipped: true } as never);
  await svc.runBatch(b.id);
  return (await svc.scan({ device })).items[0].imported!.sessionId!;
}

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'Sure, here is the next step.' }]], chore: () => [{ text: 'Sure, here is the next step.' }] });
  svc = importOf(t.engine)!;
});

afterAll(async () => {
  await t.close();
});

test('an imported claude.ai chat sits under Imported with its source and original date', async () => {
  const sid = await importExport(exportOf('c1111111-1111-4111-8111-111111111111', 'Sales chart'));
  const s = t.engine.repos.sessions.get(sid)!;
  expect(s).toMatchObject({ kind: 'chat', archived: true });
  expect(inImported(s)).toBe(true);
  expect(importedLabel(s, Date.parse('2026-10-30T12:00:00Z'))).toBe('claude.ai, 2 Apr');
  // the original date, not the import's
  expect(new Date(s.updatedAt).toISOString().slice(0, 10)).toBe('2026-04-02');
  // a merge's duplicate copy and a continued chat are not listed under Imported
  expect(inImported({ ...s, meta: { ...s.meta, import: { ...(s.meta!.import as object), duplicateOf: 'ses_x' } } })).toBe(false);
  expect(inImported({ ...s, ...continuedPatch(s) })).toBe(false);
  expect(inImported({ ...s, ...continuedPatch(s), archived: true })).toBe(false);
});

test('continuing it: the first request carries the imported turns as real turns, then it is a normal chat', async () => {
  const sid = await importExport(exportOf('c2222222-2222-4222-8222-222222222222', 'Chart follow-up'));
  const before = t.requests.length + t.chores.length;
  await t.engine.send(sid, { text: 'Now add March, 23.' });
  await Promise.race([t.engine.runnerFor(sid).waitIdle(), Bun.sleep(30_000)]);

  const all = [...t.requests, ...t.chores];
  const bodies = all.slice(before).map((x) => JSON.parse(x) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> | string }> });
  const turn = bodies.find((b) => JSON.stringify(b.messages).includes('Now add March, 23.'))!;
  expect(turn).toBeDefined();
  const msgs = turn.messages;
  const text = (m: (typeof msgs)[number]) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n'));
  // roles alternate and follow the export: user, assistant, user, assistant, then the new message
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  expect(text(msgs[0])).toContain('Turn this CSV into a chart page.');
  // the attachment's text and the file's name go along
  expect(text(msgs[0])).toContain('[Attached sales.csv]\nmonth,total');
  expect(text(msgs[0])).toContain('[Attached logo.png]');
  // the artifact's code goes as text (an imported call is never replayed as a tool call), the unsigned thinking not at all
  expect(text(msgs[1])).toContain('[artifact "Sales chart"]');
  expect(text(msgs[1])).toContain('<canvas id="c"></canvas>');
  expect(JSON.stringify(msgs[1])).not.toContain('Plan the chart.');
  expect(JSON.stringify(msgs[1])).not.toContain('"tool_use"');
  expect(text(msgs[2])).toContain('Make February red.');
  expect(text(msgs[3])).toContain('February is red now.');
  expect(text(msgs[4])).toContain('Now add March, 23.');

  const s = t.engine.repos.sessions.get(sid)!;
  expect(s.archived).toBe(false);
  expect(inImported(s)).toBe(false);
  expect((s.meta!.import as { continuedAt?: number }).continuedAt).toBeGreaterThan(0);
  // still says where it came from
  expect(s.tags).toContain('imported');
  expect(s.model).toBe(t.engine.config.get().defaultModel);
});

test("a member's import is theirs: the owner's list and scan do not reach it", async () => {
  const member = 'acct_member1';
  const sid = await runAs(member, () => importExport(exportOf('c3333333-3333-4333-8333-333333333333', 'Member chat')));
  expect(t.engine.repos.sessions.get(sid)!.accountId).toBe(member);
  const ownerList = t.engine.listSessions({ archived: true, tag: 'imported', accountId: OWNER_ID });
  expect(ownerList.some((s) => s.id === sid)).toBe(false);
  const memberList = t.engine.listSessions({ archived: true, tag: 'imported', accountId: member });
  expect(memberList.map((s) => s.id)).toEqual([sid]);
});
