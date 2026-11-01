/**
 * A small streaming .zip writer for the logs export: deflate, UTF-8 names,
 * sizes and CRCs in data descriptors after each file, so a file is never
 * held whole in memory. Opens with every unzip tool, Finder, Explorer and
 * the iPhone's Files app. No zip64: an export stays far under 4 GB.
 */
import zlib from 'node:zlib';
import { once } from 'node:events';

export interface ZipEntry {
  /** Path inside the zip, with forward slashes. */
  name: string;
  /** Epoch ms. Default now. */
  mtime?: number;
  data: Uint8Array | string | (() => AsyncIterable<Uint8Array>);
}

const enc = new TextEncoder();

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const crc32 = (data: Uint8Array, prev: number): number => (zlib as unknown as { crc32(d: Uint8Array, v?: number): number }).crc32(data, prev);

async function* source(data: ZipEntry['data']): AsyncIterable<Uint8Array> {
  if (typeof data === 'string') yield enc.encode(data);
  else if (data instanceof Uint8Array) yield data;
  else yield* data();
}

/** Deflate a stream of chunks; counts and the CRC of what went in are in `stats` when it ends. */
async function* deflate(input: AsyncIterable<Uint8Array>, stats: { crc: number; size: number }): AsyncIterable<Uint8Array> {
  const d = zlib.createDeflateRaw({ level: 6 });
  let failed: unknown;
  const feed = (async () => {
    try {
      for await (const chunk of input) {
        if (!chunk.byteLength) continue;
        stats.crc = crc32(chunk, stats.crc);
        stats.size += chunk.byteLength;
        if (!d.write(chunk)) await once(d, 'drain');
      }
    } catch (err) {
      failed = err;
    } finally {
      d.end();
    }
  })();
  for await (const out of d) yield out as Uint8Array;
  await feed;
  if (failed) throw failed;
}

class Bytes {
  private view: DataView;
  readonly buf: Uint8Array;
  private at = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.buf.set(b, this.at);
    this.at += b.byteLength;
    return this;
  }
}

/** bit 3: sizes in a data descriptor; bit 11: the name is UTF-8. */
const FLAGS = 0x0808;

async function* zipChunks(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): AsyncIterable<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  for await (const e of entries) {
    const name = enc.encode(e.name.replace(/^\/+/, ''));
    const { time, date } = dosTime(e.mtime ?? Date.now());
    const local = new Bytes(30 + name.byteLength)
      .u32(0x04034b50)
      .u16(20)
      .u16(FLAGS)
      .u16(8)
      .u16(time)
      .u16(date)
      .u32(0)
      .u32(0)
      .u32(0)
      .u16(name.byteLength)
      .u16(0)
      .bytes(name).buf;
    const start = offset;
    yield local;
    offset += local.byteLength;
    const stats = { crc: 0, size: 0 };
    let compressed = 0;
    for await (const chunk of deflate(source(e.data), stats)) {
      compressed += chunk.byteLength;
      yield chunk;
    }
    offset += compressed;
    const desc = new Bytes(16).u32(0x08074b50).u32(stats.crc).u32(compressed).u32(stats.size).buf;
    yield desc;
    offset += desc.byteLength;
    central.push(
      new Bytes(46 + name.byteLength)
        .u32(0x02014b50)
        .u16(0x031e) // made by unix, version 3.0
        .u16(20)
        .u16(FLAGS)
        .u16(8)
        .u16(time)
        .u16(date)
        .u32(stats.crc)
        .u32(compressed)
        .u32(stats.size)
        .u16(name.byteLength)
        .u16(0)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32((0o100644 << 16) >>> 0) // a regular file, rw-r--r--
        .u32(start)
        .bytes(name).buf,
    );
    count++;
  }
  let size = 0;
  for (const c of central) {
    yield c;
    size += c.byteLength;
  }
  yield new Bytes(22).u32(0x06054b50).u16(0).u16(0).u16(count).u16(count).u32(size).u32(offset).u16(0).buf;
}

/** The zip as a stream, for a Response body or a file. */
export function zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const it = zipChunks(entries)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/** Read a zip this writer made (tests and the CLI's checks): name to bytes. */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const csize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? new Uint8Array(zlib.inflateRawSync(raw)) : raw.slice();
    if (crc32(data, 0) !== crc) throw new Error(`bad CRC for ${name}`);
    out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
