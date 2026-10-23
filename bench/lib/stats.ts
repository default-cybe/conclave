/** Statistics for the verdict (PROTOCOL 13). Plain math, no packages. */
import { rng } from './util';

/** 95% Wilson interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Exact two-sided sign test: a wins vs b wins, ties dropped. */
export function signTest(a: number, b: number): number | null {
  const n = a + b;
  if (n === 0) return null;
  const k = Math.min(a, b);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** Percentile bootstrap interval of the mean, resampling the items. */
export function bootstrapMean(xs: number[], level = 0.9, resamples = 10_000, seed = 1): [number, number] | null {
  if (!xs.length) return null;
  const r = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - level) / 2) * resamples)];
  const hi = means[Math.min(resamples - 1, Math.ceil((1 - (1 - level) / 2) * resamples) - 1)];
  return [lo, hi];
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Geometric mean of a/b ratios with a bootstrap interval over the pairs. */
export function geoRatio(pairs: Array<[number, number]>, level = 0.9, seed = 1): { ratio: number; ci: [number, number] | null; n: number } | null {
  const logs = pairs.filter(([a, b]) => a > 0 && b > 0).map(([a, b]) => Math.log(a / b));
  if (!logs.length) return null;
  const m = mean(logs)!;
  const ci = bootstrapMean(logs, level, 10_000, seed);
  return { ratio: Math.exp(m), ci: ci ? [Math.exp(ci[0]), Math.exp(ci[1])] : null, n: logs.length };
}
