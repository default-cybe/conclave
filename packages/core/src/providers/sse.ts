import { ProviderError } from './types';

export interface SseMessage {
  /** Event name, "message" when the server sent none. */
  event: string;
  data: string;
  id?: string;
}

export interface SseOptions {
  signal?: AbortSignal;
  /** Fail when no bytes arrive for this long. */
  idleTimeoutMs?: number;
  /** Provider id for error messages. */
  provider?: string;
}

/**
 * Incremental text/event-stream parser. Follows the WHATWG rules: CR, LF or
 * CRLF line ends (a CRLF may be split across chunks), comment lines, one
 * optional space after the colon, multi-line data joined with "\n".
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private event = '';
  private id?: string;
  private pendingCR = false;
  private started = false;

  push(chunk: string, end = false): SseMessage[] {
    const out: SseMessage[] = [];
    let text = chunk;
    if (!this.started && text.length) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
    if (text.length) this.pendingCR = false;
    this.buf += text;

    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      const line = this.buf.slice(start, i);
      if (c === 13) {
        if (i + 1 < this.buf.length) {
          if (this.buf.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      this.line(line, out);
    }
    this.buf = this.buf.slice(start);

    if (end) {
      if (this.buf.length) this.line(this.buf, out);
      this.buf = '';
      // Some servers end the stream without the final blank line.
      this.dispatch(out);
    }
    return out;
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === '') return this.dispatch(out);
    if (line.charCodeAt(0) === 58 /* : */) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
  }

  private dispatch(out: SseMessage[]): void {
    if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
    this.data = [];
    this.event = '';
  }
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function abortError(provider?: string): ProviderError {
  return new ProviderError('aborted', 'Request aborted', { provider });
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: SseOptions,
): Promise<ReadResult> {
  const { signal, idleTimeoutMs } = opts;
  if (signal?.aborted) throw abortError(opts.provider);
  if (!signal && !idleTimeoutMs) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const races: Array<Promise<ReadResult>> = [reader.read()];
  if (idleTimeoutMs) {
    races.push(
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProviderError('network', `No data from ${opts.provider ?? 'provider'} for ${Math.round(idleTimeoutMs / 1000)}s`, {
                provider: opts.provider,
              }),
            ),
          idleTimeoutMs,
        );
      }),
    );
  }
  if (signal) {
    races.push(
      new Promise((_, reject) => {
        onAbort = () => reject(abortError(opts.provider));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }
  try {
    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read SSE messages from a fetch Response (or its body). Stops at the
 * OpenAI style "[DONE]" sentinel. Cancels the body when the consumer stops
 * early so the connection is released.
 */
export async function* parseSse(source: Response | ReadableStream<Uint8Array>, opts: SseOptions = {}): AsyncGenerator<SseMessage> {
  const body = source instanceof Response ? source.body : source;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    while (true) {
      let res: ReadResult;
      try {
        res = await readChunk(reader, opts);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (opts.signal?.aborted) throw abortError(opts.provider);
        throw new ProviderError('network', `Stream interrupted: ${(err as Error)?.message ?? err}`, { provider: opts.provider });
      }
      const text = res.done ? decoder.decode() : decoder.decode(res.value, { stream: true });
      for (const msg of parser.push(text, res.done)) {
        if (msg.data === '[DONE]') return;
        yield msg;
      }
      if (res.done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Parse an SSE data payload as JSON. Tolerates servers that put several JSON
 * objects in one event on separate data lines.
 */
export function parseSseJson(data: string): unknown[] {
  try {
    return [JSON.parse(data)];
  } catch {
    if (!data.includes('\n')) return [];
    const out: unknown[] = [];
    for (const line of data.split('\n')) {
      const t = line.trim();
      if (!t || t === '[DONE]') continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip junk lines */
      }
    }
    return out;
  }
}
