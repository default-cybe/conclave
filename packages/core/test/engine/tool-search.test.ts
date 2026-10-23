import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Tool } from '../../src/tools/types';
import { rankTools, ToolSearchTool } from '../../src/tools/tool-search';
import { CATALOG } from './fixtures/mcp-catalog';
import { startTestEngine, toolResults, type RequestBody } from './harness';
import { fakeHost, makeCtx } from '../tools/helpers';

/**
 * HARNESS-REVIEW item 18: past mcp.deferAbove MCP tools, their schemas stay
 * out of the request and load through ToolSearch.
 */

const SERVER = join(import.meta.dir, 'fixtures', 'mcp-catalog-server.ts');
const tools: Tool[] = CATALOG.map((c) => ({ name: `mcp__gh__${c.name}`, description: c.description, inputSchema: c.inputSchema as never, readOnly: !!c.annotations?.readOnlyHint, run: async () => ({ content: '' }) }));

describe('ToolSearch ranker', () => {
  test('Recall@5 on a dozen queries over a 45-tool catalog', () => {
    const queries: Array<[string, string]> = [
      ['create a github issue', 'create_issue'],
      ['merge the pull request', 'merge_pull_request'],
      ['list commits on a branch', 'list_commits'],
      ['search code for a function', 'search_code'],
      ['comment on an issue', 'add_issue_comment'],
      ['read a file from the repository', 'get_file_contents'],
      ['rerun the failed CI workflow', 'rerun_workflow_run'],
      ['make a new notion page', 'notion_create_page'],
      ['query a notion database', 'notion_query_database'],
      ['what is on my calendar this week', 'calendar_list_events'],
      ['notes of the latest release', 'get_latest_release'],
      ['ask someone to review my PR', 'request_reviewers'],
    ];
    let hits = 0;
    const misses: string[] = [];
    for (const [q, want] of queries) {
      const top = rankTools(tools, q, 5).map((t) => t.name);
      if (top.includes(`mcp__gh__${want}`)) hits++;
      else misses.push(`${q} -> ${top.join(', ')}`);
    }
    console.log(`ToolSearch Recall@5: ${hits}/${queries.length}${misses.length ? `; misses: ${misses.join(' | ')}` : ''}`);
    expect(hits).toBeGreaterThanOrEqual(11);
  });

  test('select: loads tools by name; the result names them in meta.promoted', async () => {
    const host = fakeHost({ deferredTools: () => tools });
    const ctx = makeCtx({ cwd: '/', host });
    const out = await ToolSearchTool.run({ query: 'select:create_issue,mcp__gh__get_commit' }, ctx);
    expect(out.meta?.promoted).toEqual(['mcp__gh__create_issue', 'mcp__gh__get_commit']);
    expect(String(out.content)).toContain('<function>{"name":"mcp__gh__create_issue"');
    const none = await ToolSearchTool.run({ query: 'select:nope' }, ctx);
    expect(none.isError).toBe(true);
  });
});

describe('deferred MCP schemas in requests', () => {
  const issue = { owner: 'o', repo: 'r', title: 'Bug' };
  const run = async (deferAbove: number) => {
    const t = await startTestEngine({
      script: [
        [{ tool: 'mcp__gh__create_issue', input: issue }],
        [{ tool: 'ToolSearch', input: { query: 'create github issue' } }],
        [{ tool: 'mcp__gh__create_issue', input: issue }],
        [{ text: 'done' }],
      ],
      approve: 'allow',
      overrides: { mcpServers: { gh: { command: 'bun', args: [SERVER] } }, mcp: { deferAbove } } as never,
    });
    const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
    await t.run(s.id, 'open an issue');
    return { t, s };
  };

  test('only the built-ins and ToolSearch go out until a search loads tools, which are appended; the request is much smaller', async () => {
    const { t, s } = await run(30);
    try {
      const bodies = t.requests.map((r) => JSON.parse(r) as RequestBody);
      const names = (i: number) => (bodies[i].tools ?? []).map((x) => x.name);
      expect(names(0).some((n) => n.startsWith('mcp__'))).toBe(false);
      expect(names(0)).toContain('ToolSearch');
      expect(JSON.stringify(bodies[0].tools)).toContain('MCP tools loaded on demand: 45, from gh (45).');
      // a call before the search is refused with a note
      const results = toolResults(t.engine, s.id);
      expect(results[0].content).toContain('mcp__gh__create_issue is not loaded yet. Call ToolSearch with query "select:mcp__gh__create_issue" first');
      expect(results[1].content).toContain('5 tools loaded');
      expect(results[2].content).toContain('create_issue called with');
      // after the search: the same tools in the same order, then the loaded ones
      const before = names(1);
      const after = names(2);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toContain('mcp__gh__create_issue');
      expect(after.length - before.length).toBe(5);

      const { t: t2 } = await run(1_000);
      try {
        const all = JSON.parse(t2.requests[0]) as RequestBody;
        expect((all.tools ?? []).filter((x) => x.name.startsWith('mcp__'))).toHaveLength(45);
        const size = (b: RequestBody) => JSON.stringify(b.tools).length;
        // the MCP part: 45 schemas against the one ToolSearch tool that stands in for them
        const part = (b: RequestBody) => (b.tools ?? []).filter((x) => x.name.startsWith('mcp__') || x.name === 'ToolSearch').reduce((n, x) => n + JSON.stringify(x).length, 0);
        console.log(
          `first request tools: ${size(all)} -> ${size(bodies[0])} chars (~${Math.round((size(all) - size(bodies[0])) / 4)} tokens less); MCP part ${part(all)} -> ${part(bodies[0])} chars (${Math.round((1 - part(bodies[0]) / part(all)) * 100)}% less)`,
        );
        expect(part(bodies[0])).toBeLessThan(part(all) * 0.3);
        expect(t.requests[0].length).toBeLessThan(t2.requests[0].length - 10_000);
      } finally {
        await t2.close();
      }
    } finally {
      await t.close();
    }
  }, 60_000);
});
