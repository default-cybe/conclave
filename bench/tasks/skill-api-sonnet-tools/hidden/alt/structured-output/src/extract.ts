/**
 * Pull the header fields out of an invoice (plain text from the PDF importer)
 * with Claude. extractInvoice() returns a filled-in Invoice or throws.
 *
 * Reads ANTHROPIC_API_KEY, and ANTHROPIC_BASE_URL when set (as the SDKs do).
 */

export interface Invoice {
  vendor: string;
  invoice_number: string;
  total_cents: number;
  currency: string;
  due_date: string;
}

export const MODEL = 'claude-sonnet-5-5';

export const RECORD_TOOL = {
  name: 'record_invoice',
  description: 'Record the header fields of one invoice.',
  input_schema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'Company that issued the invoice' },
      invoice_number: { type: 'string' },
      total_cents: { type: 'integer', description: 'Amount due, in cents' },
      currency: { type: 'string', description: 'ISO 4217 code, e.g. EUR' },
      due_date: { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['vendor', 'invoice_number', 'total_cents', 'currency', 'due_date'],
    additionalProperties: false,
  },
};

/** Check the fields the model returned and build an Invoice, or throw. */
export function toInvoice(input: unknown): Invoice {
  const o = input as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new Error('invoice: not an object');
  for (const k of ['vendor', 'invoice_number', 'currency', 'due_date']) {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new Error(`invoice: ${k} missing`);
  }
  if (!Number.isInteger(o.total_cents)) throw new Error('invoice: total_cents must be an integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.due_date as string)) throw new Error('invoice: due_date must be YYYY-MM-DD');
  return {
    vendor: (o.vendor as string).trim(),
    invoice_number: (o.invoice_number as string).trim(),
    total_cents: o.total_cents as number,
    currency: (o.currency as string).trim().toUpperCase(),
    due_date: o.due_date as string,
  };
}

async function post(body: unknown): Promise<any> {
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function extractInvoice(text: string): Promise<Invoice> {
  const data = await post({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: 'between_tools' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RECORD_TOOL.input_schema } },
    messages: [{ role: 'user', content: `Extract the header fields of this invoice as JSON. If it is not an invoice, answer NONE.\n\n${text}` }],
  });
  const out = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('invoice: no invoice fields in the answer');
  }
  return toInvoice(parsed);
}
