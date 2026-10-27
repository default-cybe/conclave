/**
 * A file left in a chat's outputs folder without a ShareFile call gets a
 * ShareFile card at turn end (runner shareStrays); a shared one gets none.
 *
 *   bun test packages/core/test/files/auto-share.test.ts
 */
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outputsDir } from '../../src/files/share';
import { startTestEngine } from '../engine/harness';

test('an unshared file in the outputs folder becomes a downloadable card; a shared one does not repeat', async () => {
  const t = await startTestEngine({ script: [[{ tool: 'ShareFile', input: { path: 'a.pdf' } }], [{ text: 'done' }]] });
  try {
    const s = await t.engine.createSession({ title: 'Out', kind: 'chat' });
    const dir = outputsDir(t.home, s.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.pdf'), 'pdf!');
    writeFileSync(join(dir, 'b.png'), 'png!');
    await t.run(s.id, 'go');
    const blocks = t.engine.repos.messages.list(s.id).flatMap((m) => m.content);
    const cards = blocks.filter((b) => b.type === 'tool_result' && b.meta?.file);
    expect(cards.length).toBe(2);
    const auto = blocks.find((b) => b.type === 'tool_use' && b.name === 'ShareFile' && (b.input as { path: string }).path === join(dir, 'b.png'));
    expect(auto).toBeTruthy();
    const f = await t.engine.sharedFile(s.id, (auto as { id: string }).id);
    expect(new TextDecoder().decode(f.bytes)).toBe('png!');
    expect(f.mediaType).toBe('image/png');
  } finally {
    await t.close();
  }
}, 30_000);

const cards = (t: Awaited<ReturnType<typeof startTestEngine>>, id: string) => t.engine.repos.messages.list(id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.meta?.file);

test('hidden files and folders are skipped, and at most 10 files get a card a turn', async () => {
  const t = await startTestEngine({ script: [[{ text: 'done' }]] });
  try {
    const s = await t.engine.createSession({ title: 'Out', kind: 'chat' });
    const dir = outputsDir(t.home, s.id);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, '.secret.txt'), 'x');
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'x');
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x');
    await t.run(s.id, 'go');
    expect(cards(t, s.id).length).toBe(10);
  } finally {
    await t.close();
  }
}, 30_000);

test('a session with a project folder gets no automatic cards', async () => {
  const t = await startTestEngine({ script: [[{ text: 'done' }]] });
  try {
    const s = await t.engine.createSession({ agent: 'coder', cwd: t.cwd });
    const dir = outputsDir(t.home, s.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.pdf'), 'pdf!');
    writeFileSync(join(t.cwd, 'b.pdf'), 'pdf!');
    await t.run(s.id, 'go');
    expect(cards(t, s.id).length).toBe(0);
    // the agent is told to save and share whole files itself, not to wait for a scan
    expect(t.requests[0]).toContain('then call ShareFile with its path.');
  } finally {
    await t.close();
  }
}, 30_000);

test('an untrusted session, which has no ShareFile, gets no automatic cards', async () => {
  const t = await startTestEngine({ script: [[{ text: 'done' }]] });
  try {
    const s = await t.engine.createSession({ title: 'Out', kind: 'chat' });
    t.engine.patchMeta(s.id, { untrusted: true });
    expect(t.engine.toolsFor(t.engine.getSession(s.id)!, t.engine.agentFor(s), 'agent', 0).some((x) => x.name === 'ShareFile')).toBe(false);
    const dir = outputsDir(t.home, s.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.pdf'), 'pdf!');
    await t.run(s.id, 'go');
    expect(cards(t, s.id).length).toBe(0);
    // its file note says it cannot save or share, and never tells it to call ShareFile
    expect(t.requests[0]).toContain('You cannot save or share files in this session.');
    expect(t.requests[0]).not.toContain('then call ShareFile with');
  } finally {
    await t.close();
  }
}, 30_000);
