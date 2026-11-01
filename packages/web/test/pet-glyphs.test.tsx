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
import { reducedNow, shared, useLiveSlot } from '../src/components/motion/useReducedMotion';
import { scrollBehavior } from '../src/features/extensions/hooks/model';
import { AgentGlyph } from '../src/components/motion/AgentGlyph';
import { Pet } from '../src/components/motion/Pet';
import { GLYPH_KINDS, GLYPH_PATHS, PET_STATES, busiestKind, glyphKind, glyphState, petState, sessionPet, stillRows } from '../src/components/motion/agentGlyphs';
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

  test("a chat's status: waiting on you, asleep until the reset, failed; the rest draw no pet", () => {
    expect(sessionPet('waiting_approval')).toBe('waiting');
    expect(sessionPet('waiting_input')).toBe('waiting');
    expect(sessionPet('waiting_reset')).toBe('parked');
    expect(sessionPet('error')).toBe('failed');
    for (const s of ['running', 'idle', 'stopped', undefined]) expect(sessionPet(s)).toBeUndefined();
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

  test('the face says the state: dot eyes while awake, shut asleep, ^^ done with 2 sparkles, a fault frown failed', () => {
    expect(renderToStaticMarkup(<Pet state="idle" />).match(/class="p-eye"/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<Pet state="parked" />)).not.toContain('p-eye');
    const done = renderToStaticMarkup(<Pet state="done" />);
    expect(done).not.toContain('p-eye');
    expect(done.match(/p-spark/g)).toHaveLength(2);
    const failed = renderToStaticMarkup(<Pet state="failed" />);
    expect(failed).toContain('p-face p-fault');
    expect(failed).toContain('p-drop');
    // the arm and its prop only for jobs that hold one
    for (const s of ['researching', 'building', 'waiting'] as const) expect(renderToStaticMarkup(<Pet state={s} />)).toContain('p-swing');
    expect(renderToStaticMarkup(<Pet state="idle" />)).not.toContain('p-swing');
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

describe('Appearance > Reduce motion over the system setting', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, matchMedia: g.matchMedia };
  // the system asks to reduce, as Windows with Animation effects off does
  const matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  const withMotion = (motion: string | undefined, fn: () => void) => {
    g.window = { matchMedia };
    g.matchMedia = matchMedia;
    g.document = { documentElement: { dataset: motion ? { motion } : {} } };
    try {
      fn();
    } finally {
      Object.assign(g, saved);
    }
  };

  test('Off (full) keeps motion, On (reduce) and System under reduce stop it', () => {
    withMotion('full', () => {
      expect(reducedNow()).toBe(false);
      expect(scrollBehavior()).toBe('smooth');
    });
    withMotion('reduce', () => {
      expect(reducedNow()).toBe(true);
      expect(scrollBehavior()).toBe('auto');
    });
    withMotion(undefined, () => {
      expect(reducedNow()).toBe(true);
      expect(scrollBehavior()).toBe('auto');
    });
  });

  test('the CSS reduce rules skip html[data-motion=full]', () => {
    const index = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
    expect(index).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^{]*:root:not\(\[data-motion='full'\]\) \*/);
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
    expect(motion).toMatch(/\[data-paused\] \*\s*\{\s*animation-play-state: paused !important;/);
  });

  test('off screen every pet and glyph animation computes to paused, whatever its own rule says', () => {
    // a small cascade: the style rules of motion.css then pet.css (index.css order), !important first, then specificity, then order
    const req = createRequire(createRequire(join(import.meta.dir, '../../core/package.json')).resolve('linkedom'));
    const cssom = req('cssom');
    const what = createRequire(req.resolve('css-select'))('css-what');
    type Sel = { type: string; name?: string; data?: unknown };
    const spec = (seq: Sel[]): number =>
      seq.reduce((n, t) => {
        if (t.type === 'pseudo' && Array.isArray(t.data)) return n + Math.max(...(t.data as Sel[][]).map(spec));
        if (t.type === 'attribute' || t.type === 'pseudo') return n + (t.name === 'id' ? 10_000 : 100);
        return n + (t.type === 'tag' || t.type === 'pseudo-element' ? 1 : 0);
      }, 0);
    const rules = [motion, pet].flatMap((src) => [...cssom.parse(src).cssRules].filter((r: { selectorText?: string; style?: CSSStyleDeclaration }) => r.selectorText && (r.style!.getPropertyValue('animation') || r.style!.getPropertyValue('animation-play-state'))));
    const playState = (el: Element) => {
      let best: { imp: boolean; spec: number; i: number; v: string } | undefined;
      let moves = false;
      rules.forEach((r: { selectorText: string; style: { getPropertyValue(p: string): string; getPropertyPriority(p: string): string } }, i: number) => {
        for (const sel of what.parse(r.selectorText) as Sel[][]) {
          if (sel.some((t) => t.type === 'pseudo-element') || !el.matches(what.stringify([sel]))) continue;
          for (const p of ['animation', 'animation-play-state']) {
            const v = r.style.getPropertyValue(p);
            if (!v) continue;
            if (p === 'animation' && v !== 'none') moves = true;
            // the shorthand resets the play state to running unless it names one
            const cand = { imp: r.style.getPropertyPriority(p) === 'important', spec: spec(sel), i, v: /\bpaused\b/.test(v) ? 'paused' : 'running' };
            if (!best || cand.imp > best.imp || (cand.imp === best.imp && (cand.spec > best.spec || (cand.spec === best.spec && cand.i >= best.i)))) best = cand;
          }
        }
      });
      return moves ? best?.v : undefined;
    };
    const { parseHTML } = req('linkedom');
    const html = [...PET_STATES.map((s) => renderToStaticMarkup(<Pet state={s} />)), ...GLYPH_KINDS.map((k) => renderToStaticMarkup(<AgentGlyph type={k} state="running" />))].join('');
    const { document: doc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const seen = new Set<string>();
    for (const svg of doc.querySelectorAll('svg')) {
      // as on screen and moving, then scrolled away
      svg.removeAttribute('data-still');
      svg.setAttribute('data-paused', '');
      for (const el of svg.querySelectorAll('*')) {
        const st = playState(el);
        if (st === undefined) continue;
        seen.add(`${svg.getAttribute('data-state')} ${el.getAttribute('class')}`);
        expect(`${svg.getAttribute('data-state')} ${el.getAttribute('class')} ${st}`).toBe(`${svg.getAttribute('data-state')} ${el.getAttribute('class')} paused`);
      }
    }
    // waiting's wave, parked's sleep, researching's follow and a glyph's light among them
    for (const k of ['waiting p-swing p-warn', 'parked p-body', 'researching p-look', 'running g-light']) expect([...seen]).toContain(k);
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
