/**
 * Tiny stdio MCP server used by mcp.test.ts. Uses the low-level Server so it
 * needs no zod from this file; the SDK supplies its own. Run with:
 *   bun mcp-echo-server.ts
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo-server', version: '0.0.1' }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the given text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'A non read-only tool.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
];

// PAGED=1 lists one tool per page, like a server with a long tool list
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  if (!process.env.PAGED) return { tools: TOOLS };
  const at = Number(req.params?.cursor ?? 0);
  return { tools: TOOLS.slice(at, at + 1), ...(at + 1 < TOOLS.length ? { nextCursor: String(at + 1) } : {}) };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${(args as { text?: string })?.text ?? ''}` }] };
  }
  if (name === 'write_note') {
    return { content: [{ type: 'text', text: `noted: ${(args as { note?: string })?.note ?? ''}` }] };
  }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
