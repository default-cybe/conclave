/**
 * A ```chart fence: a tiny JSON spec drawn as an inline SVG, no chart library.
 *   {"type":"bar"|"line","labels":["Q1","Q2"],"series":[{"name":"Revenue","values":[3,5]}]}
 * The spec is model output: every string is escaped and every number checked.
 */
export interface ChartSpec {
  type: 'bar' | 'line';
  labels: string[];
  series: { name: string; values: number[] }[];
}

const MAX_POINTS = 24;
const MAX_SERIES = 4;

/** The spec, or undefined when it is not one we draw. */
export function parseChart(src: string): ChartSpec | undefined {
  let j: unknown;
  try {
    j = JSON.parse(src);
  } catch {
    return undefined;
  }
  const o = j as Partial<ChartSpec> | null;
  if (!o || (o.type !== 'bar' && o.type !== 'line') || !Array.isArray(o.labels) || !Array.isArray(o.series)) return undefined;
  const labels = o.labels.map(String);
  if (!labels.length || labels.length > MAX_POINTS || !o.series.length || o.series.length > MAX_SERIES) return undefined;
  const series: ChartSpec['series'] = [];
  for (const s of o.series as unknown[]) {
    const x = s as { name?: unknown; values?: unknown } | null;
    if (!x || !Array.isArray(x.values) || x.values.length !== labels.length || !x.values.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
    series.push({ name: String(x.name ?? ''), values: x.values as number[] });
  }
  return { type: o.type, labels, series };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (v: number) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(2)}`);

/** A round step for about 4 gridlines over [0, max]. */
function step(max: number): number {
  const raw = max / 4 || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

/** The chart as an SVG string; colors come from the overlay's tokens through classes (ov-s0..3). */
export function chartSvg(c: ChartSpec, w = 360, h = 170): string {
  const legend = c.series.length > 1 ? 18 : 0;
  const L = 34, R = 8, T = 8 + legend, B = 22;
  const vals = c.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...vals);
  const st = step(Math.max(...vals, 0) - lo);
  const top = Math.ceil(Math.max(...vals, 0) / st) * st || st;
  const bottom = Math.floor(lo / st) * st;
  const y = (v: number) => T + ((top - v) / (top - bottom)) * (h - T - B);
  const band = (w - L - R) / c.labels.length;
  const out: string[] = [];
  for (let v = bottom; v <= top + st / 2; v += st)
    out.push(`<line class="ov-grid" x1="${L}" x2="${w - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ov-tick" x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${esc(num(v))}</text>`);
  c.labels.forEach((l, i) => out.push(`<text class="ov-tick" x="${L + band * (i + 0.5)}" y="${h - 6}" text-anchor="middle">${esc(cut(l, Math.max(3, Math.floor(band / 6))))}</text>`));
  c.series.forEach((s, k) => {
    if (c.type === 'bar') {
      const bw = Math.min(28, (band * 0.7) / c.series.length);
      s.values.forEach((v, i) => {
        const x = L + band * (i + 0.5) - (bw * c.series.length) / 2 + bw * k;
        const y0 = y(Math.max(0, v)), y1 = y(Math.min(0, v));
        out.push(`<rect class="ov-s${k}" x="${x}" y="${y0}" width="${Math.max(1, bw - 2)}" height="${Math.max(1, y1 - y0)}" rx="2"><title>${esc(`${s.name} ${c.labels[i]}: ${v}`)}</title></rect>`);
      });
    } else {
      const pts = s.values.map((v, i) => `${L + band * (i + 0.5)},${y(v)}`);
      out.push(`<polyline class="ov-line ov-s${k}" points="${pts.join(' ')}"/>`);
      s.values.forEach((v, i) => out.push(`<circle class="ov-s${k}" cx="${L + band * (i + 0.5)}" cy="${y(v)}" r="2.5"><title>${esc(`${s.name} ${c.labels[i]}: ${v}`)}</title></circle>`));
    }
    if (legend) out.push(`<rect class="ov-s${k}" x="${L + k * 90}" y="4" width="8" height="8" rx="2"/><text class="ov-tick" x="${L + k * 90 + 12}" y="11.5">${esc(cut(s.name, 13))}</text>`);
  });
  const title = esc(c.series.map((s) => s.name).filter(Boolean).join(', ') || 'Chart');
  return `<svg class="ov-chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">${out.join('')}</svg>`;
}
