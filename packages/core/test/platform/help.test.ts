import { afterEach, describe, expect, test } from 'bun:test';
import { HELP_DOCS, helpDocs, indexSections, splitSections } from '../../src/platform/docs';
import { ConclaveHelpTool, setHelpDocs } from '../../src/tools/conclave-help';
import { fakeHost, makeCtx } from '../tools/helpers';

const INSTALL = `# Installing Conclave

How to put the hub on a server.

## 4. Subscriptions

Sign in to Claude, ChatGPT and Google plans through CLIProxyAPI.

### Accounts and their order

Add a second Claude account in Settings > Models > Subscriptions, then set the order in Accounts. Plans go before API keys.

\`\`\`sh
# Docker: docker compose exec hub conclave remote quick
conclave models accounts
\`\`\`

## 15. The hub's browser

Settings > Browser installs Chromium or CloakBrowser. A proxy is used only when the owner asks for one, with a country.
`;

const DESIGN = `# Conclave design log

## 47. Refusal fallback

A refused turn goes to the next model in the owner's list.

## 42. The hub's browser

The proxy, only when asked: the browser tools take a proxy input.
`;

afterEach(() => setHelpDocs(undefined));

const ctx = () => makeCtx({ cwd: '/', host: fakeHost() });
const text = (o: { content: unknown }) => String(o.content);

describe('the docs index', () => {
  test('splits at ## and ###, skips headings in code blocks, keeps a path and a unique id', () => {
    const s = splitSections('INSTALL.md', INSTALL);
    expect(s.map((x) => x.id)).toEqual(['INSTALL.md#installing-conclave', 'INSTALL.md#4-subscriptions', 'INSTALL.md#accounts-and-their-order', 'INSTALL.md#15-the-hub-s-browser']);
    expect(s[2].path).toBe('INSTALL.md > 4. Subscriptions > Accounts and their order');
    expect(s[2].text).toContain('# Docker: docker compose exec hub conclave remote quick');
    const dup = splitSections('X.md', '## Notes\n\none\n\n## Notes\n\ntwo\n');
    expect(dup.map((x) => x.id)).toEqual(['X.md#notes', 'X.md#notes-2']);
  });

  test('finds the section a question is about, and nothing for words it does not hold', () => {
    const idx = indexSections([
      { file: 'INSTALL.md', text: INSTALL, weight: 1.15 },
      { file: 'DESIGN.md', text: DESIGN },
    ]);
    expect(idx.search('how do I set up a second Claude account')[0].section.id).toBe('INSTALL.md#accounts-and-their-order');
    const proxy = idx.search('browser proxy country', 2).map((h) => h.section.id);
    expect(proxy).toEqual(['INSTALL.md#15-the-hub-s-browser', 'DESIGN.md#42-the-hub-s-browser']);
    expect(idx.search('refused turn next model')[0].section.id).toBe('DESIGN.md#47-refusal-fallback');
    expect(idx.search('xyzzy quux frobnicate')).toEqual([]);
    expect(idx.search('the and of')).toEqual([]);
    expect(idx.get('install.md#accounts-and-their-order')?.title).toBe('Accounts and their order');
    expect(idx.get('Accounts and their order')?.id).toBe('INSTALL.md#accounts-and-their-order');
    expect(idx.get('nope')).toBeUndefined();
  });

  test('the shipped docs load, and real questions land on the right page', async () => {
    const docs = await helpDocs();
    expect(docs.missing).toEqual([]);
    expect(new Set(docs.sections.map((s) => s.file))).toEqual(new Set(Object.keys(HELP_DOCS)));
    expect(new Set(docs.sections.map((s) => s.id)).size).toBe(docs.sections.length);
    const top = (q: string) => docs.search(q, 3).map((h) => h.section.id);
    expect(top('how do I set up a second Claude account')).toContain('INSTALL.md#accounts-and-their-order');
    // a browser proxy page comes first (EXTENSIONS or INSTALL); the exact order moves as the docs grow
    expect(top('browser proxy country')[0]).toMatch(/^(EXTENSIONS\.md#browser-proxy|INSTALL\.md#a-proxy-when-you-ask-for-one)$/);
    expect(top('refusal fallback safety priority').some((id) => /refusal-fallback/.test(id))).toBe(true);
    expect(top('Delegate hand work to code on another device').some((id) => id.startsWith('DESIGN.md#43'))).toBe(true);
    expect(docs.search('xyzzy quux frobnicate')).toEqual([]);
  });
});

describe('ConclaveHelp', () => {
  const fake = () => setHelpDocs(async () => indexSections([{ file: 'INSTALL.md', text: INSTALL }, { file: 'DESIGN.md', text: DESIGN }]));

  test('is read-only and returns the best sections with their ids', async () => {
    fake();
    expect(ConclaveHelpTool.readOnly).toBe(true);
    const out = await ConclaveHelpTool.run({ query: 'second Claude account' }, ctx());
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain('## INSTALL.md > 4. Subscriptions > Accounts and their order');
    expect(text(out)).toContain('id: INSTALL.md#accounts-and-their-order');
    expect(text(out)).toContain('Add a second Claude account in Settings > Models > Subscriptions');
    expect(out.meta?.hits).toBeGreaterThan(0);
    expect((out.meta?.sections as string[])[0]).toBe('INSTALL.md#accounts-and-their-order');
  });

  test('reads one section whole by its id', async () => {
    fake();
    const out = await ConclaveHelpTool.run({ section: 'DESIGN.md#47-refusal-fallback' }, ctx());
    expect(text(out)).toStartWith('DESIGN.md > 47. Refusal fallback\nid: DESIGN.md#47-refusal-fallback');
    expect(text(out)).toContain("A refused turn goes to the next model in the owner's list.");
    const wrong = await ConclaveHelpTool.run({ section: 'DESIGN.md#refusal' }, ctx());
    expect(text(wrong)).toContain('No section has the id "DESIGN.md#refusal". Close matches: DESIGN.md#47-refusal-fallback');
    expect(wrong.meta?.hits).toBe(0);
  });

  test('returns nothing when no section matches, and asks for a query when given none', async () => {
    fake();
    const none = await ConclaveHelpTool.run({ query: 'xyzzy quux frobnicate' }, ctx());
    expect(none.isError).toBeUndefined();
    expect(none.meta).toEqual({ hits: 0, sections: [] });
    expect(text(none)).toBe('Nothing in the Conclave docs matches "xyzzy quux frobnicate". Try other words, or the name of the page or feature.');
    const empty = await ConclaveHelpTool.run({}, ctx());
    expect(empty.isError).toBe(true);
  });

  test('says so when the hub carries no docs', async () => {
    setHelpDocs(async () => indexSections([], Object.keys(HELP_DOCS)));
    const out = await ConclaveHelpTool.run({ query: 'accounts' }, ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('not bundled with this hub');
  });

  test('on the shipped docs, the owner\'s question gets the accounts section', async () => {
    const out = await ConclaveHelpTool.run({ query: 'how do I set up a second Claude account' }, ctx());
    expect(text(out)).toContain('INSTALL.md#accounts-and-their-order');
    expect(text(out).length).toBeLessThan(9_000);
  });
});
