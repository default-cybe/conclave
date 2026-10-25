/**
 * The pure half of the pet and the agent glyphs (docs/design/CHAT-AND-MOTION.md
 * 1.11): which glyph an agent type gets, which glyph state a call or task is
 * in, which pet pose that is, and the strokes, all on a 16 (glyph) or 32x24
 * (pet) grid. No React here, so the tests can read it.
 */
import { KNOT_PIECES } from '../brand/knotGeometry';

export type GlyphKind = 'explore' | 'researcher' | 'builder' | 'tester' | 'reviewer' | 'debugger' | 'designer' | 'verifier' | 'general-purpose' | 'workflow' | 'delegate';
export type GlyphState = 'running' | 'done' | 'failed' | 'waiting';
export type PetState = 'idle' | 'thinking' | 'researching' | 'building' | 'testing' | 'reviewing' | 'waiting' | 'parked' | 'done' | 'failed';

export const GLYPH_KINDS: readonly GlyphKind[] = ['explore', 'researcher', 'builder', 'tester', 'reviewer', 'debugger', 'designer', 'verifier', 'general-purpose', 'workflow', 'delegate'];
export const PET_STATES: readonly PetState[] = ['idle', 'thinking', 'researching', 'building', 'testing', 'reviewing', 'waiting', 'parked', 'done', 'failed'];

/** Agent types seen in the wild that are another glyph's job (mock/workflows.ts). */
const ALIAS: Record<string, GlyphKind> = {
  'web-searcher': 'researcher',
  research: 'researcher',
  searcher: 'researcher',
  explorer: 'explore',
  'fact-checker': 'verifier',
  verify: 'verifier',
  test: 'tester',
  review: 'reviewer',
  'code-reviewer': 'reviewer',
  build: 'builder',
  coder: 'builder',
  debug: 'debugger',
  design: 'designer',
  synthesizer: 'general-purpose',
};

/** The glyph for an agent type ("Explore", "web-searcher", undefined). Unknown types draw general-purpose. */
export function glyphKind(agentType?: string): GlyphKind {
  const t = (agentType ?? '').trim().toLowerCase();
  if ((GLYPH_KINDS as readonly string[]).includes(t)) return t as GlyphKind;
  return ALIAS[t] ?? 'general-purpose';
}

/** A workflow call's or a subagent's state, as the glyph says it. Queued holds dim like waiting; anything not live or failed is done. */
export function glyphState(state: string, waiting?: boolean): GlyphState {
  if (waiting || state === 'parked' || state === 'waiting' || state === 'queued') return 'waiting';
  if (state === 'running') return 'running';
  if (state === 'failed' || state === 'error') return 'failed';
  return 'done';
}

const KIND_POSE: Record<GlyphKind, PetState> = {
  explore: 'researching',
  researcher: 'researching',
  builder: 'building',
  designer: 'building',
  debugger: 'building',
  tester: 'testing',
  verifier: 'testing',
  reviewer: 'reviewing',
  'general-purpose': 'thinking',
  workflow: 'building',
  delegate: 'thinking',
};

/** The pet's pose for the busiest kind of work, or for a state that is not work. */
export function petState(kind: GlyphKind | undefined, state: GlyphState = 'running'): PetState {
  if (state === 'waiting') return 'waiting';
  if (state === 'failed') return 'failed';
  if (state === 'done') return 'done';
  return kind ? KIND_POSE[kind] : 'thinking';
}

/** The kind most of the running agents are ("busiest"); ties go to the first seen. */
export function busiestKind(agentTypes: readonly (string | undefined)[]): GlyphKind | undefined {
  const n = new Map<GlyphKind, number>();
  let best: GlyphKind | undefined;
  for (const t of agentTypes) {
    const k = glyphKind(t);
    n.set(k, (n.get(k) ?? 0) + 1);
    if (!best || n.get(k)! > n.get(best)!) best = k;
  }
  return best;
}

/** At most this many list rows animate at once (CHAT-AND-MOTION 1.9); the rest draw their still frame. */
export const LIVE_ROWS = 3;

/** For each row, whether it stays still: only the first LIVE_ROWS running rows move. */
export function stillRows(states: readonly GlyphState[]): boolean[] {
  let live = 0;
  return states.map((s) => !(s === 'running' && live++ < LIVE_ROWS));
}

/** Where the light rests under reduced motion and in a held state: about 3/4 along (dashoffset on a 100 long path). */
export const GLYPH_LIGHT = { length: 22, still: 36 } as const;

const R = (n: number) => Math.round(n * 100) / 100;

/** The Knot's path as one closed loop, mapped into a box (every `step`th point). */
export function knotLoop(x: number, y: number, w: number, h: number, step = 3): string {
  const pts: string[] = [];
  for (const p of KNOT_PIECES) {
    const all = [...p.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)];
    all.forEach((m, i) => {
      if (i % step && i !== all.length - 1) return;
      // the knot sits in 10..54 by 11.65..52.37 of its 64 box
      pts.push(`${R(x + ((+m[1] - 10) / 44) * w)} ${R(y + ((+m[2] - 11.65) / 40.72) * h)}`);
    });
  }
  return `M${pts.join(' L')}Z`;
}

/** One stroke per kind on a 16 grid, each built on a loop or the knot. */
export const GLYPH_PATHS: Record<GlyphKind, string> = {
  // a loop, then a tail that walks out to the right
  explore: 'M8 8 A3 3 0 1 1 2 8 A3 3 0 1 1 8 8 C9.5 8 9.5 5 11.5 5 S13.5 9 15 9',
  // the loop is a lens, the tail its handle
  researcher: 'M9.3 9.3 A4 4 0 1 1 3.7 3.7 A4 4 0 1 1 9.3 9.3 L14 14',
  // a turn of the knot that closes into a square block
  builder: 'M2 10 C2 4 8 4 7 8.5 C6.5 11 3 10.5 4.5 8.5 L9 8.5 L14 8.5 L14 13.5 L9 13.5 L9 8.5',
  // a loop that ends in a tick
  tester: 'M5 11 C1.5 11 1.5 5 5 5 C8 5 8 8.5 6.5 9.5 L9 12 L14.5 4.5',
  // two linked loops, the bridge between them
  reviewer: 'M6.5 9 A2.75 2.75 0 1 0 1 9 A2.75 2.75 0 1 0 6.5 9 Q8 7.2 9.5 9 A2.75 2.75 0 1 0 15 9 A2.75 2.75 0 1 0 9.5 9',
  // a figure 8 with a break before it closes
  debugger: 'M8 8 C11 5 13.5 5.5 13.5 8 C13.5 10.5 11 11 8 8 C5 5 2.5 5.5 2.5 8 C2.5 10.5 5 11 6.9 9.3',
  // an open curve that ends in a pen nib
  designer: 'M1.5 13 C4.5 5 8 13.5 11 6 L13.5 2.5 L14.5 5.5 L11 6',
  // one closed loop
  verifier: 'M8 2.5 A5.5 5.5 0 1 1 7.99 2.5Z',
  // the small trefoil: the Knot's own path
  'general-purpose': knotLoop(1.5, 2, 13, 12),
  // three loops on a rail
  workflow: 'M0.5 12 L3.5 12 C5.7 12 5.7 6.5 3.5 6.5 C1.3 6.5 1.3 12 3.5 12 L8 12 C10.2 12 10.2 6.5 8 6.5 C5.8 6.5 5.8 12 8 12 L12.5 12 C14.7 12 14.7 6.5 12.5 6.5 C10.3 6.5 10.3 12 12.5 12 L15.5 12',
  // a loop that throws a line to the right
  delegate: 'M7.5 8 A3 3 0 1 0 1.5 8 A3 3 0 1 0 7.5 8 L14.5 8 L12 5.5',
};

/** How the light moves on each kind while it runs. */
export const GLYPH_MOTION: Record<GlyphKind, 'travel' | 'draw' | 'hop' | 'tighten'> = {
  explore: 'travel',
  researcher: 'travel',
  builder: 'draw',
  tester: 'draw',
  reviewer: 'travel',
  debugger: 'draw',
  designer: 'draw',
  verifier: 'tighten',
  'general-purpose': 'travel',
  workflow: 'hop',
  delegate: 'travel',
};

/** The pet's body, a squat trefoil "bean" from the Knot's loop, in its 32x24 box. */
export const PET_BODY = knotLoop(4, 3, 24, 14);
