/**
 * The iPhone app's launch (packages/mobile, README "Light and dark launch"):
 * the launch image, the web view behind the page and the page all show the
 * same ground, light or dark with the phone. knot.json's icons.ground draws
 * the launch images and the Ground color; it must stay the web app's --bg.
 *
 *   bun test packages/web/test/ios-launch.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hex, oklchToRgb } from '../build/color';

const repo = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const css = repo('packages/web/src/styles/index.css');
const knot = JSON.parse(repo('docs/design/brand/knot.json'));

/** The --bg of the theme block that starts with `head`, as #rrggbb. */
function bg(head: string): string {
  const at = css.indexOf(head);
  expect(at).toBeGreaterThanOrEqual(0);
  const m = /--bg: oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(css.slice(at))!;
  return hex(oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3])));
}

describe('the launch ground', () => {
  test("is the web app's page ground, light and dark", () => {
    expect(knot.icons.ground).toEqual({ light: bg(":root[data-theme='light'] {"), dark: bg(":root[data-theme='dark'] {") });
  });

  test('the asset catalog has it for both appearances, the launch image in both', () => {
    const color = JSON.parse(repo('packages/mobile/assets/Ground.colorset/Contents.json')).colors;
    const rgb = (c: { color: { components: Record<string, string> } }) => '#' + ['red', 'green', 'blue'].map((k) => c.color.components[k].slice(2).toLowerCase()).join('');
    expect(color.map(rgb)).toEqual([knot.icons.ground.light, knot.icons.ground.dark]);
    expect(color.map((c: { appearances?: unknown[] }) => c.appearances?.length ?? 0)).toEqual([0, 1]);
    const images = JSON.parse(repo('packages/mobile/assets/Splash.imageset/Contents.json')).images;
    expect(images.map((i: { appearances?: Array<{ value: string }> }) => i.appearances?.[0]?.value ?? 'any')).toEqual(['any', 'dark']);
  });

  test('capacitor.config.ts sets no single background color', () => {
    expect(repo('packages/mobile/capacitor.config.ts')).not.toMatch(/^\s*backgroundColor:/m);
  });
});
