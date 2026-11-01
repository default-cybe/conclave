#!/usr/bin/env bun
/**
 * The Conclave mark, every asset from one file: docs/design/brand/knot.json.
 *
 *   bun scripts/brand/knot.ts                    write everything: code, SVG, Android XML, PNGs, Tauri icons
 *   bun scripts/brand/knot.ts --text             only the text files (code, SVG, XML, the desktop page, the website's knot)
 *   bun scripts/brand/knot.ts --only <dir>       the text files, and only the PNGs under <dir> (no Tauri icons)
 *   bun scripts/brand/knot.ts --check            exit 1 if a text file differs from what the JSON gives,
 *                                                or a PNG is missing or not its size
 *   bun scripts/brand/knot.ts --sheet out.png    also render a contact sheet of every icon, masks shown
 *
 * PNGs are drawn by Chromium through playwright-core (a dependency of
 * packages/core): CHROMIUM_PATH, else /opt/pw-browsers/chromium, else
 * Playwright's own. The Tauri icon set comes from packages/desktop's tauri
 * CLI (`bun run icons` there), then the small sizes are redrawn with the
 * heavier stroke. Re-running it reproduces the committed files.
 *
 * Drawing (docs/design/brand/README.md): six pieces in path order, under
 * and over by turns, each with its share of a 100 long path, split away
 * from the crossings. Layers: the under pieces, the light on them, three
 * halos (strokes in the color behind the mark, around each crossing), the
 * over pieces, the light on them. So the light passes under a strand where
 * the strand does.
 *
 * The rope (docs/design/KNOT-MOTION.md): the same pieces moved to 100 to 200
 * on a rope, the last one split where the rope starts, with a lead in and a
 * lead out. The script writes its paths and halos back into knot.json's
 * "rope" block and into both geometry files, so --check covers them too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = (p: string) => join(ROOT, p);

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

interface Piece {
  kind: 'under' | 'over';
  from: number;
  length: number;
  d: string;
}
interface Span {
  from: number;
  length: number;
}
interface RopePath {
  id: string;
  kind: 'lead' | 'under' | 'over';
  from: number;
  length: number;
  d: string;
}
interface RopeHalo {
  on: string;
  from: number;
  length: number;
  d: string;
}
/** A moment that moves the rope: w goes from `from` to `to` in `move` ms (ease in out cubic, or x^easeIn). */
interface RopeTimes {
  from: number;
  to: number;
  fade?: number;
  straight?: number;
  move: number;
  easeIn?: number;
  cinch?: number;
  lapAt?: number;
  lap?: number;
  wordAt?: number;
  word?: number;
}
interface Rope {
  about: string[];
  leadIn: { from: number };
  leadOut: { length: number; dip: [number, number, number]; y: number };
  light: { length: number };
  camera: { view: [number, number]; pad: [number, number]; smooth: number; steps: number };
  moments: {
    launch: RopeTimes;
    launchLong: RopeTimes;
    receive: RopeTimes;
    send: RopeTimes;
    run: { loop: number; length: number; light: number; from: number };
    success: {
      spin: number;
      laps: number;
      ease: [number, number, number, number];
      cinchAt: number;
      cinch: number;
      trail: { length: number; back: number; opacity: number; in: [number, number]; out: [number, number] };
    };
    cinch: { at: number[]; scale: number[] };
    word: { rise: number };
  };
}
interface Knot {
  box: number;
  length: number;
  curve: { scale: number; shiftY: number; start: number; origin: [number, number] };
  rope: Rope;
  pieces: Piece[];
  halos: Array<{ over: number; from: number; length: number; d: string }>;
  stroke: { width: number; halo: number; small: { upTo: number; width: number; halo: number } };
  light: {
    brand: Span;
    thinking: { loop: number; turn: number; ease: [number, number, number, number]; still: number };
    tool: { loop: number; length: number };
    paused: Span;
  };
  icons: {
    colors: { tile: string; fg: string; light: string; mono: string };
    /** The knot on the light theme's ground: the light mark and the iPhone's light launch image. */
    colorsLight: { fg: string; light: string };
    /** The web app's page ground (--bg in packages/web/src/styles/index.css), behind the iPhone's launch image. */
    ground: { light: string; dark: string };
    radius: number;
    tile: number;
    favicon: number;
    maskable: number;
    badge: number;
    splash: number;
    android: { viewport: number; box: number };
    notification: { viewport: number; box: number };
  };
}

const KNOT_JSON = 'docs/design/brand/knot.json';
const K: Knot = JSON.parse(readFileSync(at(KNOT_JSON), 'utf8'));
const UNDERS = [0, 2, 4];
const OVERS = [1, 3, 5];
const points = (d: string) => [...d.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const n = (x: number) => String(Math.round(x * 1000) / 1000);

/**
 * Where the light [from, from + length) on the 100 long path falls on piece
 * p, in the piece's own length units: zero, one or two intervals (two when
 * the light wraps round the path's end onto the same piece).
 */
function lit(p: Piece, span: Span): Array<[number, number]> {
  const L = K.length;
  if (span.length <= 0) return [];
  if (span.length >= L) return [[0, p.length]];
  const out: Array<[number, number]> = [];
  for (const shift of [-L, 0, L]) {
    const a = Math.max(span.from + shift - p.from, 0);
    const b = Math.min(span.from + span.length + shift - p.from, p.length);
    if (b - a > 1e-3) out.push([a, b]);
  }
  return out;
}

/** The stroke widths for a knot drawn at px pixels (its 64 unit box). */
const widths = (px: number) => (px <= K.stroke.small.upTo ? { w: K.stroke.small.width, h: K.stroke.small.halo } : { w: K.stroke.width, h: K.stroke.halo });

// ---------------------------------------------------------------------------
// The rope (docs/design/KNOT-MOTION.md)
// ---------------------------------------------------------------------------

/** Where the knot starts on the rope: the knot is 100 to 200, the lead in before it, the lead out after. */
const ROPE_KNOT = 100;
const f2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

/** The knot's length in box units: the curve walked in fine steps (the 100 long path is this long). */
function knotBoxLength(): number {
  const { scale, shiftY, start } = K.curve;
  const at = (t: number) => [32 + scale * (Math.sin(t) + 2 * Math.sin(2 * t)), 32 + scale * (Math.cos(t) - 2 * Math.cos(2 * t) + shiftY)];
  const N = 40000;
  let total = 0;
  let [px, py] = at(start);
  for (let i = 1; i <= N; i++) {
    const [x, y] = at(start + (2 * Math.PI * i) / N);
    total += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return total;
}

const polyLength = (pts: number[][]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const polyD = (pts: number[][]) => 'M' + pts.map(([x, y]) => `${f2(x)} ${f2(y)}`).join(' L');

/**
 * The rope from the pieces: the six pieces moved to 100 to 200, the last one
 * split at the rope's start (the bottom of the right lobe) into k6 and k0, a
 * straight lead in from the right and a lead out that dips under the left
 * lobe and runs left. One position is the same length everywhere on it.
 */
function ropePaths(): { paths: RopePath[]; halos: RopeHalo[] } {
  const R = K.rope;
  const unit = knotBoxLength() / K.length;
  const [x0, y0] = K.curve.origin;
  const r = (x: number) => Math.round(x * 1000) / 1000;

  // the last piece runs past 100: split it where the rope starts
  const last = K.pieces[5];
  const tokens = last.d.slice(1).split(' L');
  const cut = tokens.findIndex((t) => {
    const [x, y] = t.split(' ').map(Number);
    return Math.hypot(x - x0, y - y0) < 0.011;
  });
  if (cut <= 0) throw new Error('knot.json: the last piece does not pass the curve origin');
  const k6: RopePath = { id: 'k6', kind: 'over', from: r(ROPE_KNOT + last.from), length: r(K.length - last.from), d: 'M' + tokens.slice(0, cut + 1).join(' L') };
  const k0: RopePath = { id: 'k0', kind: 'over', from: ROPE_KNOT, length: r(last.from + last.length - K.length), d: 'M' + tokens.slice(cut).join(' L') };
  const middle = K.pieces.slice(0, 5).map((p, i): RopePath => ({ id: `k${i + 1}`, kind: p.kind, from: r(ROPE_KNOT + p.from), length: p.length, d: p.d }));

  const leadInLength = ROPE_KNOT - R.leadIn.from;
  const leadIn: RopePath = { id: 'in', kind: 'lead', from: R.leadIn.from, length: leadInLength, d: polyD([[x0 + leadInLength * unit, y0], [x0, y0]]) };

  // the lead out: a cubic down to y under the left lobe, then straight left, long enough for its share
  const [c1, c2, c3] = R.leadOut.dip;
  const ctrl = [[x0, y0], [x0 - c1, y0], [x0 - c2, R.leadOut.y], [x0 - c3, R.leadOut.y]];
  const bez = (t: number) => {
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((k) => Number(f2(ctrl.reduce((s, c, i) => s + w[i] * c[k], 0))));
  };
  const steps = 28;
  const dip = Array.from({ length: steps + 1 }, (_, i) => bez(i / steps));
  const rest = R.leadOut.length * unit - polyLength(dip);
  const leadOut: RopePath = { id: 'out', kind: 'lead', from: ROPE_KNOT + K.length, length: R.leadOut.length, d: polyD([...dip, [dip[steps][0] - rest, R.leadOut.y]]) };

  const paths = [leadIn, k0, ...middle, k6, leadOut];
  const halos = K.halos.map((h): RopeHalo => {
    const from = r(ROPE_KNOT + h.from);
    const on = paths.find((p) => p.kind === 'over' && from >= p.from && from + h.length <= p.from + p.length);
    if (!on) throw new Error(`knot.json: halo at ${h.from} is not inside an over piece of the rope`);
    return { on: on.id, from, length: h.length, d: h.d };
  });
  return { paths, halos };
}

/** The rope's light: the rope's last `length`, so a tied rope has it at the still mark's home. */
const ropeLight = () => ({ length: K.rope.light.length, back: K.length - K.rope.light.length, home: ROPE_KNOT + K.light.brand.from });

/** One line JSON with spaces, the style of knot.json. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}

/** knot.json with its rope written out: the set values as they are, the paths, halos and home from the pieces. */
function knotJson(cur: string): string {
  const R = K.rope;
  const { paths, halos } = ropePaths();
  const list = (xs: unknown[], pad: string) => `[\n${xs.map((x) => pad + '  ' + (typeof x === 'string' ? x : inline(x))).join(',\n')}\n${pad}]`;
  const moments = Object.entries(R.moments).map(([k, v]) => `      ${JSON.stringify(k)}: ${inline(v)}`).join(',\n');
  const block = [
    `  "rope": {`,
    `    "about": ${list(R.about.map((a) => JSON.stringify(a)), '    ')},`,
    `    "leadIn": ${inline(R.leadIn)},`,
    `    "leadOut": ${inline(R.leadOut)},`,
    `    "light": ${inline(ropeLight())},`,
    `    "camera": ${inline(R.camera)},`,
    `    "moments": {\n${moments}\n    },`,
    `    "paths": ${list(paths, '    ')},`,
    `    "halos": ${list(halos, '    ')}`,
    `  }`,
  ].join('\n');
  const at = cur.indexOf('\n  "rope": ');
  if (at < 0) throw new Error('knot.json: no "rope" block (it must be the last key)');
  return cur.slice(0, at) + '\n' + block + '\n}\n';
}

/** A moment of the rope with every field (0 when it does not apply). */
const times = (t: RopeTimes) => ({ from: t.from, to: t.to, fade: t.fade ?? 0, straight: t.straight ?? 0, move: t.move, easeIn: t.easeIn ?? 0, cinch: t.cinch ?? 0, lapAt: t.lapAt ?? 0, lap: t.lap ?? 0, wordAt: t.wordAt ?? 0, word: t.word ?? 0 });

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

interface Draw {
  /** canvas edge in px; picks the stroke (heavier at 32 px of knot and under) */
  px: number;
  /** the knot's 64 unit box as a share of the canvas */
  share: number;
  fg: string;
  /** null: no light (one color marks) */
  light: string | null;
  /** halo color, or 'cut' to cut the under pieces with a mask (a transparent mark) */
  halo: string;
  /** rounded tile behind the knot */
  tile?: string;
  /** full square behind the knot */
  fill?: string;
  /** force the heavier stroke */
  fat?: boolean;
  span?: Span;
}

/** The knot's layers, in its 64 unit box. */
function knotLayers(o: { fg: string; light: string | null; halo: string; w: number; h: number; span?: Span; idSuffix?: string }): string {
  const span = o.span ?? K.light.brand;
  const piece = (i: number) => `<path d="${K.pieces[i].d}"/>`;
  const light = (ids: number[]) => {
    if (!o.light) return '';
    const parts: string[] = [];
    for (const i of ids) {
      const p = K.pieces[i];
      for (const [a, b] of lit(p, span)) {
        if (a <= 1e-3 && b >= p.length - 1e-3) parts.push(piece(i));
        else parts.push(`<path d="${p.d}" pathLength="${p.length}" stroke-dasharray="${n(b - a)} ${n(p.length + 1)}" stroke-dashoffset="${n(-a)}"/>`);
      }
    }
    return parts.length ? `<g stroke="${o.light}">${parts.join('')}</g>` : '';
  };
  const halos = (stroke: string) => `<g stroke="${stroke}" stroke-width="${o.h}" stroke-linecap="butt">${K.halos.map((h) => `<path d="${h.d}"/>`).join('')}</g>`;
  const unders = `<g stroke="${o.fg}">${UNDERS.map(piece).join('')}</g>${light(UNDERS)}`;
  // the over pieces' base ends flat: the under pieces' round ends fill the joins below it, and a
  // round end would paint a ring of base color over a lit join
  const overs = `<g stroke="${o.fg}" stroke-linecap="butt">${OVERS.map(piece).join('')}</g>${light(OVERS)}`;
  const g = `fill="none" stroke-width="${o.w}" stroke-linecap="round" stroke-linejoin="round"`;
  if (o.halo === 'cut') {
    const id = 'cut' + (o.idSuffix ?? '');
    return (
      `<mask id="${id}" maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80"><rect x="-8" y="-8" width="80" height="80" fill="#fff"/>${halos('#000')}</mask>` +
      `<g ${g}><g mask="url(#${id})">${unders}</g>${overs}</g>`
    );
  }
  return `<g ${g}>${unders}${halos(o.halo)}${overs}</g>`;
}

function svg(o: Draw, attrs = ''): string {
  const box = K.box;
  const knotPx = o.px * o.share;
  const { w, h } = o.fat ? { w: K.stroke.small.width, h: K.stroke.small.halo } : widths(knotPx);
  const k = o.share;
  const off = (box - box * k) / 2;
  let body = '';
  if (o.fill) body += `<rect width="${box}" height="${box}" fill="${o.fill}"/>`;
  if (o.tile) body += `<rect width="${box}" height="${box}" rx="${K.icons.radius}" fill="${o.tile}"/>`;
  const layers = knotLayers({ fg: o.fg, light: o.light, halo: o.halo, w, h, span: o.span });
  body += k === 1 ? layers : `<g transform="translate(${n(off)} ${n(off)}) scale(${n(k)})">${layers}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}"${attrs}>${body}</svg>`;
}

// ---------------------------------------------------------------------------
// Text outputs
// ---------------------------------------------------------------------------

const GEN = 'Generated by scripts/brand/knot.ts from docs/design/brand/knot.json. Edit that file and run the script.';

function webGeometry(): string {
  return `/**
 * The Conclave mark's geometry (docs/design/brand/README.md).
 * ${GEN}
 *
 * Six pieces in path order, under and over by turns, each with its share of
 * a path ${K.length} long that starts at the bottom of the right lobe and goes
 * left. Draw: the under pieces, the light on them, the halos (strokes in
 * the color behind the mark, around each crossing), the over pieces, the
 * light on them.
 */

export interface KnotPiece {
  kind: 'under' | 'over';
  /** where the piece starts on the ${K.length} long path (the last one runs past ${K.length}, round to the start) */
  from: number;
  /** its share of the path (use as pathLength) */
  length: number;
  d: string;
}

export const KNOT_BOX = ${K.box};
export const KNOT_LENGTH = ${K.length};

export const KNOT_PIECES: readonly KnotPiece[] = [
${K.pieces.map((p) => `  { kind: '${p.kind}', from: ${p.from}, length: ${p.length}, d: '${p.d}' },`).join('\n')}
];

/** One halo per crossing, inside the over piece KNOT_PIECES[over]. */
export const KNOT_HALOS: readonly { over: number; from: number; length: number; d: string }[] = [
${K.halos.map((h) => `  { over: ${h.over}, from: ${h.from}, length: ${h.length}, d: '${h.d}' },`).join('\n')}
];

/** Stroke widths in box units; at ${K.stroke.small.upTo}px and under the heavier pair. */
export const KNOT_STROKE = { width: ${K.stroke.width}, halo: ${K.stroke.halo}, smallUpTo: ${K.stroke.small.upTo}, smallWidth: ${K.stroke.small.width}, smallHalo: ${K.stroke.small.halo} } as const;

/** The light: spans on the ${K.length} long path, loops in ms. brand is the light's home, where the still mark shows it. */
export const KNOT_LIGHT = {
  brand: { from: ${K.light.brand.from}, length: ${K.light.brand.length} },
  thinking: { loop: ${K.light.thinking.loop}, turn: ${K.light.thinking.turn}, ease: [${K.light.thinking.ease.join(', ')}] as const, still: ${K.light.thinking.still} },
  tool: { loop: ${K.light.tool.loop}, length: ${K.light.tool.length} },
  paused: { from: ${K.light.paused.from}, length: ${K.light.paused.length} },
} as const;
${webRope()}`;
}

function webRope(): string {
  const { paths, halos } = ropePaths();
  const M = K.rope.moments;
  const idx = (id: string) => paths.findIndex((p) => p.id === id);
  return `
// ---------------------------------------------------------------------------
// The rope (docs/design/KNOT-MOTION.md): the knot as one rope that ties itself
// ---------------------------------------------------------------------------

export interface RopePath {
  id: string;
  /** lead: the lead in or the lead out; under and over: a piece of the knot */
  kind: 'lead' | 'under' | 'over';
  /** where it starts on the rope (the knot is ${ROPE_KNOT} to ${ROPE_KNOT + K.length}) */
  from: number;
  /** its share of the rope (use as pathLength) */
  length: number;
  d: string;
}

/** The rope in order: the lead in, k0 to k6 (the six pieces, the last split where the rope starts), the lead out. */
export const ROPE_PATHS: readonly RopePath[] = [
${paths.map((p) => `  { id: '${p.id}', kind: '${p.kind}', from: ${p.from}, length: ${p.length}, d: '${p.d}' },`).join('\n')}
];

/** One halo per crossing, on the over path ROPE_PATHS[on]. */
export const ROPE_HALOS: readonly { on: number; from: number; length: number; d: string }[] = [
${halos.map((h) => `  { on: ${idx(h.on)}, from: ${h.from}, length: ${h.length}, d: '${h.d}' },`).join('\n')}
];

/** A moment that moves the rope: w from \`from\` to \`to\` in \`move\` ms after \`straight\` (ease in out cubic, or x^easeIn). Times after the move count from its end. */
export interface RopeTimes {
  from: number;
  to: number;
  fade: number;
  straight: number;
  move: number;
  easeIn: number;
  cinch: number;
  lapAt: number;
  lap: number;
  wordAt: number;
  word: number;
}

/** The rope's numbers: where the knot starts, the light (the rope's last \`length\`), the launch camera, every moment's times in ms. */
export const ROPE = {
  knot: ${ROPE_KNOT},
  light: ${inline(ropeLight()).replace(/"(\w+)":/g, '$1:')},
  camera: { view: [${K.rope.camera.view.join(', ')}], pad: [${K.rope.camera.pad.join(', ')}], smooth: ${K.rope.camera.smooth}, steps: ${K.rope.camera.steps} },
  launch: ${inline(times(M.launch)).replace(/"(\w+)":/g, '$1:')} as RopeTimes,
  launchLong: ${inline(times(M.launchLong)).replace(/"(\w+)":/g, '$1:')} as RopeTimes,
  receive: ${inline(times(M.receive)).replace(/"(\w+)":/g, '$1:')} as RopeTimes,
  send: ${inline(times(M.send)).replace(/"(\w+)":/g, '$1:')} as RopeTimes,
  run: ${inline(M.run).replace(/"(\w+)":/g, '$1:')},
  success: ${inline(M.success).replace(/"(\w+)":/g, '$1:')},
  cinch: ${inline(M.cinch).replace(/"(\w+)":/g, '$1:')},
  word: ${inline(M.word).replace(/"(\w+)":/g, '$1:')},
} as const;
`;
}

function kotlinGeometry(): string {
  const f = (x: number) => (Number.isInteger(x) ? `${x}f` : `${x}f`);
  const arr = (pts: number[][]) => `floatArrayOf(${pts.map(([x, y]) => `${f(x)}, ${f(y)}`).join(', ')})`;
  const d = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
  return `package dev.conclave.client.motion

/*
 * The Conclave mark's geometry (docs/design/brand/README.md).
 * ${GEN}
 *
 * Six pieces in path order, under and over by turns, each with its share of
 * a path ${K.length} long that starts at the bottom of the right lobe and goes
 * left. Draw: the under pieces, the light on them, the halos (strokes in the
 * color behind the mark, around each crossing), the over pieces, the light
 * on them. Points are x, y pairs in a ${K.box} unit box.
 */

/** One piece of the knot's path. [from] and [length] are on the ${K.length} long path (the last piece runs past it, round to the start). */
class KnotPiece(val over: Boolean, val from: Double, val length: Double, val points: FloatArray)

object KnotGeometry {
    const val BOX = ${K.box}f
    const val LENGTH = ${d(K.length)}

    val PIECES: List<KnotPiece> = listOf(
${K.pieces.map((p) => `        KnotPiece(${p.kind === 'over'}, ${d(p.from)}, ${d(p.length)}, ${arr(points(p.d))}),`).join('\n')}
    )

    /** One halo per crossing, inside the over piece PIECES[HALO_OVER[i]]. */
    val HALOS: List<FloatArray> = listOf(
${K.halos.map((h) => `        ${arr(points(h.d))},`).join('\n')}
    )
    val HALO_OVER = intArrayOf(${K.halos.map((h) => h.over).join(', ')})

    /** Stroke widths in box units; at [SMALL_UP_TO] dp and under the heavier pair. */
    const val WIDTH = ${K.stroke.width}f
    const val HALO = ${K.stroke.halo}f
    const val SMALL_UP_TO = ${K.stroke.small.upTo}
    const val SMALL_WIDTH = ${K.stroke.small.width}f
    const val SMALL_HALO = ${K.stroke.small.halo}f

    /** The light's home, where the still mark shows it: a span on the ${K.length} long path. */
    const val BRAND_FROM = ${d(K.light.brand.from)}
    const val BRAND_LENGTH = ${d(K.light.brand.length)}

    /** Thinking: the light writes the knot (until [THINK_TURN] of the loop), then lets go from the tail. */
    const val THINK_LOOP = ${d(K.light.thinking.loop)}
    const val THINK_TURN = ${d(K.light.thinking.turn)}
    val THINK_EASE = doubleArrayOf(${K.light.thinking.ease.map(d).join(', ')})

    /** The still pose of thinking (reduced motion): the loop at this many ms. */
    const val THINK_STILL = ${d(K.light.thinking.still)}

    /** A tool runs: a light this long travels one lap per [TOOL_LOOP] ms. */
    const val TOOL_LOOP = ${d(K.light.tool.loop)}
    const val TOOL_LENGTH = ${d(K.light.tool.length)}

    /** Paused (a limit), mounted straight into it: the light rests here, in fg-3. */
    const val PAUSED_FROM = ${d(K.light.paused.from)}
    const val PAUSED_LENGTH = ${d(K.light.paused.length)}

}
${kotlinRope()}`;
}

function kotlinRope(): string {
  const { paths, halos } = ropePaths();
  const M = K.rope.moments;
  const L = ropeLight();
  const f = (x: number) => `${x}f`;
  const d = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
  const arr = (pts: number[][]) => `floatArrayOf(${pts.map(([x, y]) => `${f(x)}, ${f(y)}`).join(', ')})`;
  const kind = (k: RopePath['kind']) => (k === 'lead' ? 'ROPE_LEAD' : k === 'under' ? 'ROPE_UNDER' : 'ROPE_OVER');
  const t = (x: RopeTimes) => {
    const v = times(x);
    return `RopeTimes(${(Object.keys(v) as Array<keyof typeof v>).map((k) => `${k} = ${d(v[k])}`).join(', ')})`;
  };
  const S = M.success;
  return `
/*
 * The rope (docs/design/KNOT-MOTION.md): the knot as one rope that ties
 * itself. Positions are on the rope: the knot is ${ROPE_KNOT} to ${ROPE_KNOT + K.length}, the lead in
 * comes from the right to ${ROPE_KNOT}, the lead out leaves to the left from ${ROPE_KNOT + K.length}.
 */

const val ROPE_LEAD = 0
const val ROPE_UNDER = 1
const val ROPE_OVER = 2

/** One path of the rope: [kind] is ROPE_LEAD, ROPE_UNDER or ROPE_OVER; [from] and [length] are on the rope. */
class RopePath(val kind: Int, val from: Double, val length: Double, val points: FloatArray)

/** A moment that moves the rope: w from [from] to [to] in [move] ms after [straight] (ease in out cubic, or x^[easeIn]). Times after the move count from its end. */
class RopeTimes(
    val from: Double,
    val to: Double,
    val fade: Double,
    val straight: Double,
    val move: Double,
    val easeIn: Double,
    val cinch: Double,
    val lapAt: Double,
    val lap: Double,
    val wordAt: Double,
    val word: Double,
)

object RopeGeometry {
    /** Where the knot starts on the rope. */
    const val KNOT = ${d(ROPE_KNOT)}

    /** The rope in order: the lead in, k0 to k6 (the six pieces, the last split where the rope starts), the lead out. */
    val PATHS: List<RopePath> = listOf(
${paths.map((p) => `        RopePath(${kind(p.kind)}, ${d(p.from)}, ${d(p.length)}, ${arr(points(p.d))}),`).join('\n')}
    )

    /** One halo per crossing, on the over path PATHS[HALO_ON[i]], from HALO_FROM[i] for HALO_LENGTH[i]. */
    val HALOS: List<FloatArray> = listOf(
${halos.map((h) => `        ${arr(points(h.d))},`).join('\n')}
    )
    val HALO_ON = intArrayOf(${halos.map((h) => paths.findIndex((p) => p.id === h.on)).join(', ')})
    val HALO_FROM = doubleArrayOf(${halos.map((h) => d(h.from)).join(', ')})
    val HALO_LENGTH = doubleArrayOf(${halos.map((h) => d(h.length)).join(', ')})

    /** The light: the rope's last [LIGHT] ([LIGHT_BACK] behind the rope's start); tied, it rests at [LIGHT_HOME]. */
    const val LIGHT = ${d(L.length)}
    const val LIGHT_BACK = ${d(L.back)}
    const val LIGHT_HOME = ${d(L.home)}

    /** The launch camera: the view in box units, its padding, and the smoothing (± [CAMERA_SMOOTH] of [CAMERA_STEPS] steps of the tie). */
    const val CAMERA_VIEW_W = ${d(K.rope.camera.view[0])}
    const val CAMERA_VIEW_H = ${d(K.rope.camera.view[1])}
    const val CAMERA_PAD_X = ${d(K.rope.camera.pad[0])}
    const val CAMERA_PAD_Y = ${d(K.rope.camera.pad[1])}
    const val CAMERA_SMOOTH = ${K.rope.camera.smooth}
    const val CAMERA_STEPS = ${K.rope.camera.steps}

    val LAUNCH = ${t(M.launch)}
    val LAUNCH_LONG = ${t(M.launchLong)}
    val RECEIVE = ${t(M.receive)}
    val SEND = ${t(M.send)}

    /** Run: a [RUN_LENGTH] long piece with a [RUN_LIGHT] long light at its head, one lap per [RUN_LOOP] ms, starting at [RUN_FROM]. */
    const val RUN_LOOP = ${d(M.run.loop)}
    const val RUN_LENGTH = ${d(M.run.length)}
    const val RUN_LIGHT = ${d(M.run.light)}
    const val RUN_FROM = ${d(M.run.from)}

    /** Success: the light runs [SUCCESS_LAPS] laps from home in [SUCCESS_SPIN] ms; a trail; the cinch at [SUCCESS_CINCH_AT]. */
    const val SUCCESS_SPIN = ${d(S.spin)}
    const val SUCCESS_LAPS = ${d(S.laps)}
    val SUCCESS_EASE = doubleArrayOf(${S.ease.map(d).join(', ')})
    const val SUCCESS_CINCH_AT = ${d(S.cinchAt)}
    const val SUCCESS_CINCH = ${d(S.cinch)}
    const val TRAIL_LENGTH = ${d(S.trail.length)}
    const val TRAIL_BACK = ${d(S.trail.back)}
    const val TRAIL_OPACITY = ${d(S.trail.opacity)}
    val TRAIL_IN = doubleArrayOf(${S.trail.in.map(d).join(', ')})
    val TRAIL_OUT = doubleArrayOf(${S.trail.out.map(d).join(', ')})

    /** The cinch: the knot's scale at these shares of its time, around the box's center. */
    val CINCH_AT = doubleArrayOf(${M.cinch.at.map(d).join(', ')})
    val CINCH_SCALE = doubleArrayOf(${M.cinch.scale.map(d).join(', ')})

    /** The word under the first run's launch rises this far (dp) as it fades in. */
    const val WORD_RISE = ${d(M.word.rise)}
}
`;
}

// Android vector drawables -------------------------------------------------

const argb = (hex: string) => '#FF' + hex.replace('#', '').toUpperCase();

/** What is left of each under piece (fractions of it) after the halos cut it, for one color marks. */
function monoUnderTrims(w: number, h: number): Array<Array<[number, number]>> {
  const halos = K.halos.map((x) => points(x.d));
  // inside a halo band: within h/2 of its centerline, between its butt ends
  const inside = (x: number, y: number) =>
    halos.some((pts) => {
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        // the band is the segments' rectangles: butt ends, and the joins of a
        // polyline this smooth add next to nothing
        if (t < 0 || t > 1) continue;
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= h / 2) return true;
      }
      return false;
    });
  return UNDERS.map((i) => {
    const pts = points(K.pieces[i].d);
    // walk the polyline in small steps
    const samples: Array<{ s: number; cut: boolean }> = [];
    let total = 0;
    for (let j = 1; j < pts.length; j++) total += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
    let s = 0;
    for (let j = 1; j < pts.length; j++) {
      const [ax, ay] = pts[j - 1];
      const [bx, by] = pts[j];
      const seg = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(seg / 0.02));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        samples.push({ s: s + seg * t, cut: inside(ax + (bx - ax) * t, ay + (by - ay) * t) });
      }
      s += seg;
    }
    samples.push({ s: total, cut: inside(pts[pts.length - 1][0], pts[pts.length - 1][1]) });
    // kept runs; a cut end gives up the round cap's reach so the gap stays clear
    const out: Array<[number, number]> = [];
    let start: number | null = null;
    let startCut = false;
    for (let k = 0; k < samples.length; k++) {
      const c = samples[k].cut;
      if (!c && start === null) {
        start = samples[k].s;
        startCut = k > 0;
      }
      if ((c || k === samples.length - 1) && start !== null) {
        const end = c ? samples[k].s : total;
        const a = start + (startCut ? w / 2 : 0);
        const b = end - (c ? w / 2 : 0);
        if (b > a) out.push([a / total, b / total]);
        start = null;
      }
    }
    return out;
  });
}

function vector(o: { viewport: number; box: number; fg: string; light: string | null; halo: string | null; fat?: boolean; comment: string; size: number }): string {
  const k = o.box / K.box;
  const off = (o.viewport - o.box) / 2;
  const { w, h } = o.fat ? { w: K.stroke.small.width, h: K.stroke.small.halo } : { w: K.stroke.width, h: K.stroke.halo };
  const path = (d: string, color: string, extra = '', width = w, cap = 'round') =>
    `        <path\n            android:pathData="${d}"\n            android:strokeColor="${color}"\n            android:strokeWidth="${width}"\n            android:strokeLineCap="${cap}"\n            android:strokeLineJoin="round"${extra} />`;
  const trim = (a: number, b: number) => `\n            android:trimPathStart="${n(a)}"\n            android:trimPathEnd="${n(b)}"`;
  const lights = (ids: number[]) =>
    o.light
      ? ids.flatMap((i) => lit(K.pieces[i], K.light.brand).map(([a, b]) => path(K.pieces[i].d, argb(o.light!), a <= 1e-3 && b >= K.pieces[i].length - 1e-3 ? '' : trim(a / K.pieces[i].length, b / K.pieces[i].length))))
      : [];
  const body: string[] = [];
  if (o.halo) {
    body.push(...UNDERS.map((i) => path(K.pieces[i].d, argb(o.fg))));
    body.push(...lights(UNDERS));
    body.push(...K.halos.map((x) => path(x.d, argb(o.halo!), '', h, 'butt')));
  } else {
    // one color: no halo color to draw with, so the under pieces stop short of each crossing
    monoUnderTrims(w, h).forEach((runs, j) => {
      const p = K.pieces[UNDERS[j]];
      for (const [a, b] of runs) body.push(path(p.d, argb(o.fg), trim(a, b)));
    });
  }
  // flat ends on the over pieces' base: the under pieces' round ends fill the joins below it
  body.push(...OVERS.map((i) => path(K.pieces[i].d, argb(o.fg), '', w, 'butt')));
  body.push(...lights(OVERS));
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${o.comment} ${GEN} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${o.size}dp"
    android:height="${o.size}dp"
    android:viewportWidth="${o.viewport}"
    android:viewportHeight="${o.viewport}">
    <group
        android:scaleX="${n(k)}"
        android:scaleY="${n(k)}"
        android:translateX="${n(off)}"
        android:translateY="${n(off)}">
${body.join('\n')}
    </group>
</vector>
`;
}

// The iPhone's asset catalog ------------------------------------------------

const IOS = 'packages/mobile/assets/';
/** The launch image (Splash.imageset): the knot on the light ground, and on the dark one. */
const SPLASH = { light: 'splash-2732-light.png', dark: 'splash-2732-dark.png' };
const DARK = [{ appearance: 'luminosity', value: 'dark' }];
/** An asset catalog Contents.json, as Xcode writes it. */
const xcassets = (body: Record<string, unknown>) => JSON.stringify({ ...body, info: { author: 'xcode', version: 1 } }, null, 2) + '\n';
/** A color set entry from #rrggbb. */
function srgb(hex: string) {
  const [red, green, blue] = [1, 3, 5].map((i) => '0x' + hex.slice(i, i + 2).toUpperCase());
  return { 'color-space': 'srgb', components: { alpha: '1.000', blue, green, red } };
}

// The desktop app's own page ----------------------------------------------

const DESKTOP_PAGE = 'packages/desktop/src/index.html';
const DESKTOP_START = '<!-- knot: generated by scripts/brand/knot.ts -->';
const DESKTOP_END = '<!-- /knot -->';

function desktopPage(cur: string): string {
  const a = cur.indexOf(DESKTOP_START);
  const b = cur.indexOf(DESKTOP_END);
  if (a < 0 || b < a) throw new Error(`${DESKTOP_PAGE}: no ${DESKTOP_START} ... ${DESKTOP_END} block`);
  const indent = cur.slice(cur.lastIndexOf('\n', a) + 1, a);
  const mark = svg({ px: 21, share: 1, fg: 'currentColor', light: 'var(--signal)', halo: 'var(--bg)' }, ' class="logo" aria-hidden="true"').replace(' xmlns="http://www.w3.org/2000/svg"', '');
  return cur.slice(0, a) + DESKTOP_START + '\n' + indent + mark + '\n' + indent + cur.slice(b);
}

// The website (site/) -------------------------------------------------------

/** The knot engine every page with motion loads (index.html and details.html, before their own script). */
const SITE_JS = 'site/base.js';
const SITE_JS_START = '// knot: generated by scripts/brand/knot.ts from docs/design/brand/knot.json';
const SITE_JS_END = '// /knot';
const SITE_PAGES = ['site/index.html', 'site/details.html', 'site/privacy.html'];
const SITE_HTML_START = '<!-- knot: generated by scripts/brand/knot.ts -->';
const SITE_HTML_END = '<!-- /knot -->';

/** Puts body between the start and end markers of a file (the markers stay). */
function between(path: string, cur: string, start: string, end: string, body: string): string {
  const a = cur.indexOf(start);
  const b = cur.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${path}: no ${start} ... ${end} block`);
  return cur.slice(0, a) + start + '\n' + body + cur.slice(b);
}

/** site/base.js: the rope, its halos and every moment's numbers, for the site's plain JS port of knotMath.ts. */
function siteScript(cur: string): string {
  const { paths, halos } = ropePaths();
  const M = K.rope.moments;
  const idx = (id: string) => paths.findIndex((p) => p.id === id);
  const js = (v: unknown) => inline(v).replace(/"(\w+)":/g, '$1:');
  const body = [
    `var ROPE_PATHS = [`,
    ...paths.map((p) => `  { id: '${p.id}', kind: '${p.kind}', from: ${p.from}, length: ${p.length}, d: '${p.d}' },`),
    `];`,
    `var ROPE_HALOS = [`,
    ...halos.map((h) => `  { on: ${idx(h.on)}, from: ${h.from}, length: ${h.length}, d: '${h.d}' },`),
    `];`,
    `var ROPE = {`,
    `  knot: ${ROPE_KNOT},`,
    `  light: ${js(ropeLight())},`,
    `  camera: ${js(K.rope.camera)},`,
    `  launch: ${js(times(M.launch))},`,
    `  launchLong: ${js(times(M.launchLong))},`,
    `  receive: ${js(times(M.receive))},`,
    `  send: ${js(times(M.send))},`,
    `  run: ${js(M.run)},`,
    `  success: ${js(M.success)},`,
    `  cinch: ${js(M.cinch)},`,
    `  word: ${js(M.word)},`,
    `};`,
    `var KNOT_LIGHT = ${js(K.light)};`,
    `var KNOT_STROKE = { width: ${K.stroke.width}, halo: ${K.stroke.halo}, smallUpTo: ${K.stroke.small.upTo}, smallWidth: ${K.stroke.small.width}, smallHalo: ${K.stroke.small.halo} };`,
    '',
  ].join('\n');
  return between(SITE_JS, cur, SITE_JS_START, SITE_JS_END, body);
}

/**
 * The pages' mark: one SVG symbol, every static knot on the site (<use href="#k">).
 * Its colors, widths and the light's place are CSS custom properties that
 * inherit into each use: --kb base, --kl light, --kh halo (the surface
 * behind), --kw and --khw the widths, --klo the light's opacity, --kda the
 * light's dashes and --p where it starts on the 100 long path (84 is home).
 * The light is a dash on a 100 period, so a lap is --p going up by 100.
 */
function siteSymbol(): string {
  // each piece's path once, in <defs>; the base and the light both <use> it (the base never dashes, so its pathLength is unused)
  const def = (i: number) => `<path id="kp${i}" d="${K.pieces[i].d}" pathLength="${K.pieces[i].length}"/>`;
  const piece = (i: number) => `<use href="#kp${i}"/>`;
  const light = (i: number) => `<use href="#kp${i}" style="stroke-dashoffset:calc(${K.pieces[i].from} - var(--p))"/>`;
  const lights = (ids: number[]) => `<g style="stroke:var(--kl);opacity:var(--klo);stroke-dasharray:var(--kda)">${ids.map(light).join('')}</g>`;
  return (
    `<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>${[...UNDERS, ...OVERS].map(def).join('')}</defs><symbol id="k" viewBox="0 0 ${K.box} ${K.box}">` +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke-width:var(--kw)">` +
    `<g style="stroke:var(--kb)">${UNDERS.map(piece).join('')}</g>${lights(UNDERS)}` +
    `<g stroke-linecap="butt" style="stroke:var(--kh);stroke-width:var(--khw)">${K.halos.map((h) => `<path d="${h.d}"/>`).join('')}</g>` +
    `<g stroke-linecap="butt" style="stroke:var(--kb)">${OVERS.map(piece).join('')}</g>${lights(OVERS)}` +
    `</g></symbol></svg>\n`
  );
}

function textOutputs(): Record<string, string> {
  const C = K.icons.colors;
  const out: Record<string, string> = {
    'packages/web/src/components/brand/knotGeometry.ts': webGeometry(),
    'packages/android/client/src/main/kotlin/dev/conclave/client/motion/KnotGeometry.kt': kotlinGeometry(),
    // the favicon: the knot on the dark tile, heavier stroke (it shows at 16 and 32 px)
    'packages/web/public/favicon.svg': svg({ px: 16, share: K.icons.favicon, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile, fat: true }) + '\n',
    // for docs and anyone who needs the files: transparent marks (the crossings are cut), and the app icon
    'docs/design/brand/mark-dark.svg': svg({ px: 64, share: 1, fg: C.fg, light: C.light, halo: 'cut' }) + '\n',
    'docs/design/brand/mark-light.svg': svg({ px: 64, share: 1, fg: K.icons.colorsLight.fg, light: K.icons.colorsLight.light, halo: 'cut' }) + '\n',
    'docs/design/brand/mark-mono.svg': svg({ px: 64, share: 1, fg: '#000', light: null, halo: 'cut' }) + '\n',
    'docs/design/brand/app-icon.svg': svg({ px: 1024, share: K.icons.tile, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile }) + '\n',
    'packages/android/app/src/main/res/drawable/ic_launcher_foreground.xml': vector({
      viewport: K.icons.android.viewport,
      box: K.icons.android.box,
      size: K.icons.android.viewport,
      fg: C.fg,
      light: C.light,
      halo: C.tile,
      comment: 'Adaptive icon foreground: the Conclave knot with its violet light; the halos are strokes in the background color (@color/ic_launcher_background).',
    }),
    'packages/android/app/src/main/res/drawable/ic_launcher_monochrome.xml': vector({
      viewport: K.icons.android.viewport,
      box: K.icons.android.box,
      size: K.icons.android.viewport,
      fg: C.mono,
      light: null,
      halo: null,
      comment: 'Themed icon layer: the knot in one color, the under strands stopping short of each crossing. The launcher tints it.',
    }),
    'packages/android/app/src/main/res/drawable/ic_stat_conclave.xml': vector({
      viewport: K.icons.notification.viewport,
      box: K.icons.notification.box,
      size: K.icons.notification.viewport,
      fg: C.mono,
      light: null,
      halo: null,
      fat: true,
      comment: 'Notification small icon: the knot in one color, heavier stroke.',
    }),
  };
  // iPhone: the launch image and the ground in the asset catalog, light and dark (packages/mobile/scripts/ios-assets.ts copies them in)
  out[IOS + 'Splash.imageset/Contents.json'] = xcassets({ images: [{ filename: SPLASH.light, idiom: 'universal', scale: '2x' }, { appearances: DARK, filename: SPLASH.dark, idiom: 'universal', scale: '2x' }] });
  out[IOS + 'Ground.colorset/Contents.json'] = xcassets({ colors: [{ color: srgb(K.icons.ground.light), idiom: 'universal' }, { appearances: DARK, color: srgb(K.icons.ground.dark), idiom: 'universal' }] });
  out[DESKTOP_PAGE] = desktopPage(readFileSync(at(DESKTOP_PAGE), 'utf8'));
  // the website: the knot's data in its engine script, and the mark as a symbol in each page
  out[SITE_JS] = siteScript(readFileSync(at(SITE_JS), 'utf8'));
  for (const page of SITE_PAGES) out[page] = between(page, readFileSync(at(page), 'utf8'), SITE_HTML_START, SITE_HTML_END, siteSymbol());
  // the rope's paths and halos, written back into the source from its pieces
  out[KNOT_JSON] = knotJson(readFileSync(at(KNOT_JSON), 'utf8'));
  return out;
}

// ---------------------------------------------------------------------------
// PNGs
// ---------------------------------------------------------------------------

interface Png {
  path: string;
  size: number;
  svg: string;
}

function pngOutputs(): Png[] {
  const C = K.icons.colors;
  const L = K.icons.colorsLight;
  const G = K.icons.ground;
  const tileIcon = (size: number) => svg({ px: size, share: K.icons.tile, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile });
  const square = (size: number, share: number) => svg({ px: size, share, fg: C.fg, light: C.light, halo: C.tile, fill: C.tile });
  const favicon = (size: number) => svg({ px: size, share: K.icons.favicon, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile });
  const web = 'packages/web/public/icons/';
  return [
    { path: web + 'favicon-16.png', size: 16, svg: favicon(16) },
    { path: web + 'favicon-32.png', size: 32, svg: favicon(32) },
    { path: web + 'favicon-48.png', size: 48, svg: favicon(48) },
    // iOS rounds the corners itself, so a full square
    { path: web + 'apple-touch-icon.png', size: 180, svg: square(180, K.icons.tile) },
    { path: web + 'icon-192.png', size: 192, svg: tileIcon(192) },
    { path: web + 'icon-512.png', size: 512, svg: tileIcon(512) },
    // maskable: full bleed, the knot inside the 80% safe circle
    { path: web + 'maskable-192.png', size: 192, svg: square(192, K.icons.maskable) },
    { path: web + 'maskable-512.png', size: 512, svg: square(512, K.icons.maskable) },
    // the notification badge: one color, alpha only
    { path: web + 'badge-96.png', size: 96, svg: svg({ px: 24, share: K.icons.badge, fg: C.mono, light: null, halo: 'cut', fat: true }) },
    // desktop: the source for `tauri icon`
    { path: 'packages/desktop/icon.png', size: 1024, svg: tileIcon(1024) },
    // iPhone (Capacitor): the app icon (no transparency, iOS rounds it) and the launch image on the page's ground, light and dark
    { path: IOS + 'icon-1024.png', size: 1024, svg: square(1024, K.icons.tile) },
    { path: IOS + 'Splash.imageset/' + SPLASH.light, size: 2732, svg: svg({ px: 2732, share: K.icons.splash, fg: L.fg, light: L.light, halo: G.light, fill: G.light }) },
    { path: IOS + 'Splash.imageset/' + SPLASH.dark, size: 2732, svg: svg({ px: 2732, share: K.icons.splash, fg: C.fg, light: C.light, halo: G.dark, fill: G.dark }) },
  ];
}

/** Tauri icons drawn small enough to want the heavier stroke: redrawn after `tauri icon`. */
function tauriSmall(): Png[] {
  const C = K.icons.colors;
  const dir = 'packages/desktop/src-tauri/icons/';
  const tile = (size: number) => svg({ px: size, share: K.icons.tile, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile });
  const out: Png[] = [];
  for (const f of readdirSync(at(dir))) {
    const m = /^(?:(\d+)x\d+|Square(\d+)x\d+Logo)\.png$/.exec(f);
    const size = m ? Number(m[1] ?? m[2]) : 0;
    if (size && size * K.icons.tile <= K.stroke.small.upTo) out.push({ path: dir + f, size, svg: tile(size) });
  }
  return out;
}

function requirePlaywright() {
  const req = createRequire(at('packages/core/package.json'));
  return req('playwright-core') as typeof import('playwright-core');
}

async function render(list: Array<{ size: number; svg: string }>): Promise<Buffer[]> {
  const { chromium } = requirePlaywright();
  const exe = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const out: Buffer[] = [];
    for (const { size, svg: s } of list) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
      out.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** A .ico of PNG images. */
function ico(images: Array<{ size: number; png: Buffer }>): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.png)]);
}

/** The PNG sizes inside a .ico. */
function icoSizes(buf: Buffer): number[] {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => buf.readUInt8(6 + 16 * i) || 256);
}

/** An .icns with its small PNG entries (16 and 32 px) replaced, entries sorted by type. */
function icnsWith(buf: Buffer, small: Map<string, Buffer>): Buffer {
  const parts: Array<[string, Buffer]> = [];
  let p = 8;
  while (p < buf.length) {
    const type = buf.toString('ascii', p, p + 4);
    const len = buf.readUInt32BE(p + 4);
    const data = small.get(type);
    if (data) {
      const h = Buffer.alloc(8);
      h.write(type, 0, 'ascii');
      h.writeUInt32BE(data.length + 8, 4);
      parts.push([type, Buffer.concat([h, data])]);
    } else parts.push([type, buf.subarray(p, p + len)]);
    p += len;
  }
  // tauri writes the entries in no fixed order; sorted, a re-run gives the same file
  parts.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const body = Buffer.concat(parts.map((x) => x[1]));
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

/** icns entry types and their pixel size (the small ones that want the heavier stroke). */
const ICNS_SMALL: Record<string, number> = { icp4: 16, icp5: 32, ic11: 32 };

/** A PNG's width and height from its header, or null when it is not a PNG. */
function pngSize(buf: Buffer): [number, number] | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** Every PNG, or with `only` the ones under that path and no Tauri icons. */
async function writePngs(only?: string) {
  const list = pngOutputs().filter((x) => !only || x.path.startsWith(only));
  const pngs = await render(list);
  list.forEach((x, i) => write(x.path, pngs[i]));
  if (only) return;
  // favicon.ico from the favicon PNGs
  write('packages/web/public/favicon.ico', ico([16, 32, 48].map((size) => ({ size, png: pngs[list.findIndex((x) => x.path.endsWith(`favicon-${size}.png`))] }))));

  // Tauri: the whole set from icon.png, then the small sizes with the heavier stroke
  const desktop = at('packages/desktop');
  execFileSync('bun', ['run', 'icons'], { cwd: desktop, stdio: 'inherit' });
  const small = tauriSmall();
  const smallPngs = await render(small);
  small.forEach((x, i) => write(x.path, smallPngs[i]));
  const icoPath = 'packages/desktop/src-tauri/icons/icon.ico';
  const sizes = icoSizes(readFileSync(at(icoPath)));
  const C = K.icons.colors;
  const icoPngs = await render(sizes.map((size) => ({ size, svg: svg({ px: size, share: K.icons.tile, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile }) })));
  write(icoPath, ico(sizes.map((size, i) => ({ size, png: icoPngs[i] }))));
  const icnsPath = 'packages/desktop/src-tauri/icons/icon.icns';
  const types = Object.keys(ICNS_SMALL);
  const icnsPngs = await render(types.map((t) => ({ size: ICNS_SMALL[t], svg: svg({ px: ICNS_SMALL[t], share: K.icons.tile, fg: C.fg, light: C.light, halo: C.tile, tile: C.tile }) })));
  write(icnsPath, icnsWith(readFileSync(at(icnsPath)), new Map(types.map((t, i) => [t, icnsPngs[i]]))));
}

// ---------------------------------------------------------------------------
// The contact sheet (for looking, not committed)
// ---------------------------------------------------------------------------

async function sheet(out: string) {
  const C = K.icons.colors;
  const img = (p: string, size: number, style = '') => `<img src="data:image/png;base64,${readFileSync(at(p)).toString('base64')}" width="${size}" height="${size}" style="${style}">`;
  const cell = (label: string, inner: string, bg = '#2a2a30') => `<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:6px"><div style="background:${bg};padding:10px;display:grid;place-items:center;min-width:40px;min-height:40px">${inner}</div><figcaption>${label}</figcaption></figure>`;
  const raw = (svgText: string, size: number, style = '') => `<img src="data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}" width="${size}" height="${size}" style="${style}">`;
  const safe = (size: number) =>
    `<div style="position:relative;width:${size}px;height:${size}px">${img('packages/web/public/icons/maskable-512.png', size)}<div style="position:absolute;inset:${size * 0.1}px;border-radius:50%;outline:1px dashed #ff5a5a"></div></div>`;
  const tauri = readdirSync(at('packages/desktop/src-tauri/icons'))
    .filter((f) => /^\d+x\d+(@2x)?\.png$|^icon\.png$/.test(f))
    .map((f) => {
      const m = /^(\d+)x\d+(@2x)?/.exec(f);
      const size = f === 'icon.png' ? 512 : Number(m![1]) * (m![2] ? 2 : 1);
      return cell(`Tauri ${f}`, img('packages/desktop/src-tauri/icons/' + f, Math.min(size, 256)));
    });
  const fg = readFileSync(at('packages/android/app/src/main/res/drawable/ic_launcher_foreground.xml'), 'utf8');
  const mono = readFileSync(at('packages/android/app/src/main/res/drawable/ic_launcher_monochrome.xml'), 'utf8');
  const stat = readFileSync(at('packages/android/app/src/main/res/drawable/ic_stat_conclave.xml'), 'utf8');
  const html = `<!doctype html><html><body style="margin:0;padding:20px;background:#1b1b1f;color:#ccc;font:12px system-ui;display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;width:1400px">
${cell('favicon 16 (x1)', img('packages/web/public/icons/favicon-16.png', 16))}
${cell('favicon 16 (x4)', img('packages/web/public/icons/favicon-16.png', 64, 'image-rendering:pixelated'))}
${cell('favicon 32 (x1)', img('packages/web/public/icons/favicon-32.png', 32))}
${cell('favicon 32 (x4)', img('packages/web/public/icons/favicon-32.png', 128, 'image-rendering:pixelated'))}
${cell('favicon 16, light tab', img('packages/web/public/icons/favicon-16.png', 16), '#f1f1f4')}
${cell('favicon.svg 64', raw(readFileSync(at('packages/web/public/favicon.svg'), 'utf8'), 64))}
${cell('apple-touch 180', img('packages/web/public/icons/apple-touch-icon.png', 180))}
${cell('PWA 192', img('packages/web/public/icons/icon-192.png', 192))}
${cell('PWA 512 (at 256)', img('packages/web/public/icons/icon-512.png', 256))}
${cell('maskable 512, safe zone', safe(256))}
${cell('maskable in a circle', img('packages/web/public/icons/maskable-512.png', 192, 'border-radius:50%'))}
${cell('badge 96', img('packages/web/public/icons/badge-96.png', 96), '#4a4a55')}
${tauri.join('\n')}
${cell('iOS 1024 (at 256, rounded as iOS does)', img('packages/mobile/assets/icon-1024.png', 256, 'border-radius:22.5%'))}
${cell('iOS launch, light (at 256)', img(IOS + 'Splash.imageset/' + SPLASH.light, 256))}
${cell('iOS launch, dark (at 256)', img(IOS + 'Splash.imageset/' + SPLASH.dark, 256))}
${cell('Android, circle', androidIcon(fg, 192, '50%'))}
${cell('Android, squircle', androidIcon(fg, 192, '32%'))}
${cell('Android, safe zone 66 dp', androidIcon(fg, 192, '0', true))}
${cell('Android themed (monochrome)', androidIcon(mono, 192, '50%', false, '#d8e2ff', '#2d3d5c'))}
${cell('Android notification 24 (x4)', vectorSvg(stat, 96, '#fff'), '#3a3a42')}
</body></html>`;
  const { chromium } = requirePlaywright();
  const exe = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(html);
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log('sheet', out);
}

/** An Android vector drawable shown through SVG (for the contact sheet). */
function vectorSvg(xml: string, size: number, tint?: string): string {
  const vp = Number(/viewportWidth="([\d.]+)"/.exec(xml)![1]);
  const g = /<group([\s\S]*?)>/.exec(xml)![1];
  const attr = (s: string, name: string) => new RegExp(`android:${name}="([^"]*)"`).exec(s)?.[1];
  const tf = `translate(${attr(g, 'translateX')} ${attr(g, 'translateY')}) scale(${attr(g, 'scaleX')})`;
  const paths = [...xml.matchAll(/<path([\s\S]*?)\/>/g)].map((m) => {
    const p = m[1];
    const d = attr(p, 'pathData')!;
    const color = tint ?? '#' + attr(p, 'strokeColor')!.slice(3);
    const ts = Number(attr(p, 'trimPathStart') ?? 0);
    const te = Number(attr(p, 'trimPathEnd') ?? 1);
    const dash = ts > 0 || te < 1 ? ` pathLength="1" stroke-dasharray="${te - ts} 2" stroke-dashoffset="${-ts}"` : '';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${attr(p, 'strokeWidth')}" stroke-linecap="${attr(p, 'strokeLineCap')}" stroke-linejoin="round"${dash}/>`;
  });
  const s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vp} ${vp}" width="${size}" height="${size}"><g transform="${tf}">${paths.join('')}</g></svg>`;
  return `<img src="data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}" width="${size}" height="${size}">`;
}

/** The adaptive icon: background color, foreground, a launcher mask (72 of 108 dp visible). */
function androidIcon(fgXml: string, size: number, radius: string, safe = false, tint?: string, bg = K.icons.colors.tile): string {
  // the visible 72 dp of the 108 dp layers
  const full = (size * 108) / 72;
  const inner = `<div style="position:absolute;left:${-(full - size) / 2}px;top:${-(full - size) / 2}px">${vectorSvg(fgXml, full, tint)}</div>`;
  const guide = safe ? `<div style="position:absolute;inset:${(size * 3) / 72}px;border-radius:50%;outline:1px dashed #ff5a5a"></div>` : '';
  return `<div style="position:relative;width:${size}px;height:${size}px;overflow:hidden;border-radius:${radius};background:${bg}">${inner}${guide}</div>`;
}

// ---------------------------------------------------------------------------

function write(path: string, data: string | Buffer) {
  mkdirSync(dirname(at(path)), { recursive: true });
  writeFileSync(at(path), data);
  console.log('wrote', relative(ROOT, at(path)));
}

async function main() {
  const args = process.argv.slice(2);
  const texts = textOutputs();
  if (args.includes('--check')) {
    const stale = Object.entries(texts).filter(([p, s]) => !existsSync(at(p)) || readFileSync(at(p), 'utf8') !== s);
    for (const [p] of stale) console.error('out of date:', p);
    // PNGs are drawn by a browser, so only their presence and size are checked
    const bad = pngOutputs().filter((x) => {
      const size = existsSync(at(x.path)) ? pngSize(readFileSync(at(x.path))) : null;
      return !size || size[0] !== x.size || size[1] !== x.size;
    });
    for (const x of bad) console.error('missing or not', `${x.size}x${x.size}:`, x.path);
    process.exit(stale.length || bad.length ? 1 : 0);
  }
  for (const [p, s] of Object.entries(texts)) write(p, s);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  if (!args.includes('--text')) await writePngs(only);
  const i = args.indexOf('--sheet');
  if (i >= 0) await sheet(args[i + 1] ?? 'knot-sheet.png');
}

await main();
