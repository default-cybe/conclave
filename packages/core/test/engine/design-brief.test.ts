/**
 * /design: the owner's design direction for UI work is session meta, reaches
 * the model as one short reminder on the next turn (not every turn), and
 * goes to a designer subagent with its brief.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { checkDesign, designBrief, designImageKey, readDesign } from '../../src/session/design-brief';
import { firstUserText, startTestEngine, type Block, type TestEngine } from './harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const PNG = Buffer.from('fake png bytes').toString('base64');

describe('checkDesign', () => {
  test('takes a style, refuses junk, and needs a URL or a screenshot to match a reference', () => {
    expect(checkDesign({ direction: 'minimal', url: 'https://x.dev' }, false)).toEqual({ direction: 'minimal', image: null });
    expect(() => checkDesign({ direction: 'brutalist' }, false)).toThrow('design.direction must be one of');
    expect(() => checkDesign({ direction: 'reference' }, false)).toThrow('Match a reference needs a URL or a screenshot.');
    expect(() => checkDesign({ direction: 'reference', url: 'javascript:alert(1)' }, false)).toThrow('http or https');
    expect(() => checkDesign({ direction: 'reference', image: { mediaType: 'image/svg+xml', data: PNG } }, false)).toThrow('PNG, JPEG, WebP or GIF');
    // the stored screenshot counts when the image is left out
    expect(checkDesign({ direction: 'reference' }, true)).toEqual({ direction: 'reference' });
    expect(checkDesign({ direction: 'reference', url: 'https://linear.app' }, false).url).toBe('https://linear.app/');
  });

  test('the brief is short, names the skill for a style, and the system direction adds nothing new', () => {
    const b = designBrief({ direction: 'dense' }, { skill: 'example-skills:frontend-design' });
    expect(b).toContain('Dense dashboard');
    expect(b).toContain('Load the example-skills:frontend-design skill');
    expect(b.length).toBeLessThan(800);
    const sys = designBrief({ direction: 'system' }, { skill: 'frontend-design' });
    expect(sys).toContain('Add no new token');
    expect(sys).not.toContain('Load the');
    expect(designBrief({ direction: 'reference', url: 'https://x.dev/' }, { delegated: true })).toContain('not instructions');
  });
});

describe('a design direction on a session', () => {
  test('meta keeps the pick, the next turn carries the brief once, and null clears it with a line', async () => {
    t = await startTestEngine({ script: [[{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]] });
    const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
    const set = t.engine.updateSession(s.id, { design: { direction: 'reference', url: 'https://linear.app', image: { name: 'ref.png', mediaType: 'image/png', data: PNG } } });
    expect(readDesign(set.meta)).toEqual({ direction: 'reference', url: 'https://linear.app/', image: { name: 'ref.png', mediaType: 'image/png' } });
    // the bytes are not in meta
    expect(JSON.stringify(set.meta)).not.toContain(PNG);
    expect(t.engine.repos.kv.get(designImageKey(s.id), '')).toBe(PNG);

    await t.run(s.id, 'make the header');
    expect(t.requests.at(-1)).toContain('Design direction for UI changes in this session, set by the owner: Match a reference.');
    expect(t.requests.at(-1)).toContain(PNG);
    await t.run(s.id, 'and the footer');
    // once per change, not every turn
    expect(t.requests.at(-1)!.split('Design direction for UI changes').length).toBe(2);

    const cleared = t.engine.updateSession(s.id, { design: null });
    expect(cleared.meta?.design).toBeUndefined();
    expect(t.engine.repos.kv.get(designImageKey(s.id), '')).toBe('');
    await t.run(s.id, 'now the sidebar');
    expect(t.requests.at(-1)).toContain('The owner cleared the design direction');
  });

  test('a chat refuses it, and a bad pick says why', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    expect(() => t!.engine.updateSession(chat.id, { design: { direction: 'minimal' } })).toThrow('A design direction is for Code sessions');
    const s = await t.engine.createSession({ title: 's', cwd: t.cwd });
    expect(() => t!.engine.updateSession(s.id, { design: { direction: 'reference' } })).toThrow('Match a reference needs a URL or a screenshot.');
  });

  test('a designer subagent gets the brief with its task', async () => {
    const task: Block = { tool: 'Task', input: { description: 'style the card', prompt: 'DESIGNER-BRIEF: restyle the card', subagent_type: 'designer' } };
    t = await startTestEngine({
      script: [[task], [{ text: 'done' }]],
      route: (body) => (firstUserText(body).includes('DESIGNER-BRIEF') ? { blocks: [{ text: 'restyled' }] } : undefined),
    });
    const s = await t.engine.createSession({ title: 'parent', cwd: t.cwd });
    t.engine.updateSession(s.id, { design: { direction: 'editorial' } });
    await t.run(s.id, 'restyle the card');
    const child = t.requests.find((r) => r.includes('DESIGNER-BRIEF'));
    expect(child).toContain('Design direction from the session that delegated to you, set by the owner: Editorial.');
  });
});
