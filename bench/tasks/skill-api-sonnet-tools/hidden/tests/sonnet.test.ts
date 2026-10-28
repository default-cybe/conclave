import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DOCS, FakeApi } from './fake-api';

const api = new FakeApi();
let extractInvoice: (text: string) => Promise<unknown>;
const got: Record<string, { ok: boolean; value: unknown }> = {};

beforeAll(async () => {
  api.start();
  process.env.ANTHROPIC_BASE_URL = api.url;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  ({ extractInvoice } = await import('../../src/extract'));
  for (const [key, doc] of Object.entries(DOCS)) {
    try {
      got[key] = { ok: true, value: await extractInvoice(doc.text) };
    } catch (e) {
      got[key] = { ok: false, value: String(e) };
    }
  }
});

afterAll(() => api.stop());

describe('invoice extractor on Claude Sonnet 5.5', () => {
  test('every request names claude-sonnet-5-5', () => {
    expect(api.log.length).toBeGreaterThan(0);
    expect(new Set(api.log.map((e) => e.body?.model))).toEqual(new Set(['claude-sonnet-5-5']));
  });

  test('the API accepts every request', () => {
    expect(api.errors()).toEqual([]);
  });

  test('extended thinking stays off', () => {
    for (const e of api.log) expect(e.body?.thinking?.type).toBe('between_tools');
  });

  for (const key of ['acme', 'north', 'blue']) {
    test(`fields for ${key}`, () => {
      expect(got[key]).toEqual({ ok: true, value: DOCS[key].invoice });
    });
  }

  test('a document that is no invoice throws', () => {
    expect(got.news.ok).toBe(false);
  });
});
