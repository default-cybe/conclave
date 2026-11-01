/**
 * A member's call on the hub's key that is stopped mid-answer still costs the
 * hub its input and what was written (docs/design/ACCOUNTS.md 6): it counts
 * against the member's monthly budget, so Stop is no way around it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';

let t: TestEngine | undefined;
let model: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  await t?.close();
  model?.stop(true);
  t = undefined;
});

const enc = new TextEncoder();
const event = (e: Record<string, unknown>) => enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

/** A model that starts every answer with tools and then never finishes it; chores (no tools) get a whole short answer. */
function stallingModel(seen: { calls: number }) {
  return Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = JSON.parse(await req.text()) as { tools?: unknown[] };
      const start = { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 9000, output_tokens: 0 } } };
      if (!body.tools?.length) {
        // a chore (a title): a whole answer that costs next to nothing
        const parts = [{ ...start, message: { ...start.message, usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
        return new Response(parts.map((p) => `event: ${p.type}\ndata: ${JSON.stringify(p)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      seen.calls++;
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(event(start));
          ctl.enqueue(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
          ctl.enqueue(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is most of a long answer, ' } }));
          // and then nothing more, until the caller goes away
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
}

describe("a member's budget on the hub's key", () => {
  test('counts a call that was stopped mid-answer', async () => {
    const seen = { calls: 0 };
    model = stallingModel(seen);
    t = await startTestEngine({
      script: [[{ text: 'unused' }]],
      overrides: {
        providers: { mock: { type: 'anthropic', baseUrl: `http://127.0.0.1:${model.port}`, apiKey: 'sk-hub', models: ['claude-sonnet-5-5'], modelOverrides: { 'claude-sonnet-5-5': { inputPrice: 100, outputPrice: 100 } } } },
      } as never,
    });
    const { engine } = t;
    // $0.10 a month on the hub's key; a request of about 10,000 tokens at $100 a million costs about $1
    const carol = engine.people.create({ name: 'carol', settings: { providers: { mock: { monthlyUsd: 0.1 } } } });
    const s = await engine.createSession({ agent: 'coder' } as never, carol.id);
    const long = `Please read all of this. ${'The quick brown fox jumps over the lazy dog. '.repeat(900)}`;

    const answered = new Promise<void>((resolve) => {
      const off = engine.bus.on((e: { type: string; sessionId?: string }) => {
        if (e.type === 'message.delta' && e.sessionId === s.id) {
          off();
          resolve();
        }
      });
    });
    const runner = engine.runnerFor(s.id);
    await runner.enqueue({ text: long });
    await answered;
    // Stop, after most of the answer arrived
    engine.abort(s.id);
    await Promise.race([runner.waitIdle(), Bun.sleep(10_000)]);
    expect(seen.calls).toBe(1);

    // the stopped call counted: her budget is spent, and the next call is refused before it is sent
    expect(engine.access.spent(carol.id, 'mock')).toBeGreaterThan(0.1);
    await runner.enqueue({ text: 'again' });
    await Promise.race([runner.waitIdle(), Bun.sleep(10_000)]);
    expect(seen.calls).toBe(1);
    expect(JSON.stringify(engine.getMessages(s.id))).toContain('monthly budget');
  }, 60_000);
});
