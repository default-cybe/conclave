/**
 * A local stand-in for POST /v1/messages that answers the way Claude Sonnet 5.5 does.
 *
 * It rejects with a 400 what the real model rejects (as documented for the
 * Sonnet 5 -> Sonnet 5.5 move: `disabled` thinking, manual budgets, forced
 * tool_choice, between_tools above effort high) and answers like it: a
 * response starts with a thinking block, and with tool_choice auto the model
 * does not always call the tool. Answers are deterministic: which invoice a
 * document is comes from the invoice number in it.
 *
 * Known limit: no streaming (stream: true is a 400 here, the real API accepts it).
 */

export const TARGET = 'claude-sonnet-5-5';

export const DOCS: Record<string, { text: string; invoice: Record<string, unknown> | null; shy?: boolean }> = {
  acme: {
    text: 'ACME GmbH\nInvoice no: A-2026-117\nDate: 2026-10-01\nTotal due: EUR 1,299.00\nPayment due by 2026-10-31',
    invoice: { vendor: 'ACME GmbH', invoice_number: 'A-2026-117', total_cents: 129900, currency: 'EUR', due_date: '2026-10-31' },
  },
  // the model sometimes answers this one in text first ("looks already paid") instead of calling the tool
  north: {
    text: 'Northwind Traders Ltd\nINVOICE #NW-88412 (stamped PAID?)\nAmount: GBP 45.10\nDue 2026-11-15',
    invoice: { vendor: 'Northwind Traders Ltd', invoice_number: 'NW-88412', total_cents: 4510, currency: 'GBP', due_date: '2026-11-15' },
    shy: true,
  },
  blue: {
    text: 'Blue Yonder Hosting\nInvoice BY/2026/0042\nTotal USD 18.00\nDue date: 2026-12-01',
    invoice: { vendor: 'Blue Yonder Hosting', invoice_number: 'BY/2026/0042', total_cents: 1800, currency: 'USD', due_date: '2026-12-01' },
  },
  news: {
    text: 'Blue Yonder Hosting newsletter, October: new data centre in Porto, no action needed.',
    invoice: null,
  },
};

const TOP = new Set(['model', 'max_tokens', 'messages', 'system', 'thinking', 'output_config', 'metadata', 'stop_sequences', 'stream', 'tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'service_tier', 'fallbacks', 'container', 'context_management', 'mcp_servers']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Entry { body: any; status: number; error: string | null }

class Bad extends Error {
  constructor(public status: number, public kind: string, message: string) { super(message); }
}

const bad = (m: string) => new Bad(400, 'invalid_request_error', m);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'tool_result' ? JSON.stringify(b.content) : '')).join(' ');
  return '';
}

function check(b: any): { thinking: 'adaptive' | 'between_tools'; effort: string } {
  if (!b || typeof b !== 'object') throw bad('body must be a JSON object');
  for (const k of Object.keys(b)) if (!TOP.has(k)) throw bad(`${k}: Extra inputs are not permitted`);
  if (b.model !== TARGET) throw new Bad(404, 'not_found_error', `model: ${b.model} (this test server serves ${TARGET} only)`);
  if (b.stream) throw bad('stream: not supported by this test server');
  if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > 128000) throw bad('max_tokens: a positive integer up to 128000 is required');
  if ('top_k' in b) throw bad('top_k: is not supported for this model');
  if ('temperature' in b && b.temperature !== 1) throw bad('temperature: only the default value 1 is supported for this model');
  if ('top_p' in b && b.top_p !== 0.99) throw bad('top_p: only the default value 0.99 is supported for this model');
  const oc = b.output_config ?? {};
  for (const k of Object.keys(oc)) if (!['effort', 'format', 'task_budget'].includes(k)) throw bad(`output_config.${k}: Extra inputs are not permitted`);
  const effort = oc.effort ?? 'high';
  if (!EFFORTS.includes(effort)) throw bad(`output_config.effort: must be one of ${EFFORTS.join(', ')}`);
  if (oc.format !== undefined && !(oc.format?.type === 'json_schema' && oc.format.schema && typeof oc.format.schema === 'object')) throw bad('output_config.format: expected {"type": "json_schema", "schema": {...}}');
  let thinking: 'adaptive' | 'between_tools' = 'adaptive';
  if (b.thinking !== undefined) {
    const t = b.thinking;
    if (t?.type === 'disabled') throw bad('"thinking.type.disabled" is not supported for this model. Use "thinking.type.between_tools" for the lowest thinking setting, or "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.');
    if (t?.type === 'enabled' || 'budget_tokens' in (t ?? {})) throw bad('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.');
    if (t?.type === 'between_tools') {
      if (Object.keys(t).length > 1) throw bad('thinking: no other field is allowed with "between_tools"');
      if (effort === 'xhigh' || effort === 'max') throw bad(`output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`);
      thinking = 'between_tools';
    } else if (t?.type !== 'adaptive') throw bad(`thinking.type: unknown value ${JSON.stringify(t?.type)}`);
  }
  const tc = b.tool_choice;
  if (tc && (tc.type === 'tool' || tc.type === 'any')) throw bad('tool_choice: type "tool" and "any" are not supported for this model.');
  if (!Array.isArray(b.messages) || !b.messages.length) throw bad('messages: at least one message is required');
  if (b.messages.at(-1).role !== 'user') throw bad('This model does not support assistant message prefill. The conversation must end with a user message.');
  return { thinking, effort };
}

export class FakeApi {
  log: Entry[] = [];
  url = '';
  private server: ReturnType<typeof Bun.serve> | null = null;
  private seen = new Map<string, number>();

  start(): this {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  errors(): Array<[number, string | null]> {
    return this.log.filter((e) => e.status !== 200).map((e) => [e.status, e.error]);
  }

  private async handle(req: Request): Promise<Response> {
    const entry: Entry = { body: null, status: 200, error: null };
    this.log.push(entry);
    try {
      if (new URL(req.url).pathname !== '/v1/messages') throw new Bad(404, 'not_found_error', 'no such route');
      if (!req.headers.get('x-api-key')) throw new Bad(401, 'authentication_error', 'x-api-key header is required');
      if (!req.headers.get('anthropic-version')) throw bad('anthropic-version header is required');
      try {
        entry.body = await req.json();
      } catch {
        throw bad('body is not JSON');
      }
      return Response.json(this.answer(entry.body, check(entry.body)));
    } catch (e) {
      const b = e instanceof Bad ? e : new Bad(500, 'api_error', String(e));
      entry.status = b.status;
      entry.error = b.message;
      return Response.json({ type: 'error', error: { type: b.kind, message: b.message } }, { status: b.status });
    }
  }

  private answer(b: any, mode: { thinking: string }): unknown {
    const all = b.messages.map((m: any) => textOf(m.content)).join('\n') + '\n' + textOf(b.system);
    const [key, doc] = Object.entries(DOCS).find(([, d]) => all.includes(d.text.split('\n')[1])) ?? Object.entries(DOCS).find(([, d]) => all.includes(d.text)) ?? [null, null];
    const head = mode.thinking === 'between_tools' ? { type: 'thinking', thinking: 'Reading the invoice header fields.', signature: 'EqQBFakeSig' } : { type: 'thinking', thinking: '', signature: 'EqQBFakeSig' };
    const base = { id: 'msg_fake', type: 'message', role: 'assistant', model: TARGET, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 60 } };
    const prose = (t: string) => ({ ...base, content: [head, { type: 'text', text: t }], stop_reason: 'end_turn' });
    if (!doc || !doc.invoice) return prose('This document is not an invoice, so there are no invoice fields to record.');
    if (b.output_config?.format) return { ...base, content: [head, { type: 'text', text: JSON.stringify(doc.invoice) }], stop_reason: 'end_turn' };
    const tool = (b.tools ?? []).find((t: any) => t?.name === 'record_invoice');
    if (!tool) return prose(JSON.stringify(doc.invoice));
    if (b.tool_choice?.type === 'none') return prose('Here are the fields: ' + JSON.stringify(doc.invoice));
    const n = (this.seen.get(key!) ?? 0) + 1;
    this.seen.set(key!, n);
    // auto does not guarantee a call: the first try on a doubtful document answers in prose, even when the prompt names the tool
    if (doc.shy && n === 1) return prose('This one looks like it may already be paid. Do you still want it recorded?');
    return { ...base, content: [head, { type: 'tool_use', id: `toolu_${key}_${n}`, name: 'record_invoice', input: doc.invoice }], stop_reason: 'tool_use' };
  }
}
