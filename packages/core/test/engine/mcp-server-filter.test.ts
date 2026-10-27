import { describe, expect, test } from 'bun:test';
import { Engine } from '../../src/engine/engine';
import type { Tool } from '../../src/tools/types';

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' } as never, readOnly: true, run: async () => ({ content: '' }) });

describe("an agent's mcpServers filter", () => {
  test("'semgrep' keeps semgrep's tools and not semgrep2's", async () => {
    const mcp = [tool('mcp__semgrep__scan'), tool('mcp__semgrep2__scan'), tool('mcp__github__get_issue')];
    // only the parts of the engine toolsWithMcp reads
    const fake = { toolsFor: () => [], deps: { mcpTools: async () => mcp } };
    const session = { id: 's', kind: 'session', meta: {} } as never;
    const agent = { name: 'a', description: '', prompt: '', source: 'user', mcpServers: ['semgrep'] } as never;
    const out = await Engine.prototype.toolsWithMcp.call(fake as never, session, agent, 'default', 0);
    expect(out.map((t) => t.name)).toEqual(['mcp__semgrep__scan']);
  });
});
