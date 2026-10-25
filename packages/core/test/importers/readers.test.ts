/**
 * The readers on the owner's fixture home (owner-home.ts), built from the
 * shapes measured in real transcripts: the live chain only, every user line
 * tagged with who wrote it, titles in the tools' own order, and unknown
 * line types counted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { convertChatGpt, convertClaudeAi, convertClaudeCode, convertCodex, convertGemini, parseRolloutName } from '../../src/importers';
import { humanText, originOf, sessionStats, type ImportedMessage } from '../../src/importers/types';
import { renderWindows } from '../../src/import/render';
import { LocalMachine } from '../../src/machine/local';
import { DEVICE_SOURCES, ReadContext, discover, scanMachine } from '../../src/import/sources';
import { chatGptExport, claudeAiExport, buildOwnerHome, OWNER, OWNER_PATHS, type OwnerHome } from './owner-home';

const h: OwnerHome = buildOwnerHome();
afterAll(() => rmSync(h.home, { recursive: true, force: true }));

const text = (m: ImportedMessage) =>
  m.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
const humans = (ms: ImportedMessage[]) => ms.map(humanText).filter(Boolean);

/** A machine whose ~ is the fixture home. */
class HomeMachine extends LocalMachine {
  constructor(
    readonly home: string,
    id = 'arch-desktop',
  ) {
    super({ id, name: id });
  }
  override resolve(path: string, cwd: string): string {
    const p = path === '~' ? this.home : path.startsWith('~/') ? `${this.home}/${path.slice(2)}` : path;
    return super.resolve(p, cwd === '~' ? this.home : cwd);
  }
}

describe('Claude Code', () => {
  const c = convertClaudeCode(readFileSync(h.path('claudeA')));

  test('imports the live chain only: no edited prompt, no retracted reply', () => {
    const all = JSON.stringify(c.messages);
    expect(all).not.toContain('Actually make it post to /api/contact');
    expect(all).not.toContain('Sure, posting to /api/contact.');
    expect(all).not.toContain("I can't help with that.");
    expect(all).toContain('Deployed. The site is live at https://kai.dev.');
  });

  test('every human prompt is kept, the queued one in place, and notices are not the owner', () => {
    expect(humans(c.messages)).toEqual([
      'Set up the contact form on the portfolio site. Use Resend for email, not nodemailer.',
      'Make the form post to /api/contact and validate it with zod. <private>my bank pin is 4242</private>',
      'also add a honeypot field',
      'Ship it. I always deploy the portfolio with `bun run deploy` from the repo root, never from CI. The launch is next friday.',
    ]);
    const notice = c.messages.find((m) => text(m).includes('Background command'))!;
    expect(notice.kind).toBe('aside');
    expect(notice.author).toBe('Background task');
    expect(originOf(notice)).toBe('task');
    const summary = c.messages.find((m) => m.kind === 'summary')!;
    expect(text(summary)).toContain('contact form with Resend');
    expect(c.messages.find((m) => m.meta?.queued)).toBeDefined();
  });

  test('wrappers are stripped, split assistant lines and parallel tool results merge', () => {
    const all = JSON.stringify(c.messages);
    expect(all).not.toContain('system-reminder');
    expect(all).not.toContain('persisted-output');
    expect(all).toContain('The file src/pages/api/contact.ts has been updated.');
    const first = c.messages.find((m) => m.role === 'assistant')!;
    expect(first.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    const parallel = c.messages.find((m) => m.content.filter((b) => b.type === 'tool_result').length === 2)!;
    expect(parallel.content.map((b) => (b as { toolUseId: string }).toolUseId)).toEqual(['toolu_02', 'toolu_03']);
  });

  test('title, times, ids and unknown lines', () => {
    expect(c.title).toBe('Portfolio contact form');
    expect(c.cwd).toBe('/home/kai/code/portfolio');
    expect(c.gitBranch).toBe('main');
    expect(c.kind).toBe('main');
    expect(c.nativeIdUnique).toBe(true);
    expect(c.unknown['line:mystery-telemetry']).toBe(1);
    const st = sessionStats(c.messages);
    expect(st.createdAt).toBe(Date.parse('2026-03-14T09:00:00.000Z'));
    expect(st.updatedAt).toBe(Date.parse('2026-03-14T09:37:00.000Z'));
    expect(st.humanPrompts).toBe(4);
    expect(st.firstIds).toEqual(['a0001-0000-4000-8000-000000000001', 'a0002-0000-4000-8000-000000000002', 'a0005-0000-4000-8000-000000000005']);
    expect(c.messages.every((m) => typeof (m.meta?.external as { id?: string })?.id === 'string')).toBe(true);
  });

  test('a subagent transcript, an sdk run and a one-line chat', () => {
    const sub = convertClaudeCode(readFileSync(h.path('claudeSub')), { subagent: true, parent: OWNER.claudeA });
    expect(sub.kind).toBe('subagent');
    expect(sub.parentNativeId).toBe(OWNER.claudeA);
    expect(humans(sub.messages)).toEqual(['Find every use of nodemailer in the repo.']);
    expect(convertClaudeCode(readFileSync(h.path('claudeC'))).kind).toBe('automation');
    expect(sessionStats(convertClaudeCode(readFileSync(h.path('claudeD'))).messages).humanPrompts).toBe(1);
  });
});

describe('Codex', () => {
  test('meta text is dropped, agent messages are notices, git and model are kept', () => {
    const c = convertCodex(readFileSync(h.path('codexT1')), { path: h.path('codexT1') });
    expect(humans(c.messages).slice(0, 2)).toEqual(['Add a dark mode toggle. Keep the CSS in src/styles/tokens.css, no tailwind.', 'Commit it with a conventional commit message. I always use conventional commits in this repo.']);
    const all = JSON.stringify(c.messages);
    expect(all).not.toContain('AGENTS.md instructions');
    expect(all).not.toContain('environment_context');
    expect(all).not.toContain('permissions instructions');
    const asides = c.messages.filter((m) => m.kind === 'aside');
    expect(asides.map((m) => m.author)).toEqual(['Background task', 'Peer agent']);
    expect(c).toMatchObject({ nativeId: OWNER.codexT1, nativeIdUnique: true, cwd: '/home/kai/code/portfolio', gitBranch: 'main', repo: 'git@github.com:kai/portfolio.git', model: 'openai/gpt-5.5-codex', kind: 'main', learnable: true });
    expect((c.messages[0].meta?.external as { id: string }).id).toMatch(/^i\d+$/);
  });

  test('names with a rollout id, and a paginated fork starts with its base', async () => {
    expect(parseRolloutName(h.path('codexT2'))).toEqual({ time: '2026-03-15T10-00-00', threadId: OWNER.codexT2, rolloutId: 'r2a' });
    const ctx = new ReadContext(new HomeMachine(h.home));
    const fork = await ctx.read({ source: 'codex', path: h.path('codexT2'), size: 0, mtime: 0 });
    const prompts = humans(fork.messages);
    expect(prompts[0]).toBe('Add a dark mode toggle. Keep the CSS in src/styles/tokens.css, no tailwind.');
    expect(prompts).toContain('Good, keep tests next to the component files from now on, named like Theme.test.ts, not in a separate tests folder.');
    expect(prompts).not.toContain('Commit it with a conventional commit message. I always use conventional commits in this repo.');
    expect(fork.parentNativeId).toBe(OWNER.codexT1);
  });

  test('an archived rollout in two zstd frames, titles from the index (last wins), internal and exec threads', async () => {
    const ctx = new ReadContext(new HomeMachine(h.home));
    const t3 = await ctx.read({ source: 'codex', path: h.path('codexT3'), size: 0, mtime: 0 });
    expect(t3.title).toBe('PBS backup check');
    expect(humans(t3.messages)).toHaveLength(2);
    const t1 = await ctx.read({ source: 'codex', path: h.path('codexT1'), size: 0, mtime: 0 });
    expect(t1.title).toBe('Dark mode toggle for the portfolio');
    const t4 = await ctx.read({ source: 'codex', path: h.path('codexT4'), size: 0, mtime: 0 });
    expect(t4).toMatchObject({ kind: 'internal', learnable: false });
    const t5 = await ctx.read({ source: 'codex', path: h.path('codexT5'), size: 0, mtime: 0 });
    expect(t5.kind).toBe('automation');
  });
});

describe('Gemini CLI', () => {
  test('rewind, patch and set records replay in order; cwd from projects.json', async () => {
    const ctx = new ReadContext(new HomeMachine(h.home));
    const g = await ctx.read({ source: 'gemini', path: h.path('gemini'), size: 0, mtime: 0, project: 'portfolio' });
    expect(humans(g.messages)).toEqual(['How do I make the hero image on the portfolio load faster? Lighthouse says the largest contentful paint is 3.8 seconds on mobile, and the hero is a 2.4 MB PNG.', 'Use astro:assets with AVIF. I prefer AVIF over WebP for photos on all my sites. Keep a JPEG fallback for old Safari and lazy load everything below the fold.']);
    expect(JSON.stringify(g.messages)).not.toContain('wrong, redo that');
    expect(JSON.stringify(g.messages)).toContain('Switched the hero to astro:assets with AVIF output.');
    expect(JSON.stringify(g.messages)).not.toContain('Switching to WebP.');
    expect(g).toMatchObject({ title: 'Faster hero image with AVIF', cwd: '/home/kai/code/portfolio', nativeId: OWNER.gemini, model: 'google/gemini-3-pro' });
    expect(convertGemini('{"sessionId":"x"}\n').messages).toEqual([]);
  });
});

describe('chat app exports', () => {
  test('claude.ai: senders, project names, unknown content counted', () => {
    const [conv, empty] = claudeAiExport() as Array<Record<string, any>>;
    const c = convertClaudeAi(conv, { projects: new Map([['p-travel', 'Travel']]) });
    expect(c.title).toBe('Lisbon trip food');
    expect(c.repo).toBe('Travel');
    expect(humans(c.messages)).toEqual(['I am vegetarian. Find dinner places in Alfama for Friday.', 'Book nothing, just list them. I never want you to make reservations for me.']);
    expect(c.unknown['content:voice_note']).toBe(1);
    expect(convertClaudeAi(empty).messages).toEqual([]);
  });

  test('ChatGPT: the live branch from current_node, not the edited prompt', () => {
    const c = convertChatGpt((chatGptExport() as Array<Record<string, any>>)[0]);
    expect(humans(c.messages)).toEqual(['Make me a 3 day gym plan. I train Monday, Wednesday and Friday mornings.', 'Good. I have a bad left knee, so no deep squats.']);
    expect(JSON.stringify(c.messages)).not.toContain('Here is a 5 day plan.');
    expect(c).toMatchObject({ title: 'Gym plan', model: 'openai/gpt-5.5', nativeId: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
  });
});

describe('discovery and render', () => {
  test('every source file is found, subagent transcripts carry their parent', async () => {
    const { found, failed } = await discover(new HomeMachine(h.home), DEVICE_SOURCES);
    expect(failed).toEqual([]);
    const rel = (p: string) => p.slice(h.home.length + 1);
    expect(found.map((f) => rel(f.path)).sort()).toEqual(
      [OWNER_PATHS.claudeA, OWNER_PATHS.claudeSub, OWNER_PATHS.claudeB, OWNER_PATHS.claudeBOld, OWNER_PATHS.claudeC, OWNER_PATHS.claudeD, OWNER_PATHS.codexT1, OWNER_PATHS.codexT2, OWNER_PATHS.codexT3, OWNER_PATHS.codexT4, OWNER_PATHS.codexT5, OWNER_PATHS.gemini].sort(),
    );
    expect(found.find((f) => f.path.endsWith('agent-a1b2c3d4.jsonl'))?.parent).toBe(OWNER.claudeA);
    expect(found.find((f) => f.path.endsWith('.zst'))?.archived).toBe(true);
  });

  test('a scan reads only files that changed', async () => {
    const m = new HomeMachine(h.home);
    const first = await scanMachine(m);
    expect(first.rows.length).toBe(first.present.length);
    const known = new Map(first.present.map((f) => [f.path, { size: f.size, mtime: f.mtime }]));
    const again = await scanMachine(m, { known });
    expect(again.rows).toEqual([]);
    // the same Claude Code id in two folders gives two different fingerprints
    const b = first.rows.filter((r) => r.info?.id === OWNER.claudeB).map((r) => r.info!.fingerprint);
    expect(new Set(b).size).toBe(2);
  });

  test('the learning view: labelled rows, secret file reads and private spans left out', () => {
    const c = convertClaudeCode(readFileSync(h.path('claudeA')));
    const w = renderWindows(c.messages);
    expect(w).toHaveLength(1);
    const t = w[0].text;
    expect(t).toContain('[user] Set up the contact form on the portfolio site.');
    expect(t).toContain('[agent notice] <task-notification>Background command');
    expect(t).toContain('[tool] Grep(nodemailer)');
    expect(t).not.toContain('RESEND_API_KEY');
    expect(t).not.toContain('re_FakeKeyForTests');
    expect(t).not.toContain('bank pin');
    expect(t).not.toContain('This session is being continued');
  });

  test('windows split on prompt boundaries under the cap', () => {
    const many: ImportedMessage[] = [];
    for (let i = 0; i < 40; i++) {
      many.push({ role: 'user', kind: 'normal', content: [{ type: 'text', text: `prompt ${i} ${'word '.repeat(200)}` }], createdAt: i, meta: { origin: 'human', external: { source: 'codex', id: `u${i}` } } });
      many.push({ role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `answer ${i} ${'more '.repeat(200)}` }], createdAt: i, meta: { external: { source: 'codex', id: `a${i}` } } });
    }
    const w = renderWindows(many, 2_000);
    expect(w.length).toBeGreaterThan(5);
    for (const x of w) {
      expect(x.tokens).toBeLessThanOrEqual(2_000);
      expect(x.text.startsWith('[user] prompt')).toBe(true);
    }
  });
});
