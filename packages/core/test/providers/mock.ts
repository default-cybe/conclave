import type { StreamEvent } from '../../src/providers/types';

export interface RecordedRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

export type Handler = (req: Request, body: any, n: number) => Response | Promise<Response>;

/** Local HTTP server that records requests and answers with the handler's response. */
export function mockServer(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const text = await req.text();
      let body: any = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        url: req.url,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      return handler(req, body, requests.length - 1);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

export type SseItem = { event?: string; data: unknown } | string;

export function sseText(items: SseItem[], eol = '\n'): string {
  return items
    .map((it) => {
      if (typeof it === 'string') return it;
      const data = typeof it.data === 'string' ? it.data : JSON.stringify(it.data);
      return `${it.event ? `event: ${it.event}${eol}` : ''}data: ${data}${eol}${eol}`;
    })
    .join('');
}

/**
 * Streaming SSE response delivered in small byte chunks, the way real
 * providers split events across TCP reads.
 */
export function sseResponse(items: SseItem[], opts: { headers?: Record<string, string>; chunk?: number; status?: number } = {}): Response {
  const bytes = new TextEncoder().encode(sseText(items));
  const size = opts.chunk ?? 7;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += size) ctrl.enqueue(bytes.slice(i, i + size));
      ctrl.close();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(opts.headers ?? {}) },
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

export function doneOf(events: StreamEvent[]): Extract<StreamEvent, { type: 'done' }> {
  const d = events[events.length - 1];
  if (!d || d.type !== 'done') throw new Error(`last event is ${d?.type}, not done`);
  return d;
}

/** fetch that sends every request to the mock server, keeping path and query. Lets tests use real base URLs. */
export function routedFetch(target: string) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return fetch(`${target}${u.pathname}${u.search}`, init);
  };
}

export async function expectReject(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}
