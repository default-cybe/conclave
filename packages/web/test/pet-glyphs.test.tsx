/**
 * The pet and the agent glyphs (docs/design/CHAT-AND-MOTION.md 1.11): which
 * glyph an agent type gets, the glyph and pet state of a call or a run, that
 * only three running rows move, the --dur-blink token, and that reduced
 * motion and `still` draw the key pose (data-still drops every animation).
 *
 *   bun test packages/web/test/pet-glyphs.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Route, useRouter, type Parser } from 'wouter';
import type { WorkflowCall, WorkflowRun } from '@conclave/core/client';
import { pageKey } from '../src/App';
import { callOrder, stateOf } from '../src/features/workflows/CallRows';
import { shared, useLiveSlot } from '../src/components/motion/useReducedMotion';
import { AgentGlyph } from '../src/components/motion/AgentGlyph';
import { Pet } from '../src/components/motion/Pet';
import { GLYPH_KINDS, GLYPH_PATHS, PET_STATES, busiestKind, glyphKind, glyphState, petState, stillRows } from '../src/components/motion/agentGlyphs';
import { DUR } from '../src/components/motion/tokens';
import { petFor } from '../src/features/workflows/words';

describe('agent type to glyph', () => {
  test('every kind maps to itself, in any case', () => {
    for (const k of GLYPH_KINDS) expect(glyphKind(k.toUpperCase())).toBe(k);
  });

  test('the types the workflows use map to their job; unknown ones are general-purpose', () => {
    expect(glyphKind('web-searcher')).toBe('researcher');
    expect(glyphKind('fact-checker')).toBe('verifier');
    expect(glyphKind('synthesizer')).toBe('general-purpose');
    expect(glyphKind('Explore')).toBe('explore');
    expect(glyphKind('something-new')).toBe('general-purpose');
    expect(glyphKind(undefined)).toBe('general-purpose');
  });

  test('every kind has one stroke', () => {
    for (const k of GLYPH_KINDS) expect(GLYPH_PATHS[k]).toMatch(/^M/);
  });
});

describe('state', () => {
  test('call states', () => {
    expect(glyphState('running')).toBe('running');
    expect(glyphState('running', true)).toBe('waiting');
    expect(glyphState('parked')).toBe('waiting');
    // queued has not started: it holds dim, never the done stroke
    expect(glyphState('queued')).toBe('waiting');
    expect(glyphState('failed')).toBe('failed');
    expect(glyphState('done')).toBe('done');
    expect(glyphState('cached')).toBe('done');
    expect(glyphState('skipped')).toBe('done');
  });

  test('pet pose from the kind of work, or the state', () => {
    expect(petState('researcher')).toBe('researching');
    expect(petState('tester')).toBe('testing');
    expect(petState('reviewer')).toBe('reviewing');
    expect(petState('builder')).toBe('building');
    expect(petState(undefined)).toBe('thinking');
    expect(petState('builder', 'waiting')).toBe('waiting');
    expect(petState('builder', 'failed')).toBe('failed');
  });

  test('the busiest kind wins, ties go to the first', () => {
    expect(busiestKind(['web-searcher', 'tester', 'researcher'])).toBe('researcher');
    expect(busiestKind(['tester', 'reviewer'])).toBe('tester');
    expect(busiestKind([])).toBeUndefined();
  });

  test('a run: its state first, then what most running agents do', () => {
    const run = (status: WorkflowRun['status']) => ({ status }) as WorkflowRun;
    const call = (agentType: string, p: Partial<WorkflowCall> = {}) => ({ kind: 'agent', state: 'running', agentType, ...p }) as WorkflowCall;
    expect(petFor(run('waiting_reset'), [])).toBe('parked');
    expect(petFor(run('paused'), [])).toBe('waiting');
    expect(petFor(run('done'), [])).toBe('done');
    expect(petFor(run('failed'), [])).toBe('failed');
    expect(petFor(run('stopped'), [])).toBe('idle');
    expect(petFor(run('running'), [call('web-searcher'), call('fact-checker'), call('web-searcher')])).toBe('researching');
    expect(petFor(run('running'), [call('tester', { waiting: 'approval' })])).toBe('waiting');
    expect(petFor(run('running'), [])).toBe('thinking');
  });

  test('only the first three running rows move', () => {
    expect(stillRows(['running', 'done', 'running', 'running', 'running', 'waiting'])).toEqual([false, true, false, false, true, true]);
  });

  test('a workflow call row: queued waits, stopped with the run is done', () => {
    const c = (p: Partial<WorkflowCall>) => ({ kind: 'agent', ...p }) as WorkflowCall;
    expect(stateOf(c({ state: 'queued' }))).toBe('waiting');
    expect(stateOf(c({ state: 'running', waiting: 'approval' }))).toBe('waiting');
    expect(stateOf(c({ state: 'failed', error: 'the run was stopped' }))).toBe('done');
  });

  test('the three moving call rows are the first three drawn, children under their workflow', () => {
    const c = (seq: number, p: Partial<WorkflowCall> = {}) => ({ seq, kind: 'agent', state: 'running', ...p }) as WorkflowCall;
    // calls arrive in seq order; 4 and 5 are the workflow's own and draw under it, before 2 and 3
    const calls = [c(0, { kind: 'workflow' }), c(2), c(3), c(4, { parentSeq: 0 }), c(5, { parentSeq: 0 })];
    const shown = callOrder(calls);
    expect(shown.map((x) => x.seq)).toEqual([0, 4, 5, 2, 3]);
    expect(stillRows(shown.map(stateOf))).toEqual([false, false, false, true, true]);
  });
});

describe('the page fade key', () => {
  const Home = () => null;
  const Inbox = () => null;
  const Chat = () => null;
  const routes = [
    <Route key="1" path="/" component={Home} />,
    <Route key="2" path="/chat/:id?" component={Chat} />,
    <Route key="3" path="/approvals" component={Inbox} />,
    <Route key="4" path="/inbox" component={Inbox} />,
    <Route key="5" path="/shares/:id?">
      <i />
    </Route>,
    <Route key="6">
      <i />
    </Route>,
  ];
  let parser!: Parser;
  const Grab = () => {
    parser = useRouter().parser;
    return null;
  };
  renderToStaticMarkup(<Grab />);
  const key = (path: string) => pageKey(routes, path, parser);

  test('two paths of one page share a key, so the page keeps its state', () => {
    expect(key('/inbox')).toBe(key('/approvals'));
    expect(key('/chat/a')).toBe(key('/chat/b'));
    expect(key('/shares')).toBe(key('/shares/x'));
  });

  test('another page gets another key', () => {
    const keys = ['/', '/chat', '/inbox', '/shares', '/nowhere'].map(key);
    expect(new Set(keys).size).toBe(5);
  });
});

describe('one observer for every mark, and the live cap outside a list', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  beforeAll(() => {
    const { parseHTML } = createRequire(join(import.meta.dir, '../../core/package.json'))('linkedom');
    const dom = parseHTML('<!doctype html><html><body></body></html>');
    const g = globalThis as Record<string, unknown>;
    for (const k of GLOBALS) saved[k] = g[k];
    g.window = dom.window;
    g.document = dom.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const k of GLOBALS) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  });

  test('shared: the source starts for the first subscriber and stops after the last', () => {
    let starts = 0;
    let stops = 0;
    let emit = () => {};
    const sub = shared((e) => {
      starts++;
      emit = e;
      return () => stops++;
    });
    const heard: number[] = [];
    const offs = [1, 2, 3].map((n) => sub(() => heard.push(n)));
    emit();
    expect(starts).toBe(1);
    expect(heard).toEqual([1, 2, 3]);
    offs[0]();
    offs[1]();
    expect(stops).toBe(0);
    offs[2]();
    offs[2]();
    expect(stops).toBe(1);
  });

  test('only the first LIVE_ROWS live lines move; one leaving frees its slot', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const Row = ({ live }: { live: boolean }) => <i data-still={useLiveSlot(live) ? '' : undefined} />;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const draw = (lives: boolean[]) => act(async () => root.render(lives.map((l, i) => <Row key={i} live={l} />)));
    const still = () => [...host.querySelectorAll('i')].map((el) => el.hasAttribute('data-still'));
    await draw([true, false, true, true, true, true]);
    expect(still()).toEqual([false, false, false, false, true, true]);
    await draw([false, false, true, true, true, true]);
    expect(still()).toEqual([false, false, false, false, false, true]);
    await act(async () => root.unmount());
  });
});

describe('render', () => {
  test('decorative unless labelled', () => {
    expect(renderToStaticMarkup(<Pet state="idle" />)).toContain('aria-hidden="true"');
    const named = renderToStaticMarkup(<Pet state="waiting" label="Waiting on you" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Waiting on you"');
    expect(renderToStaticMarkup(<AgentGlyph type="tester" />)).toContain('aria-hidden="true"');
  });

  test('every pet state renders its pose, sized 24 to 64', () => {
    for (const s of PET_STATES) expect(renderToStaticMarkup(<Pet state={s} />)).toContain(`data-state="${s}"`);
    expect(renderToStaticMarkup(<Pet size={8} />)).toContain('width="24"');
    expect(renderToStaticMarkup(<Pet size={200} />)).toContain('width="64"');
  });

  test('the key poses: 3 blocks drawn (CSS hides the third), 3 ticks, 3 zs', () => {
    expect(renderToStaticMarkup(<Pet state="building" />).match(/p-block/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<Pet state="testing" />).match(/p-tick/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<Pet state="parked" />).match(/p-z/g)).toHaveLength(3);
  });

  test('reduced motion (the server render reads it as on) and still draw the key pose', () => {
    // useReducedMotion answers true without a window, as on a first paint under reduce
    expect(renderToStaticMarkup(<Pet state="researching" />)).toContain('data-still=""');
    expect(renderToStaticMarkup(<AgentGlyph type="builder" state="running" />)).toContain('data-still=""');
  });

  test('done glyphs have no light; the others keep it', () => {
    expect(renderToStaticMarkup(<AgentGlyph type="tester" state="done" />)).not.toContain('g-light');
    expect(renderToStaticMarkup(<AgentGlyph type="tester" state="failed" />)).toContain('g-light');
    expect(renderToStaticMarkup(<AgentGlyph type="nope" />)).toContain('data-kind="general-purpose"');
  });
});

describe('css', () => {
  const motion = readFileSync(new URL('../src/styles/motion.css', import.meta.url), 'utf8');
  const pet = readFileSync(new URL('../src/styles/pet.css', import.meta.url), 'utf8');

  test('--dur-blink mirrors tokens.ts', () => {
    expect(Number(/--dur-blink:\s*(\d+)ms/.exec(motion)?.[1])).toBe(DUR.blink);
  });

  test('still drops every animation; paused holds them', () => {
    expect(pet).toMatch(/\[data-still\] \*\s*\{\s*animation: none !important;/);
    expect(motion).toMatch(/\[data-paused\] \*\s*\{\s*animation-play-state: paused;/);
  });

  test('the key poses are the base styles: 2 blocks, ticks drawn, the light 3/4 along', () => {
    expect(pet).toMatch(/\.p-block:nth-of-type\(3\) \{\s*opacity: 0;/);
    expect(pet).toMatch(/\.p-tick \{[^}]*stroke-dashoffset: 0;/);
    expect(pet).toMatch(/\.g-light \{[^}]*stroke-dashoffset: 36;/);
  });

  test('only motion tokens time the animations (the blink cycle aside)', () => {
    for (const m of pet.matchAll(/animation: (?!none)[\w-]+ ([^ ;]+)/g)) if (!m[1].startsWith('15.9s')) expect(m[1]).toMatch(/^(var\(--|calc\()/);
  });
});
