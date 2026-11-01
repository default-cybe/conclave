/**
 * A tiny PNG writer and rasterizer for the fake map servers: solid ground,
 * a few streets, parks and water, a route line and round markers. Enough
 * for a map card to look like a map in screenshots. Test code only.
 */
import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const td = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
  td.set(data, 4);
  out.set(td, 4);
  view.setUint32(8 + data.length, crc32(td));
  return out;
}

/** RGB pixels as a PNG. */
export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: [number, number, number],
  ) {
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }

  set(x: number, y: number, c: [number, number, number]): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(c, (y * this.w + x) * 3);
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, y1); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, x1); x++) this.set(x, y, c);
  }

  disc(cx: number, cy: number, r: number, c: [number, number, number]): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c);
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, c: [number, number, number]): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) this.disc(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width / 2, c);
  }

  png(): Uint8Array {
    return encodePng(this.w, this.h, this.px);
  }
}

const LAND: [number, number, number] = [242, 239, 233];
const STREET: [number, number, number] = [255, 255, 255];
const EDGE: [number, number, number] = [214, 208, 198];
const PARK: [number, number, number] = [200, 230, 190];
const WATER: [number, number, number] = [170, 211, 223];

/** Ground for a stretch of world pixels: a street grid every 64 px, a park and a canal by position, so tiles join up. */
export function paintGround(c: Canvas, worldX: number, worldY: number, scale = 1): void {
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const wx = worldX + x / scale;
      const wy = worldY + y / scale;
      const cellX = Math.floor(wx / 192);
      const cellY = Math.floor(wy / 192);
      const inPark = (cellX * 7 + cellY * 13) % 11 === 0 && wx % 192 > 40 && wx % 192 < 150 && wy % 192 > 40 && wy % 192 < 150;
      const canal = Math.abs(((wy + wx * 0.35) % 900) - 450) < 9;
      const mx = wx % 64;
      const my = wy % 64;
      const street = mx < 3 || my < 3;
      const edge = mx < 4 || my < 4;
      if (canal) c.px.set(WATER, (y * c.w + x) * 3);
      else if (street) c.px.set(STREET, (y * c.w + x) * 3);
      else if (edge) c.px.set(EDGE, (y * c.w + x) * 3);
      else if (inPark) c.px.set(PARK, (y * c.w + x) * 3);
    }
}

/** A 256 px tile at z/x/y. */
export function fakeTile(z: number, x: number, y: number): Uint8Array {
  void z;
  const c = new Canvas(256, 256, LAND);
  paintGround(c, x * 256, y * 256);
  return c.png();
}
