/**
 * A fake Anthropic Messages API for the parity checks. It plays a short
 * scripted agent: on the first main turn it asks for one Bash call that
 * prints what the agent can see (env, processes, folders), and on the next
 * turn it answers with a RESULT line. Side calls (no tools) get "ok".
 *
 * Usage numbers are fixed per request, so a check can compare what the tap
 * counted with what each tool reports.
 */

export const MOCK_USAGE = { input: 120, output: 30, cache_read: 900, cache_write: 200 };

export const PROBE_COMMAND = [
  'echo "PWD=$(pwd)"',
  'echo "HOME=$HOME"',
  'echo "--- env"',
  'env | sort',
  'echo "--- parent"',
  'ls -la ..',
  'echo "--- grandparent"',
  'ls -la ../..',
  'echo "--- home"',
  'ls -la ~',
  'echo "--- ps"',
  'ps -eo pid,args 2>/dev/null | head -200',
  'echo "--- background"',
  '(sleep 600 &) ; echo started',
].join('; ');

export interface MockRequest {
  path: string;
  model: string | null;
  tools: string[];
  body: any;
  bodyText: string;
}

export interface MockUpstream {
  url: string;
  port: number;
  requests: MockRequest[];
  stop: () => void;
}

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function hasToolResult(messages: any[]): boolean {
  return messages.some((m) => Array.isArray(m?.content) && m.content.some((b: any) => b?.type === 'tool_result'));
}

export function startMockUpstream(opts: { port?: number; servedModel?: (requested: string) => string } = {}): MockUpstream {
  const requests: MockRequest[] = [];
  let n = 0;
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = req.method === 'POST' ? await req.text() : '';
      let body: any = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      if (url.pathname.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'claude-sonnet-5-5', type: 'model' }, { id: 'claude-haiku-5-5', type: 'model' }], has_more: false });
      }
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 1000 });
      if (!url.pathname.endsWith('/v1/messages')) return Response.json({ type: 'error', error: { type: 'not_found_error', message: `mock: ${url.pathname}` } }, { status: 404 });
      const tools: string[] = Array.isArray(body.tools) ? body.tools.map((t: any) => t?.name).filter(Boolean) : [];
      requests.push({ path: url.pathname, model: body.model ?? null, tools, body, bodyText: text });
      const requested = String(body.model ?? 'unknown');
      const served = opts.servedModel ? opts.servedModel(requested) : requested;
      const id = `msg_mock_${++n}`;
      const usage = { input_tokens: MOCK_USAGE.input, output_tokens: MOCK_USAGE.output, cache_read_input_tokens: MOCK_USAGE.cache_read, cache_creation_input_tokens: MOCK_USAGE.cache_write };
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      const bash = tools.find((t) => t === 'Bash');
      const wantTool = !!bash && !hasToolResult(messages);
      const content: any[] = wantTool
        ? [{ type: 'tool_use', id: `toolu_mock_${n}`, name: bash, input: { command: PROBE_COMMAND, description: 'Show the environment' } }]
        : [{ type: 'text', text: tools.length ? 'I looked around.\nRESULT: DONE\nI ran one command and read its output.' : 'ok' }];
      const stop = wantTool ? 'tool_use' : 'end_turn';
      if (!body.stream) {
        return Response.json({ id, type: 'message', role: 'assistant', model: served, content, stop_reason: stop, stop_sequence: null, usage });
      }
      const events: Array<[string, unknown]> = [
        ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: served, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }],
      ];
      content.forEach((b, i) => {
        if (b.type === 'text') {
          events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } }]);
        } else {
          events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
          events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
        }
        events.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
      });
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: MOCK_USAGE.output } }]);
      events.push(['message_stop', { type: 'message_stop' }]);
      return new Response(sse(events), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, requests, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const m = startMockUpstream({ port: Number(process.argv[2] ?? 7790) });
  process.stderr.write(`mock upstream at ${m.url}\n`);
}
