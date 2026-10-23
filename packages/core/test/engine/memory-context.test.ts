import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MEMORY_CONTEXT_TOKENS, memoryContext, type ContextAssistant } from '../../src/engine/memory-context';
import { MEMORY_CONTEXT_URI, handleHubMcpRequest, type HubMcpApi } from '../../src/engine/hub-mcp';
import type { MemoryEntry } from '../../src/types';
import type { DayPlan, GoalSummary } from '../../src/assistant/types';
import { estimateTokens } from '../../src/util/text';

/**
 * memory_context: the block claude.ai and ChatGPT read at the start of a
 * chat, and the allow filter the hub uses for OAuth scopes.
 */

let n = 0;
function mem(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now();
  return { id: `mem_${++n}`, scope: 'global', kind: 'fact', content, tags: [], importance: 0.5, createdAt: now, updatedAt: now, useCount: 0, ...extra };
}

function memoryOf(entries: MemoryEntry[]) {
  return {
    profile: () => entries.filter((e) => e.kind === 'profile'),
    list: (o: { kind?: string } = {}) => entries.filter((e) => !o.kind || e.kind === o.kind),
  } as unknown as HubMcpApi['memory'];
}

function goal(title: string, extra: Partial<GoalSummary> = {}): GoalSummary {
  return { id: `goal_${++n}`, title, area: 'study', description: '', status: 'active', taskIds: [], createdAt: 0, updatedAt: 0, subgoals: [], entryCount: 0, openTasks: 0, ...extra };
}

const plan: DayPlan = {
  date: '2026-10-18',
  summary: 'Finish the lab report, then rest.',
  items: [
    { time: '09:00', text: 'Lab report, section 3' },
    { time: '14:00', text: 'Gym' },
  ],
  focus: { text: 'Lab report', start: '09:00', end: '11:00' },
  savedAt: 0,
};

const assistant = (goals: GoalSummary[], p?: DayPlan): ContextAssistant => ({
  goals: { list: () => goals },
  plan: (d) => (p && p.date === d ? p : undefined),
  today: () => '2026-10-18',
});

describe('memory_context', () => {
  test('holds the profile, the most important facts, active goals with the next step and today plan', () => {
    const text = memoryContext({
      memory: memoryOf([
        mem('Security student in Delft. Short answers, no em dashes.', { kind: 'profile', importance: 0.8 }),
        mem('The Proxmox host is called madx.', { importance: 0.9 }),
        mem('Likes green tea.', { importance: 0.2 }),
        mem('Old fact that was replaced.', { importance: 1, meta: { supersededBy: 'mem_x' } }),
        mem('A learned item waiting for review.', { importance: 1, meta: { review: 'pending' } }),
        mem('Goal (study, active): pass the exam.', { tags: ['goal'], importance: 1 }),
        mem('Project only fact.', { scope: 'project', scopeKey: '/code/x', importance: 1 }),
      ]),
      assistant: assistant([goal('Pass the networks exam', { targetDate: '2026-12-10', nextStep: 'Do the 2024 past paper.' }), goal('Run a 10k', { area: 'health' })], plan),
    });
    expect(text).toContain('About the owner\n- Security student in Delft.');
    expect(text).toContain('Important facts\n- The Proxmox host is called madx.\n- Likes green tea.');
    expect(text).not.toContain('replaced');
    expect(text).not.toContain('waiting for review');
    expect(text).not.toContain('Project only');
    // goals come from the goal list, not from their memory copies
    expect(text).not.toContain('Goal (study');
    expect(text).toContain('- Pass the networks exam (study, target 2026-12-10). Next step: Do the 2024 past paper.');
    expect(text).toContain('- Run a 10k (health). No next step set.');
    expect(text).toContain('Plan for today (2026-10-18)\nFinish the lab report, then rest.\n- 09:00 Lab report, section 3');
    expect(text).toContain('Focus 09:00 to 11:00: Lab report');
    expect(text).not.toMatch(/[–—]/);
  });

  test('stays under about 1,500 tokens however much memory there is, and every part keeps room', () => {
    const many = Array.from({ length: 400 }, (_, i) => mem(`Fact number ${i} about the homelab, with enough words to take some room in the block.`, { importance: i / 400 }));
    const profile = Array.from({ length: 60 }, (_, i) => mem(`Profile line ${i}: prefers plain answers and metric units, works late on Thursdays.`, { kind: 'profile' }));
    const goals = Array.from({ length: 30 }, (_, i) => goal(`Goal ${i}`, { nextStep: 'Write the next step down in a full sentence.' }));
    const text = memoryContext({ memory: memoryOf([...profile, ...many]), assistant: assistant(goals, plan) });
    expect(estimateTokens(text)).toBeLessThanOrEqual(MEMORY_CONTEXT_TOKENS);
    expect(text).toContain('About the owner');
    expect(text).toContain('Important facts');
    expect(text).toContain('Active goals');
    expect(text).toContain('Plan for today');
    // the most important facts win
    expect(text).toContain('Fact number 399');
    expect(text).not.toContain('Fact number 0 ');
  });

  test('without goals or a plan it still answers, and an empty memory says what to do', () => {
    expect(memoryContext({ memory: memoryOf([mem('Uses Arch Linux.')]) })).toContain('Important facts\n- Uses Arch Linux.');
    expect(memoryContext({ memory: memoryOf([]), assistant: assistant([]) })).toContain('Conclave memory is empty so far');
    // a plan for another day is not today's
    expect(memoryContext({ memory: memoryOf([mem('x y z')]), assistant: assistant([], { ...plan, date: '2026-10-17' }) })).not.toContain('Plan for today');
  });
});

describe('memory_context over MCP, and the allow filter', () => {
  const api: HubMcpApi = {
    version: 'test',
    memory: {
      ...memoryOf([mem('The CTF team meets on Thursdays.', { importance: 0.9 })]),
      search: async () => [],
      save: async () => mem('saved'),
    } as unknown as HubMcpApi['memory'],
    search: () => [],
    listSessions: () => [],
    listTasks: () => [],
    routines: { list: () => [] } as unknown as HubMcpApi['routines'],
    assistant: assistant([goal('Pass the exam', { nextStep: 'Past paper.' })], plan),
  };

  async function connect(allow?: (kind: 'tool' | 'prompt' | 'resource', name: string) => boolean) {
    const server = Bun.serve({ port: 0, fetch: (req) => handleHubMcpRequest(api, req, { allow }) });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    return { client, close: async () => (await client.close(), server.stop(true)) };
  }

  test('the tool, the prompt and the resource give the same block', async () => {
    const { client, close } = await connect();
    try {
      expect(client.getInstructions()).toContain('call memory_context before you answer');
      const tool = ((await client.callTool({ name: 'memory_context', arguments: {} })).content as Array<{ text: string }>)[0].text;
      expect(tool).toContain('The CTF team meets on Thursdays.');
      expect(tool).toContain('Pass the exam');
      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toEqual(['memory_context']);
      const prompt = await client.getPrompt({ name: 'memory_context' });
      expect((prompt.messages[0].content as { text: string }).text).toBe(tool);
      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toEqual([MEMORY_CONTEXT_URI]);
      const read = await client.readResource({ uri: MEMORY_CONTEXT_URI });
      expect((read.contents[0] as { text: string }).text).toBe(tool);
      const search = (await client.listTools()).tools.find((t) => t.name === 'memory_search');
      expect(search?.description).toContain('Basic Memory, so this one connector covers them');
    } finally {
      await close();
    }
  });

  test('allow hides and refuses tools, prompts and resources', async () => {
    const { client, close } = await connect((kind, name) => kind === 'tool' && (name === 'memory_search' || name === 'memory_recent'));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['memory_search', 'memory_recent']);
      const refused = await client.callTool({ name: 'memory_save', arguments: { content: 'x' } });
      expect(refused.isError).toBe(true);
      expect((refused.content as Array<{ text: string }>)[0].text).toContain('not part of what the owner allowed');
      expect((await client.listPrompts()).prompts).toEqual([]);
      expect((await client.listResources()).resources).toEqual([]);
      await expect(client.readResource({ uri: MEMORY_CONTEXT_URI })).rejects.toThrow(/unknown resource/);
      await expect(client.getPrompt({ name: 'memory_context' })).rejects.toThrow(/unknown prompt/);
    } finally {
      await close();
    }
  });
});
