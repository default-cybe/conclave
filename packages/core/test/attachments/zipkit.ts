/**
 * Zips for tests, built byte by byte so a test can make the bad ones too: a
 * name outside the folder, a link, sizes that lie, an encrypted entry.
 */
import zlib from 'node:zlib';

export interface KitEntry {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored (default), 8 deflated. */
  method?: 0 | 8;
  /** The size the central directory claims, when it should lie. */
  claim?: number;
  /** A Unix mode in the external attributes (0o120777 is a link). */
  mode?: number;
  encrypted?: boolean;
}

const enc = new TextEncoder();
const crc32 = (b: Uint8Array) => (zlib as unknown as { crc32(d: Uint8Array): number }).crc32(b) >>> 0;

export function makeZip(entries: KitEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : (e.data ?? new Uint8Array(0));
    const method = e.method ?? 0;
    const body = method === 8 ? new Uint8Array(zlib.deflateRawSync(raw)) : raw;
    const size = e.claim ?? raw.length;
    const crc = crc32(raw);
    const flags = (e.encrypted ? 1 : 0) | 0x0800;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, (3 << 8) | 30, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, flags, true);
    cd.setUint16(10, method, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(38, ((e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** A tiny real PNG (1x1), for pictures inside a zip. */
export const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

/**
 * A tiny real one-page PDF that says `text`, with a correct xref table. `trailer`
 * adds entries to the trailer (" /Encrypt 5 0 R" makes it an encrypted one).
 */
export function makePdf(text: string, trailer = ''): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
export const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
