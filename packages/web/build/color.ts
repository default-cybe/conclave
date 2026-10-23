/** OKLCH to sRGB helpers used at build time (manifest colors). */

export type RGB = [number, number, number];

export function oklchToRgb(l: number, c: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const lin: RGB = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return lin.map((v) => {
    const x = Math.max(0, Math.min(1, v));
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(g * 255);
  }) as RGB;
}

export function hex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Brand colors for the manifest and the HTML theme-color meta: the app icon's (docs/design/brand/knot.json, icons.colors). */
export const BRAND = {
  /** tile background, = #141417 */
  ink: [0x14, 0x14, 0x17] as RGB,
  /** light theme page, = #f9f9fa */
  inkLight: [0xf9, 0xf9, 0xfa] as RGB,
  /** the knot, = #ecebef */
  knot: [0xec, 0xeb, 0xef] as RGB,
  /** its light, = #b592f0 (the dark theme signal of the reference) */
  light: [0xb5, 0x92, 0xf0] as RGB,
};
