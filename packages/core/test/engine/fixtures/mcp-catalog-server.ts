/**
 * Stdio MCP server that lists the 45-tool catalog (mcp-catalog.ts). Every
 * tool echoes its name and arguments; sleep waits for `ms` and ignores
 * cancellation, so a caller has to stop waiting on its own.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CATALOG } from './mcp-catalog';

const server = new Server({ name: 'catalog-server', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CATALOG }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'sleep') {
    await new Promise((r) => setTimeout(r, Number((args as { ms?: number })?.ms ?? 1000)));
    return { content: [{ type: 'text', text: 'slept' }] };
  }
  return { content: [{ type: 'text', text: `${name} called with ${JSON.stringify(args ?? {})}` }] };
});

await server.connect(new StdioServerTransport());
