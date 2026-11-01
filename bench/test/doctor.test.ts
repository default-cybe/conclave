import { afterAll, expect, test } from 'bun:test';
import { proxyModels } from '../lib/doctor';

// CLIProxyAPI answers /v1/models in the Anthropic format when the request has
// an anthropic-version header, and there it renames ids that are not plain
// claude-* ids. Without the header it lists them as they are.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (req.headers.get('anthropic-version')) {
      return Response.json({ data: [{ type: 'model', id: 'claude-fable-5-dd-5-5-tennos-edualc/uen' }], has_more: false });
    }
    return Response.json({ object: 'list', data: [{ id: 'neu/claude-sonnet-5-5' }, { id: 'claude-sonnet-5-5' }] });
  },
});
afterAll(() => server.stop(true));

test('the model list keeps neu/ ids as the proxy serves them', async () => {
  const m = await proxyModels(`http://127.0.0.1:${server.port}`, 'k');
  expect(m.ids).toEqual(['neu/claude-sonnet-5-5', 'claude-sonnet-5-5']);
});

test('Claude calls go to the Anthropic API when its key is set, else to the proxy', async () => {
  const { claudeConfig } = await import('../lib/env');
  const saved = { key: process.env.BENCH_CLAUDE_API_KEY, url: process.env.BENCH_CLAUDE_BASE_URL, proxy: process.env.CLIPROXY_BASE_URL };
  try {
    delete process.env.BENCH_CLAUDE_BASE_URL;
    process.env.CLIPROXY_BASE_URL = 'http://10.0.0.5:8317/v1';
    delete process.env.BENCH_CLAUDE_API_KEY;
    expect(claudeConfig().baseUrl).toBe('http://10.0.0.5:8317');
    process.env.BENCH_CLAUDE_API_KEY = 'k';
    expect(claudeConfig()).toEqual({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', host: 'api.anthropic.com' });
  } finally {
    for (const [k, v] of [['BENCH_CLAUDE_API_KEY', saved.key], ['BENCH_CLAUDE_BASE_URL', saved.url], ['CLIPROXY_BASE_URL', saved.proxy]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
