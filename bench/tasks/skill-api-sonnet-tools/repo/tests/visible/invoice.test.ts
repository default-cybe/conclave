import { describe, expect, test } from 'bun:test';
import { toInvoice } from '../../src/extract';

describe('toInvoice', () => {
  const good = { vendor: ' Acme GmbH ', invoice_number: 'A-17', total_cents: 129900, currency: 'eur', due_date: '2026-11-30' };

  test('accepts a complete record and tidies it', () => {
    expect(toInvoice(good)).toEqual({ vendor: 'Acme GmbH', invoice_number: 'A-17', total_cents: 129900, currency: 'EUR', due_date: '2026-11-30' });
  });

  test('rejects missing or malformed fields', () => {
    expect(() => toInvoice({ ...good, vendor: '' })).toThrow('vendor missing');
    expect(() => toInvoice({ ...good, total_cents: 12.5 })).toThrow('total_cents');
    expect(() => toInvoice({ ...good, due_date: '30.11.2026' })).toThrow('due_date');
    expect(() => toInvoice(null)).toThrow('not an object');
  });
});
