import { describe, expect, test } from 'bun:test';
import { FPS, Pacer, RAMP, STILL_T, makeScene, renderFrame } from '../src/components/ascii/field';

const text = (f: ReturnType<typeof renderFrame>) => Array.from(f.level, (l) => RAMP[l]).join('');

describe('ascii field', () => {
  test('a frame is the same for the same seed and time', () => {
    const a = renderFrame(makeScene(80, 16, 2, 7), 12.3);
    const b = renderFrame(makeScene(80, 16, 2, 7), 12.3);
    expect(text(a)).toBe(text(b));
    expect(Array.from(a.hot)).toEqual(Array.from(b.hot));
  });

  test('another seed or another time gives another frame', () => {
    const base = text(renderFrame(makeScene(80, 16, 2, 7), 12.3));
    expect(text(renderFrame(makeScene(80, 16, 2, 8), 12.3))).not.toBe(base);
    expect(text(renderFrame(makeScene(80, 16, 2, 7), 14))).not.toBe(base);
  });

  test('draws ramp glyphs only, with a few signal cells', () => {
    const f = renderFrame(makeScene(120, 30, 2, 3), STILL_T);
    const drawn = f.level.filter((l) => l > 0).length;
    const hot = f.hot.reduce((n, h) => n + h, 0);
    expect(drawn).toBeGreaterThan(50);
    // the hub's core and the packet: violet stays an accent
    expect(hot).toBeGreaterThanOrEqual(1);
    expect(hot).toBeLessThanOrEqual(3);
    expect(/^[ .:\-=+*#%@]+$/.test(text(f))).toBe(true);
  });

  test('a tiny grid does not throw', () => {
    expect(renderFrame(makeScene(3, 2, 2, 1), 0).level.length).toBe(6);
  });

  test('reduced motion draws one frame', () => {
    const p = new Pacer(FPS, true);
    let n = 0;
    for (let now = 0; now < 5000; now += 16.7) if (p.due(now)) n++;
    expect(n).toBe(1);
  });

  test('motion is capped at 20 frames a second on a 60Hz display', () => {
    const p = new Pacer(FPS, false);
    let n = 0;
    for (let i = 0; i < 60; i++) if (p.due((i * 1000) / 60)) n++;
    expect(n).toBe(20);
  });
});
